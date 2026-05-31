# 第 11 节：定时任务与主动触发 (Chronos)

> "从被动响应到主动工作——好的 Agent 不只是等待，它知道什么时候该主动出击。"

## 本节改动全景

相比第 10 节，本节的改动集中在主动触发层，Plugin/Skill 系统与 Agent 主循环**完全不变**：

| 改动点 | 第 10 节 | 第 11 节 |
|--------|---------|---------|
| 触发方式 | 只有用户主动发消息 | + Cron 定时触发 / 系统事件触发 |
| 执行模式 | 单一模式（响应用户）| + CHRONOS MODE（静默自检）|
| 工具集 | plugin 工具 | + `notify`（异常通知工具）|
| 新增文件 | 无 | `src/chronos/engine.ts`、`src/chronos/eventBus.ts`、`config/chronos.json`、`scripts/scan-secrets.js` |
| Agent 构造 | 固定 system prompt | + `isChronos` 标志位，动态切换 CHRONOS MODE |

**这一节的核心设计思想**：把"时间"和"系统事件"也封装成消息发送者——ChronosEngine 以 `caller: 'agent'` 的身份向 Orchestrator 发送消息，Orchestrator 完全不感知"这是用户触发还是定时器触发"，它只是照常执行任务。区别仅在于 system prompt 里多了 CHRONOS MODE 约束。

---

## 整体架构

> 文档是设计蓝图，实际代码在此基础上有所完善（如 cron 表达式解析、isExecuting 竞态保护等）。读代码时以代码为准，文档描述核心骨架。

```
启动时：
  ChronosEngine.loadFromConfig('config/chronos.json')
    └── registerJob({id, expression, taskPrompt, enabled})
          └── scheduleCron(expression) → 计算下次触发时间 → setTimeout 链

每次 Cron 触发：
  ChronosEngine._runJob(config)
    ├── guard: isExecuting → skip（防止任务堆积）
    ├── isExecuting = true
    ├── 构造 ACPMessage {isChronos: true, caller: 'agent', sessionId: 'chronos-{id}-{ts}'}
    ├── agent.handle(msg) with CHRONOS MODE system prompt
    └── isExecuting = false（无论成功失败）

事件驱动触发：
  eventBus.emitEvent({type: 'SYSTEM_ALERT', payload: {...}})
    └── ChronosEngine.handleEvent(event)
          └── 同上 _runJob 流程（session ID 前缀为 'event-{type}-{ts}'）

CHRONOS MODE（system prompt 追加）：
  [CHRONOS MODE] 你在无人值守下自主运行。
  - 一切正常：保持静默，不发送通知
  - 发现异常：立即调用 notify 工具，停止其他操作
  - 硬性限制：最多 ${maxSteps} 次工具调用，超限即停止并汇报
```

两条触发路径的对比：

| | 用户触发（正常模式）| Cron/事件触发（CHRONOS MODE）|
|--|--|--|
| 触发者 | 人类用户 | ChronosEngine（定时器/事件）|
| session ID | `cli` / `web-{uuid}` | `chronos-{jobId}-{ts}` / `event-{type}-{ts}` |
| system prompt | 标准 Orchestrator 提示 | + CHRONOS MODE 追加块 |
| 输出目标 | 用户 terminal / 浏览器 | `notify` 工具（飞书 / QQ / stdout）|
| 执行策略 | 无特殊限制 | 静默优先，异常才告警 |

---

## 为什么需要主动触发

```
【传统 Agent：被动响应】

  用户（主动提问）──> Orchestrator ──> Worker（执行）──> 结果返回给用户

  问题：用户不在线 = 什么都不发生

【增强 Agent：主动工作（本节新增）】

  触发源                          执行层                     输出
  ──────                          ──────                     ────
  [定时事件]  ──> Cron 调度 ──┐
                               ├──> ChronosEngine ──> Orchestrator ──> Worker（执行）
  [系统事件]  ──> Event Bus ──┘         │                                    │
  (Webhook/                         anti-deadloop                           │
   监控系统)                         isExecuting 锁                          ▼
                                    maxSteps 上限              notify 工具（异常时）
                                                                   │
                                                         ┌─────────┴──────────┐
                                                         ▼                    ▼
                                                    飞书卡片告警          QQ 私信推送
```

前 10 节的 xclaw 是纯被动架构——所有事情都等用户开口才开始。对于日常交互这已经足够，但两类场景会让被动架构失效：

```
场景 A — 时间敏感的例行巡检
  需求：每 15 分钟检查一次服务器内存和磁盘，超阈值立即告警
  被动架构：用户记不住，或者人睡觉了，没人发消息
  → 需要定时器主动触发 Agent 执行检查

场景 B — 外部系统事件响应
  需求：监控系统检测到 CPU 飙升，立刻触发 Agent 分析日志并给出建议
  被动架构：监控系统不会打字，无法"发消息"给 Agent
  → 需要事件总线让外部信号驱动 Agent
```

对比两种架构的执行时序：

```
被动架构 — "帮我检查服务器内存"
  凌晨 3:00：内存使用率飙升到 95%
  凌晨 3:00：无人值守，没有用户消息
  早上 9:00：用户上班，看到服务挂了 ← 已经晚了 6 小时

主动架构 — Cron 每 15 分钟检查
  凌晨 3:00：内存使用率飙升到 95%
  凌晨 3:00：Cron 触发 → Agent 检查 → 发现异常 → notify → 飞书告警
  凌晨 3:01：用户收到通知，可以远程处理 ← 1 分钟响应
```

---

## 1. Cron 调度器：ChronosEngine

### 1.1 轻量级 Cron 解析

`node-cron` 是功能完善的外部库，但引入它只为了一个调度功能并不合算。xclaw 实现了一个**零依赖**的 cron 解析器，支持项目所需的核心语法：

```typescript
// src/chronos/engine.ts

// 支持的 cron 表达式语法：
//   *     — 匹配所有值
//   */n   — 每隔 n 个单位触发
//   n     — 精确值匹配
//
// 标准 5 字段格式：分钟 小时 日 月 周
// "*/15 * * * *"  — 每 15 分钟
// "0 1 * * *"     — 每天凌晨 1 点
// "*/1 * * * *"   — 每分钟（调试用）

function matchField(field: string, value: number): boolean {
  if (field === '*') return true;
  if (field.startsWith('*/')) {
    const step = parseInt(field.slice(2), 10);
    return value % step === 0;
  }
  return parseInt(field, 10) === value;
}

function cronMatches(expression: string, date: Date): boolean {
  const [min, hour, dom, month, dow] = expression.split(' ');
  return (
    matchField(min!,   date.getMinutes()) &&
    matchField(hour!,  date.getHours())   &&
    matchField(dom!,   date.getDate())    &&
    matchField(month!, date.getMonth() + 1) &&
    matchField(dow!,   date.getDay())
  );
}

// 计算到下一个匹配分钟的等待时间
function nextTickMs(expression: string): number {
  const now = new Date();
  // 从下一分钟开始搜索（当前分钟内已过）
  const start = new Date(now);
  start.setSeconds(0, 0);
  start.setMinutes(start.getMinutes() + 1);

  for (let i = 0; i < 60 * 24 * 7; i++) {  // 最多搜索一周
    const candidate = new Date(start.getTime() + i * 60_000);
    if (cronMatches(expression, candidate)) {
      return candidate.getTime() - Date.now();
    }
  }
  throw new Error(`no match found for cron expression: ${expression}`);
}

// 递归 setTimeout 实现 cron——每次触发后重新计算下次时间
function scheduleCron(expression: string, fn: () => void): { cancel: () => void } {
  let timer: NodeJS.Timeout | null = null;

  const tick = () => {
    fn();  // 先执行，再安排下次
    const delay = nextTickMs(expression);
    timer = setTimeout(tick, delay);
  };

  const delay = nextTickMs(expression);
  timer = setTimeout(tick, delay);

  return { cancel: () => { if (timer) clearTimeout(timer); } };
}
```

**为什么用递归 setTimeout 而不是 setInterval**：cron 表达式的触发间隔是不均匀的（"每天凌晨 1 点"的间隔正好是 24 小时，但下次触发时间要精确到分钟边界）。`setInterval` 会产生漂移，而递归 `setTimeout` 每次都重新计算到下一个匹配时刻，精度更高。

### 1.2 ChronosEngine 核心逻辑

```typescript
// src/chronos/engine.ts

interface CronJobConfig {
  id: string;
  expression: string;
  taskPrompt: string;
  enabled: boolean;
}

interface JobEntry {
  config: CronJobConfig;
  cancel: (() => void) | null;
  isExecuting: boolean;  // 防止任务堆积的锁
}

export class ChronosEngine {
  private jobs = new Map<string, JobEntry>();
  private providerChain: string[];
  private maxSteps: number;

  constructor(providerChain: string[], maxSteps = 15) {
    this.providerChain = providerChain;
    this.maxSteps      = maxSteps;  // 系统触发任务的步数硬上限
  }

  loadFromConfig(configPath: string): void {
    if (!fs.existsSync(configPath)) {
      log(`[chronos] no config file found at ${configPath}, skipping`);
      return;
    }
    const configs = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as CronJobConfig[];
    for (const config of configs) {
      this.registerJob(config);
    }
  }

  registerJob(config: CronJobConfig): void {
    if (this.jobs.has(config.id)) {
      this.jobs.get(config.id)!.cancel?.();  // 停掉旧的
    }

    const entry: JobEntry = { config, cancel: null, isExecuting: false };
    this.jobs.set(config.id, entry);

    if (!config.enabled) {
      log(`[chronos] job [${config.id}] registered but disabled`);
      return;
    }

    try {
      const { cancel } = scheduleCron(config.expression, () => this._runJob(entry));
      entry.cancel = cancel;
      log(`[chronos] job [${config.id}] scheduled: ${config.expression}`);
    } catch (err: any) {
      log(`[chronos] job [${config.id}] failed to schedule: ${err.message}`);
    }
  }

  // 受锁保护的任务执行 — 上一次未完成则跳过本次
  async _runJob(entry: JobEntry): Promise<void> {
    if (entry.isExecuting) {
      log(`[chronos] job [${entry.config.id}] still running, skipping this tick`);
      return;
    }
    entry.isExecuting = true;
    const jobId = entry.config.id;

    try {
      log(`[chronos] job [${jobId}] triggered`);
      const sessionId = `chronos-${jobId}-${Date.now()}`;
      const msg: ACPMessage = {
        id: crypto.randomUUID(),
        sessionId,
        channel: 'internal',
        content: entry.config.taskPrompt,
        timestamp: Date.now(),
        caller: 'agent',
        isChronos: true,  // 触发 CHRONOS MODE system prompt
      };

      // Chronos Agent 用更低的 maxIterations 上限防止烧费用
      const chronosAgent = new Agent(
        this.providerChain,
        this.maxSteps,
        null,
        null,
        0,
        buildChronosSystemPrompt(this.maxSteps),  // CHRONOS MODE prompt
      );

      const result = await chronosAgent.handle(msg, (token) => {
        process.stdout.write(token);  // 实时输出到 terminal，方便调试
      });
      log(`[chronos] job [${jobId}] completed: ${result.slice(0, 100)}`);
    } catch (err: any) {
      log(`[chronos] job [${jobId}] failed: ${err.message}`);
    } finally {
      entry.isExecuting = false;  // 无论成败都释放锁
    }
  }
  
  // 事件驱动触发（同 _runJob，但 session ID 前缀不同）
  async handleEvent(event: SystemEvent): Promise<void> {
    const sessionId = `event-${event.type.toLowerCase()}-${Date.now()}`;
    const prompt = `[系统事件: ${event.type}]
事件详情：
${JSON.stringify(event.payload, null, 2)}

处理步骤（按顺序执行）：
1. 首先调用 notify 工具发送告警通知，级别 WARNING，标题"系统事件告警"，消息中包含事件类型和详情。
2. 然后分析此事件的可能原因和严重程度。
3. 如果分析结果表明情况严重，再次调用 notify 工具升级为 CRITICAL 级别并附上分析结论。`;

    const msg: ACPMessage = {
      id: crypto.randomUUID(),
      sessionId,
      channel: 'internal',
      content: prompt,
      timestamp: Date.now(),
      caller: 'agent',
      isChronos: true,
    };

    const chronosAgent = new Agent(
      this.providerChain,
      this.maxSteps,
      null, null, 0,
      buildChronosSystemPrompt(this.maxSteps),
    );
    await chronosAgent.handle(msg, (token) => process.stdout.write(token));
  }

  jobIds(): IterableIterator<string> { return this.jobs.keys(); }

  stopAll(): void {
    for (const entry of this.jobs.values()) {
      entry.cancel?.();
    }
    this.jobs.clear();
    log('[chronos] all jobs stopped');
  }
}
```

**为什么每次触发都 `new Agent()`**：`Agent` 类在内存里维护一个 `sessions: Map<string, Message[]>` 存放对话历史。Chronos 任务每次触发都生成新的 `sessionId`（`chronos-{id}-{ts}`），如果复用同一个 Agent 实例，这个 Map 会随着每次触发无限累积旧 session，长期运行即内存泄漏。更根本的是，Chronos 巡检本来就是**无状态**的——每次检查都从零开始，不需要知道上次跑了什么。新建实例保证每次都是干净的上下文，实例本身只是几个字段加一个空 Map，开销可以忽略。

---

## 2. 事件总线：EventBus

事件总线是轻量的 `EventEmitter` 包装器，为外部系统（Webhook、监控 agent、CI）提供统一的注入入口：

```typescript
// src/chronos/eventBus.ts
import { EventEmitter } from 'events';

export interface SystemEvent {
  type: 'CODE_COMMIT' | 'SYSTEM_ALERT' | 'SKILL_ERROR' | string;
  payload: Record<string, any>;
}

class AgentEventBus extends EventEmitter {
  emitEvent(event: SystemEvent): void {
    this.emit(event.type, event.payload);
  }
}

export const eventBus = new AgentEventBus();
```

在 `index.ts` 中把事件总线和 ChronosEngine 挂钩：

```typescript
// index.ts（新增）
import { eventBus } from './chronos/eventBus.ts';

// 示例：系统告警事件 → Chronos 引擎
eventBus.on('SYSTEM_ALERT', (payload) => {
  log(`[event-bus] SYSTEM_ALERT received`);
  chronos.handleEvent({ type: 'SYSTEM_ALERT', payload });
});
```

外部系统通过独立的 Webhook HTTP 服务器注入事件（详见第 8 节）：

```bash
curl -X POST http://localhost:3001/webhook/alert \
  -H "Content-Type: application/json" \
  -d '{"service":"database","error":"connection timeout"}'
```

---

## 3. CHRONOS MODE：系统 Prompt 扩展

当任务由 Cron 或事件触发时，Orchestrator 的 system prompt 末尾追加 CHRONOS MODE 约束块。这个约束块解决了两个关键问题：**避免无效通知**（一切正常时保持静默）和**防止失控执行**（步数硬上限）。

```typescript
// src/agent.ts — 新增

export function buildChronosSystemPrompt(maxSteps: number): string {
  const base = buildSystemPrompt();  // 复用标准 Orchestrator prompt

  return base + `

## [CHRONOS MODE — 系统自动触发]

你现在在**无人值守**的环境下运行。没有人在等待你的回复。

### 执行原则
1. **静默优先**：如果检查结果一切正常，什么都不做，直接结束。不要发送通知，不要输出无意义的确认信息。
2. **异常即告警**：一旦发现真正的异常（资源超阈值、安全漏洞、服务故障），立即调用 \`notify\` 工具。告警后无需继续其他操作，直接结束。
3. **步数硬限制**：最多执行 ${maxSteps} 次工具调用。超出限制时，立即停止并输出一行简短说明（"已达步数上限，任务终止"）。不要循环重试。

### 禁止行为
- 禁止在没有发现异常的情况下调用 \`notify\`
- 禁止进行超出巡检范围的操作（不要修改文件、不要删除数据）
- 禁止向用户询问确认（无人值守，没有人会回答）`;
}
```

**CHRONOS MODE 与普通模式的 system prompt 对比**：

```
普通模式 system prompt（buildSystemPrompt）:
  - 你是 xclaw，一个 AI Orchestrator
  - 通过 delegate/debate/pipeline 工具协调 Worker
  - 工具列表...
  [无特殊约束，回复内容由任务决定]

CHRONOS MODE system prompt（buildChronosSystemPrompt）:
  = 普通 system prompt
  + ## [CHRONOS MODE] 追加块
      - 静默优先：正常 → 什么都不做
      - 异常即告警：用 notify 工具
      - 步数硬上限：超过 maxSteps 强制终止
```

---

## 4. `notify` 工具：异常通知

Agent 在 CHRONOS MODE 下发现异常时，通过 `notify` 工具推送告警。`notify` 支持三种输出模式，按优先级依次检查：

| 优先级 | 渠道 | 触发条件 |
|--------|------|----------|
| 1 | 飞书群机器人 | `FEISHU_WEBHOOK_URL` 已配置 |
| 2 | QQ 私信或群消息 | `QQ_APP_ID` + `QQ_CLIENT_SECRET` + `QQ_NOTIFY_OPENID` 均已配置 |
| 3 | stdout 打印 | 以上均未配置（开发模式降级） |

**飞书 vs QQ 推送的关键区别**：飞书使用群机器人 Webhook（无状态 HTTP POST，无需认证），而 QQ 渠道需要先获取 access_token 再调用消息发送 API——这与 `channels/qq.ts` 里响应用户消息的 token 逻辑完全一致，可以直接复用。

```typescript
// src/tools.ts — registerHostModeTools() 中新增

// QQ token 缓存（与 channels/qq.ts 独立维护，避免跨模块共享可变状态）
let qqTokenCache: { token: string; expiresAt: number } | null = null;

async function getQQNotifyToken(appId: string, secret: string): Promise<string> {
  if (qqTokenCache && Date.now() < qqTokenCache.expiresAt - 60_000) {
    return qqTokenCache.token;
  }
  const res = await fetch('https://bots.qq.com/app/getAppAccessToken', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ appId, clientSecret: secret }),
  });
  const data = await res.json() as { access_token: string; expires_in: number };
  qqTokenCache = { token: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
  return data.access_token;
}

registerTool(
  {
    name: 'notify',
    description: '发送告警通知。仅在主动巡检发现真实异常时调用。正常情况下禁止调用。',
    parameters: {
      type: 'object',
      properties: {
        title:   { type: 'string', description: '告警标题，简洁描述问题' },
        message: { type: 'string', description: '详细说明：异常数据、影响范围、建议操作' },
        level:   { type: 'string', description: 'INFO | WARNING | CRITICAL' },
      },
      required: ['title', 'message', 'level'],
    },
  },
  async (_sessionId, params) => {
    const { title, message, level } = params as { title: string; message: string; level: string };
    const prefix = level === 'CRITICAL' ? '🚨' : level === 'WARNING' ? '⚠️' : 'ℹ️';
    const text = `${prefix} [xclaw 巡检] [${level}] ${title}\n${message}\n时间：${new Date().toLocaleString()}`;

    // ── 优先级 1：飞书 Webhook ────────────────────────────────────────────────
    const feishuUrl = process.env['FEISHU_WEBHOOK_URL'];
    if (feishuUrl) {
      const colorMap: Record<string, string> = { INFO: 'blue', WARNING: 'orange', CRITICAL: 'red' };
      const payload = {
        msg_type: 'interactive',
        card: {
          header: {
            title:    { tag: 'plain_text', content: `[xclaw 巡检] ${title}` },
            template: colorMap[level] ?? 'blue',
          },
          elements: [
            { tag: 'markdown', content: `**级别:** ${level}　**时间:** ${new Date().toLocaleString()}` },
            { tag: 'hr' },
            { tag: 'markdown', content: message },
          ],
        },
      };
      const resp = await fetch(feishuUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!resp.ok) return `error: feishu webhook returned ${resp.status}`;
      return `notified via feishu: [${level}] ${title}`;
    }

    // ── 优先级 2：QQ 主动推送 ─────────────────────────────────────────────────
    // 与 channels/qq.ts 的"被动回复"不同：这里是无触发消息的主动推送（proactive），
    // 目标 openid 和消息类型通过环境变量配置，不依赖 replyCtx。
    const qqAppId  = process.env['QQ_APP_ID'];
    const qqSecret = process.env['QQ_CLIENT_SECRET'];
    const qqOpenid = process.env['QQ_NOTIFY_OPENID'];       // 推送目标（用户或群的 openid）
    const qqType   = process.env['QQ_NOTIFY_TYPE'] ?? 'c2c'; // 'c2c'（私信）或 'group'（群消息）

    if (qqAppId && qqSecret && qqOpenid) {
      try {
        const token = await getQQNotifyToken(qqAppId, qqSecret);
        const API   = 'https://api.sgroup.qq.com';
        const url   = qqType === 'group'
          ? `${API}/v2/groups/${qqOpenid}/messages`
          : `${API}/v2/users/${qqOpenid}/messages`;

        // QQ 主动消息（非回复）：msg_id 留空，msg_seq 用时间戳保证唯一性
        const resp = await fetch(url, {
          method: 'POST',
          headers: { Authorization: `QQBot ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: text, msg_type: 0, msg_seq: Date.now() % 65536 }),
        });
        if (!resp.ok) return `error: QQ notify returned ${resp.status}: ${await resp.text()}`;
        return `notified via qq (${qqType}): [${level}] ${title}`;
      } catch (err: any) {
        return `error: QQ notify failed: ${err.message}`;
      }
    }

    // ── 优先级 3：stdout 降级（开发模式）────────────────────────────────────────
    console.log(`\n${text}\n`);
    return `notified via stdout: [${level}] ${title}`;
  },
);
```

**`notify` 工具加入 ORCHESTRATOR_TOOLS 白名单**：

```typescript
// src/tools.ts
const ORCHESTRATOR_TOOLS = new Set([
  'delegate', 'debate', 'pipeline',
  'view_file', 'list_dir',
  'memory_save', 'memory_search', 'kb_search',
  'shell',
  'notify',  // ← 新增：Orchestrator 在 CHRONOS MODE 下直接调用
]);
```

---

## 5. 任务配置文件

任务列表通过 JSON 配置文件管理，无需修改代码即可增删任务：

```json
// config/chronos.json
[
  {
    "id": "server-health-monitor",
    "expression": "*/15 * * * *",
    "taskPrompt": "检查当前主机状态。使用 shell 工具执行：\n1. 内存检查：node skills/sysinfo/scripts/sysinfo.js memory\n2. 磁盘检查：node skills/sysinfo/scripts/sysinfo.js disk\n\n判断标准：\n- 内存使用率 > 85%：WARNING\n- 磁盘剩余 < 10%：WARNING\n- 两者同时超标：CRITICAL\n\n正常则保持静默。超标则调用 notify 工具。",
    "enabled": false
  },
  {
    "id": "codebase-security-audit",
    "expression": "0 2 * * *",
    "taskPrompt": "使用 shell 工具执行：node scripts/scan-secrets.js\n\n判断规则：\n- 输出第一行是 CLEAN：静默结束，不做任何操作。\n- 输出第一行是 FOUND：立即调用 notify 工具，级别 CRITICAL，消息中列出所有发现的文件和行号（从输出的后续行获取）。",
    "enabled": false
  }
]
```

配置字段说明：

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | string | 任务唯一标识，用于日志和 sessionId 生成 |
| `expression` | string | 标准 5 字段 cron 表达式 |
| `taskPrompt` | string | 直接传给 Orchestrator 的任务描述，应包含判断标准和行动指令 |
| `enabled` | boolean | `false` 时任务被注册但不启动，重启后生效 |

### 5.1 跨平台安全扫描脚本

`codebase-security-audit` 任务使用 `node scripts/scan-secrets.js` 代替 shell 的 `grep` 命令。原因：Windows 的 `cmd /c` 环境没有 `grep`，直接在 taskPrompt 里写 grep 会导致 Agent 反复重试并耗尽 15 步预算，始终无法触发 notify。

`scripts/scan-secrets.js` 用 Node.js `fs` 模块实现跨平台目录扫描，无任何外部依赖：

```javascript
// scripts/scan-secrets.js
// Usage: node scripts/scan-secrets.js [rootDir]
// Output: 第一行 CLEAN 或 FOUND，后续行为 file:line  [pattern-name]

const PATTERNS = [
  { name: 'OpenAI key',        re: /sk-[A-Za-z0-9]{20,}/g },
  { name: 'Anthropic key',     re: /sk-ant-[A-Za-z0-9\-_]{20,}/g },
  { name: 'Private key block', re: /-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/g },
  { name: 'AWS key',           re: /AKIA[0-9A-Z]{16}/g },
  { name: 'Generic secret',    re: /(?:secret|password|passwd|pwd)\s*[:=]\s*["'][^"'\s]{8,}["']/gi },
  { name: 'API key assign',    re: /(?:api[_-]?key|apikey)\s*[:=]\s*["'][^"'\s]{8,}["']/gi },
  { name: 'Bearer token',      re: /Bearer\s+[A-Za-z0-9\-_]{20,}/g },
];
```

taskPrompt 只需一条指令，Agent 读到输出第一行就能决策，不再需要多步 grep 重试：

```
node scripts/scan-secrets.js
↓
CLEAN          → 静默结束
FOUND          → 调用 notify，把后续行列表附上
src/config.ts:12  [OpenAI key]
```

---

## 6. 防死循环设计

主动触发场景下，两类死循环风险必须在工程层面拦截：

### 6.1 任务堆积（时间死循环）

```
风险场景：
  cron 每 1 分钟触发一次
  但 Agent 执行需要 3 分钟
  → 1 分钟时触发任务 A（开始）
  → 2 分钟时触发任务 B（任务 A 还没结束）
  → 3 分钟时触发任务 C（任务 A、B 都没结束）
  → 多个 Agent 实例并发运行，LLM 并发调用暴增

防护机制（isExecuting 锁）：
  → 1 分钟：任务 A 开始，isExecuting = true
  → 2 分钟：检测到 isExecuting，跳过，打印 "still running, skipping"
  → 3 分钟：同上，跳过
  → 4 分钟：任务 A 完成，isExecuting = false
  → 4 分钟 cron 触发：isExecuting = false，任务 B 正常开始
```

```typescript
// engine.ts — _runJob 中的锁保护
async _runJob(entry: JobEntry): Promise<void> {
  if (entry.isExecuting) {
    log(`[chronos] job [${entry.config.id}] still running, skipping this tick`);
    return;  // 直接跳过，不等待
  }
  entry.isExecuting = true;
  try {
    // ... 执行任务
  } finally {
    entry.isExecuting = false;  // finally 确保即使抛错也释放锁
  }
}
```

### 6.2 工具调用死循环（费用死循环）

```
风险场景：
  Agent 在检查磁盘时调用 shell 工具
  shell 返回错误信息
  Agent 尝试"修复"，再次调用 shell
  shell 还是报错
  循环继续，每次循环消耗 ~2000 tokens
  1 小时内：约 60 次循环 × 2000 tokens = 120k tokens

防护机制（maxSteps 硬上限）：
  ChronosEngine 为每个 chronos 任务创建专用 Agent，maxIterations 设为 maxSteps（默认 15）
  标准 Orchestrator maxIterations 是 50
  → chronos 任务最多 15 次工具调用，之后强制停止
```

```typescript
// engine.ts — 创建 Chronos 专用 Agent
const chronosAgent = new Agent(
  this.providerChain,
  this.maxSteps,  // ← 比主 Agent 更严格的上限（默认 15 vs 50）
  null, null, 0,
  buildChronosSystemPrompt(this.maxSteps),
);
```

**两层防护的配合**：

```
外层防护（isExecuting）：防止任务在时间维度上堆积
内层防护（maxSteps）：防止单次任务在工具调用维度上失控
```

---

## 7. ACPMessage 协议扩展

为支持 Chronos 模式的路由判断，`ACPMessage` 新增 `isChronos` 标志位：

```typescript
// gateway/types.ts
export interface ACPMessage {
  id: string;
  sessionId: string;
  channel: string;
  content: string;
  timestamp: number;
  type?: string;
  caller?: 'user' | 'agent';
  parentSessionId?: string;
  isChronos?: boolean;  // ← 新增：标记系统自动触发任务
}
```

虽然 ChronosEngine 目前通过创建独立的 Agent 实例并传入 `systemPromptOverride` 来注入 CHRONOS MODE prompt，`isChronos` 字段保留在协议层是为了未来可以在 Gateway 层统一处理（例如统计系统触发的任务比例、对 chronos session 做特殊的 DB 标记等）。

---

## 8. 启动配置

```typescript
// index.ts — 在现有启动逻辑末尾新增

import * as http from 'http';
import { ChronosEngine } from './chronos/engine.ts';
import { eventBus }      from './chronos/eventBus.ts';

// ── Plugins / Skills 初始化（已有，略）────────────────────────────────────────

// ── Chronos 定时任务引擎 ──────────────────────────────────────────────────────
const providerChainForChronos = buildProviderChain();
const chronos = new ChronosEngine(providerChainForChronos, 15);

chronos.loadFromConfig(path.resolve('config/chronos.json'));
log(`[chronos] active jobs: ${[...chronos.jobIds()].filter(Boolean).join(', ') || 'none'}`);

// ── 事件总线 ──────────────────────────────────────────────────────────────────
eventBus.on('SYSTEM_ALERT', (payload) => {
  log(`[event-bus] SYSTEM_ALERT received`);
  chronos.handleEvent({ type: 'SYSTEM_ALERT', payload });
});

// ── Webhook 服务器（独立端口，在所有监听器注册完毕后再 listen）──────────────────
// 重要：必须在 eventBus.on() 之后才调用 listen()。
// 原因：listen() 之后 Node.js 开始接受连接；如果期间有 await（如 loadPluginsDir），
// 事件循环会处理进来的请求，此时 eventBus 监听器若未注册，emitEvent 发出的事件直接丢失。
const WEBHOOK_PORT = parseInt(process.env['WEBHOOK_PORT'] ?? '3001', 10);
const webhookServer = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/webhook/alert') {
    const secret = process.env['WEBHOOK_SECRET'];
    if (secret && req.headers['authorization'] !== `Bearer ${secret}`) {
      res.writeHead(401).end('unauthorized');
      return;
    }
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try {
        const payload = JSON.parse(body);
        eventBus.emitEvent({ type: 'SYSTEM_ALERT', payload });
        res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"ok":true}');
      } catch {
        res.writeHead(400).end('bad json');
      }
    });
  } else {
    res.writeHead(404).end();
  }
});
await new Promise<void>((resolve) => webhookServer.listen(WEBHOOK_PORT, resolve));
log(`[webhook]  http://localhost:${WEBHOOK_PORT}/webhook/alert`);

// ── Cleanup ───────────────────────────────────────────────────────────────────
process.on('SIGINT', async () => {
  chronos.stopAll();           // ← 清理 cron timer
  webhookServer.close();       // ← 关闭 webhook 服务器
  await stopPluginServices();
  // ...
});
```

**为什么 Webhook 用独立端口，而不是挂在 Web 适配器（端口 3000）上**：Web 适配器使用 `ws` 包的 `WebSocketServer`，它会向 `http.Server` 注入一个 `request` 事件监听器，对所有非 `GET` 请求返回 `405 Method Not Allowed`——这个拦截发生在我们自己的 `createServer` 回调之前，无法通过修改回调绕过。使用独立端口（默认 `3001`，通过 `WEBHOOK_PORT` 配置）的独立 `http.createServer` 完全绕开了这个问题。

**`WEBHOOK_SECRET` 认证**：如果设置了 `WEBHOOK_SECRET` 环境变量，Webhook 接口要求请求头携带 `Authorization: Bearer <secret>`；未设置则无认证（开发模式）。

---

## 9. 改动全景

```
第 10 节                              第 11 节

gateway/types.ts                      gateway/types.ts
  ACPMessage                 →         ACPMessage
  caller?: 'user' | 'agent'             + isChronos?: boolean

tools.ts                              tools.ts
  ORCHESTRATOR_TOOLS         →         ORCHESTRATOR_TOOLS
  （无 notify）                           + 'notify'
                                       registerHostModeTools()
                                         + notify 工具（飞书 Webhook / QQ 主动推送 / stdout 三级降级）

agent.ts                              agent.ts
  buildSystemPrompt()        →         buildSystemPrompt()（不变）
                                       + buildChronosSystemPrompt(maxSteps)
                                           = buildSystemPrompt() + CHRONOS MODE 追加块

src/chronos/（新建）                   2 个文件
                                       engine.ts
                                         CronJobConfig 接口
                                         JobEntry 接口（含 isExecuting 锁）
                                         ChronosEngine 类
                                           loadFromConfig(path)
                                           registerJob(config)
                                           _runJob(entry)     ← isExecuting 防堆积
                                           handleEvent(event) ← 事件驱动触发
                                           stopAll()
                                         scheduleCron(expression, fn)  ← 零依赖 cron
                                         nextTickMs(expression)
                                         cronMatches(expression, date)
                                         matchField(field, value)
                                       eventBus.ts
                                         SystemEvent 接口
                                         AgentEventBus（EventEmitter 包装）
                                         eventBus（单例导出）

config/chronos.json（新建）            任务配置文件（enabled: false 为安全默认值）
                                       server-health-monitor  ← */15 * * * *
                                       codebase-security-audit ← 0 2 * * *（使用 scan-secrets.js）

scripts/scan-secrets.js（新建）        跨平台 Node.js 密钥扫描脚本
                                       替代 grep（Windows cmd 无此命令）
                                       输出：CLEAN 或 FOUND + file:line 列表

index.ts                              index.ts
  process.on('SIGINT')       →         + chronos.stopAll()
                                       + ChronosEngine 初始化
                                       + eventBus 事件监听

增加能力：
  定时触发   → scheduleCron 解析 cron 表达式，递归 setTimeout 精确调度
  事件触发   → eventBus 发布订阅，外部系统通过 emitEvent() 注入
  CHRONOS MODE → buildChronosSystemPrompt 追加静默优先约束
  notify 工具 → 飞书 Webhook 卡片 / QQ 主动推送 / stdout 三级降级，供 CHRONOS MODE 下异常告警
  防堆积锁   → isExecuting per-job 锁，跳过上次未完成的 cron tick
  步数上限   → ChronosEngine 创建 maxSteps=15 的专用 Agent，防费用爆炸
```

---

## 知识点总结

| 知识点 | 说明 |
|--------|------|
| **被动 vs 主动架构** | 被动：等用户消息；主动：时间/事件主动驱动 Agent，适合无人值守的例行检查和突发响应 |
| **零依赖 cron** | `cronMatches` 逐字段匹配，`nextTickMs` 搜索下一个触发时刻，递归 `setTimeout` 替代 `setInterval`——精确且无漂移 |
| **递归 setTimeout vs setInterval** | `setInterval` 有累积漂移；递归 `setTimeout` 每次重新计算下次触发时刻，适合需要对齐到分钟边界的 cron 场景 |
| **isExecuting 锁** | 每个 job 持有一个布尔锁；cron tick 触发时先检查锁，上次未完成则跳过——防止慢任务堆积为并发 LLM 调用 |
| **maxSteps 上限** | Chronos 专用 Agent 使用更低的 maxIterations（默认 15 vs 主 Agent 50）；超限强制终止，防止工具调用死循环烧费用 |
| **CHRONOS MODE** | `buildChronosSystemPrompt` 在标准 prompt 末尾追加约束块：静默优先 + 异常即告警 + 步数硬上限 |
| **静默优先原则** | 无异常时不发送通知——避免通知疲劳，让真正的告警有信号价值 |
| **notify 工具** | 三级降级：飞书 Webhook 卡片（优先）→ QQ 主动推送（`QQ_NOTIFY_OPENID` 配置时）→ stdout 打印（开发模式兜底）|
| **QQ proactive vs reactive** | QQ 频道回复消息依赖 `replyCtx`（有入站 `msg_id`）；CHRONOS MODE 的主动推送无触发消息，直接用 `QQ_NOTIFY_OPENID` 指定目标，`msg_id` 留空——两种路径独立，互不干扰 |
| **QQ token 复用** | `notify` 工具内维护独立的 `qqTokenCache`，与 `channels/qq.ts` 的 `tokenCache` 隔离，避免跨模块共享可变状态 |
| **事件总线** | `EventEmitter` 包装为 `AgentEventBus`，外部系统通过 `emitEvent()` 注入事件；与 ChronosEngine 松耦合 |
| **isChronos 字段** | `ACPMessage` 上的标志位，标记系统触发来源；未来可用于 Gateway 层统计、DB 标记或差异化限流 |
| **独立 Agent 实例** | ChronosEngine 为每次触发 `new Agent()`，而非复用主 Orchestrator 实例。原因双重：①复用实例会导致 `sessions` Map 无限累积旧 sessionId，长期运行内存泄漏；②巡检任务本身无状态，每次都应从干净上下文出发。Agent 实例极轻（几个字段 + 空 Map），new 的开销可以忽略 |
| **finally 释放锁** | `try { ... } finally { entry.isExecuting = false }` 确保任务失败时锁也被释放，避免任务永久卡死 |
| **配置驱动** | `config/chronos.json` 管理任务列表；`enabled: false` 默认禁用，修改配置后重启生效，无需改代码 |
| **两层防护** | 外层（isExecuting）防时间维度堆积；内层（maxSteps）防工具调用维度失控——两者互补，覆盖不同失控路径 |
| **跨平台脚本优于 shell 命令** | taskPrompt 里直接写 `grep` 在 Windows `cmd` 环境下不存在，Agent 会反复重试耗尽步数预算；用 `node scripts/scan-secrets.js` 把平台差异封装进脚本，Agent 只需读第一行输出即可决策 |

---

## 试一试

```bash
cd sections/11-chronos/nodejs
cp .env.example .env
npm install
npm start
```

**Terminal 2（CLI 客户端）**

```bash
node --env-file=.env src/cli.ts
```

### 环境变量说明

`.env` 中与本节相关的配置项：

```bash
# ── 通知渠道（三选一，按优先级依次检查）────────────────────────────────────────

# 优先级 1：飞书群机器人 Webhook（推荐，开箱即用）
# 飞书管理后台 → 群机器人 → 添加机器人 → 复制 Webhook 地址
FEISHU_WEBHOOK_URL=https://open.feishu.cn/open-apis/bot/v2/hook/xxxxx

# 优先级 2：QQ 主动推送（需要已有 QQ Bot 凭证）
# QQ_APP_ID / QQ_CLIENT_SECRET 与 QQ 频道接入共用同一套凭证（见第 04 节）
# QQ_NOTIFY_OPENID：推送目标的 openid（用户私信）或 group_openid（群消息）
# QQ_NOTIFY_TYPE：'c2c'（私信，默认）或 'group'（群消息）
QQ_APP_ID=your_qq_app_id
QQ_CLIENT_SECRET=your_qq_client_secret
QQ_NOTIFY_OPENID=xxxxxxxxxxxxxxxxxxxxxx
QQ_NOTIFY_TYPE=c2c

# 优先级 3：stdout 打印（无需任何配置，开发调试默认降级）
```

> **如何获取 `QQ_NOTIFY_OPENID`**：让目标用户先给 Bot 发一条私信（或在群里 @ Bot），xclaw 收到消息时日志里会打印 `[qq] c2c from <openid>` 或 `[qq] group <group_openid>`，把对应值填入环境变量即可。

---

### 验证 notify 工具（stdout 降级模式）

不配置任何通知渠道，直接测试基础功能：

```
You: 调用 notify 工具，标题"测试告警"，消息"这是一条测试通知"，级别 WARNING

xclaw uses [notify]: {"title":"测试告警","message":"这是一条测试通知","level":"WARNING"}
→ notified via stdout: [WARNING] 测试告警

⚠️ [xclaw 巡检] [WARNING] 测试告警
这是一条测试通知
时间：2026/5/22 14:30:00

xclaw: 已发送 WARNING 级别通知（stdout 模式）。
```

### 验证飞书通知（可选）

在 `.env` 中配置 `FEISHU_WEBHOOK_URL` 后重启，触发 notify：

```
xclaw uses [notify]: {"title":"磁盘空间告警","message":"/ 磁盘使用率 92%，剩余 8GB","level":"WARNING"}
→ notified via feishu: [WARNING] 磁盘空间告警
```

飞书群收到橙色卡片消息，标题 `[xclaw 巡检] 磁盘空间告警`，正文包含级别和时间。

三种级别对应的卡片颜色：
- `INFO` → 蓝色
- `WARNING` → 橙色
- `CRITICAL` → 红色

### 验证 QQ 通知（可选）

**前置步骤**：先让目标用户给 Bot 发一条私信，从日志获取 openid：

```
[qq] c2c from o1ab2c3d4e5f6g7h8i9j0k  ← 复制这个值
```

在 `.env` 中配置后重启：

```bash
QQ_NOTIFY_OPENID=o1ab2c3d4e5f6g7h8i9j0k
QQ_NOTIFY_TYPE=c2c
```

触发 notify：

```
xclaw uses [notify]: {"title":"安全扫描告警","message":"发现硬编码 API Key：workspace/config.ts 第 12 行","level":"CRITICAL"}
→ notified via qq (c2c): [CRITICAL] 安全扫描告警
```

目标用户的 QQ 收到私信：

```
🚨 [xclaw 巡检] [CRITICAL] 安全扫描告警
发现硬编码 API Key：workspace/config.ts 第 12 行
时间：2026/5/22 14:30:00
```

> **QQ 主动消息限制**：QQ 平台对 Bot 主动发消息有频率和权限限制（每日配额）。频繁巡检场景建议用飞书 Webhook，QQ 仅用于高优先级的 CRITICAL 告警。

### 验证 Cron 触发（每分钟模式）

修改 `config/chronos.json`，临时把 `server-health-monitor` 改为每分钟触发并启用：

```json
{
  "id": "server-health-monitor",
  "expression": "*/1 * * * *",
  "taskPrompt": "说一句话：'巡检完成，一切正常'，然后静默结束。",
  "enabled": true
}
```

重启服务，等待约 1 分钟：

```
[chronos] job [server-health-monitor] scheduled: */1 * * * *
[chronos] job [server-health-monitor] triggered
巡检完成，一切正常
[chronos] job [server-health-monitor] completed: 巡检完成，一切正常
```

下一分钟再次自动触发，无需任何用户操作。

### 验证防堆积锁

把 `taskPrompt` 改为需要多步骤的任务（让 Agent 执行超过 1 分钟），用 `*/1` 频率观察锁行为：

```
[chronos] job [server-health-monitor] triggered        ← 第 1 分钟，开始执行
[chronos] job [server-health-monitor] still running, skipping this tick  ← 第 2 分钟，跳过
[chronos] job [server-health-monitor] still running, skipping this tick  ← 第 3 分钟，跳过
[chronos] job [server-health-monitor] completed: ...   ← 执行完毕，锁释放
[chronos] job [server-health-monitor] triggered        ← 第 4 分钟，正常开始
```

### 验证事件驱动触发（Webhook）

服务启动后，用 `curl` 向 Webhook 接口发送告警事件：

```bash
curl -X POST http://localhost:3001/webhook/alert \
  -H "Content-Type: application/json" \
  -d '{"service":"database","error":"connection timeout"}'
```

如果配置了 `WEBHOOK_SECRET`，加上认证头：

```bash
curl -X POST http://localhost:3001/webhook/alert \
  -H "Authorization: Bearer your-secret" \
  -H "Content-Type: application/json" \
  -d '{"service":"database","error":"connection timeout"}'
```

立刻观察日志（Webhook 返回 `{"ok":true}` 后即开始执行）：

```
{"ok":true}

[event-bus] SYSTEM_ALERT received
[chronos] event-driven task triggered for SYSTEM_ALERT

xclaw uses [notify]: {"title":"系统事件告警","message":"收到 SYSTEM_ALERT 事件：service=database, error=connection timeout","level":"WARNING"}
→ notified via qq (c2c): [WARNING] 系统事件告警

xclaw uses [shell]: ...（分析阶段）

xclaw uses [notify]: {"title":"数据库连接超时确认","message":"...分析结论...","level":"CRITICAL"}
→ notified via qq (c2c): [CRITICAL] 数据库连接超时确认
```

Agent 先发第一条 WARNING 通知（立即），再分析，分析后视严重程度发第二条 CRITICAL 升级通知。
