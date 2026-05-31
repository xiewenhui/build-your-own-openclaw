import fs from 'fs';
import path from 'path';
import * as http from 'http';
import { createOpenAIProvider } from './providers/openai.ts';
import { createClaudeProvider } from './providers/claude.ts';
import { registerProvider } from './providers/registry.ts';
import { loadConfig } from './config.ts';
import { CLIConfirmer } from './hitl.ts';
import { SandboxPool } from './cubesandbox.ts';
import { registerToolsForMode, registerBrowserTools, registerMemoryTools, registerKBTools, initOrchestratorTools, toolRegistry } from './tools.ts';
import { BrowserPool } from './browser.ts';
import { Agent } from './agent.ts';
import { Gateway } from './gateway/gateway.ts';
import { createWebAdapter } from './channels/web.ts';
import { createQQAdapter } from './channels/qq.ts';
import { DB } from './db.ts';
import { log } from './logger.ts';
import { createMemoryStore } from './memory.ts';
import { registerDefaultWorkers, workerRegistry } from './agents.ts';
import { loadPluginsDir, stopPluginServices } from './plugins/loader.ts';
import { globalSkillRegistry } from './skills/registry.ts';
import { ChronosEngine } from './chronos/engine.ts';
import { eventBus } from './chronos/eventBus.ts';
import { activeTaskTracker } from './observability/tracker.ts';

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

// ── Browser automation ────────────────────────────────────────────────────────
const browserPool = new BrowserPool(cfg.browser);
await browserPool.init();
registerBrowserTools(browserPool, hitl, cfg);

// ── SQLite persistence ────────────────────────────────────────────────────────
const db = new DB(cfg.state.dbPath);
log(`[main] sqlite: ${cfg.state.dbPath}`);

// ── Memory store ──────────────────────────────────────────────────────────────
const memoryStore = createMemoryStore(cfg);
log(`[main] memory backend: ${cfg.memory.backend}`);
registerMemoryTools(memoryStore);
registerKBTools(memoryStore, cfg);

// ── Multi-agent: Worker 注册 + Orchestrator 工具 ──────────────────────────────
const providerChain = buildProviderChain();
registerDefaultWorkers(providerChain, cfg.sandbox.workDir, mode);
log(`[main] workers: ${[...workerRegistry.keys()].join(', ')}`);

// 全局交付区：子 Agent 提交重量级成果物的共享目录
const sharedDir = path.resolve(cfg.sandbox.workDir, 'shared');
fs.mkdirSync(sharedDir, { recursive: true });
log(`[main] shared delivery dir: ${sharedDir}`);

// Orchestrator 工具（delegate / deliver / debate / pipeline）引用已注册的 workerRegistry
initOrchestratorTools(workerRegistry, sharedDir, mode);

// ── Agent + Gateway ───────────────────────────────────────────────────────────
const agent = new Agent(providerChain, cfg.agent.maxIterations, db, memoryStore, cfg.memory.topK);

// 静态团队：把所有 Worker 传入 Gateway 供路由层使用
const teamAgents = new Map([...workerRegistry.entries()]);
const gateway = new Gateway(agent, teamAgents, db);

gateway.register(createWebAdapter());
gateway.register(createQQAdapter());

await gateway.start();
log('[gateway] started');
log('[gateway] CLI: node --env-file=.env src/cli.ts');

// ── Webhook server (separate port, no ws interference) ────────────────────────
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

// ── Plugins ───────────────────────────────────────────────────────────────────
const pluginsDir = path.resolve('plugins');
await loadPluginsDir(pluginsDir);
log(`[plugins] registered tools: ${[...toolRegistry.keys()].join(', ')}`);

// ── Skills ────────────────────────────────────────────────────────────────────
const skillsDir = path.resolve('skills');
if (fs.existsSync(skillsDir)) {
  globalSkillRegistry.addDir(skillsDir);
  log(`[skills] loaded from ${skillsDir}`);
}

for (const { skill, ok, missing } of globalSkillRegistry.listStatus()) {
  if (ok) {
    log(`[skill] ${skill.frontmatter.name}: ready`);
  } else {
    log(`[skill] ${skill.frontmatter.name}: requires ${missing.join(', ')} — skipping`);
  }
}

// ── Chronos: scheduled + event-driven tasks ───────────────────────────────────
const providerChainForChronos = buildProviderChain();
const chronos = new ChronosEngine(providerChainForChronos, 15);
chronos.loadFromConfig(path.resolve('config/chronos.json'));
const activeJobs = chronos.jobIds().filter(Boolean);
log(`[chronos] active jobs: ${activeJobs.length ? activeJobs.join(', ') : 'none'}`);

eventBus.on('SYSTEM_ALERT', (payload) => {
  log('[event-bus] SYSTEM_ALERT received');
  chronos.handleEvent({ type: 'SYSTEM_ALERT', payload });
});

// ── Start webhook server AFTER all listeners are registered ───────────────────
await new Promise<void>((resolve) => webhookServer.listen(WEBHOOK_PORT, resolve));
log(`[webhook]  http://localhost:${WEBHOOK_PORT}/webhook/alert`);

// ── Cleanup ───────────────────────────────────────────────────────────────────
const handleShutdown = async (signal: string) => {
  log(`[system] signal ${signal} — stopping new triggers`);

  chronos.stopAll();
  webhookServer.close();

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

function buildProviderChain(): string[] {
  const primary  = cfg.agent.providers.primary  || 'claude';
  const fallback = cfg.agent.providers.fallback || 'openai';
  if (!fallback || fallback === primary) return [primary];
  return [primary, fallback];
}
