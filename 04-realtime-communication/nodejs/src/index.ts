import { createOpenAIProvider } from './providers/openai.ts';
import { createClaudeProvider } from './providers/claude.ts';
import { registerProvider } from './providers/registry.ts';
import { Agent } from './agent.ts';
import { Gateway } from './gateway/gateway.ts';
import { createCliAdapter } from './channels/cli.ts';
import { createWebAdapter } from './channels/web.ts';
import { createQQAdapter } from './channels/qq.ts';
import { log } from './logger.ts';

// ── Providers ─────────────────────────────────────────────────────────────────
registerProvider(createOpenAIProvider());
registerProvider(createClaudeProvider());

// ── Agent + Gateway ───────────────────────────────────────────────────────────
const agent   = new Agent();
const gateway = new Gateway(agent);

gateway.register(createCliAdapter());
gateway.register(createWebAdapter());
gateway.register(createQQAdapter());

await gateway.start();
log('[gateway] started');
