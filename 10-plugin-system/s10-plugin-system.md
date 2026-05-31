# 第 10 节：技能发现与插件化 (Plugin System)

> "让 Agent 变聪明有两条路：改代码，或者加文档。Plugin 走代码路，Skill 走文档路。"

## 本节改动全景

相比第 09 节，本节的改动集中在扩展层，Agent 主循环与多代理系统**完全不变**：

| 改动点 | 第 09 节 | 第 10 节 |
|--------|---------|---------|
| 工具注册方式 | 硬编码在 `tools.ts` | + Plugin 动态加载（`plugins/loader.ts`）|
| Agent 行为指导 | 固定 system prompt | + Skill 按需注入（`skills/inject.ts`）|
| 扩展方式 | 修改源码后重启 | 在 `plugins/` 或 `skills/` 目录放文件后重启 |
| 新增文件 | 无 | `src/plugin-sdk/`（3 个文件）+ `src/plugins/loader.ts` + `src/skills/`（3 个文件）|

**这一节的核心设计思想**：把"怎么做"和"做什么"分成两个扩展点——Plugin 告诉 Agent 多了什么工具（代码层），Skill 告诉 Agent 如何用好这些工具（提示层）。两者都在运行时动态发现，不需要改 `tools.ts` 或 `agent.ts`。

---

## 整体架构

> 文档是设计蓝图，实际代码在此基础上有所完善（如 `pluginServices` 生命周期管理、`user-invocable` 过滤、关键词命中阈值等）。读代码时以代码为准，文档描述核心骨架。

```
启动时：
  loadPluginsDir()
    ├── 读取 openclaw.plugin.json（清单）
    ├── dynamic import index.ts → entry.register(api)
    │       api.registerTool() ──→ toolRegistry（Agent 工具列表）
    │       api.registerService() ──→ pluginServices（后台服务）
    └── 注册内嵌 skill 目录 → globalSkillRegistry

  globalSkillRegistry.addDir('skills/')
    └── 扫描每个子目录的 SKILL.md → 解析 frontmatter + body

每次用户消息：
  buildSystemPrompt(userMessage)
    └── buildSkillPromptSection(userMessage)
          └── globalSkillRegistry.resolveForMessage()
                ├── 跳过 user-invocable: false 的 skill
                ├── 检查前置依赖（bins / env）
                └── 关键词集合交集 ≥ 2 命中 → 注入 body 到 system prompt

  注：system prompt 中包含 "CRITICAL RULE"，要求 Orchestrator 遇到 Available Skills 时
  必须直接用 shell tool 执行脚本，不得转交 worker。对应地，shell 已加入
  ORCHESTRATOR_TOOLS 白名单，host 模式下也注册了 host 版 shell tool。
```

两个系统的职责边界：

| | Plugin | Skill |
|--|--|--|
| 作用层 | 代码层（工具注册）| 提示层（prompt 注入）|
| 扩展能力 | 新工具、后台服务 | 最佳实践、操作指南 |
| 触发时机 | 启动时一次性加载 | 每条消息按需匹配 |
| 分发粒度 | 按插件目录 | 按 SKILL.md 文件 |
| 可内嵌 | Plugin 可附带 Skill | Skill 独立存在 |

---

## 为什么需要 Plugin 和 Skill

前 9 节的 xclaw 虽然功能完整，但扩展方式只有一种：改 `tools.ts` 然后重启。这在以下三个场景会产生摩擦：

```
场景 A — 工具越来越多，tools.ts 膨胀
  第 02 节：4 个基础工具
  第 07 节：+8 个浏览器工具
  第 08 节：+4 个记忆/KB 工具
  第 09 节：+4 个多代理工具
  → 一个文件近 1000 行，不同关注点混在一起，难以维护

场景 B — 团队协作：不同人维护不同工具
  Alice 写飞书集成，Bob 写天气查询，Charlie 写数据库工具
  → 如果都改 tools.ts，每次合并都有冲突
  → Plugin 让每人维护独立目录，互不干扰

场景 C — Agent 有工具但不会用
  registerTool 只是把工具放进列表，LLM 只能靠 description 猜参数格式
  → 给 gh CLI 注册一个工具容易，让 Agent 知道该用哪些参数、何时用不容易
  → Skill 的 SKILL.md 是给 LLM 读的"使用手册"，按需注入
```

Plugin 和 Skill 解决的是同一个问题的两面：**可扩展性**。Plugin 扩展系统能做什么，Skill 扩展 Agent 怎么做得好。

---

## 1. Plugin 系统

### 1.1 清单文件：`openclaw.plugin.json`

每个插件目录必须包含清单文件。系统启动时扫描 `plugins/` 目录，只有在清单里声明激活的插件才会被加载：

```json
{
  "id": "feishu-tools",
  "activation": { "onStartup": true },
  "enabledByDefault": true,
  "contracts": {
    "tools": ["feishu_send_message"]
  },
  "skills": ["./skills"],
  "configSchema": {
    "type": "object",
    "properties": {
      "appId":     { "type": "string" },
      "appSecret": { "type": "string" }
    }
  }
}
```

核心字段说明：

| 字段 | 说明 |
|------|------|
| `id` | 插件唯一标识，用于日志和错误信息 |
| `activation.onStartup` | 启动时自动激活 |
| `enabledByDefault` | 无需用户手动开启 |
| `contracts.tools` | 声明注册的工具名——系统可以在不加载代码的情况下知道能力全集 |
| `skills` | 内嵌 skill 目录路径（相对插件目录），随插件一起分发 |
| `configSchema` | 插件配置的 JSON Schema 声明（见下方 TODO 说明）|

> **设计原则**：清单文件是静态声明，不含逻辑。系统读清单做发现和路由；`index.ts` 才做真正的注册。两层分离让系统在不执行代码的情况下了解插件的能力全集。

> **`configSchema` 现状**：`configSchema` 字段目前是预留接口——清单声明了 schema，但 loader 尚未实现从 `config.json` 读取配置并注入 `pluginConfig`。当前插件应通过 `process.env` 直接读取配置（见 feishu-tools 示例）。未来实现方向：loader 读取插件目录下的 `config.json`，用 `configSchema` 做 ajv 校验，再通过 `api.pluginConfig` 传入。

---

### 1.2 plugin-sdk：三个核心文件

```
src/plugin-sdk/
├── types.ts    ← PluginTool / PluginService / PluginApi / PluginEntry 接口
├── define.ts   ← definePluginEntry()，纯标记函数（仅做类型推导）
└── api.ts      ← buildPluginApi()，连接 toolRegistry + 管理 service 生命周期
```

#### `types.ts`：四个接口

```typescript
// src/plugin-sdk/types.ts

// 一个可被 Agent 调用的工具
export interface PluginTool {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required?: string[];
  };
  execute(
    sessionId: string,
    params: Record<string, string>,
    onDelta?: (token: string) => void,
  ): Promise<string>;
}

// 可选的后台服务，有 start/stop 生命周期
export interface PluginService {
  id: string;
  start?(): Promise<void>;
  stop?(): Promise<void>;
}

// 传入 register() 的注册句柄
export interface PluginApi {
  registerTool(tool: PluginTool): void;
  registerService(svc: PluginService): void;
  pluginConfig?: unknown; // TODO: 待实现，见清单字段说明
}

// 插件 index.ts 的默认导出结构
export interface PluginEntry {
  id: string;
  name: string;
  description: string;
  register(api: PluginApi): void | Promise<void>;
}
```

#### `api.ts`：连接 toolRegistry

`buildPluginApi()` 是粘合层：把插件的 `PluginTool` 直接写入全局 `toolRegistry`，把 `PluginService` 追加到 loader 持有的 services 列表：

```typescript
// src/plugin-sdk/api.ts
export function buildPluginApi(opts: {
  id: string;
  pluginDir: string;
  services: PluginService[];
  pluginConfig?: unknown;
}): PluginApi {
  return {
    pluginConfig: opts.pluginConfig,

    registerTool(tool) {
      toolRegistry.set(tool.name, {
        definition: { name: tool.name, description: tool.description, parameters: tool.parameters as any },
        execute: tool.execute,
      });
      log(`[plugin:${opts.id}] registered tool: ${tool.name}`);
    },

    registerService(svc) {
      opts.services.push(svc);  // loader 负责调用 start() / stop()
    },
  };
}
```

---

### 1.3 入口文件：`index.ts`

插件通过 `definePluginEntry()` 声明注册逻辑，运行时由 loader 调用 `register(api)`：

```typescript
// plugins/weather/index.ts
import { definePluginEntry } from '../../src/plugin-sdk/define.ts';

export default definePluginEntry({
  id: 'weather',
  name: 'Weather Tool',
  description: 'Provides weather query via wttr.in',

  register(api) {
    api.registerTool({
      name: 'weather_get',
      description: '获取指定城市的当前天气和预报。',
      parameters: {
        type: 'object',
        properties: {
          city:   { type: 'string', description: '城市名或机场代码，如 London、PEK' },
          format: { type: 'string', description: 'brief（单行）或 forecast（3日预报），默认 brief' },
        },
        required: ['city'],
      },
      async execute(_sessionId, params) {
        // 重型依赖在 execute 内懒加载，不阻塞插件注册阶段
        const { spawnSafe } = await import('../../src/tools.ts');
        const fmt  = params['format'] === 'forecast' ? '' : '?format=3';
        const city = encodeURIComponent(params['city'] ?? '');
        return spawnSafe('curl', ['-s', `wttr.in/${city}${fmt}`]);
      },
    });
  },
});
```

**懒加载模式**：所有重型依赖（网络库、SDK、Playwright 等）放在 `execute` 内通过动态 `import()` 加载，保证插件注册阶段快速返回，不拖慢启动。

---

### 1.4 插件加载流程

```typescript
// src/plugins/loader.ts（核心逻辑）

const pluginServices: PluginService[] = [];  // 模块级，跨所有插件共享

export async function loadPluginsDir(dir: string): Promise<void> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const pluginDir  = path.join(dir, entry.name);
    const manifestPath = path.join(pluginDir, 'openclaw.plugin.json');
    if (!fs.existsSync(manifestPath)) continue;

    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    if (!manifest.enabledByDefault && !manifest.activation?.onStartup) continue;

    // SECURITY NOTE: plugin code runs with the same Node.js process permissions as the
    // host — full filesystem, env vars, and network access. For production use, plugins
    // should be executed in a sandboxed worker (vm2, isolated-vm, or a subprocess with
    // restricted capabilities). Sandboxing is omitted here to keep the teaching example simple.
    const mod   = await import(pathToFileURL(path.join(pluginDir, 'index.ts')).href);
    const api   = buildPluginApi({ id: manifest.id, pluginDir, services: pluginServices });

    // 快照 services 长度：只对本插件新注册的 service 调用 start()
    // 如果在 register() 之后对整个数组遍历，会重复启动前面插件的 service
    const lenBefore = pluginServices.length;
    await mod.default.register(api);

    for (const svc of pluginServices.slice(lenBefore)) {
      svc.start?.().catch(e => log(`[plugin:${manifest.id}] service ${svc.id} start error: ${e.message}`));
    }

    // 注册内嵌 skill 目录
    for (const rel of manifest.skills ?? []) {
      globalSkillRegistry.addDir(path.resolve(pluginDir, rel));
    }
  }
}

export async function stopPluginServices(): Promise<void> {
  for (const svc of pluginServices) {
    await svc.stop?.().catch(() => {});
  }
}
```

**`lenBefore` 快照**是关键细节：`pluginServices` 是模块级共享数组，所有插件的 service 都追加进同一个数组。如果 `register()` 之后遍历整个数组调用 `start()`，第二个插件加载时会再次启动第一个插件的 service。用 `slice(lenBefore)` 精确限定"本次新增的 service"。

```
加载顺序示意（pluginServices 状态变化）：
  加载 feishu-tools:
    lenBefore = 0
    register() → services = [feishu-token-svc]
    slice(0)   → 启动 feishu-token-svc ✓

  加载 weather:
    lenBefore = 1                    ← 快照当前长度
    register() → services = [feishu-token-svc, weather-svc]
    slice(1)   → 只启动 weather-svc ✓（不重复启动 feishu-token-svc）
```

---

### 1.5 PluginService：后台服务生命周期

Plugin 不只能注册工具，还可以注册有 `start/stop` 生命周期的后台服务——适合需要长连接、token 缓存、定时刷新的场景：

```typescript
// plugins/feishu-tools/index.ts — 用 service 缓存 tenant token
let cachedToken: string | null = null;
let tokenExpiry = 0;

register(api) {
  api.registerService({
    id: 'feishu-token-cache',
    async start() { /* token 首次获取延迟到工具调用时 */ },
    async stop()  { cachedToken = null; tokenExpiry = 0; },
  });

  api.registerTool({
    name: 'feishu_send_message',
    // ...
    async execute(_sessionId, params) {
      // 复用缓存 token，避免每次调用都打认证接口
      if (!cachedToken || Date.now() >= tokenExpiry) {
        const res  = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ app_id: process.env['FEISHU_APP_ID'], app_secret: process.env['FEISHU_APP_SECRET'] }),
        });
        const data = await res.json() as any;
        if (data.code !== 0) return `error: ${data.msg}`;
        cachedToken  = data.tenant_access_token;
        tokenExpiry  = Date.now() + (data.expire - 60) * 1000; // 提前 60s 刷新
      }
      // ... 发送消息
    },
  });
}
```

`PluginService` 的意义在于和 plugin 生命周期绑定——`stopPluginServices()` 会在进程退出时调用每个 service 的 `stop()`，完成资源清理（关连接、清缓存）。

---

## 2. Skill 系统

### 2.1 SKILL.md 格式

每个 Skill 是一个目录，必须包含 `SKILL.md`，结构为 YAML frontmatter + Markdown 正文：

```markdown
---
name: github
description: "Use gh for GitHub issues, PR status, CI logs, comments, reviews, releases, and API queries."
user-invocable: true
metadata:
  openclaw:
    emoji: "🐙"
    requires:
      bins: ["gh"]
    install:
      - id: brew
        kind: brew
        formula: gh
        bins: ["gh"]
        label: "Install GitHub CLI (brew)"
---

# GitHub Skill

Use the `gh` CLI to interact with GitHub repositories, issues, PRs, and CI.

## Quick Commands

\`\`\`bash
gh pr list --state open
gh pr checks
gh issue view 123
\`\`\`
```

frontmatter 字段说明：

| 字段 | 说明 |
|------|------|
| `name` | Skill 唯一标识 |
| `description` | **最重要字段**：关键词匹配的来源，决定 skill 何时被注入 |
| `user-invocable` | `false` 时跳过自动匹配注入（适合内嵌 skill，由 plugin 工具触发）|
| `requires.bins` | 前置命令依赖，缺失时跳过该 skill |
| `requires.env` | 前置环境变量依赖 |
| `install` | 依赖缺失时的安装建议，供 `/skills` 命令展示 |

> **`description` 是关键**：系统根据 description 做关键词匹配，决定"这条用户消息需要哪些 skill"。写好 description 比写好 body 更重要——它是 skill 的索引键，不是简介。

---

### 2.2 Skill 发现与注入

三个文件各司其职：

```
src/skills/
├── loader.ts    ← 解析 SKILL.md（js-yaml），返回 LoadedSkill 对象
├── registry.ts  ← SkillRegistry：addDir / checkRequirements / resolveForMessage
└── inject.ts    ← buildSkillPromptSection()，含 {baseDir} 替换
```

#### 关键词匹配：`resolveForMessage`

```typescript
// src/skills/registry.ts
resolveForMessage(userMessage: string): LoadedSkill[] {
  // 用集合而非 includes()，确保是完整词匹配，避免子串误命中
  const msgWords = new Set(userMessage.toLowerCase().split(/\W+/).filter(w => w.length > 3));

  return [...this.skills.values()].filter(skill => {
    // user-invocable: false 的 skill 是工具的配套文档，不自动注入
    if (skill.frontmatter['user-invocable'] === false) return false;

    const { ok } = this.checkRequirements(skill);
    if (!ok) return false;

    const keywords = skill.frontmatter.description.toLowerCase().split(/\W+/).filter(w => w.length > 3);
    const hits = keywords.filter(kw => msgWords.has(kw)).length;

    // 要求至少 2 个关键词命中，防止单词偶然匹配触发不相关的 skill
    // 例如用户说"内存优化"不应触发 sysinfo skill（只有 memory 一个词命中）
    return hits >= Math.min(2, keywords.length);
  });
}
```

**为什么要 ≥ 2 命中**：单关键词匹配噪声极高。`sysinfo` skill 的 description 含 `memory`，用户说"帮我优化内存占用"就会被误注入；`github` skill 含 `issues`，用户说"这代码有 issues"也会触发。要求 2 个关键词同时命中，大幅降低误触发率，代价几乎为零：真正需要该 skill 的请求通常会包含多个相关词。

**`user-invocable: false` 过滤**：`feishu-messaging` skill 是 `feishu_send_message` 工具的使用手册，应当在用户需要发消息时由系统自动注入，而不是响应任何关键词匹配——把它设为 `false` 后，`resolveForMessage` 直接跳过它。

#### `{baseDir}` 替换

SKILL.md 正文里用 `{baseDir}` 引用 skill 目录的绝对路径，注入前替换为实际路径，让 Agent 拿到可直接执行的命令：

```typescript
// src/skills/inject.ts
function resolveSkillBody(skill: LoadedSkill): string {
  return skill.body.replaceAll('{baseDir}', skill.dir);
}

export function buildSkillPromptSection(userMessage: string): string {
  const matched = globalSkillRegistry.resolveForMessage(userMessage);
  if (matched.length === 0) return '';

  const bodies = matched
    .map(s => `### ${s.frontmatter.name}\n${resolveSkillBody(s)}`)
    .join('\n\n---\n\n');
  return `\n\n## Available Skills\n\n${bodies}`;
}
```

在 `buildSystemPrompt()` 末尾追加：

```typescript
// src/agent.ts
if (userMessage) {
  prompt += buildSkillPromptSection(userMessage);
}
```

---

### 2.3 Skill 目录结构：三类可选资源

Skill 目录除 `SKILL.md` 外，还可以携带三类资源：

```
skills/sysinfo/
├── SKILL.md
├── scripts/
│   └── sysinfo.js          ← 确定性逻辑，Agent 直接执行，不放进 context
└── references/
    └── proc-fields.md      ← 按需参考文档，Agent 用 view_file 主动读取
```

**`scripts/`**：封装需要精确执行的逻辑。脚本语言不限（Python、Shell、Node.js、Go），也可以是 curl 命令片段。Agent 不把脚本内容放进 context，而是直接执行，节省 token 并避免 LLM 重写出错版本。

**`references/`**：详细参考文档（API 字段说明、CLI 手册）。不自动注入 prompt——Agent 在需要时通过 `view_file {baseDir}/references/xxx.md` 按需读取，避免 context 膨胀。

**`assets/`**：模板、图标等静态文件，由脚本或 Agent 直接引用。

---

### 2.4 三个自由度层次

Skill body 的指令详细程度应匹配任务的约束性需求：

**高自由度（文字指令）**：有多种合理方案，让 LLM 根据上下文判断
```markdown
## PR Review
Review changed files for correctness, security, and test coverage.
Focus on the diff, not the entire codebase.
```

**中自由度（参数化模板）**：有偏好模式，允许少量变体
```markdown
## Completion Notification
When done, send exactly one message:
feishu_send_message receive_id=<id> content='Done: <summary>'
```

**低自由度（具体命令）**：操作有确定性要求，必须保持一致
```markdown
## Weather Query
\`\`\`bash
node {baseDir}/scripts/sysinfo.js cpu
node {baseDir}/scripts/sysinfo.js all
\`\`\`
```

---

## 3. Plugin 内嵌 Skill

Plugin 可以通过 `"skills"` 字段声明内嵌 Skill 目录，工具和文档一起分发：

```
plugins/feishu-tools/
├── openclaw.plugin.json       ← "skills": ["./skills"]
├── index.ts                   ← 注册 feishu_send_message 工具
└── skills/
    └── feishu-messaging/
        └── SKILL.md           ← user-invocable: false，由系统自动注入
```

`feishu-messaging` skill 的 frontmatter 标记 `user-invocable: false`，意思是：它不响应关键词匹配，而是在用户触发 `feishu_send_message` 工具的上下文中被系统注入，提供 receive_id 类型对照表、ID 获取方法等操作指南。

```markdown
---
name: feishu-messaging
description: "Send Feishu messages to users and groups using feishu_send_message tool."
user-invocable: false        ← 跳过关键词匹配，不自动注入
metadata:
  openclaw:
    requires:
      env: ["FEISHU_APP_ID", "FEISHU_APP_SECRET"]
---
```

插件激活时，`loadPluginsDir` 自动将内嵌 skill 目录注册到 `globalSkillRegistry`：

```typescript
for (const rel of manifest.skills ?? []) {
  globalSkillRegistry.addDir(path.resolve(pluginDir, rel));
}
```

---

## 4. 健康检查与降级

前置依赖缺失时不抛错，仅打印警告，系统继续运行，缺依赖的 skill 自动跳过：

```
[plugin:weather] loaded (tools: weather_get)
[plugin:feishu-tools] loaded (tools: feishu_send_message)
[skill] sysinfo: ready
[skill] feishu-messaging: ready
[skill] github: requires bin:gh — skipping
```

`globalSkillRegistry.listStatus()` 返回所有 skill 的可用状态，用于实现 `/skills` 命令。`/skills` 命令在 `agent.ts` 的 `handleCommand()` 中处理，与 `/steps`、`/rollback`、`/fork` 并列为内置斜杠命令：

```
Available skills:
  ✅ sysinfo           — Query CPU, memory, disk, processes
  ✅ feishu-messaging  — Send Feishu messages (auto-injected)
  ❌ github            — requires: bin:gh (brew install gh / apt install gh)
```

---

## 5. 启动配置

```typescript
// src/index.ts — 在 gateway.start() 之后加载 plugin 和 skill
await gateway.start();

// ── Plugins ──────────────────────────────────────────────────────────────
// dynamic import 要求进程已初始化完毕（toolRegistry 已建立），所以在 gateway 后加载
const pluginsDir = path.resolve('plugins');
await loadPluginsDir(pluginsDir);

// ── Skills ────────────────────────────────────────────────────────────────
const skillsDir = path.resolve('skills');
if (fs.existsSync(skillsDir)) {
  globalSkillRegistry.addDir(skillsDir);
}

for (const { skill, ok, missing } of globalSkillRegistry.listStatus()) {
  if (ok) log(`[skill] ${skill.frontmatter.name}: ready`);
  else    log(`[skill] ${skill.frontmatter.name}: requires ${missing.join(', ')} — skipping`);
}

// ── Cleanup ────────────────────────────────────────────────────────────────
process.on('SIGINT', async () => {
  await stopPluginServices();  // 按注册顺序调用所有 service 的 stop()
  // ...
});
```

---

## 6. 改动全景

```
第 09 节                              第 10 节

tools.ts                              tools.ts（两处修改）
  toolRegistry（全局 Map）   →          toolRegistry（被 buildPluginApi 写入）
                                       ORCHESTRATOR_TOOLS + 'shell'（Orchestrator 直接执行 skill 脚本）
                                       registerHostModeTools() + host 模式 shell tool 注册

agent.ts                              agent.ts
  buildSystemPrompt()        →         buildSystemPrompt(mems, kb, userMessage?)
                                         + buildSkillPromptSection(userMessage)

src/plugin-sdk/（新建）               3 个文件
                                       types.ts   ← PluginTool / PluginService / PluginApi / PluginEntry
                                       define.ts  ← definePluginEntry()（标记函数）
                                       api.ts     ← buildPluginApi() → 写入 toolRegistry + services 列表

src/plugins/loader.ts（新建）         loadPluginsDir(dir)
                                         ├── 读 openclaw.plugin.json
                                         ├── dynamic import index.ts
                                         ├── buildPluginApi + entry.register(api)
                                         ├── pluginServices.slice(lenBefore) → start()  ← 防重复启动
                                         └── manifest.skills → globalSkillRegistry.addDir()
                                       stopPluginServices()

src/skills/（新建）                   3 个文件
                                       loader.ts    ← 解析 SKILL.md（js-yaml frontmatter + body）
                                       registry.ts  ← SkillRegistry
                                                        checkRequirements()  ← bins/env 检查
                                                        resolveForMessage()  ← 集合交集 + ≥2 命中阈值
                                                                               + user-invocable 过滤
                                       inject.ts    ← buildSkillPromptSection() + {baseDir} 替换

plugins/（新建示例目录）
  weather/
    openclaw.plugin.json + index.ts   ← weather_get 工具（curl wttr.in）
  feishu-tools/
    openclaw.plugin.json + index.ts   ← feishu_send_message 工具 + token 缓存 service
    skills/feishu-messaging/SKILL.md  ← 内嵌 skill（user-invocable: false）

skills/（新建示例目录）
  github/SKILL.md                     ← requires: bin:gh，git 工作流指南
  sysinfo/SKILL.md + scripts/ + references/  ← {baseDir} 替换 + 捆绑脚本
```

---

## 知识点总结

| 知识点 | 说明 |
|--------|------|
| **Plugin vs Skill 分层** | Plugin 扩展"能做什么"（工具注册），Skill 扩展"怎么做好"（prompt 注入）；职责不重叠 |
| **清单文件** | `openclaw.plugin.json` 是静态声明，不含逻辑；系统靠它做发现和路由，不加载代码 |
| **dynamic import** | `await import(pathToFileURL(...).href)` 在运行时加载插件代码；`pathToFileURL` 处理跨平台路径 |
| **懒加载 execute** | 重型依赖放在 `execute()` 内动态 `import()`，不阻塞插件注册阶段的启动速度 |
| **pluginServices 快照** | `lenBefore = services.length` 在 `register()` 前快照，`slice(lenBefore)` 只启动本插件新增的 service，防止后续插件加载时重复调用前面插件的 `start()` |
| **PluginService 生命周期** | `start()` 在 `register()` 后立即调用；`stop()` 在进程退出时统一调用；适合管理 token 缓存、长连接等需要清理的资源 |
| **pluginConfig 预留** | `configSchema` 声明了插件配置 schema，但 loader 暂未实现从 `config.json` 读取并注入；当前插件通过 `process.env` 读取配置 |
| **Plugin 安全边界** | 插件代码以宿主进程相同权限运行，可访问文件系统、环境变量、网络；教学示例有意简化，生产环境应用 vm2/isolated-vm/subprocess 隔离 |
| **SKILL.md 结构** | YAML frontmatter（元数据 + 依赖声明）+ Markdown body（注入内容）；用 js-yaml 解析 |
| **description 即索引** | `description` 是关键词匹配的唯一来源，写得越准确，skill 触发越精确 |
| **集合交集匹配** | 消息词汇和 description 词汇都先拆成 Set，再取交集；确保是完整词匹配，避免子串误命中 |
| **≥ 2 命中阈值** | 单词偶然匹配（如"memory"触发 sysinfo）误触发率高；要求 2 个词同时命中，在精确度和召回率之间取得平衡 |
| **`user-invocable: false`** | 标记为 `false` 的 skill 跳过关键词匹配，不自动注入；适合随插件工具分发的配套文档 |
| **前置依赖检查** | `checkRequirements()` 检查 `bins` 和 `env`；缺失时降级跳过，不阻塞启动；日志明确提示缺什么 |
| **`{baseDir}` 替换** | Skill body 里用占位符引用自身目录；注入前替换为绝对路径，让 Agent 拿到可直接执行的命令 |
| **捆绑资源** | `scripts/` 放确定性脚本（Agent 直接执行）；`references/` 放详细文档（Agent 按需 `view_file`）；两者都不自动入 context |
| **内嵌 Skill** | Plugin 通过 `"skills"` 字段携带配套 Skill 一起分发；工具和使用文档打包，安装一步到位 |
| **三个自由度层次** | 高自由度（文字指令）/ 中自由度（参数化模板）/ 低自由度（具体命令）；按操作的确定性需求选择 |

---

## 试一试

```bash
cd sections/10-plugin-system/nodejs
cp .env.example .env
npm install
npm start
```

**Terminal 2（CLI 客户端）**

```bash
node --env-file=.env src/cli.ts
```

### 验证 Plugin：天气工具

```
You: 今天天气怎么样？

xclaw uses [weather_get]: {"city": "Beijing"}
→ ⛅️ +20°C ...

xclaw: 北京今天多云，气温 20°C，东北风 3 级。
```

### 验证 Plugin：飞书消息

```
# 先在 .env 配置 FEISHU_APP_ID 和 FEISHU_APP_SECRET

You: 帮我给飞书用户 ou_xxxxxx 发一条消息：部署完成

xclaw uses [feishu_send_message]: {"receive_id":"ou_xxxxxx","content":"部署完成"}
→ ok: message sent (msg_id: om_xxx)
```

### 验证 Skill：系统信息

```
You: show memory usage and disk space

（resolveForMessage 命中 "cpu" + "memory" 两个关键词，注入 sysinfo skill）

xclaw: 我来查询系统资源状态。
xclaw uses [shell]: {"command": "node /path/to/skills/sysinfo/scripts/sysinfo.js all"}
→ {"cpu":{"model":"Apple M2","count":8,"loadAvg1m":1.4},"memory":{"totalMB":16384,"usedPct":68},...}

xclaw: 当前系统状态：CPU 8 核 M2，1 分钟负载 1.4；内存 16GB，已用 68%（约 11GB）。
```

### 验证 Skill 关键词阈值（不应触发）

```
You: 这段代码有内存泄漏的问题，帮我分析一下

（"memory" 命中 sysinfo，但只有 1 个词，未达到阈值 2，不注入——避免把系统监控指南注入到代码分析任务里）

xclaw: 好的，我来分析这段代码的内存泄漏... （直接回答，无 skill 注入）
```

### 查看 Skill 状态

```
You: /skills

Available skills:
  ✅ sysinfo          — Query CPU, memory, disk, processes
  ✅ feishu-messaging — Send Feishu messages (auto-injected)
  ❌ github           — requires: bin:gh (brew install gh)
```
