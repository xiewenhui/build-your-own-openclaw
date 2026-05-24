import fs from 'fs';
import { createOpenAIProvider } from './providers/openai.ts';
import { createClaudeProvider } from './providers/claude.ts';
import { registerProvider } from './providers/registry.ts';
import { loadConfig } from './config.ts';
import { CLIConfirmer } from './hitl.ts';
import { SandboxPool } from './cubesandbox.ts';
import { registerToolsForMode } from './tools.ts';
import { Agent } from './agent.ts';
import { Gateway } from './gateway/gateway.ts';
import { createWebAdapter } from './channels/web.ts';
import { createQQAdapter } from './channels/qq.ts';
import { DB } from './db.ts';
import { log } from './logger.ts';

// ── Config ────────────────────────────────────────────────────────────────────
const cfg = loadConfig('xclaw.yaml');
const mode = cfg.sandbox.mode;
log(`[main] sandbox mode: ${mode}`);

// ── Workspace ─────────────────────────────────────────────────────────────────
if (mode === 'host') {
  fs.mkdirSync(cfg.sandbox.workDir, { recursive: true });
  log(`[main] workspace: ${cfg.sandbox.workDir}`);
}

// ── Providers ─────────────────────────────────────────────────────────────────
registerProvider(createOpenAIProvider());
registerProvider(createClaudeProvider());

// ── Sandbox pool (Full Mode only) ─────────────────────────────────────────────
let pool: SandboxPool | null = null;
if (mode === 'full') {
  pool = new SandboxPool();
}

// ── HITL + Tools ──────────────────────────────────────────────────────────────
// stdin is exclusively owned by HITL — no CLI adapter competing for it.
// CLI connects as a WebSocket client via: node --env-file=.env src/cli.ts
const hitl = new CLIConfirmer(cfg.sandbox.hitl.autoApproveReads);
registerToolsForMode(mode, pool, hitl, cfg);

// ── SQLite persistence ────────────────────────────────────────────────────────
const db = new DB(cfg.state.dbPath);
log(`[main] sqlite: ${cfg.state.dbPath}`);

// ── Agent + Gateway ───────────────────────────────────────────────────────────
const providerChain = buildProviderChain();
const agent   = new Agent(providerChain, cfg.agent.maxIterations, db);
const gateway = new Gateway(agent, db);

gateway.register(createWebAdapter());
gateway.register(createQQAdapter());

await gateway.start();
log('[gateway] started');
log('[gateway] CLI: node --env-file=.env src/cli.ts');

// ── Cleanup ───────────────────────────────────────────────────────────────────
process.on('SIGINT', async () => {
  if (pool) await pool.killAll();
  db.close();
  process.exit(0);
});

function buildProviderChain(): string[] {
  const primary  = cfg.agent.providers.primary  || 'claude';
  const fallback = cfg.agent.providers.fallback || 'openai';
  if (!fallback || fallback === primary) return [primary];
  return [primary, fallback];
}
