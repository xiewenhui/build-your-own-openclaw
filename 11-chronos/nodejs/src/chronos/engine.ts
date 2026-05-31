import fs from 'fs';
import crypto from 'crypto';
import { Agent, buildChronosSystemPrompt } from '../agent.ts';
import type { ACPMessage } from '../gateway/types.ts';
import { log } from '../logger.ts';
import type { SystemEvent } from './eventBus.ts';

// ── Cron expression parser ───────────────────────────────────────────────────
// Supports: *  */n  n  (5-field: minute hour dom month dow)

function matchField(field: string, value: number): boolean {
  if (field === '*') return true;
  if (field.startsWith('*/')) {
    const step = parseInt(field.slice(2), 10);
    return !isNaN(step) && value % step === 0;
  }
  return parseInt(field, 10) === value;
}

function cronMatches(expression: string, date: Date): boolean {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  const [min, hour, dom, month, dow] = parts;
  return (
    matchField(min!,   date.getMinutes())    &&
    matchField(hour!,  date.getHours())      &&
    matchField(dom!,   date.getDate())       &&
    matchField(month!, date.getMonth() + 1) &&
    matchField(dow!,   date.getDay())
  );
}

// Search forward from the next whole minute for the first matching time.
// Returns milliseconds until that moment.
function nextTickMs(expression: string): number {
  const now = new Date();
  const start = new Date(now);
  start.setSeconds(0, 0);
  start.setMinutes(start.getMinutes() + 1);

  // Search up to 1 week ahead (10080 minutes)
  for (let i = 0; i < 10080; i++) {
    const candidate = new Date(start.getTime() + i * 60_000);
    if (cronMatches(expression, candidate)) {
      return candidate.getTime() - Date.now();
    }
  }
  throw new Error(`no matching time found for cron expression: "${expression}"`);
}

// Recursive setTimeout — avoids setInterval drift by recalculating each tick.
function scheduleCron(expression: string, fn: () => void): { cancel: () => void } {
  let timer: NodeJS.Timeout | null = null;

  const tick = () => {
    fn();
    try {
      const delay = nextTickMs(expression);
      timer = setTimeout(tick, delay);
    } catch (err: any) {
      log(`[chronos] scheduleCron error: ${err.message}`);
    }
  };

  try {
    const delay = nextTickMs(expression);
    timer = setTimeout(tick, delay);
  } catch (err: any) {
    log(`[chronos] scheduleCron initial error: ${err.message}`);
  }

  return { cancel: () => { if (timer) clearTimeout(timer); } };
}

// ── Types ────────────────────────────────────────────────────────────────────

export interface CronJobConfig {
  id: string;
  expression: string;
  taskPrompt: string;
  enabled: boolean;
}

interface JobEntry {
  config: CronJobConfig;
  cancel: (() => void) | null;
  isExecuting: boolean;
}

// ── ChronosEngine ────────────────────────────────────────────────────────────

export class ChronosEngine {
  private jobs = new Map<string, JobEntry>();
  private providerChain: string[];
  private maxSteps: number;

  constructor(providerChain: string[], maxSteps = 15) {
    this.providerChain = providerChain;
    this.maxSteps      = maxSteps;
  }

  loadFromConfig(configPath: string): void {
    if (!fs.existsSync(configPath)) {
      log(`[chronos] config not found at ${configPath}, skipping`);
      return;
    }
    let configs: CronJobConfig[];
    try {
      configs = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as CronJobConfig[];
    } catch (err: any) {
      log(`[chronos] failed to parse config: ${err.message}`);
      return;
    }
    for (const config of configs) {
      this.registerJob(config);
    }
  }

  registerJob(config: CronJobConfig): void {
    // Stop and replace if already registered
    this.jobs.get(config.id)?.cancel?.();

    const entry: JobEntry = { config, cancel: null, isExecuting: false };
    this.jobs.set(config.id, entry);

    if (!config.enabled) {
      log(`[chronos] job [${config.id}] registered (disabled)`);
      return;
    }

    const { cancel } = scheduleCron(config.expression, () => this._runJob(entry));
    entry.cancel = cancel;
    log(`[chronos] job [${config.id}] scheduled: ${config.expression}`);
  }

  async _runJob(entry: JobEntry): Promise<void> {
    // Per-job lock: skip if the previous run hasn't finished yet
    if (entry.isExecuting) {
      log(`[chronos] job [${entry.config.id}] still running, skipping this tick`);
      return;
    }
    entry.isExecuting = true;
    const jobId = entry.config.id;

    try {
      log(`[chronos] job [${jobId}] triggered`);
      const msg = this._buildMsg(`chronos-${jobId}-${Date.now()}`, entry.config.taskPrompt);
      const agent = this._makeAgent();
      const result = await agent.handle(msg, (token) => process.stdout.write(token));
      log(`[chronos] job [${jobId}] completed: ${result.slice(0, 120)}`);
    } catch (err: any) {
      log(`[chronos] job [${jobId}] failed: ${err.message}`);
    } finally {
      entry.isExecuting = false;
    }
  }

  async handleEvent(event: SystemEvent): Promise<void> {
    const sessionId = `event-${event.type.toLowerCase()}-${Date.now()}`;
    log(`[chronos] event-driven task triggered for ${event.type}`);
    const prompt = `[系统事件: ${event.type}]
事件详情：
${JSON.stringify(event.payload, null, 2)}

处理步骤（按顺序执行）：
1. 首先调用 notify 工具发送告警通知，级别 WARNING，标题"系统事件告警"，消息中包含事件类型和详情。
2. 然后分析此事件的可能原因和严重程度。
3. 如果分析结果表明情况严重，再次调用 notify 工具升级为 CRITICAL 级别并附上分析结论。`;
    const msg   = this._buildMsg(sessionId, prompt);
    const agent = this._makeAgent();
    try {
      await agent.handle(msg, (token) => process.stdout.write(token));
    } catch (err: any) {
      log(`[chronos] event task failed: ${err.message}`);
    }
  }

  jobIds(): string[] {
    return [...this.jobs.keys()];
  }

  stopAll(): void {
    for (const entry of this.jobs.values()) {
      entry.cancel?.();
    }
    this.jobs.clear();
    log('[chronos] all jobs stopped');
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private _buildMsg(sessionId: string, content: string): ACPMessage {
    return {
      id: crypto.randomUUID(),
      sessionId,
      channel: 'internal',
      content,
      timestamp: Date.now(),
      caller: 'agent',
      isChronos: true,
    };
  }

  private _makeAgent(): Agent {
    return new Agent(
      this.providerChain,
      this.maxSteps,
      null, null, 0,
      buildChronosSystemPrompt(this.maxSteps),
    );
  }
}
