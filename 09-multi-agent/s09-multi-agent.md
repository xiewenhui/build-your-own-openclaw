# 第 09 节：多代理协作 (Multi-Agent Collaboration)

> "单个 Agent 的能力上限是它的 context window；多个 Agent 协作的能力上限是团队设计。"

## 本节改动全景

相比第 08 节，本节的改动集中在多代理层，记忆系统与 Agent 主循环**完全不变**：

| 改动点 | 第 08 节 | 第 09 节 |
|--------|---------|---------|
| Agent 数量 | 1 个（单 Agent）| N 个（1 个 Orchestrator + 多个 Worker）|
| 工具集 | memory/kb/browser | + `delegate`（主从）/ `debate`（对等）/ `pipeline`（流水线）|
| 路由层 | `resolveSessionId`（无路由）| + `routeToAgent`（静态团队模式）|
| 消息协议 | `ACPMessage`（无来源标记）| + `caller` / `parentSessionId` 字段 |
| 新增文件 | 无 | `agents.ts`（WorkerRegistry + 预置角色）|
| Agent 构造 | 固定 system prompt | + `systemPromptOverride` 支持每个 Worker 定制角色 |

**这一节的核心设计思想**：把另一个 Agent 封装成工具——Orchestrator 不感知"这是调用 LLM 还是调用函数"，照常 `{"action":"delegate","agent":"coder","task":"..."}` 发起；多代理层封装了子 Agent 的实例化、会话隔离和结果聚合。

---

## 整体架构

> 文档是设计蓝图，实际代码在此基础上有所完善（如 `mode` 参数、`onDelta` 流式透传、`hasCodeIntent` 路由过滤等）。读代码时以代码为准，文档描述核心骨架。

所有请求的入口是 `Gateway.dispatch()`，它先做静态路由，未匹配再交给 Orchestrator：

```
用户请求
    │
    ▼
Gateway.dispatch()
    │
    ├── routeToAgent() ──→ 静态团队路由（规则匹配 + hasCodeIntent 前置过滤）
    │       匹配到 ──────→ 专家 Agent（team:{role}:{sessionId}，持久会话）
    │
    └── 未匹配 ──────────→ Orchestrator Agent（主 agent，含 delegate/debate/pipeline 工具）
                                │
                                ├── delegate ──→ Worker Agent（新 subSession，无历史）
                                ├── debate   ──→ 多 Worker 并行（Promise.all）
                                └── pipeline ──→ Worker 顺序串联（{{input}} 注入）
```

**两条路径的关键差异**：

| | 静态团队路由 | Orchestrator 路由 |
|--|--|--|
| 决策者 | 规则正则（`routeToAgent`）| LLM 推理（Orchestrator system prompt）|
| Worker session | 持久复用（`team:{role}:{sid}`）| 每次新建（`{sid}:{worker}:{taskId}`）|
| 适合场景 | 单一明确的专家请求 | 需要拆解的复合任务 |

---

## 为什么需要多代理协作

前 8 节的 xclaw 是单 Agent 架构——一个 LLM 实例，一个 context window，完成所有任务。对于日常任务这已经足够，但三类场景会让单 Agent 力不从心：

```
场景 A — 容量瓶颈
  任务：审查整个代码仓库（500 个文件）并生成架构报告
  单 Agent：context window 放不下全部文件
  → 需要拆成子任务，分批处理，最后聚合

场景 B — 专注瓶颈
  任务：实现一个功能 → 写测试 → 做代码审查 → 写文档
  单 Agent：角色频繁切换，"程序员思维" 和 "审查员思维" 互相干扰
  → 让不同 Agent 专注不同角色，各自有定制的 system prompt

场景 C — 并发瓶颈
  任务：同时研究三个竞品的定价策略
  单 Agent：顺序执行，3 倍时间
  → 三个 Worker 并行运行，1 倍时间
```

对比一下两种架构在同一任务上的执行路径：

```
单 Agent — "帮我实现 JWT 认证模块并做代码审查"
  Step 1: 思考架构（LLM 调用）
  Step 2: 写代码（LLM 调用）
  Step 3: 转换视角，切换到"审查员模式"（同一 LLM，上下文越来越长）
  Step 4: 审查自己写的代码（很难真正客观）
  Step 5: 写文档（更长的上下文，注意力进一步分散）

多 Agent — 同样的任务
  Orchestrator 规划：
  ├── [并行] delegate → coder:   "实现 JWT sign/verify，HS256 算法"
  │                               ← 干净的 context，专注实现
  ├── [串行] delegate → reviewer: "审查以下代码，关注安全漏洞：\n<代码>"
  │                               ← 全新视角，从未见过这段代码
  └── [串行] delegate → writer:   "为以下代码生成 JSDoc 文档：\n<代码>"
                                  ← 只做文档，不受实现细节干扰
```

---

## 1. 四种协作模式

### 1.1 主从模式（Orchestrator-Worker）

```
用户
 │
 ▼
┌─────────────────────────────────────────┐
│         Orchestrator Agent              │
│   规划 → 拆解 → 派发 → 聚合结果          │
└─────────────────────────────────────────┘
      │            │            │
      ▼            ▼            ▼
  ┌────────┐  ┌────────┐  ┌────────┐
  │ coder  │  │reviewer│  │ writer │
  │ Worker │  │ Worker │  │ Worker │
  └────────┘  └────────┘  └────────┘
  （新会话）   （新会话）   （新会话）
```

**核心特征**：Orchestrator 是 LLM，它通过推理动态决定"现在该找谁、给什么任务"。每次 `delegate` 创建一个全新的子会话——Worker 不记得上次被调用时做了什么。

**适合场景**：任务边界清晰、可拆解成独立子任务的工作（代码生成、报告撰写、多步研究）。

### 1.2 静态常驻团队（Resident Panel）

```
用户请求
    │
    ▼
┌──────────────────────────────────┐
│          Router（路由层）         │
│   "代码问题" → coder              │
│   "审查请求" → reviewer           │
│   "文档需求" → writer             │
└──────────────────────────────────┘
      │            │            │
      ▼            ▼            ▼
  ┌────────┐  ┌────────┐  ┌────────┐
  │ coder  │  │reviewer│  │ writer │
  │ 持久   │  │ 持久   │  │ 持久   │
  │ 会话   │  │ 会话   │  │ 会话   │
  └────────┘  └────────┘  └────────┘
```

**核心特征**：Router 做路由（规则/关键词/意图分类），不是 LLM 推理。每个 Agent 有自己持久的会话——coder 记得你上次讨论的项目架构，reviewer 记得你的代码规范偏好。

**主从 vs 静态团队的核心区别**：

| | 主从模式 | 静态常驻团队 |
|--|--|--|
| 谁决定找哪个 Agent | Orchestrator（LLM 推理） | Router（规则/关键词）|
| Worker 的 session | 每次新建（无历史）| 持续复用（有历史）|
| 用户感知 | 只看到 Orchestrator | 可直接和专家对话 |
| 适合场景 | 复杂任务拆解 | 专家角色服务 |

**适合场景**：产品团队多角色、客服分线（售前/技术/售后）、代码库的模块 Owner 模型。

### 1.3 流水线模式（Pipeline）

```
输入文本
    │
    ▼
┌──────────┐     ┌──────────┐     ┌──────────┐
│ extractor│ ──► │ analyzer │ ──► │ reporter │
│ 提取结构  │     │ 分析数据 │      │ 生成报告 │
└──────────┘     └──────────┘     └──────────┘
    输出              输出              输出
  ↓（作为下一步输入）↓（作为下一步输入）↓
```

**核心特征**：固定顺序，前一步的输出直接成为下一步的输入（通过 `{{input}}` 占位符注入）。没有中心调度者，也没有反馈回路。

**适合场景**：ETL、文档处理管道（提取→翻译→摘要）、数据分析流程。

### 1.4 对等协作（Peer Debate）

```
                    问题
                     │
        ┌────────────┼────────────┐
        ▼            ▼            ▼
   ┌─────────┐  ┌─────────┐  ┌─────────┐
   │optimist │  │ skeptic │  │security │
   │ 乐观派  │   │ 怀疑派  │   │ 安全专家│
   └─────────┘  └─────────┘  └─────────┘
        │            │            │
        └────────────┼────────────┘
                     ▼
              Orchestrator 综合
              各方观点后决策
```

**核心特征**：多个 Agent 并行接收同一问题，各自从不同视角独立回答，最后由调用方综合。适合需要多视角审视、降低单点偏见的决策场景。

**适合场景**：架构决策评审、安全风险评估、方案对比选型。

### 1.5 四种模式对比

| 维度 | 主从 | 静态团队 | 流水线 | 对等协作 |
|------|------|---------|--------|---------|
| 调度者 | Orchestrator（LLM）| Router（规则）| 无 | 调用方 |
| 执行顺序 | 动态（LLM 决定）| 按请求 | 固定顺序 | 并行 |
| Worker 历史 | 无（每次新建）| 有（会话持续）| 无 | 无 |
| 上下文传递 | 任务描述中显式传入 | 会话历史隐式积累 | `{{input}}` 注入 | 问题广播 |
| 适合问题 | 复杂任务拆解 | 专家角色服务 | 数据处理管道 | 多视角决策 |

---

## 2. 协议扩展：ACP 增加来源追踪

现有 `ACPMessage` 只有用户发给 Agent 的结构。多代理场景需要两个新字段：

```typescript
// gateway/types.ts
export interface ACPMessage {
  id: string;
  sessionId: string;
  channel: string;
  content: string;
  timestamp: number;
  type?: string;
  caller?: 'user' | 'agent';      // 新增：谁发的这条消息
  parentSessionId?: string;       // 新增：父会话 ID（子任务追踪）
}
```

`caller` 的用处：Worker 可以根据调用来源调整行为——来自用户时礼貌解释，来自 Agent 时直接返回结果（省去客套话）。

`parentSessionId` 的用处：traces 表中可以通过它把所有子会话关联到父会话，形成完整的任务追踪树。

---

## 3. Worker 注册表

把 Worker Agent 集中管理，让所有工具（`delegate`、`debate`、`pipeline`）都能通过名称找到对应 Agent：

```typescript
// agents.ts（新建）
import { Agent } from './agent.ts';

// ── Worker 注册表 ────────────────────────────────────────────────────────────

export const workerRegistry = new Map<string, Agent>();

// ── 预置角色 ─────────────────────────────────────────────────────────────────

export function registerDefaultWorkers(providerChain: string[], baseWorkDir: string, mode: string = 'host'): void {
  const agentsBase = path.resolve(baseWorkDir, 'agents');
  if (mode === 'host') fs.mkdirSync(agentsBase, { recursive: true });

  for (const spec of WORKER_SPECS) {
    let workerDir: string | undefined;
    let workspaceSection: string;

    if (mode === 'host') {
      workerDir = path.join(agentsBase, spec.name);
      fs.mkdirSync(workerDir, { recursive: true });
      workspaceSection = `\n\n## Workspace
Scratch directory for intermediate files: ${workerDir}
Use this for any work-in-progress files. Final artifacts must be submitted via the deliver tool
to the [Shared delivery dir] path provided in the task header — not to this directory.`;
    } else {
      workspaceSection = `\n\n## Workspace
You run in an isolated KVM sandbox. Use the shell tool for intermediate work in /workspace/.
Submit final artifacts via the deliver tool (provide filename + content).`;
    }

    const fullPrompt = `${spec.prompt}${workspaceSection}

## Tool calls
To call a tool, output ONLY a raw JSON object — no surrounding text:
{"action": "deliver", "path": "<absolute path from [Shared delivery dir]>", "content": "<file content>"}
{"action": "view_file", "path": "<path>"}
{"action": "list_dir", "path": "<path>"}

You will receive a "tool output:" message after each call. Read the result, then continue working.
Never combine a tool call and the final result JSON in the same response — they are separate turns.

## Returning Results
**If the task starts with [Shared delivery dir:]** (called by Orchestrator via delegate):
Output ONLY this JSON — no surrounding text:
{"status":"success"|"error","summary_data":{...},"artifact_pointers":{...}}

Rules:
- summary_data: decisions and metadata only — scores, flags, key findings, assumptions. No large text bodies.
- Any file output (code, documentation, reports, diffs): call deliver first, then put the confirmed path in artifact_pointers.
- artifact_pointers: only paths that deliver confirmed with "delivered: <path>". Never invent a path.
- If nothing was delivered, set artifact_pointers to {}.

**If there is no [Shared delivery dir:] header** (talking directly with a user):
Respond in natural language. Do not output JSON.`;

    workerRegistry.set(
      spec.name,
      new Agent(providerChain, 20, null, null, 0, fullPrompt, workerDir),
    );
  }
}
```

对 `Agent` 构造函数增加一个可选参数：

```typescript
// agent.ts — 构造函数新增 systemPromptOverride + workDir
constructor(
  providerChain: string[],
  maxIterations: number,
  db: DB | null = null,
  memoryStore: MemoryStore | null = null,
  memoryTopK = 5,
  systemPromptOverride?: string,   // ← 新增：Worker 专属角色 prompt
  workDir?: string,                // ← 新增：Worker 专属隔离工作区路径
) {
  // ...
  this.systemPromptOverride = systemPromptOverride;
  this._workDir = workDir;
}

get agentWorkDir(): string | undefined { return this._workDir; }

// handle() 中初始化 session 时使用 override（优先从 DB 恢复历史）
if (!this.sessions.has(msg.sessionId)) {
  if (this.db) {
    const status = this.db.getStatus(msg.sessionId);
    if (status !== null) {
      const loaded = this.db.loadMessages(msg.sessionId, this.systemPromptOverride ?? buildSystemPrompt());
      this.sessions.set(msg.sessionId, loaded);
    }
  }
  if (!this.sessions.has(msg.sessionId)) {
    this.sessions.set(msg.sessionId, [{ role: 'system', content: this.systemPromptOverride ?? buildSystemPrompt() }]);
  }
}
```

---

## 4. 主从模式：`delegate` 工具

`delegate` 是主从模式的核心——它把"调用一个 Agent"封装成普通工具，让 Orchestrator 像调用文件读写一样使用它：

```typescript
// tools.ts — initOrchestratorTools(registry, sharedDir, mode)

export function initOrchestratorTools(registry: Map<string, Agent>, sharedDir: string, mode: string): void {

  // ── deliver：提交重量级成果文件到全局交付区 ────────────────────────────────
  // host 模式：path 为任务头部 [Shared delivery dir: ...] 提供的绝对路径，直接写宿主机。
  // full 模式：path 为目标文件名（如 jwt.ts），taskId 从 sessionId 末段自动推断。
  // 轻量结构化结果（JSON 摘要）直接在回复的 summary_data 里返回，无需调用此工具。
  registerTool(
    {
      name: 'deliver',
      description: mode === 'full'
        ? '将最终成果文件提交到共享交付区。path: 目标文件名（如 jwt.ts），content: 文件内容。'
        : '将重量级成果文件（源码、报告等）提交到全局交付区（workspace/shared/）。path 使用 [Shared delivery dir: ...] 提供的绝对路径。',
      parameters: {
        type: 'object',
        properties: {
          path:    { type: 'string', description: mode === 'full' ? '目标文件名' : '交付文件绝对路径，必须在 [Shared delivery dir: ...] 目录内' },
          content: { type: 'string', description: '文件内容' },
        },
        required: ['path', 'content'],
      },
    },
    async (sessionId, params) => {
      if (mode === 'full') {
        // full 模式：从 sub-session ID（格式 parent:workerName:taskId）末段提取 taskId
        const taskId = sessionId.split(':').at(-1) ?? 'unknown';
        const hostPath = path.join(sharedDir, taskId, path.basename(params['path']!));
        await fs.mkdir(path.dirname(hostPath), { recursive: true });
        await fs.writeFile(hostPath, params['content']!, 'utf-8');
        return `delivered: ${hostPath}`;
      }
      // host 模式：path 必须在 sharedDir 内
      const deliveryPath = path.resolve(params['path']!);
      if (!deliveryPath.startsWith(path.resolve(sharedDir) + path.sep)) {
        return `error: path must be inside ${sharedDir}`;
      }
      await fs.mkdir(path.dirname(deliveryPath), { recursive: true });
      await fs.writeFile(deliveryPath, params['content']!, 'utf-8');
      return `delivered: ${deliveryPath}`;
    },
  );

  // ── delegate：委托子任务给指定 Worker ──────────────────────────────────────
  // Worker 必须以结构化 JSON 结束回复：
  //   { status, summary_data（轻量决策数据）, artifact_pointers（重量级文件路径）}
  registerTool(
    {
      name: 'delegate',
      description: '将子任务委托给专家 Agent 执行。Worker 返回结构化 JSON：{ status, summary_data（轻量决策数据，Orchestrator 直接读取）, artifact_pointers（重量级文件路径，按需 view_file 读取）}。',
      parameters: {
        type: 'object',
        properties: {
          agent: {
            type: 'string',
            description: '目标 Agent 名称：coder / reviewer / writer / skeptic / optimizer',
          },
          task: {
            type: 'string',
            description: '子任务的完整描述。必须自包含：含所有必要背景、代码片段、约束条件。',
          },
        },
        required: ['agent', 'task'],
      },
    },
    async (sessionId, params, onDelta) => {
      const workerName = params['agent']!;
      const worker = registry.get(workerName);
      if (!worker) {
        return `error: unknown agent "${workerName}". Available: ${[...registry.keys()].join(', ')}`;
      }

      const taskId   = crypto.randomUUID().slice(0, 6);
      const subSessionId = `${sessionId}:${workerName}:${taskId}`;

      // Worker 私有工作区（中间文件）：workspace/agents/{name}/{taskId}/
      // 全局交付区（最终成果）：workspace/shared/{taskId}/
      // 工具调用格式和返回规范已在 Worker system prompt 中定义，此处只注入路径
      const headers: string[] = [];
      if (mode === 'host') {
        const workerDir = worker.agentWorkDir;
        if (workerDir) {
          fsSync.mkdirSync(path.join(workerDir, taskId), { recursive: true });
          headers.push(`[Task workspace: ${path.join(workerDir, taskId)}]`);
        }
        const deliveryDir = path.join(sharedDir, taskId);
        fsSync.mkdirSync(deliveryDir, { recursive: true });
        headers.push(`[Shared delivery dir: ${deliveryDir}]`);
      }
      // full 模式：无宿主机路径可注入；deliver 工具从 sessionId 推断 taskId

      const taskContent = [...headers, params['task']!].join('\n\n');

      const msg = {
        id: crypto.randomUUID(), sessionId: subSessionId,
        channel: 'internal', content: taskContent,
        timestamp: Date.now(), caller: 'agent' as const, parentSessionId: sessionId,
      };

      // Worker 的 onDelta token 透传给 Orchestrator 的 onDelta，实现流式输出
      onDelta?.(`\n[${workerName}] working...\n`);
      const result = await worker.handle(msg, (token) => onDelta?.(token));
      onDelta?.(`\n[${workerName}] done\n`);
      return result;
    },
  );

  // ── debate：并行征求多个 Agent 意见 ─────────────────────────────────────────
  registerTool(
    {
      name: 'debate',
      description: '向多个专家 Agent 同时发送同一个问题，并行征求意见，返回所有回复。适合需要多视角审视的决策场景（架构选型、风险评估）。',
      parameters: {
        type: 'object',
        properties: {
          question: {
            type: 'string',
            description: '需要多方意见的问题，必须自包含',
          },
          agents: {
            type: 'string',
            description: 'JSON 数组，参与讨论的 Agent 名称列表，如 ["coder","reviewer","skeptic"]',
          },
        },
        required: ['question', 'agents'],
      },
    },
    async (sessionId, params, onDelta) => {
      let names: string[];
      try {
        names = JSON.parse(params['agents']!) as string[];
      } catch {
        return 'error: agents must be a JSON array, e.g. ["coder","reviewer"]';
      }

      // 并行调用，互不阻塞
      onDelta?.(`\n[debate] asking ${names.join(', ')} in parallel...\n`);
      const results = await Promise.all(
        names.map(async (name) => {
          const worker = registry.get(name);
          if (!worker) return `[${name}]: not found`;
          const msg = {
            id: crypto.randomUUID(),
            sessionId: `${sessionId}:debate:${name}:${crypto.randomUUID().slice(0, 6)}`,
            channel: 'internal',
            content: params['question']!,
            timestamp: Date.now(),
            caller: 'agent' as const,
            parentSessionId: sessionId,
          };
          const reply = await worker.handle(msg, () => {});
          return `[${name}]\n${reply}`;
        }),
      );

      return results.join('\n\n---\n\n');
    },
  );

  // ── pipeline：顺序执行多步任务 ───────────────────────────────────────────────
  registerTool(
    {
      name: 'pipeline',
      description: '按顺序执行多个 Agent 任务，前一步的输出自动注入到下一步（用 {{input}} 占位符引用）。适合数据处理管道、文档转换等流水线场景。',
      parameters: {
        type: 'object',
        properties: {
          steps: {
            type: 'string',
            description: 'JSON 数组，每个元素为 {"agent":"名称","task":"任务描述"}。task 中用 {{input}} 引用上一步的输出，第一步的 {{input}} 为空字符串。',
          },
        },
        required: ['steps'],
      },
    },
    async (sessionId, params, onDelta) => {
      let steps: Array<{ agent: string; task: string }>;
      try {
        steps = JSON.parse(params['steps']!) as Array<{ agent: string; task: string }>;
      } catch {
        return 'error: steps must be a JSON array of {agent, task} objects';
      }

      let prevOutput = '';
      for (let i = 0; i < steps.length; i++) {
        const step = steps[i]!;
        const worker = registry.get(step.agent);
        if (!worker) return `error: step ${i + 1}: unknown agent "${step.agent}"`;

        const taskWithInput = step.task.replace(/\{\{input\}\}/g, prevOutput);
        const msg = {
          id: crypto.randomUUID(),
          sessionId: `${sessionId}:pipe:step${i}:${crypto.randomUUID().slice(0, 6)}`,
          channel: 'internal',
          content: taskWithInput,
          timestamp: Date.now(),
          caller: 'agent' as const,
          parentSessionId: sessionId,
        };
        onDelta?.(`\n[pipeline step ${i + 1}/${steps.length}: ${step.agent}]\n`);
        prevOutput = await worker.handle(msg, (token) => onDelta?.(token));
      }

      return prevOutput; // 最后一步的输出即最终结果
    },
  );
}
```

---

## 5. 静态常驻团队：Router 扩展

静态团队不依赖 Orchestrator，而是由 Gateway 层的 Router 直接把请求分配给对应 Agent。Router 有两种实现方式：

### 5.1 规则路由（快速、确定）

```typescript
// gateway/router.ts — 增加 routeToAgent
import type { Agent } from '../agent.ts';

export function resolveSessionId(channel: string, clientSessionId?: string): string {
  if (channel === 'cli') return 'cli';
  return clientSessionId ?? `web-${Date.now()}`;
}

// 静态团队路由：仅匹配单一、明确的专家请求。
// 复合任务（如"写代码+审查+加注释"）不在此处路由，交由 Orchestrator 拆解分派。
// 返回 null 表示未匹配，交给 Orchestrator 处理。
export function routeToAgent(
  content: string,
  agentMap: Map<string, Agent>,
): Agent | null {
  const lower = content.toLowerCase();

  // 只有不包含"写"/"实现"/"创建"等编码意图时，才直接路由给专家
  const hasCodeIntent = /写|实现|创建|编写|开发|build|create|implement|write/.test(lower);
  if (hasCodeIntent) return null; // 复合任务 → Orchestrator

  if (/^(帮我)?(做个?|做一下|做一次|请做|进行|给.*做|做代码)?审查|^review|^code review/.test(lower))
    return agentMap.get('reviewer') ?? null;

  if (/^(帮我)?(写|生成|加上|添加)(一下|一份|一个)?(文档|readme|注释|jsdoc)/.test(lower))
    return agentMap.get('writer') ?? null;

  if (/^(帮我)?(做个?|分析|看看)(性能|优化|复杂度)/.test(lower))
    return agentMap.get('optimizer') ?? null;

  if (/漏洞|安全风险|sql\s*injection|xss|注入/.test(lower))
    return agentMap.get('skeptic') ?? null;

  return null; // 无法匹配，交由 Orchestrator（含 delegate 工具）处理
}
```

### 5.2 LLM 意图路由（灵活、准确）

当规则匹配不可靠时（请求措辞不规律、多语言），用一个轻量 Agent 判断意图：

```typescript
// gateway/router.ts — LLM 路由（可选增强）
import { streamWithFallback } from '../providers/registry.ts';

export async function routeToAgentByLLM(
  content: string,
  availableAgents: string[],
  providerChain: string[],
): Promise<string | null> {
  const prompt = `根据用户的请求，选择最合适的专家处理。只输出一个单词（专家名称），不要解释。

可选专家：${availableAgents.join(' / ')}
专家说明：
- coder: 代码实现、bug 修复、功能开发
- reviewer: 代码审查、质量评估
- writer: 文档、注释、README
- optimizer: 性能优化
- skeptic: 风险分析、批判性评估
- 如果请求综合性很强（需要多步骤），输出 null

用户请求：${content}`;

  const reply = await streamWithFallback(
    [{ role: 'user', content: prompt }],
    providerChain,
    () => {},
  );

  const name = reply.trim().toLowerCase();
  if (name === 'null' || !availableAgents.includes(name)) return null;
  return name;
}
```

### 5.3 Gateway 集成静态团队

```typescript
// gateway/gateway.ts — dispatch() 增加静态团队路由
import { routeToAgent } from './router.ts';

export class Gateway {
  private adapters = new Map<string, ChannelAdapter>();
  private agent: Agent;            // Orchestrator（含 delegate 工具）
  private teamAgents: Map<string, Agent>;  // 静态团队
  private db: DB | null;

  constructor(agent: Agent, teamAgents: Map<string, Agent> = new Map(), db: DB | null = null) {
    this.agent   = agent;
    this.teamAgents = teamAgents;
    this.db      = db;
  }

  private async dispatch(raw: ACPMessage): Promise<void> {
    const msg = { ...raw, sessionId: resolveSessionId(raw.channel, raw.sessionId) };
    const adapter = this.adapters.get(msg.channel)!;

    // 静态团队路由优先——匹配到专家 Agent 则直接转发
    const routed = routeToAgent(msg.content, this.teamAgents);
    const handler = routed ?? this.agent;

    // 静态团队的 sessionId 带 Agent 名前缀，确保每个专家有独立会话
    const dispatchMsg = routed
      ? { ...msg, sessionId: `team:${[...this.teamAgents.entries()].find(([, v]) => v === routed)?.[0]}:${msg.sessionId}` }
      : msg;

    try {
      const full = await handler.handle(dispatchMsg, (token) => {
        adapter.send({ type: 'delta', id: msg.id, sessionId: msg.sessionId, channel: msg.channel, content: token });
      });
      adapter.send({ type: 'reply', id: msg.id, sessionId: msg.sessionId, channel: msg.channel, content: full });
    } catch (err: any) {
      adapter.send({ type: 'error', id: msg.id, sessionId: msg.sessionId, channel: msg.channel, content: err.message });
    }
  }
  // ... 其余不变
}
```

---

## 6. 上下文传递：子任务如何获得足够信息

多代理系统最容易踩的坑：子 Agent 看不到父 Agent 的对话历史，任务描述必须完全自包含。

```
❌ 错误写法
  task: "审查一下上面的代码"
  → Worker 看不到"上面的代码"，无从审查

✅ 正确写法
  task: "审查以下 TypeScript 代码，关注安全性和边界处理：\n\n```typescript\nfunction login(user, pass) {\n  return db.query(`SELECT * FROM users WHERE name='${user}'`);\n}\n```\n\n重点：SQL 注入风险、密码明文传输"
  → Worker 有完整上下文，可以独立完成任务
```

四种上下文传递策略的选型：

| 策略 | 做法 | 优点 | 缺点 | 适用场景 |
|------|------|------|------|---------|
| **全量嵌入** | 把相关代码/文档直接贴进 task | 信息完整 | task 过长时浪费 token | 代码片段较短时 |
| **Orchestrator 提炼** | 先总结关键信息再传给 Worker | 节省 token | 可能丢失细节 | 长文档、大量背景 |
| **共享记忆**（第 08 节）| Worker 通过 `memory_search` 自己查 | 无感知传递 | 需要提前写入 memoryStore | 跨多次会话的持久知识 |
| **结构化接口** | 定义明确的输入 schema（如 JSON）| 解析可靠 | 需要提前设计协议 | 自动化程度高的管道 |

**Orchestrator 的 system prompt 应当明确这条规则**：

```
你是任务协调 Agent，负责拆解复杂任务并用 delegate/debate/pipeline 工具分配给专家。

协作规则：
1. 每个子任务必须自包含——Worker 只能看到你在 task 参数里写的内容，看不到你和用户的对话历史
2. 把相关代码、数据、约束条件直接复制进 task 描述里
3. 先规划（输出拆解思路），再逐步派发，最后聚合结果
4. 简单任务直接回答，不要为了用工具而用工具

可用专家：
- coder：代码实现   - reviewer：代码审查   - writer：文档注释
- skeptic：风险分析 - optimizer：性能优化
```

---

## 7. 工作区隔离（Workspace Isolation）

> 如果让所有 Agent 共享同一个工作区，系统会迅速崩溃。

### 7.1 为什么必须隔离

**文件覆写冲突**

```
共享工作区（危险）：
  Agent_A（写前端）→ workspace/utils.ts   ← 生成第一版
  Agent_B（写后端）→ workspace/utils.ts   ← 直接覆盖，A 的工作消失

独立工作区（安全）：
  Agent_A → workspace/agents/coder/a1b2c3/utils.ts  ✓
  Agent_B → workspace/agents/coder/d4e5f6/utils.ts  ✓  互不干扰
```

**其他三类隔离需求**：

| 维度 | 共享工作区的风险 | 独立工作区的保障 |
|------|----------------|----------------|
| **安全沙箱** | 恶意/幻觉代码执行 `rm -rf /` 影响宿主机 | 每个 Worker 的文件操作边界检查限定在其目录内 |
| **上下文污染** | Worker 产生的 .tmp/.log 文件误导 Orchestrator 扫描 | 垃圾文件只存在于 Worker 自己的目录，不可见 |
| **依赖冲突** | Agent_A 需要 Python 3.8，Agent_B 需要 Python 3.12 | 各自目录下维护独立的 venv/package.json |

### 7.2 目录结构设计

```
workspace/                           ← 主 Agent 工作区（Orchestrator）
├── agents/
│   ├── coder/                       ← coder Worker 专属根目录（持久）
│   │   ├── a1b2c3/                  ← delegate 调用 #1 的私有工作区（中间文件）
│   │   │   └── jwt_utils_draft.ts
│   │   └── d4e5f6/                  ← delegate 调用 #2 的私有工作区
│   ├── reviewer/
│   └── writer/
├── shared/                          ← 全局交付区（子 Agent 提交最终成果物）
│   ├── a1b2c3/                      ← 与 coder 同一 taskId
│   │   └── jwt_utils.ts             ← deliver 工具写入的最终成果
│   └── d4e5f6/
│       └── security_report.md
└── xclaw.db
```

**两层隔离**：
- **Worker 级**：`workspace/agents/{name}/` — 按角色隔离，每个专家的工作互不干扰
- **任务级**：`workspace/agents/{name}/{taskId}/` — 同一角色并发执行多个任务时不互相覆写

**全局交付区**（`workspace/shared/`）：子 Agent 完成工作后，通过 `deliver` 工具把最终成果写到这里；Orchestrator 只收到文件路径引用，不在 context 里内联大段代码。

### 7.3 实现

```typescript
// agents.ts — registerDefaultWorkers() 创建隔离目录
export function registerDefaultWorkers(providerChain: string[], baseWorkDir: string, mode: string = 'host'): void {
  const agentsBase = path.resolve(baseWorkDir, 'agents');
  if (mode === 'host') fs.mkdirSync(agentsBase, { recursive: true });

  for (const spec of WORKER_SPECS) {
    let workerDir: string | undefined;
    let workspaceSection: string;

    if (mode === 'host') {
      workerDir = path.join(agentsBase, spec.name);  // workspace/agents/coder/
      fs.mkdirSync(workerDir, { recursive: true });
      // 明确区分"中间文件暂存区"和"最终成果交付区"——两者路径不同
      workspaceSection = `\n\n## Workspace
Scratch directory for intermediate files: ${workerDir}
Use this for any work-in-progress files. Final artifacts must be submitted via the deliver tool
to the [Shared delivery dir] path provided in the task header — not to this directory.`;
    } else {
      workspaceSection = `\n\n## Workspace
You run in an isolated KVM sandbox. Use the shell tool for intermediate work in /workspace/.
Submit final artifacts via the deliver tool (provide filename + content).`;
    }

    const fullPrompt = `${spec.prompt}${workspaceSection}

## Tool calls
To call a tool, output ONLY a raw JSON object — no surrounding text:
{"action": "deliver", "path": "<absolute path from [Shared delivery dir]>", "content": "<file content>"}
{"action": "view_file", "path": "<path>"}
{"action": "list_dir", "path": "<path>"}

You will receive a "tool output:" message after each call. Read the result, then continue working.
Never combine a tool call and the final result JSON in the same response — they are separate turns.

## Returning Results
**If the task starts with [Shared delivery dir:]** (called by Orchestrator via delegate):
Output ONLY this JSON — no surrounding text:
{"status":"success"|"error","summary_data":{...},"artifact_pointers":{...}}

Rules:
- summary_data: decisions and metadata only — scores, flags, key findings, assumptions. No large text bodies.
- Any file output (code, documentation, reports, diffs): call deliver first, then put the confirmed path in artifact_pointers.
- artifact_pointers: only paths that deliver confirmed with "delivered: <path>". Never invent a path.
- If nothing was delivered, set artifact_pointers to {}.

**If there is no [Shared delivery dir:] header** (talking directly with a user):
Respond in natural language. Do not output JSON.`;

    workerRegistry.set(
      spec.name,
      new Agent(providerChain, 20, null, null, 0, fullPrompt, workerDir),
    );
  }
}
```

```typescript
// tools.ts — delegate 工具为每次子任务创建独立目录
const taskId = crypto.randomUUID().slice(0, 6);
const subSessionId = `${sessionId}:${workerName}:${taskId}`;

// host 模式：在 Worker 工作区和全局交付区分别创建任务子目录并注入路径
// full 模式：无宿主机路径可注入，deliver 工具从 sessionId 末段推断 taskId
const headers: string[] = [];
const workerDir = worker.agentWorkDir;
if (mode === 'host') {
  if (workerDir) {
    fsSync.mkdirSync(path.join(workerDir, taskId), { recursive: true });
    headers.push(`[Task workspace: ${path.join(workerDir, taskId)}]`);
  }
  const deliveryDir = path.join(sharedDir, taskId);
  fsSync.mkdirSync(deliveryDir, { recursive: true });
  headers.push(`[Shared delivery dir: ${deliveryDir}]`);
}

// 工具调用格式和返回规范已在 Worker system prompt 里定义；此处只注入路径
const taskContent = [...headers, params['task']!].join('\n\n');
```

### 7.4 路径边界执行

xclaw 已有 `canonicalize()` 函数（第 05 节引入）做路径边界检查：

```typescript
// tools.ts — 现有的防护机制
function canonicalize(userPath: string, workDir: string): string {
  const abs = path.resolve(workDir, userPath);
  if (!abs.startsWith(path.resolve(workDir) + path.sep)) {
    throw new Error(`path not allowed: "${abs}" is outside workspace "${workDir}"`);
  }
  return abs;
}
```

加上工作区隔离后，每个 Worker 的 `workDir` 都是它自己的 `workspace/agents/{name}/`，而不是共享的 `workspace/`。这样路径检查就自动把文件操作限定在 Worker 自己的目录里。

> **生产环境**：在 xclaw 架构中，工作区隔离通过目录边界 + system prompt 指引实现。真正的生产系统应在此基础上加 Docker/WASM 容器隔离（每个 Worker 运行在独立容器里，挂载自己的目录），达到进程级别的安全隔离。本系统的沙箱执行（第 05 节）已为 Orchestrator 提供了这一层，可以用同样的机制给 Worker 配置独立 SandboxPool。

---

## 8. 生产环境工程实践

隔离了工作区之后，一套能支撑生产环境的多 Agent 系统还需要以下工程实践。这些原则解决多 Agent 系统最致命的三个痛点：**费用爆炸**、**陷入死循环**、**不可观测性**。

### 8.1 熔断与死循环检测（Circuit Breaker）

LLM 非常容易在遇到 Bug 时进入"报错 → 修复 → 再报错"死循环，几分钟内烧掉大量费用。

xclaw 已有 `maxIterations` 限制单个 Agent 的循环次数（第 01 节），多代理场景需要在此基础上增加子任务级别的限制：

```typescript
// delegate 工具：增加重试上限，防止 Orchestrator 反复向同一 Worker 派发失败任务
const MAX_DELEGATE_ATTEMPTS = 3;
// 在 delegate 工具内记录失败次数，超限直接返回错误而不继续尝试

// 同时，Worker Agent 自身的 maxIterations 设置为较小值
// registerDefaultWorkers 里：new Agent(providerChain, 10, ...)  ← 子 Agent 最多 10 轮
//   而 Orchestrator 可以有更高的 maxIterations（如 30 轮）处理复杂任务
```

**超时机制**：Worker Agent 执行时间超过阈值强制中止。在 `delegate` 工具里用 `Promise.race` 实现：

```typescript
// tools.ts — delegate 工具增加超时
const WORKER_TIMEOUT_MS = 60_000; // 60 秒

const result = await Promise.race([
  worker.handle(msg, () => {}),
  new Promise<string>((_, reject) =>
    setTimeout(() => reject(new Error(`agent "${workerName}" timed out after ${WORKER_TIMEOUT_MS}ms`)), WORKER_TIMEOUT_MS)
  ),
]);
```

### 8.2 子 Agent 结果提交：三种通路

子 Agent 向主代理提交结果，不能"万物皆文件"——按数据体量和结构化程度选择通路：

| 通路 | 机制 | 适用数据 | 示例 |
|------|------|----------|------|
| **结构化内存** | 返回 JSON 对象直接进 Orchestrator context | 轻量、结构清晰（< 2000 chars）| `{"pass": false, "issue": "SQL injection at line 10"}` |
| **全局交付区** | 调用 `deliver` 写文件到 `workspace/shared/`，JSON 里附路径指针 | 大体积、非结构化成果物 | 完整源码、PDF 报告、diff 文件 |
| **消息流** | `onDelta` 实时推送（已有机制）| 需要实时展示的日志/进度 | `[20/100] tests passing...` |

**"万物皆文件"的工程灾难**：如果所有 Worker 不管结果大小都写文件，高并发时磁盘 I/O 成为瓶颈；运行一周后 `workspace/shared/` 里充斥成千上万个临时 JSON 片段；Orchestrator 每次获取简单结果还要多一次工具调用读文件。

xclaw 的解决方案是**双层返回协议**——Workers 统一以结构化 JSON 结束回复：

```json
{
  "status": "success",
  "summary_data": {
    "files_written": ["jwt.ts"],
    "exports": ["signJWT", "verifyJWT"]
  },
  "artifact_pointers": {
    "source_code": "workspace/shared/a1b2c3/jwt.ts"
  }
}
```

Orchestrator 读 `summary_data` 做决策（无文件 I/O），只在需要完整内容时用 `view_file` 按 `artifact_pointers` 里的路径读取。

---

### 8.3 结构化通信契约（Structured Contract）

纯文本在 Agent 间传递是不可靠的——Orchestrator 无法稳定解析 Worker 返回的任意文本。在任务中约定输出格式，由 Orchestrator 在任务描述里明确要求：

```
// Orchestrator 派发 coder 任务时的格式要求（注入到 task 描述末尾）
---
请按以下 JSON 格式返回，不要有其他文字：
{
  "code": "<完整代码>",
  "language": "<编程语言>",
  "dependencies": ["<依赖1>", "<依赖2>"],
  "assumptions": ["<假设1>"]
}
```

工具层对解析失败的情况自动重试或降级：

```typescript
// delegate 工具对返回值尝试 JSON 解析，失败则返回原始文本（降级）
try {
  const parsed = JSON.parse(result);
  return JSON.stringify(parsed, null, 2); // 规范化格式返回给 Orchestrator
} catch {
  return result; // 降级：返回原始文本
}
```

### 8.4 全链路追踪（LLM Observability）

xclaw 第 06 节已有 `traces` 表，记录每个 `session_id` 下的每一步操作。多代理引入了 `parentSessionId` 字段，可以把所有子会话关联到根会话，形成完整调用树：

```
trace 查询：所有关联到 cli 会话的调用链
  cli                        ← Orchestrator 根会话
  └── cli:coder:a1b2c3       ← delegate → coder
  └── cli:coder:d4e5f6       ← delegate → coder（第二次）
  └── cli:reviewer:e7f8g9    ← delegate → reviewer
  └── cli:debate:coder:...   ← debate（并行）
  └── cli:debate:skeptic:... ← debate（并行）
```

生产系统建议接入专业的 LLM 追踪工具（如 Langfuse、Phoenix），为每个根请求分配唯一 `traceId`，记录每个 Agent 的 token 消耗、耗时、完整 prompt/completion，方便做成本分析和性能优化。

### 8.5 上下文防爆炸（Context Explosion）

多 Agent 频繁交互会导致 token 呈指数级增长。核心原则：**Orchestrator context 只存路径引用，不存大段文本**。

xclaw 的双层返回协议（`summary_data` + `artifact_pointers`）从结构上强制执行了这一原则：

```
Worker（coder）完成 JWT 实现后的回复：
{
  "status": "success",
  "summary_data": {
    "files_written": ["jwt.ts"],
    "exports": ["signJWT", "verifyJWT"],
    "dependencies": []
  },
  "artifact_pointers": {
    "source_code": "workspace/shared/a1b2c3/jwt.ts"
  }
}

→ Orchestrator context 增加：约 200 tokens（JSON 摘要）
→ 如果内联完整代码：约 1500 tokens

累计 5 次 delegate → 节省约 6500 tokens（≈ $0.02 on Claude Sonnet）
```

如果 Orchestrator 需要把 Worker A 的输出传给 Worker B（如让 reviewer 审查 coder 的代码），通过 `artifact_pointers` 里的路径传递，而不是复制代码全文：

```typescript
// ✅ 正确：传路径，Worker B 用 view_file 自己读
task: `审查以下文件中的代码，重点关注安全性：
  source: workspace/shared/a1b2c3/jwt.ts
  使用 view_file 工具读取后进行审查。`

// ❌ 错误：把完整代码复制进 task
task: `审查以下代码：\n${全部代码内容}`  // 每次都把代码再进 Orchestrator context 一次
```

### 8.6 单向状态流动（Single Source of Truth）

禁止 Agent 之间通过非结构化"悄悄话"传递核心数据。Orchestrator 负责维护全局状态，子 Agent 只更新分配给自己的字段：

```typescript
// Orchestrator 维护的任务状态（在 context 里以结构化 JSON 存在）
{
  "task": "实现 JWT 认证模块",
  "steps": {
    "code":     { "status": "done",    "output_file": "workspace/agents/coder/a1b2/jwt.ts" },
    "review":   { "status": "done",    "score": 7, "issues": ["缺少算法验证"] },
    "document": { "status": "pending", "output_file": null }
  }
}
// 每次 delegate 完成后，Orchestrator 更新对应 step 的 status 和 output_file
// 不把 Worker 的完整输出塞进 context，只记录引用路径
```

---

## 9. 启动配置

```typescript
// index.ts — 在现有 Agent 初始化后增加多代理注册
import path from 'path';
import { registerDefaultWorkers, workerRegistry } from './agents.ts';
import { initOrchestratorTools } from './tools.ts';

// ── Worker 注册（含工作区隔离）─────────────────────────────────────────────────
// 每个 Worker 在 workspace/agents/{name}/ 下获得独立工作区
registerDefaultWorkers(providerChain, cfg.sandbox.workDir, mode);
log(`[main] workers: ${[...workerRegistry.keys()].join(', ')}`);

// ── 全局交付区（子 Agent 提交最终成果物）────────────────────────────────────────
const sharedDir = path.resolve(cfg.sandbox.workDir, 'shared');
fs.mkdirSync(sharedDir, { recursive: true });
log(`[main] shared delivery dir: ${sharedDir}`);

// ── Orchestrator 工具（deliver / delegate / debate / pipeline）────────────────
// mode 参数决定 host/full 两种路径注入策略
initOrchestratorTools(workerRegistry, sharedDir, mode);

// ── Agent + Gateway ───────────────────────────────────────────────────────────
// Orchestrator Agent 本身不传 systemPromptOverride（使用 buildSystemPrompt() 生成角色 prompt）
const agent = new Agent(providerChain, cfg.agent.maxIterations, db, memoryStore, cfg.memory.topK);

// ── Gateway 集成静态团队（可选）────────────────────────────────────────────────
const teamAgents = new Map([...workerRegistry.entries()]);
const gateway = new Gateway(agent, teamAgents, db);
```

---

## 10. 改动全景

```
第 08 节                              第 09 节

agent.ts                              agent.ts
  constructor(chain, iter,    →         constructor(chain, iter,
    db, memStore, topK)                   db, memStore, topK,
                                          systemPromptOverride?)  ← 新增
  handle() — 不变               →         handle() — 不变

tools.ts                              tools.ts
  registerMemoryTools()      →         registerMemoryTools()（不变）
  registerKBTools()                    registerKBTools()（不变）
  registerBrowserTools()               registerBrowserTools()（不变）
                                       + initOrchestratorTools(registry, sharedDir)
                                             deliver   ← 写文件到 workspace/shared/
                                             delegate  ← 主从：注入双层返回格式
                                             debate    ← 对等：并行多视角
                                             pipeline  ← 流水线：顺序处理

agents.ts（新建）                      workerRegistry: Map<string, Agent>
                                       registerDefaultWorkers(chain, baseWorkDir)
                                         → 每个 Worker 创建 workspace/agents/{name}/
                                         → system prompt 注入工作区路径 + 返回格式规范
                                         → coder / reviewer / writer / skeptic / optimizer

workspace/shared/（新增目录）          全局交付区：子 Agent 通过 deliver 提交最终成果
                                       Orchestrator context 只保留路径引用，不内联大文本

gateway/types.ts                      gateway/types.ts
  ACPMessage                 →         ACPMessage
                                         + caller?: 'user' | 'agent'
                                         + parentSessionId?: string

gateway/router.ts                     gateway/router.ts
  resolveSessionId()         →         resolveSessionId()（不变）
                                       + routeToAgent()  ← 静态团队路由
                                       + routeToAgentByLLM()（可选）

gateway/gateway.ts                    gateway/gateway.ts
  constructor(agent, db)     →         constructor(agent, teamAgents, db)
  dispatch()                            dispatch()
                                          + 静态团队路由优先逻辑

index.ts                              index.ts
  new Agent(...)             →         new Agent(...)（不变）
                                       + registerDefaultWorkers()
                                       + registerOrchestratorTools()
                                       + new Gateway(agent, teamAgents, db)

增加能力：
  主从协作   → Orchestrator 用 delegate 动态拆解任务，Worker 无状态执行
  对等协作   → debate 并行广播，Promise.all 收集多视角回复
  流水线     → pipeline 顺序串联，{{input}} 注入前一步输出
  静态团队   → routeToAgent 按内容路由，Worker 持久会话（记得用户历史）
  子会话追踪 → parentSessionId 关联父子任务，可在 traces 表追踪完整调用链
  角色定制   → systemPromptOverride 让每个 Worker 有专属人设
```

---

## 知识点总结

| 知识点 | 说明 |
|--------|------|
| **单 Agent 瓶颈** | context window 容量限制、专注度被稀释、无法并发执行 |
| **主从模式** | Orchestrator（LLM 推理）动态决定找谁、给什么任务；每次 delegate 创建新 session；Worker 无历史 |
| **静态常驻团队** | Router（规则/LLM）按意图路由；Worker 持久 session；Agent 记得用户上下文 |
| **流水线模式** | 固定顺序；前一步输出通过 `{{input}}` 注入下一步；适合 ETL/文档转换 |
| **对等协作** | `Promise.all` 并行调用多个 Agent；各自独立视角；调用方负责综合结果 |
| **delegate 工具** | 把 Agent 调用封装成工具；Orchestrator 像调用函数一样调用 Worker；隐藏多代理复杂性 |
| **子任务自包含原则** | Worker 只能看到 task 参数里的内容；相关代码/背景必须显式复制进去 |
| **session 隔离** | 主从/流水线/对等：每次调用新 sessionId（无历史）；静态团队：按角色前缀复用 sessionId |
| **systemPromptOverride** | 每个 Worker 有独立的角色 system prompt；Agent 构造时传入；不影响 Orchestrator |
| **caller 字段** | 区分消息来自用户还是另一个 Agent；Worker 可据此调整回复风格 |
| **parentSessionId** | 标记子会话与父会话的归属；traces 表中可追踪完整的任务调用树 |
| **LLM 路由 vs 规则路由** | 规则路由：快速确定，适合明确分类；LLM 路由：灵活准确，适合语义复杂的路由决策 |
| **上下文传递策略** | 全量嵌入（完整但耗 token）/ Orchestrator 提炼（节省但可能丢失）/ 共享记忆（无感知，需提前写入）|
| **工作区隔离** | 每个 Worker 有独立的 `workspace/agents/{name}/` 目录；每次 delegate 再创建 `{taskId}/` 子目录；防止文件覆写冲突 |
| **两层隔离** | Worker 级（按角色，持久）+ 任务级（按 taskId，临时）；同一角色并发执行多任务时互不干扰 |
| **路径边界** | 工作区路径注入 system prompt，LLM 被引导在自己目录内操作；生产环境配合 canonicalize + Docker 沙箱实现强制隔离 |
| **熔断机制** | Worker 的 maxIterations 设置更低（如 10）；delegate 工具加超时（Promise.race + setTimeout）；防止死循环烧费用 |
| **结构化契约** | 在 task 描述末尾约定 JSON 输出格式；Orchestrator 对解析失败降级处理，不让格式问题污染后续流程 |
| **三种提交通路** | 结构化内存（轻量 JSON，零文件 I/O）/ 全局交付区（大文件，路径指针）/ 消息流（实时进度）；按数据体量选择 |
| **双层返回协议** | Worker 统一以 `{status, summary_data, artifact_pointers}` 结束回复；`summary_data` 直接入 context；`artifact_pointers` 只存路径 |
| **deliver 工具** | 只允许写 `workspace/shared/` 内；无需 HITL；Worker 用它提交大体积成果物（源码、报告、diff）|
| **全局交付区** | `workspace/shared/{taskId}/`；多任务共享，按 taskId 隔离；Orchestrator 通过 `view_file` 按需读取 |
| **上下文防爆炸** | 双层协议从结构上强制：Orchestrator context 只保留摘要 + 路径引用；Worker 间传递成果用路径，不复制全文 |
| **单向状态流动** | Orchestrator 维护全局任务状态 JSON；子 Agent 只更新分配字段；禁止 Agent 间私下传递核心数据 |

---

## 试一试

```bash
cd sections/09-multi-agent/nodejs
cp .env.example .env
npm install
npm start
```

**Terminal 2（CLI 客户端）**

```bash
node --env-file=.env src/cli.ts
```

### 验证主从模式（delegate）

```
You: 帮我写一个 Node.js JWT 工具模块，要求：HS256 算法，包含 sign 和 verify 函数，
     写完后做代码审查，最后加上 JSDoc 注释

xclaw: 好的，我来拆解这个任务：
  1. 让 coder 实现 JWT 工具
  2. 让 reviewer 审查代码安全性
  3. 让 writer 补充文档

xclaw uses [delegate]: {"agent":"coder","task":"用 Node.js 实现 JWT 工具模块，要求：\n1. 使用 HS256 算法\n2. 实现 signJWT(payload, secret, expiresIn) 函数\n3. 实现 verifyJWT(token, secret) 函数，返回 payload 或 null\n4. 不使用外部依赖，只用 Node.js 内置 crypto 模块\n请返回完整可运行的代码。"}
→ [coder] const crypto = require('crypto'); function signJWT...

xclaw uses [delegate]: {"agent":"reviewer","task":"审查以下 Node.js JWT 实现，重点关注安全性：\n\n```javascript\n...（代码内容）...\n```\n\n评分 1-10，指出具体问题和修改建议"}
→ [reviewer] 评分 7/10。发现问题：\n1. 未校验算法类型...

xclaw uses [delegate]: {"agent":"writer","task":"为以下 JWT 工具函数补充 JSDoc 注释：\n\n```javascript\n...（代码内容）...\n```"}
→ [writer] /**\n * Signs a JWT token...\n */

xclaw: 以下是完整的 JWT 工具模块（含代码审查意见和文档）：
  ...
```

### 验证对等协作（debate）

```
You: 我在考虑用 Redis 还是 SQLite 来存储用户 session，帮我多角度分析一下

xclaw uses [debate]: {"question":"技术选型对比：Redis vs SQLite 用于存储 Web 用户 session（约 10 万用户，单机部署）。请从你的专业角度给出建议和理由。","agents":"[\"coder\",\"skeptic\",\"optimizer\"]"}

→ [coder]
  推荐 Redis。理由：session 读写频繁，Redis O(1) 操作、内存级速度更适合...

  ---

  [skeptic]
  两者都有陷阱。Redis：单点故障如何处理？宕机后 session 全丢，用户全部强制登出。
  SQLite：高并发写入有锁竞争，10 万用户同时活跃时会成为瓶颈...

  ---

  [optimizer]
  性能角度：Redis 读 ~0.1ms，SQLite 读 ~1ms（有缓存）。
  对于 session 这类热点数据，Redis 的内存命中率优势明显...

xclaw: 综合三方意见，建议：单机 < 5 万并发用 SQLite（零依赖）；超过 5 万或需要高可用则上 Redis...
```

### 验证流水线模式（pipeline）

```
You: 我有一篇英文技术博客，帮我：提取核心观点 → 翻译成中文 → 生成摘要

xclaw uses [pipeline]: {"steps":"[{\"agent\":\"writer\",\"task\":\"从以下英文文章提取 5 个核心观点，每点一行：\n\n<文章内容>\"},{\"agent\":\"writer\",\"task\":\"将以下英文观点列表翻译成中文，保持专业技术术语准确：\n\n{{input}}\"},{\"agent\":\"writer\",\"task\":\"根据以下核心观点，写一段 100 字的中文摘要：\n\n{{input}}\"}]"}
→ Step 1 (writer): 1. LLM agents need persistent memory...
  Step 2 (writer): 1. LLM Agent 需要持久化记忆...
  Step 3 (writer): 本文探讨了构建生产级 LLM Agent 的五个关键要素...

xclaw: 摘要如下：本文探讨了...
```

### 验证静态常驻团队路由

```
You: 帮我看看这段代码有没有 SQL 注入漏洞

  const db = require('./db');

  async function login(req, res) {
    const { username, password } = req.body;
    const sql = "SELECT * FROM users WHERE username = '" + username
              + "' AND password = '" + password + "'";
    const user = await db.run(sql);
    if (user) res.json({ token: generateToken(user) });
    else res.status(401).send('unauthorized');
  }

（Router 检测到关键词"漏洞"，直接路由到 skeptic Agent，不经过 Orchestrator）

[skeptic]: 发现高危漏洞！第 4-5 行直接拼接用户输入到 SQL 查询：
  const sql = "SELECT * FROM users WHERE username = '" + username + "' AND password = '" + password + "'";

  攻击者可将 username 设为 `' OR '1'='1`，密码随意，生成的 SQL 变为：
    SELECT * FROM users WHERE username = '' OR '1'='1' AND password = '...'
  条件恒为真，绕过密码校验直接登录。

  修复方案：使用参数化查询
    const sql = 'SELECT * FROM users WHERE username = ? AND password = ?';
    const user = await db.run(sql, [username, password]);

  评分：2/10（高危）

（注意：这次回复直接来自 skeptic，Orchestrator 未参与）
```