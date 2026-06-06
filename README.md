# 从零构建你自己的 OpenClaw 

> 本项目是一个循序渐进的实战过程记录，旨在从零实现一个类似 OpenClaw 的个人 AI 助手。

## 免责声明

本项目由作者周末个人时间、使用私人电脑独立完成。本项目参考了OpenClaw的架构设计，记录个人 AI 助理的通用技术实践。内容不涉及任何企事业单位的商业秘密、非公开专属数据、特定业务逻辑。

本项目代码及文档仅供技术学习参考，作者不对其准确性、完整性或安全性作任何保证。若要打造类似商业产品请基于原始[OpenClaw](https://github.com/openclaw/openclaw) 二次开发，其40万行源码达到的工程细节完备度远超本项目。

## 关于本项目

2026年初席卷全网的“养虾热”虽逐渐褪去喧嚣，但作为构建自主智能体的里程碑，OpenClaw在Prompt动态组装、Context阶梯压缩以及Harness驾驭机制等底层工程维度上的极致打磨，为整个AI行业留下了长远影响。如果说将Harness 架构原则类比为"造智能手机的设计理念和方法"，那OpenClaw就是基于Harness架构原则、赋予开发者无限定制自由的"Android开源旗舰"。

本项目追求以最必要的小规模代码量来实践个人AI助理Harness架构关键功能，展现AI Native原生架构设计和应用开发过程，适合**具备编程基础的工程师**探究AI系统的实现本质。

每个章节包含：
- **技术文档** —— 概念讲解 + 实现过程
- **完整代码** —— 可运行、可对比、可扩展 (ts和golang)，按章节次序递进完善

## 目标读者

- 具备一定开发经验，对 AI Agent 有基本了解，想具象化理解或亲手实践Harness Engineering
- 想从0制造个人 AI 助手

## 内容（第 01–12 章）

全部 12 章分四个阶段：**基础阶段**（01–04）从最小原型到实时多渠道 Agent；**运行时阶段**（05–07）解决安全隔离、状态持久化与浏览器自动化；**进阶能力阶段**（08–09）赋予 Agent 记忆与协作能力；**生产就绪阶段**（10–12）完成插件化、主动调度与可观测性。

### 第 01 章 —— 最小 Agent 原型

每个 Agent 的核心：两层嵌套的 `while(true)` 循环，以及一个作为唯一状态载体的 messages 数组。

```
外层循环：等待用户输入
  └─ 内层循环：自主推理
       ├─ Thought   —— 调用 LLM
       ├─ Action    —— 执行 Shell 命令（command: 前缀）
       └─ Observation —— 将输出追加回 messages[]
```

核心洞察：消息历史*就是*状态，无需状态机。

### 第 02 章 —— 动态工具系统

将工具协议从文本前缀升级为 JSON，并引入可插拔工具注册表。

| 维度 | 变化 |
|------|------|
| 协议 | `command: <cmd>` → `{"action": "tool", ...params}` |
| 解析 | 双层防护：格式提取（4 种策略）+ 非法转义修复 |
| 注册表 | `registerTool()` —— schema 自动注入系统提示词 |
| 安全 | `MAX_ITERATIONS = 10` 防止内层循环失控 |

新增一个工具只需一次 `registerTool()` 调用，主循环与系统提示词自动更新。

### 第 03 章 —— 多模型 Provider 注册表

通过统一的 `Provider` 接口，将 LLM 调用层与主循环解耦。

- **统一消息格式** —— 内部 `Message[]` 与 SDK 无关；格式转换封装在各 Provider 内部
- **格式转换** —— OpenAI 直接映射；Claude 需将 `system` 提取为顶层字段
- **上下文管理** —— token 估算（4 字符 ≈ 1 token）→ 截断（保留最新）→ 压缩（LLM 摘要作为最后手段）
- **降级路由** —— `chatWithFallback(messages, chain)` 按顺序尝试每个 Provider；全部失败才抛出异常

主循环改动：一行。工具调度：不变。

### 第 04 章 —— 实时多渠道通信

将单一 CLI Agent 扩展为可同时服务 CLI、浏览器（WebSocket）和 QQ 机器人的并发网关。

**ACP（Agent 渠道协议）** —— 两种类型统一所有渠道：

```
ACPMessage  →  Gateway.dispatch()  →  Agent.handle()
                                            │
                                   streamWithFallback()
                                            │
                               onDelta(token) ──→ adapter.send({type:'delta'})
                               return full   ──→ adapter.send({type:'reply'})
```

| 机制 | 说明 |
|------|------|
| ChannelAdapter 接口 | `onMessage` / `send` / `start` —— 三个方法覆盖渠道完整生命周期 |
| 流式 token 缓冲 | 工具调用 token 被缓冲并丢弃；只有确认的文本回复才会推送给客户端 |
| 会话隔离 | `Map<sessionId, Message[]>` —— 每个用户/群组维护独立历史 |
| QQ 渠道 | HELLO → IDENTIFY → 心跳握手；`replyCtx` 映射存储原始 `msg_id` 用于回复 |
| 日志隔离 | 诊断日志 → stderr；readline 提示符留在 stdout —— 不破坏光标 |

---

### 第 05 章 —— 沙箱执行与风险隔离

Agent 拥有工具调用能力后，如何防止它伤害宿主机或泄露数据。

提供两种隔离模式：

| 模式 | 原理 | 适用场景 |
|------|------|---------|
| Host Mode | 应用层逻辑鸟笼：路径规范化 + HITL 确认环 + 原子化工具 + 进程降权 | 个人/开发环境，零依赖，快速启动 |
| Full Sandbox Mode | KVM MicroVM 硬件级隔离，对接 CubeSandbox（E2B 兼容接口） | 企业/生产环境，内核级隔离 |

四道防线（Host Mode）：

```
① path.resolve() 展开所有 ..，前缀校验拦截路径穿越
② HITL 拦截器：破坏性操作挂起等待 y/n，天然暂停主循环
③ 工具原子化：view_file / edit_file / list_dir，后缀白名单 + 大小熔断
④ 子进程降权：AGENT_RUN_UID 限制爆炸半径
```

架构变化：CLI 从主进程中独立为 WebSocket 客户端进程，主进程 stdin 由 HITL 独占，消除多 readline 竞争。

### 第 06 章 —— 状态管理与持久化

前五节 Agent 状态全活在内存里，`Ctrl+C` 即归零。本节用 SQLite 两张表解决长周期 Agent 的可靠性问题。

**Schema**：`sessions`（状态机：Init → Running → Paused → Success / Failed） + `traces`（执行轨迹，`parent_step_id` 串联树状结构支持多 Agent Debug）

四个核心能力：

| 能力 | 机制 |
|------|------|
| **进程崩溃恢复** | 状态先落地、副作用后发生；悬空 `running` 步骤由重启后恢复提示词触发 LLM 重新决策 |
| **断点重连** | 读 `current_status`：Running/Paused → 重构 messages[] + 注入恢复提示词继续执行；Success/Failed → 只读历史 |
| **Rollback** | `DELETE WHERE start_time >= target`，原子撤销"记忆"；现实副作用（文件/邮件）不可撤，需配合沙箱快照 |
| **Fork** | 克隆历史到新 session（`is_forked=1 + parent_session_id`），原 session 完整保留，两条路径可并排对比 |

用户通过 `/steps`、`/rollback <step_id>`、`/fork <step_id>` 命令操控轨迹。

### 第 07 章 —— 浏览器自动化

HTTP 请求拿不到 SPA 渲染的内容、填不了登录表单、截不了图——本节给 Agent 装上"真实浏览器"作为工具。

新增工具集（Playwright 封装）：`browser_navigate` / `browser_click` / `browser_type` / `browser_content` / `browser_screenshot` / `browser_key`

关键工程细节：

| 问题 | 解法 |
|------|------|
| HTML 噪声过多 | 精简管道：去脚本/样式 → 语义标签提取 → Token 截断，只送有效内容给 LLM |
| 多 session 浏览器隔离 | `BrowserContext` per session，独立 cookie/storage/localStorage |
| 截图送入 LLM | `ContentBlock[]` 混合格式：文本 + 图像 base64，Vision 模式 |
| 主循环感知 | 零改动——浏览器工具与 shell 工具对主循环完全透明 |

### 第 08 章 —— 长/短期记忆与 RAG

LLM context window 是"工作记忆"——容量有限、关机即失。本节给 Agent 装上跨会话记忆和企业级知识库。

**MemoryStore 统一接口**：`save/search/delete/close` 四个方法，上层对后端透明。

| 维度 | 说明 |
|------|------|
| 双后端 | `SQLiteMemoryStore`（零依赖，向量 JSON 序列化，<50K 条 <50ms）→ `MilvusMemoryStore`（HNSW 索引，百万级，ANN 召回率 >95%） |
| 工厂切换 | `createMemoryStore(cfg)` 按 `xclaw.yaml` 中 `memory.backend` 自动选择 |
| 双路并行召回 | `Promise.all([search(agent), search(kb)])` → 合并注入 system prompt 末尾，不污染对话历史 |
| 自动记忆提取 | `extractAndSaveMemories()` 在 Session Success 后异步触发，LLM 蒸馏要点，不阻塞回复 |
| 记忆工具 | `memory_save` / `memory_search`（Agent 主动存查）、`kb_index` / `kb_search`（知识库批量索引与检索） |
| 文档切片 | `chunkText(text, 512, 64)` 滑动窗口 + 64 token overlap，保证跨 chunk 语义连续 |

### 第 09 章 —— 多 Agent 协作

单 Agent 的能力上限是 context window——容量瓶颈、专注瓶颈、并发瓶颈。本节实现四种协作模式。

| 模式 | 原理 | 适用场景 |
|------|------|---------|
| 主从 `delegate` | Orchestrator LLM 推理动态派发，Worker 无状态 | 动态任务拆解 |
| 静态常驻团队 | Router 规则路由，Worker 持久会话 | 固定角色协作 |
| 流水线 `pipeline` | `{{input}}` 占位符注入前步输出 | 顺序加工链 |
| 对等 `debate` | `Promise.all` 并行广播，多视角碰撞 | 创意/决策对齐 |

关键工程细节：

- **双层返回协议**：`summary_data`（轻量决策数据）直入 Orchestrator context；`artifact_pointers`（重量级文件路径）按需 `view_file` 读取——防上下文爆炸
- **协议扩展**：`ACPMessage` 新增 `caller: 'user' | 'agent'` + `parentSessionId` 子会话追踪
- **工作区隔离**：Worker 级（`workspace/agents/{name}/`）+ 任务级（`{taskId}/`，临时）
- **熔断**：Worker `maxIterations=10`（vs 主 Agent 30-50），`delegate` 工具 `Promise.race` + 60s 超时

### 第 10 章 —— 技能发现与插件化

工具膨胀难维护、多人协作合并冲突、Agent 有工具但不会用——本节实现 Plugin（代码层）+ Skill（提示层）双轨扩展。

| 层 | 机制 | 扩展方向 |
|------|------|---------|
| Plugin | `openclaw.plugin.json` 清单 + `index.ts` 入口 + `buildPluginApi()` 粘合层 | "能做什么"——工具注册 |
| Skill | `SKILL.md`（YAML frontmatter + Markdown body） | "怎么做好"——prompt 注入 |

关键工程细节：

- **Skill 匹配**：`SkillRegistry.resolveForMessage()` 关键词集合交集，>= 2 命中才注入（单词偶然匹配误触发率高）
- **PluginService 生命周期**：`start()` 在 `register()` 后立即调用，`stop()` 进程退出统一调用
- **懒加载**：重型依赖放在 `execute()` 内动态 `import()`，不阻塞启动
- **Skill 三类资源**：`scripts/`（确定性脚本）、`references/`（详细文档）、`assets/`（模板等静态文件）
- **`{baseDir}` 替换**：Skill body 中占位符注入前替换为 skill 目录绝对路径

### 第 11 章 —— 定时任务与主动触发

被动架构的致命缺陷——用户不在线 = 什么都不发生。本节给 Agent 装上"生物钟"和"感知器官"。

**ChronosEngine**：零依赖 `cronMatches()` + 递归 `setTimeout`（无漂移，精确对齐分钟边界），每次触发 `new Agent()` 创建独立实例。

| 机制 | 说明 |
|------|------|
| CHRONOS MODE | `buildChronosSystemPrompt()` 追加约束——静默优先、异常即告警、步数硬上限 15 |
| 事件总线 | `AgentEventBus`（EventEmitter 包装），外部系统通过 Webhook HTTP 服务器注入（独立端口 3001） |
| notify 工具 | 三级降级：飞书群 Webhook 卡片 → QQ 主动推送 → stdout 打印 |
| 两层防死循环 | 外层 `isExecuting` 防时间维度堆积；内层 `maxSteps=15` 防工具调用维度失控 |

架构核心：时间和事件封装成消息发送者，ChronosEngine 以 `caller: 'agent'` 身份向 Orchestrator 发消息，后者完全不感知触发来源。

### 第 12 章 —— 可观测性与持续评估

Agent 的黑盒性与不确定性——你无法优化你无法度量的东西。本节构建 Trace → Metric → Benchmark 负反馈闭环。

| 能力 | 机制 |
|------|------|
| **分布式追踪** | `AsyncLocalStorage` 跨 async 调用自动传递 `traceId + sessionId`；`traceSpan` 高阶函数零侵入包装计时 + span + metrics |
| **指标采集** | `MetricsCollector` 单例：`record()` + `percentile()` P50/P95，LLM_CALL 自动捕获 token 用量与美元成本 |
| **断言驱动 Benchmark** | `TestCase` 包含 `expectedTools` / `forbiddenTools` / `assertResponse`，覆盖路由准度、提取准度、防死循环三类回归 |
| **CI 门禁** | `BenchmarkRunner` 每个案例独立 Agent + `__toolHook` 拦截工具调用，通过率 < 100% 时 `process.exit(1)` 阻断 |
| **容器化** | 多阶段 Dockerfile，Node.js 22 原生 TS 支持，镜像 ~150MB，非 root 运行 |
| **优雅停机** | `activeTaskTracker` 计数器，`SIGTERM` → 停 Chronos + Webhook → 轮询等待 → 清理 → exit |

优化双路径：错题回流（`agent.error.count` 上升 → Trace 上下文 → 新 TestCase → CI 强制覆盖）；成本优化（P95 `llm.cost.usd` 超阈值 → 定位高消耗 session → Prompt 精简/小模型降级）。

---

## 双语实现

**第 01–08 章**以 **Node.js（TypeScript）和 Go** 双语实现，可并排阅读对比；**第 09–12 章**目前仅提供 Node.js 实现（Go 版本计划补充）。

```
sections/
  01-agent-loop/
    nodejs/src/index.ts          # TypeScript，OpenAI SDK
    golang/main.go               # Go，单文件

  02-tool-system/
    nodejs/src/index.ts          # registerTool + extractJSON
    golang/main.go               # 相同架构的 Go 实现

  03-provider-registry/
    nodejs/src/
      providers/{types,openai,claude,registry}.ts
      context.ts  tools.ts  index.ts
    golang/
      providers/{types,openai,claude,registry}.go
      context.go  tools.go  main.go

  04-realtime-communication/
    nodejs/src/
      providers/  gateway/  channels/
      agent.ts  logger.ts  index.ts
    golang/
      providers/  gateway.go  channels.go
      agent.go  cli.go  web.go  qq.go  main.go

  05-sandbox-execution/
    nodejs/src/
      tools/{hostTools,sandboxTools}.ts
      sandbox/  index.ts  cli.ts
    golang/
      tools/  sandbox/  cmd/cli/  main.go
    xclaw.yaml                   # 行为规则（sandbox.mode: host|full）

  06-state-management/
    nodejs/src/
      db.ts  agent.ts  index.ts  cli.ts
    golang/
      db.go  agent.go  cmd/cli/  main.go
    # SQLite：sessions 状态机 + traces 执行轨迹

  07-browser-automation/
    nodejs/src/
      tools/browserTools.ts      # Playwright 封装
      index.ts
    golang/
      tools/browser.go  main.go

  08-memory-rag/
    nodejs/src/
      memory/{types,sqlite,milvus,factory}.ts
      tools/memoryTools.ts  extract.ts  index.ts
    golang/
      memory/  tools/  main.go
    xclaw.yaml                   # memory.backend: sqlite|milvus

  09-multi-agent/                # 以下仅 Node.js 实现
    nodejs/src/
      workers/  protocols/  workspace.ts
      agent.ts  orchestrator.ts  index.ts

  10-plugin-system/
    nodejs/src/
      plugin/{loader,api,skillRegistry}.ts
      index.ts
    plugins/                     # 示例插件
      hello/  sysinfo/

  11-chronos/
    nodejs/src/
      chronos/{cron,engine,eventBus,notify}.ts
      webhook/server.ts  index.ts
    config/chronos.json          # 定时任务配置

  12-observability/
    nodejs/src/
      trace/  metrics/  benchmark/
      Dockerfile  index.ts
    benchmarks/dataset.ts        # 断言测试用例
```

每章都是独立可运行的模块。前 8 章两种实现遵循相同架构，设计上可并排阅读对比。

---

## 实践大纲

### 第一阶段：基础

| 章节 | 主题 | 核心挑战 |
|------|------|----------|
| [01](./sections/01-agent-loop) | 最小 Agent 原型 | 结构化输出解析 |
| [02](./sections/02-tool-system) | 动态工具系统 | Schema 自动生成 |
| [03](./sections/03-provider-registry) | 多模型适配器 | API 格式抽象 |
| [04](./sections/04-realtime-communication) | 实时渠道 | 流式传输与会话隔离 |

### 第二阶段：运行时

| 章节 | 主题 | 核心挑战 |
|------|------|----------|
| [05](./sections/05-sandbox-execution) | 沙箱执行 | 路径穿越防护 + HITL 确认环 + KVM 隔离 |
| [06](./sections/06-state-management) | 状态与持久化 | SQLite 事务 + 断点重连 + Rollback/Fork |
| [07](./sections/07-browser-automation) | 浏览器自动化 | SPA 渲染 + HTML 精简 + Vision 截图 |

### 第三阶段：进阶能力

| 章节 | 主题 | 核心挑战 |
|------|------|----------|
| [08](./sections/08-memory-rag) | 长/短期记忆 | 向量数据库 + BM25/语义混合检索 |
| [09](./sections/09-multi-agent) | 多 Agent 协作 | 任务拆解 + 跨 Agent 上下文传递 |

### 第四阶段：生产就绪

| 章节 | 主题 | 核心挑战 |
|------|------|----------|
| [10](./sections/10-plugin-system) | 插件系统 | YAML 清单 + 动态加载 + 健康检查 |
| [11](./sections/11-chronos) | 定时与主动任务 | Cron 调度 + 事件驱动 + 主动巡检 |
| [12](./sections/12-observability) | 部署与可观测性 | Latency/Token 监控 + Benchmark 评估 |

---

## 代码运行要求

- Node.js 20+ 或 Go 1.21+
- OpenAI、Anthropic 或任意兼容 LLM 提供商的 API Key

## 参考项目

[OpenClaw](https://github.com/openclaw/openclaw) 项目，这是一个功能完整，能力强大可扩展的个人 AI 助手，支持多渠道消息、语音交互和沙箱执行。本项目聚焦于关键核心harness架构原理实践。

## 许可证

Apache-2.0
