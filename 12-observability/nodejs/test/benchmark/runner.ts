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

// Register providers before running any benchmarks
registerProvider(createOpenAIProvider());
registerProvider(createClaudeProvider());

// Register tools so the Orchestrator system prompt includes them
const cfg = loadConfig('xclaw.yaml');
const hitl = new CLIConfirmer(true); // auto-approve all reads in benchmark
registerToolsForMode(cfg.sandbox.mode, null, hitl, cfg);

// Use same provider chain as the server
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
      const agent = new Agent(this.providerChain, tc.maxSteps);

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

      const output = await agent.handle(msg, () => {});
      (global as any).__toolHook = previous;

      if (passed && tc.expectedTools) {
        for (const expected of tc.expectedTools) {
          if (!toolsUsed.includes(expected)) {
            passed = false;
            reason = `漏配路径：未触发预期工具 [${expected}]`;
          }
        }
      }

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

    if (passed < reports.length) process.exit(1);
  }
}

const runner = new BenchmarkRunner(buildProviderChain());
runner.run();
