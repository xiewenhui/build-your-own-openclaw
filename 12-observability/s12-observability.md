# 第 12 节：可观测性与持续评估 (Observability)

> "你无法优化你无法度量的东西。Agent 的黑盒不是宿命，是工程欠债。"

## 本节改动全景

前 11 节让 xclaw 具备了完整的执行能力——从工具调用到多 Agent 协同，再到 Chronos 主动触发。但进入生产环境之前，还有最后一公里需要打通：**黑盒性与不确定性**。

| 改动点 | 第 11 节 | 第 12 节 |
|--------|---------|---------|
| 部署方式 | 直接 `npm start` | + 多阶段 Dockerfile、优雅停机 |
| 可观测性 | 仅 console.log | + Trace 链路、Metrics 指标、结构化日志 |
| 质量保障 | 无 | + 断言驱动 Benchmark 跑分机 |
| 优化闭环 | 无 | + 生产失败 → TestCase 自动回流 |
| 新增文件 | 无 | `src/observability/context.ts`、`metrics.ts`、`tracer.ts`、`test/benchmark/dataset.ts`、`test/benchmark/runner.ts`、`Dockerfile` |

**这一节的核心设计思想**：三件套（Traces + Metrics + Benchmark）形成一个负反馈闭环——生产失败自动转化为新测试用例，每次发版前强制跑分，通过率不达标即阻断部署。

---

## 整体架构

```
可观测性层（横切关注点，零侵入织入）：

  agent.handle(msg)
    └── traceSpan('agent.handle', ...)
          ├── [LLM 调用]    traceSpan('llm.call', {type:'LLM_CALL'})
          │     └── 自动捕获 usage → metrics.record('llm.tokens.*', 'llm.cost.usd')
          ├── [工具调用]    traceSpan('tool.exec', {toolName})
          │     └── 自动记录 latency → metrics.record('tool.exec.latency.ms')
          └── [结构化日志]  每个 span 结束时输出 {log_type:'TRACE', trace_id, span_id, duration_ms}

AsyncLocalStorage（traceStorage）：
  - 无需显式传参，跨所有 async 调用自动传递 traceId + sessionId
  - 一次 agent.handle() 对应一棵完整的 Span 树

Benchmark 引擎（离线评测）：

  ts-node test/benchmark/runner.ts
    ├── 遍历 benchmarkDataset（TestCase 数组）
    ├── 对每个 Case 跑 agent.handle()
    │     ├── 拦截触发的工具名（onToolTriggered hook）
    │     ├── 断言 expectedTools / forbiddenTools / assertResponse
    │     └── 记录耗时和通过状态
    └── 打印通过率报告，通过率 < 100% 时退出码非零（阻断 CI）

持续优化闭环：
  生产失败 ──> Trace 保留完整上下文 ──> 人工确认 ──> 新 TestCase 加入 dataset.ts ──> 下次 CI 强制覆盖
```

---

## 1. 容器化部署

### 1.1 生产级多阶段 Dockerfile

Agent 进程包含长任务（工具执行）、定时器（Chronos）和 SQLite 持久化数据，部署时需要做到：环境隔离、镜像精简、持久化目录挂载。

```dockerfile
# Dockerfile

# ── Stage 1: 安装依赖 ──────────────────────────────────────────────────────────
FROM node:22-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY src ./src
COPY config ./config

# ── Stage 2: 生产运行时（只含生产依赖 + 源码）────────────────────────────────
FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/src ./src
COPY --from=builder /app/config ./config

# 持久化数据目录（SQLite、workspace、logs）
RUN mkdir -p /app/data && chown -R node:node /app/data
VOLUME /app/data
ENV XCLAW_DATA_DIR=/app/data

USER node                     # 非 root 运行，符合最小权限原则
EXPOSE 3000                   # Web 适配器
EXPOSE 3001                   # Webhook 接口

CMD ["node", "--env-file=.env", "src/index.ts"]
```

**注意**：xclaw 使用 Node.js 22 的原生 TypeScript 支持（`--experimental-strip-types`），无需 `tsc` 编译步骤。`runner` 阶段直接复制 `src/` 源码运行，镜像体积约 ~150MB。

### 1.2 进程级优雅停机 (Graceful Shutdown)

当容器因扩缩容、滚动发布收到 `SIGTERM` 时，如果 Agent 正在执行一个 30 秒的外部工具调用，暴力中断会导致工具状态不一致。需要一个"防自残"关闭钩子：

```typescript
// src/observability/tracker.ts — 活跃任务计数器

class ActiveTaskTracker {
  private count = 0;

  enter(): void { this.count++; }
  exit():  void { this.count = Math.max(0, this.count - 1); }
  hasActiveTasks(): boolean { return this.count > 0; }
}

export const activeTaskTracker = new ActiveTaskTracker();
```

```typescript
// src/index.ts — 替换原有 SIGINT handler，同时覆盖 SIGTERM

const handleShutdown = async (signal: string) => {
  log(`[system] signal ${signal} — stopping new triggers`);

  // 1. 停止 Chronos 定时器，不再接收新的 cron / event 触发
  chronos.stopAll();
  webhookServer.close();

  // 2. 等待当前正在执行的 Agent 任务自然结束（最多等 15 秒）
  let retries = 0;
  while (activeTaskTracker.hasActiveTasks() && retries < 10) {
    log(`[system] ${retries + 1}/10 waiting for active tasks to finish...`);
    await new Promise((r) => setTimeout(r, 1500));
    retries++;
  }

  log('[system] clean shutdown');
  await stopPluginServices();
  await browserPool.closeAll().catch(() => {});
  if (pool) await pool.killAll().catch(() => {});
  await memoryStore.close().catch(() => {});
  db.close();
  process.exit(0);
};

process.on('SIGTERM', () => handleShutdown('SIGTERM'));
process.on('SIGINT',  () => handleShutdown('SIGINT'));
```

在 `agent.handle()` 的入口和出口包裹 tracker：

```typescript
// src/agent.ts — handle() 方法入口处

async handle(msg: ACPMessage, onDelta: (token: string) => void): Promise<string> {
  activeTaskTracker.enter();
  try {
    return await this._handleInner(msg, onDelta);
  } finally {
    activeTaskTracker.exit();
  }
}

private async _handleInner(msg: ACPMessage, onDelta: (token: string) => void): Promise<string> {
  // ... 原有逻辑
}
```

**为什么不直接用 `process.on('SIGTERM')` 然后立刻 `process.exit()`**：Agent 的工具调用是异步的，强制退出会在工具的 finally 块之前终止，导致文件写入中断、子进程泄漏、SQLite WAL 未提交等问题。轮询 + 超时是最简单可靠的等待方案。

---

## 2. 可观测性三件套

大模型监控与普通 HTTP 服务不同：我们不只关心状态码，更关心**首字延迟（TTFT）**、**Token 吞吐量**、**单次任务资金消耗**，以及 Thought → Action → Observation 链条里的**耗时瓶颈**。

### 2.1 调用链追踪：AsyncLocalStorage

Node.js 原生的 `AsyncLocalStorage` 能在不传递显式参数的前提下，跨所有 async 调用追踪同一个 `traceId`——就像 Java 的 `ThreadLocal`，但适用于异步回调链。

```typescript
// src/observability/context.ts

import { AsyncLocalStorage } from 'async_hooks';

export interface TraceSpan {
  spanId:    string;
  name:      string;
  startTime: number;
  endTime?:  number;
  metadata?: Record<string, unknown>;
}

export interface TraceContext {
  traceId:   string;
  sessionId: string;
  spans:     TraceSpan[];
}

export const traceStorage = new AsyncLocalStorage<TraceContext>();

export function generateId(): string {
  return Math.random().toString(36).slice(2, 15);
}
```

**AsyncLocalStorage 的工作原理**：调用 `traceStorage.run(ctx, fn)` 时，`fn` 及其内部所有 `await` 链（无论多深）都能通过 `traceStorage.getStore()` 读到同一个 `ctx`。Node.js 在创建新的异步资源时自动复制当前存储，无需手动传参。

### 2.2 指标收集器

内存指标收集器，自动计算 P50/P95 延迟，输出结构化 JSON 日志，可直接对接 Promtail → Grafana 或 ELK：

```typescript
// src/observability/metrics.ts

class MetricsCollector {
  private static instance: MetricsCollector;
  private registry = new Map<string, number[]>();

  private constructor() {}

  static getInstance(): MetricsCollector {
    if (!MetricsCollector.instance) {
      MetricsCollector.instance = new MetricsCollector();
    }
    return MetricsCollector.instance;
  }

  record(name: string, value: number, tags: Record<string, string> = {}): void {
    if (!this.registry.has(name)) this.registry.set(name, []);
    this.registry.get(name)!.push(value);

    // 结构化日志——Promtail/Filebeat 可直接解析
    console.log(JSON.stringify({
      log_type:     'METRIC',
      metric_name:  name,
      metric_value: value,
      ...tags,
      timestamp: new Date().toISOString(),
    }));
  }

  percentile(name: string, p: number): number {
    const values = this.registry.get(name) ?? [];
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.ceil((p / 100) * sorted.length) - 1] ?? 0;
  }

  summary(): Record<string, { p50: number; p95: number; count: number }> {
    const out: Record<string, { p50: number; p95: number; count: number }> = {};
    for (const [name, values] of this.registry) {
      out[name] = {
        p50:   this.percentile(name, 50),
        p95:   this.percentile(name, 95),
        count: values.length,
      };
    }
    return out;
  }
}

export const metrics = MetricsCollector.getInstance();
```

### 2.3 埋点包装器 (Tracer Wrapper)

一个高阶函数，把"开始计时 → 执行 → 记录延迟 → 输出 Trace 日志"的切面逻辑封装起来，业务代码零侵入：

```typescript
// src/observability/tracer.ts

import { traceStorage, generateId, type TraceContext } from './context.ts';
import { metrics } from './metrics.ts';

export async function traceSpan<T>(
  spanName: string,
  metadata: Record<string, unknown>,
  fn: () => Promise<T>,
): Promise<T> {
  const store = traceStorage.getStore();

  // 顶层调用：自动初始化 Trace 上下文
  if (!store) {
    const ctx: TraceContext = {
      traceId:   generateId(),
      sessionId: (metadata['sessionId'] as string) ?? 'sys',
      spans:     [],
    };
    return traceStorage.run(ctx, () => traceSpan(spanName, metadata, fn));
  }

  const spanId    = generateId();
  const startTime = Date.now();
  store.spans.push({ spanId, name: spanName, startTime, metadata });

  try {
    const result = await fn();

    // LLM 调用：自动捕获 Token 消耗和资金成本
    if (metadata['type'] === 'LLM_CALL' && result && (result as any).usage) {
      const { prompt_tokens, completion_tokens } = (result as any).usage;
      const model = (metadata['model'] as string) ?? 'unknown';
      metrics.record('llm.tokens.input',  prompt_tokens,    { model });
      metrics.record('llm.tokens.output', completion_tokens, { model });
      // 费率近似：输入 $5/M，输出 $15/M（claude-sonnet-4 参考值）
      const cost = (prompt_tokens * 5 + completion_tokens * 15) / 1_000_000;
      metrics.record('llm.cost.usd', cost, { model });
    }

    return result;
  } catch (error: any) {
    metrics.record('agent.error.count', 1, { spanName, error: error.message });
    throw error;
  } finally {
    const duration = Date.now() - startTime;
    metrics.record(`${spanName}.latency.ms`, duration);

    console.log(JSON.stringify({
      log_type:    'TRACE',
      trace_id:    store.traceId,
      session_id:  store.sessionId,
      span_id:     spanId,
      span_name:   spanName,
      duration_ms: duration,
      ...metadata,
      timestamp: new Date().toISOString(),
    }));
  }
}
```

**接入方式**：在 `agent.ts` 的 LLM 调用处包一层，`streamWithFallback` 返回 `StreamResult`，`result.usage` 即可触发 Token/Cost 指标：

```typescript
// src/agent.ts — LLM 调用处
const result = await traceSpan(
  'llm.call',
  { type: 'LLM_CALL', model: this.providerChain[0], sessionId: msg.sessionId },
  () => streamWithFallback(messages, this.providerChain, onToken),
);
const reply = result.reply;  // StreamResult.reply
// result.usage 由 traceSpan 内部自动消费，无需手动处理
```

> **为什么需要改 `Provider.stream()` 返回值**：原来 `stream()` 返回 `Promise<string>`，tracer 无法从中读到 `usage`。将返回值改为 `Promise<StreamResult>` 后，两个 provider 都在流结束时附上 token 统计：Claude 用 `stream.getFinalMessage().usage`，OpenAI 用 `stream_options: { include_usage: true }` 从最后一个 chunk 读取。

---

## 3. 自动化 Benchmark

修改一行 Prompt 往往会导致原先正常的工具路由走向崩溃，或反复重试耗尽步数预算。因此需要一套包含**工具选择准度**、**数据提取准度**和**死循环免疫度**的测试数据集。

### 3.1 测试用例定义

```typescript
// test/benchmark/dataset.ts

export interface TestCase {
  id:               string;
  category:         'tool_routing' | 'data_extraction' | 'anti_loop';
  inputPrompt:      string;
  expectedTools?:   string[];                        // 必须触发的工具
  forbiddenTools?:  string[];                        // 绝对不能触发的工具
  assertResponse?:  (output: string) => boolean;    // 最终文本断言
  maxSteps:         number;
}

export const benchmarkDataset: TestCase[] = [
  {
    id:            'TC_001_ROUTING',
    category:      'tool_routing',
    inputPrompt:   '帮我检查下服务器目前的内存占用，如果超标了就顺便重启一下。',
    expectedTools: ['shell'],          // 必须先执行检查
    forbiddenTools: ['notify'],        // 没发现异常不该发通知
    maxSteps: 4,
  },
  {
    id:           'TC_002_EXTRACTION',
    category:     'data_extraction',
    inputPrompt:  '从这段日志中找出错误码：[2026-05-23 07:15] CRITICAL ERR_CODE:0xAF921 DB_TIMEOUT',
    assertResponse: (output) => output.includes('0xAF921'),
    maxSteps: 2,
  },
  {
    id:              'TC_003_ANTI_LOOP',
    category:        'anti_loop',
    inputPrompt:     '帮我执行一个肯定会报错的未知系统指令：xclaw_invalid_cmd_xyz',
    forbiddenTools:  [],               // 报错后应汇报而非反复重试
    assertResponse:  (output) => {
      const lower = output.toLowerCase();
      return lower.includes('错误') || lower.includes('失败') || lower.includes('error');
    },
    maxSteps: 4,
  },
];
```

**三类测试的覆盖目标**：

| 类别 | 防御的回归场景 |
|------|--------------|
| `tool_routing` | Prompt 改动导致工具调用顺序错乱（先重启再检查）|
| `data_extraction` | 模型幻觉，捏造不存在的错误码 |
| `anti_loop` | 工具报错后反复重试，耗尽 maxSteps 预算 |

### 3.2 自动化评测运行机

```typescript
// test/benchmark/runner.ts

import { benchmarkDataset, type TestCase } from './dataset.ts';
import { Agent } from '../../src/agent.ts';
import type { ACPMessage } from '../../src/gateway/types.ts';
import { registerProvider } from '../../src/providers/registry.ts';
import { createOpenAIProvider } from '../../src/providers/openai.ts';
import { createClaudeProvider } from '../../src/providers/claude.ts';
import { loadConfig } from '../../src/config.ts';
import { CLIConfirmer } from '../../src/hitl.ts';
import { registerToolsForMode } from '../../src/tools.ts';
import crypto from 'crypto';

// 注册 Provider 和工具，与 index.ts 保持一致
registerProvider(createOpenAIProvider());
registerProvider(createClaudeProvider());

const cfg = loadConfig('xclaw.yaml');
const hitl = new CLIConfirmer(true);  // benchmark 自动确认所有操作
registerToolsForMode(cfg.sandbox.mode, null, hitl, cfg);

function buildProviderChain(): string[] {
  const primary  = cfg.agent.providers.primary  || 'claude';
  const fallback = cfg.agent.providers.fallback || 'openai';
  if (!fallback || fallback === primary) return [primary];
  return [primary, fallback];
}

interface BenchmarkReport {
  testCaseId: string;
  passed:     boolean;
  durationMs: number;
  reason:     string;
  toolsUsed:  string[];
}

export class BenchmarkRunner {
  private providerChain: string[];

  constructor(providerChain = ['claude']) {
    this.providerChain = providerChain;
  }

  async run(): Promise<BenchmarkReport[]> {
    console.log(`\n${'='.repeat(50)}`);
    console.log(`xclaw Benchmark — ${benchmarkDataset.length} test cases`);
    console.log(`${'='.repeat(50)}\n`);

    const reports: BenchmarkReport[] = [];

    for (const tc of benchmarkDataset) {
      reports.push(await this._runCase(tc));
    }

    this._printSummary(reports);
    return reports;
  }

  private async _runCase(tc: TestCase): Promise<BenchmarkReport> {
    const startTime   = Date.now();
    const toolsUsed:  string[] = [];
    let passed = true;
    let reason = 'SUCCESS';

    try {
      // 为每个 Case 创建独立 Agent，隔离 session 状态
      const agent = new Agent(this.providerChain, tc.maxSteps);

      // 注入工具拦截钩子（通过 monkey-patching）
      const previous = (global as any).__toolHook;
      (global as any).__toolHook = (toolName: string) => {
        toolsUsed.push(toolName);
        if (tc.forbiddenTools?.includes(toolName)) {
          passed = false;
          reason = `触犯红线：误触发禁忌工具 [${toolName}]`;
        }
      };

      const msg: ACPMessage = {
        id:        crypto.randomUUID(),
        sessionId: `bench-${tc.id}-${Date.now()}`,
        channel:   'internal',
        content:   tc.inputPrompt,
        timestamp: Date.now(),
      };

      const output = await agent.handle(msg, () => {});  // onDelta 不需要输出
      (global as any).__toolHook = previous;

      // 验证必须触发的工具
      if (passed && tc.expectedTools) {
        for (const expected of tc.expectedTools) {
          if (!toolsUsed.includes(expected)) {
            passed = false;
            reason = `漏配路径：未触发预期工具 [${expected}]`;
          }
        }
      }

      // 验证输出文本断言
      if (passed && tc.assertResponse && !tc.assertResponse(output)) {
        passed = false;
        reason = '断言失败：输出不符合预期规则';
      }
    } catch (err: any) {
      passed = false;
      reason = `运行时崩溃: ${err.message}`;
    }

    const report = { testCaseId: tc.id, passed, durationMs: Date.now() - startTime, reason, toolsUsed };
    const mark = passed ? '✓' : '✗';
    console.log(`[${mark}] ${tc.id} (${report.durationMs}ms) — ${reason}`);
    return report;
  }

  private _printSummary(reports: BenchmarkReport[]): void {
    const passed = reports.filter(r => r.passed).length;
    const rate   = ((passed / reports.length) * 100).toFixed(1);

    console.log(`\n${'='.repeat(50)}`);
    console.log(`通过率: ${passed}/${reports.length} (${rate}%)`);
    console.log(`${'='.repeat(50)}\n`);

    // 非零退出码阻断 CI 流水线
    if (passed < reports.length) process.exit(1);
  }
}

// 直接运行：node --env-file=.env test/benchmark/runner.ts
const runner = new BenchmarkRunner(buildProviderChain());
runner.run();
```

**CI 集成**（GitHub Actions 示例）：

```yaml
# .github/workflows/benchmark.yml
- name: Run xclaw Benchmark
  run: npx tsx test/benchmark/runner.ts
  env:
    ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```

通过率低于 100% 时 `process.exit(1)` 使 CI 步骤失败，阻断合并和部署。

---

## 4. 持续优化闭环

```
【生产环境】                   【分析层】                     【开发/CI 门禁】

发生失败
  ↓
Trace 日志保留完整链路
  trace_id / session_id
  每个 span 的输入输出         提取失败 Payload
  失败时的错误信息         ──>  整理为 TestCase      ──>  加入 dataset.ts
                               {inputPrompt,                    ↓
                                assertResponse,          CI 强制跑分
                                forbiddenTools...}       通过率 < 100%
                                                         阻断部署
线上高成本请求
  ↓
metrics 记录 llm.cost.usd
  ↓
统计 P95 成本 / 耗时瓶颈   ──>  定位高消耗 Prompt   ──>  精简 / 降级模型调优
```

**两条优化路径**：

| 路径 | 触发条件 | 行动 |
|------|---------|------|
| 错题回流 | 生产失败（`agent.error.count` 上升）| Trace 上下文 → 新 TestCase → dataset.ts |
| 成本优化 | P95 `llm.cost.usd` 超阈值 | 定位高消耗 session → Prompt 精简 → 小模型降级 |

---

## 5. 改动全景

```
第 11 节                              第 12 节

src/index.ts                          src/index.ts
  SIGINT handler             →         升级为 handleShutdown(signal)
                                       + activeTaskTracker 轮询等待
                                       + SIGTERM 覆盖

src/agent.ts                          src/agent.ts
  handle(msg)                →         + activeTaskTracker.enter/exit（委托给 _handleInner）
                                       + traceSpan 包裹 LLM 调用和工具调用
                                       + __toolHook?.(action) 供 Benchmark 拦截

src/providers/types.ts                新增 UsageStats、StreamResult 接口
                                       stream() 返回值由 Promise<string>
                                       改为 Promise<StreamResult>

src/providers/claude.ts               stream() 用 getFinalMessage() 附上 usage
src/providers/openai.ts               stream() 用 stream_options.include_usage 附上 usage
src/providers/registry.ts             streamWithFallback 返回 StreamResult

src/observability/（新建）             4 个文件
                                       context.ts
                                         TraceSpan 接口
                                         TraceContext 接口
                                         traceStorage（AsyncLocalStorage 单例）
                                         generateId()
                                       metrics.ts
                                         MetricsCollector（单例）
                                           record(name, value, tags)
                                           percentile(name, p)
                                           summary()
                                         metrics（导出实例）
                                       tracer.ts
                                         traceSpan<T>(spanName, metadata, fn)
                                           ← 自动初始化 Trace 上下文
                                           ← LLM_CALL 自动捕获 Token / Cost
                                           ← finally 输出结构化 TRACE 日志
                                       tracker.ts
                                         ActiveTaskTracker
                                           enter() / exit() / hasActiveTasks()
                                           供优雅停机轮询

test/benchmark/（新建）                2 个文件
                                       dataset.ts
                                         TestCase 接口
                                         benchmarkDataset（3 个初始 Case）
                                       runner.ts
                                         启动时注册 Provider + 工具（与 index.ts 一致）
                                         BenchmarkRunner
                                           run()
                                           _runCase(tc)
                                           _printSummary(reports)
                                         通过率 < 100% 时 process.exit(1)

Dockerfile（新建）                     多阶段构建
                                       builder: 安装依赖 + 复制 src/
                                       runner:  生产依赖 + src/ 直接运行（无 tsc）
                                       node:22-alpine，CMD node --env-file=.env src/index.ts
                                       VOLUME /app/data（SQLite 持久化）

增加能力：
  容器化      → 多阶段 Dockerfile，镜像体积 ~150MB，非 root 运行
  优雅停机    → activeTaskTracker 等待当前任务完成，最多 15 秒
  调用链追踪  → AsyncLocalStorage 无侵入跨异步传播 traceId
  指标收集    → P50/P95 延迟、Token 消耗、LLM 资金成本
  结构化日志  → {log_type:'TRACE'/'METRIC', trace_id, duration_ms} 对接 Grafana/ELK
  Benchmark   → 断言驱动，3 类测试（路由/提取/防死循环），CI 红线阻断
  优化闭环    → 生产失败 → TestCase 回流 → 下次发版强制覆盖
```

---

## 知识点总结

| 知识点 | 说明 |
|--------|------|
| **可观测性三件套** | Traces（调用链）+ Metrics（指标）+ Benchmark（跑分）—— 三者互补：Trace 定位问题，Metrics 量化趋势，Benchmark 防回归 |
| **AsyncLocalStorage** | Node.js 原生异步上下文存储，`traceStorage.run(ctx, fn)` 后 fn 内所有 await 链均可 `getStore()` 读到 ctx，无需显式传参 |
| **结构化日志** | `{log_type, metric_name/span_name, value/duration_ms, timestamp}` 格式，Promtail/Filebeat 直接解析，无需改日志系统 |
| **P95 延迟** | 第 95 百分位延迟——95% 的请求在此时间内完成。比平均值更能反映长尾体验，是 SLA 最常见的基准指标 |
| **Token 成本追踪** | LLM API 返回 `usage.prompt_tokens` + `completion_tokens`，乘以费率即得每次调用的美元成本；P95 成本可定位高消耗会话 |
| **多阶段 Dockerfile** | builder 阶段含 devDeps + tsc；runner 阶段只含生产依赖 + dist/。典型镜像体积降低 5~6 倍，攻击面缩小 |
| **VOLUME 持久化** | SQLite 数据库、workspace 文件、长记忆向量需跨容器重启存活，必须挂载到宿主机 Volume |
| **优雅停机** | SIGTERM → 停止新触发 → 轮询等待活跃任务 → 超时强制退出。避免工具执行中途被杀导致状态损坏 |
| **activeTaskTracker** | 简单计数器，Agent.handle() 入口 enter()，finally exit()。优雅停机时轮询 hasActiveTasks() |
| **断言驱动 Benchmark** | TestCase 包含 expectedTools / forbiddenTools / assertResponse 三种断言，覆盖路由准度、提取准度、防死循环三类回归 |
| **CI 红线阻断** | BenchmarkRunner 通过率 < 100% 时 `process.exit(1)`，使 GitHub Actions / Jenkins 步骤失败，阻断合并和部署 |
| **生产失败回流** | 每次 LLM 幻觉或工具崩溃都由 Trace 保留完整上下文，整理为新 TestCase 加入 dataset.ts，形成错题集负反馈 |
| **traceSpan 高阶函数** | 把"计时 + span 记录 + metrics + 结构化日志"封装为一个包装器，业务代码只需 `traceSpan('name', meta, fn)`，零侵入 |

---

## 试一试

### 本地启动

```bash
cd sections/12-observability/nodejs
cp .env.example .env
npm install
npm start
```

### Docker 构建与运行

```bash
# 构建镜像
docker build -t xclaw:latest .

# 运行（挂载持久化目录，传入 .env）
docker run -d \
  -p 3000:3000 \
  -p 3001:3001 \
  -v $(pwd)/data:/app/data \
  --env-file .env \
  xclaw:latest
```

### 验证结构化日志

启动后发一条消息，观察 stdout 中的 Trace 和 Metric 日志：

```json
{"log_type":"TRACE","trace_id":"k3f2m9x","session_id":"web-abc123","span_id":"p7n1q","span_name":"llm.call","duration_ms":1823,"model":"claude","timestamp":"2026-05-23T10:00:01.234Z"}
{"log_type":"METRIC","metric_name":"llm.tokens.input","metric_value":1240,"model":"claude","timestamp":"2026-05-23T10:00:01.235Z"}
{"log_type":"METRIC","metric_name":"llm.cost.usd","metric_value":0.0000062,"model":"claude","timestamp":"2026-05-23T10:00:01.236Z"}
{"log_type":"METRIC","metric_name":"llm.call.latency.ms","metric_value":1823,"timestamp":"2026-05-23T10:00:01.237Z"}
```

### 运行 Benchmark

```bash
npx tsx test/benchmark/runner.ts
```

输出示例：

```
==================================================
xclaw Benchmark — 3 test cases
==================================================

[✓] TC_001_ROUTING (3241ms) — SUCCESS
[✓] TC_002_EXTRACTION (1876ms) — SUCCESS
[✓] TC_003_ANTI_LOOP (2103ms) — SUCCESS

==================================================
通过率: 3/3 (100.0%)
==================================================
```

某次 Prompt 改动导致回归：

```
[✗] TC_001_ROUTING (2890ms) — 触犯红线：误触发禁忌工具 [notify]

==================================================
通过率: 2/3 (66.7%)
==================================================

# process.exit(1) → CI 步骤失败，阻断部署
```

### 验证优雅停机

服务运行中触发一个长任务，然后发送 SIGTERM：

```bash
# 另一个 terminal 发送信号
kill -SIGTERM <pid>

# 观察日志
[system] signal SIGTERM — stopping new triggers
[system] 1/10 waiting for active tasks to finish...
[system] 2/10 waiting for active tasks to finish...
[system] clean shutdown
```

---

## 🏆 恭喜通关！

至此，你已完成整部教程的全部实战。xclaw 从第 1 节的最简 ReAct 循环，一路演进到现在：

```
第 01 节  ReAct 状态机主循环
第 02 节  工具系统
第 03 节  Provider 注册与 Fallback
第 04 节  实时通信（WebSocket / QQ 频道）
第 05 节  沙盒执行隔离
第 06 节  状态持久化（SQLite）
第 07 节  浏览器自动化
第 08 节  长短期记忆与 RAG
第 09 节  多 Agent 协同
第 10 节  插件与 Skill 系统
第 11 节  Chronos 主动触发
第 12 节  可观测性与 Benchmark ← 你在这里
```

你没有依赖 LangChain、LlamaIndex 等厚重框架，而是亲手实现了每一层——这意味着你真正理解了每个决策背后的工程取舍，而不只是会调 API。这套代码底座，是你进军更大规模 Agent 系统的起点。
