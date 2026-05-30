import { streamWithFallback } from './providers/registry.ts';
import { toolRegistry, buildToolsPrompt, buildOrchestratorToolsPrompt, extractJSON } from './tools.ts';
import type { Message } from './providers/types.ts';
import type { ACPMessage } from './gateway/types.ts';
import { log } from './logger.ts';
import { DB, expandStepId, shortStepId } from './db.ts';
import type { MemoryStore } from './memory.ts';
import { embed, extractAndSaveMemories } from './memory.ts';
import { getProvider } from './providers/registry.ts';

export class Agent {
  private sessions = new Map<string, Message[]>();
  private providerChain: string[];
  private maxIterations: number;
  private db: DB | null;
  private memoryStore: MemoryStore | null;
  private memoryTopK: number;
  private systemPromptOverride?: string; // 自定义角色 prompt，供 Worker Agent 使用
  private readonly _workDir?: string;     // Worker 专属隔离工作区路径

  constructor(
    providerChain: string[],
    maxIterations: number,
    db: DB | null = null,
    memoryStore: MemoryStore | null = null,
    memoryTopK = 5,
    systemPromptOverride?: string,
    workDir?: string,
  ) {
    this.providerChain = providerChain;
    this.maxIterations = maxIterations;
    this.db = db;
    this.memoryStore = memoryStore;
    this.memoryTopK = memoryTopK;
    this.systemPromptOverride = systemPromptOverride;
    this._workDir = workDir;
  }

  get agentWorkDir(): string | undefined { return this._workDir; }

  // Process one user message; call onDelta for each streamed token.
  async handle(msg: ACPMessage, onDelta: (token: string) => void): Promise<string> {
    // ── Special commands ──────────────────────────────────────────────────────
    if (this.db) {
      const reply = this.handleCommand(msg);
      if (reply !== null) {
        onDelta(reply);
        return reply;
      }
    }

    // ── Load or initialise session ────────────────────────────────────────────
    if (!this.sessions.has(msg.sessionId)) {
      // Cache miss: try to restore from DB (server-restart / reconnect case).
      if (this.db) {
        const status = this.db.getStatus(msg.sessionId);
        if (status !== null) {
          const loaded = this.db.loadMessages(msg.sessionId, this.systemPromptOverride ?? buildSystemPrompt());
          this.sessions.set(msg.sessionId, loaded);
          log(`[agent] [${msg.sessionId}] restored ${loaded.length} messages from DB (status: ${status})`);
        }
      }
      if (!this.sessions.has(msg.sessionId)) {
        this.sessions.set(msg.sessionId, [{ role: 'system', content: this.systemPromptOverride ?? buildSystemPrompt() }]);
      }
    }
    const messages = [...this.sessions.get(msg.sessionId)!];

    // ── Dual-path memory recall (agent memory + KB) ───────────────────────────
    if (this.memoryStore) {
      try {
        const queryEmbedding = await embed(msg.content);
        const [agentMems, kbMems] = await Promise.all([
          this.memoryStore.search(queryEmbedding, this.memoryTopK, { source: 'agent' }),
          this.memoryStore.search(queryEmbedding, Math.max(1, Math.floor(this.memoryTopK / 2)), { source: 'kb' }),
        ]);

        const memLines = agentMems.map((r) => `- ${r.content}`).join('\n');
        const kbLines  = kbMems.map((r, i) => `[${i + 1}] (doc: ${r.docId ?? '?'})\n${r.content}`).join('\n\n');

        // Patch the system prompt in the working copy of messages.
        const sysPrompt = buildSystemPrompt(memLines || undefined, kbLines || undefined);
        if (messages.length > 0 && messages[0]!.role === 'system') {
          messages[0] = { role: 'system', content: sysPrompt };
        } else {
          messages.unshift({ role: 'system', content: sysPrompt });
        }
      } catch (e: any) {
        log(`[agent] memory recall failed (non-fatal): ${e.message}`);
      }
    }

    // ── Persist session + set Running ─────────────────────────────────────────
    if (this.db) {
      this.db.ensureSession(msg.sessionId, 'Session ' + msg.sessionId);
      this.db.setStatus(msg.sessionId, 'Running');
    }

    // ── Record user_input trace ───────────────────────────────────────────────
    let lastStepId = '';
    if (this.db) {
      const sid = this.db.beginTrace(msg.sessionId, '', 'user_input', 'user', msg.content);
      this.db.completeTrace(sid, msg.content);
      lastStepId = sid;
    }

    messages.push({ role: 'user', content: msg.content });

    // ── Agent loop ────────────────────────────────────────────────────────────
    let iterations = 0;
    while (true) {
      if (++iterations > this.maxIterations) {
        const notice = `[xclaw] reached max iterations (${this.maxIterations}), stopping`;
        if (this.db) this.db.setStatus(msg.sessionId, 'Failed');
        log(notice);
        this.sessions.set(msg.sessionId, messages);
        return notice;
      }

      // Begin llm_call trace BEFORE calling the LLM (state-before-action).
      let llmStepId = '';
      if (this.db) {
        llmStepId = this.db.beginTrace(msg.sessionId, lastStepId, 'llm_call', 'llm', null);
      }

      const buffer: string[] = [];
      let reply: string;
      try {
        reply = await streamWithFallback(messages, this.providerChain, (token) => {
          buffer.push(token);
        });
      } catch (err: any) {
        if (this.db && llmStepId) {
          this.db.failTrace(llmStepId, err.message);
          this.db.setStatus(msg.sessionId, 'Failed');
        }
        throw err;
      }

      if (this.db && llmStepId) {
        this.db.completeTrace(llmStepId, reply);
      }
      messages.push({ role: 'assistant', content: reply });
      lastStepId = llmStepId;

      const toolCall = extractJSON(reply);
      if (toolCall && typeof toolCall['action'] === 'string') {
        const action = toolCall['action'];
        const tool = toolRegistry.get(action);
        if (tool) {
          const params: Record<string, string> = {};
          for (const [k, v] of Object.entries(toolCall as Record<string, string>)) {
            if (k !== 'action' && typeof v === 'string') params[k] = v;
          }

          // Begin tool_call trace BEFORE executing (state-before-action).
          let toolStepId = '';
          if (this.db) {
            toolStepId = this.db.beginTrace(msg.sessionId, llmStepId, 'tool_call', action, params);
          }

          log(`[agent] [${msg.sessionId}] [${toolStepId || '-'}] uses [${action}]: ${JSON.stringify(params)}`);
          onDelta(`\n[uses ${action}${Object.keys(params).length ? ': ' + JSON.stringify(params) : ''}]\n`);
          try {
            const output = await tool.execute(msg.sessionId, params, onDelta);
            const logOutput = output.startsWith('data:image/')
              ? `[screenshot ${Math.round(output.length / 1024)}KB]`
              : output.slice(0, 200) + (output.length > 200 ? '…' : '');
            log(output.startsWith('data:image/') ? `[screenshot ${Math.round(output.length / 1024)}KB]` : output);
            onDelta(`→ ${logOutput}\n`);
            if (this.db && toolStepId) this.db.completeTrace(toolStepId, output);
            if (output.startsWith('data:image/')) {
              const rest = output.slice('data:'.length);
              const [header, data] = rest.split(';base64,');
              messages.push({
                role: 'user',
                content: [
                  { type: 'image', source: { type: 'base64', media_type: header, data } },
                  { type: 'text', text: 'tool output:\n[截图已附上] 页面当前状态如上图，请根据截图决定下一步操作。' },
                ],
              });
            } else {
              // Cap each tool output at 12000 chars before storing in history.
              // Prevents a single large HTML response from exhausting the context window.
              const MAX_TOOL_OUTPUT = 12000;
              const capped = output.length > MAX_TOOL_OUTPUT
                ? output.slice(0, MAX_TOOL_OUTPUT) + '\n[输出已截断]'
                : output;
              messages.push({ role: 'user', content: `tool output:\n${capped}` });
            }
          } catch (err: any) {
            const errMsg = err.stderr ?? err.message;
            console.error(`[agent] tool error: ${errMsg}`);
            if (this.db && toolStepId) this.db.failTrace(toolStepId, errMsg);
            messages.push({ role: 'user', content: `tool error:\n${errMsg}` });
          }
          lastStepId = toolStepId || llmStepId;
        } else {
          const available = [...toolRegistry.keys()].join(', ');
          messages.push({ role: 'user', content: `error: unknown tool "${action}". Available: ${available}` });
        }
      } else {
        // Plain text reply — flush buffered tokens to the channel adapter.
        for (const token of buffer) onDelta(token);
        if (this.db) this.db.setStatus(msg.sessionId, 'Success');
        this.sessions.set(msg.sessionId, messages);

        // Async memory extraction — non-blocking, must not delay the reply.
        if (this.memoryStore) {
          const store = this.memoryStore;
          const provider = getProvider(this.providerChain[0]!);
          if (provider) {
            extractAndSaveMemories(messages, msg.sessionId, provider, store)
              .catch((e: any) => log(`[memory] extraction failed: ${e.message}`));
          }
        }

        return reply;
      }
    }
  }

  // handleCommand processes /steps, /rollback, /fork slash commands.
  // Returns the reply string if a command was handled; null otherwise.
  private handleCommand(msg: ACPMessage): string | null {
    const content = msg.content.trim();

    // /steps [n] — list the most recent n steps (default 10)
    if (content === '/steps' || content.startsWith('/steps ')) {
      let n = 10;
      const after = content.slice('/steps'.length).trim();
      if (after) {
        const parsed = parseInt(after, 10);
        if (!isNaN(parsed) && parsed > 0) n = parsed;
      }
      const steps = this.db!.loadSteps(msg.sessionId, n);
      if (steps.length === 0) return 'no steps recorded yet in this session.';
      // Reverse to show oldest first (loadSteps returns newest first).
      steps.reverse();
      let out = `步骤列表 (session: ${msg.sessionId}):\n`;
      for (const s of steps) {
        out += `  ${s.stepId.padEnd(6)}  ${s.stepType.padEnd(12)}  ${s.name.padEnd(10)}  ${s.snippet}\n`;
      }
      out += '\n用法:\n';
      out += '  /rollback <stepID>        回到该步骤之前重新执行\n';
      out += '  /fork <stepID> [title]    从该步骤分叉新会话（原会话保留）\n';
      return out;
    }

    // /rollback <stepID>
    if (content.startsWith('/rollback ')) {
      const short = content.slice('/rollback '.length).trim();
      const stepId = expandStepId(msg.sessionId, short);
      try {
        this.db!.rollback(msg.sessionId, stepId);
        this.sessions.delete(msg.sessionId); // force reload from DB on next handle()
        return `[rollback] session reset to before step ${short} — send your new instruction`;
      } catch (err: any) {
        return `rollback failed: ${err.message}`;
      }
    }

    // /fork <stepID> [new title]
    if (content.startsWith('/fork ')) {
      const rest = content.slice('/fork '.length).trim();
      const spaceIdx = rest.indexOf(' ');
      const short = spaceIdx >= 0 ? rest.slice(0, spaceIdx) : rest;
      const title = spaceIdx >= 0 ? rest.slice(spaceIdx + 1).trim() : `fork from ${short}`;
      const stepId = expandStepId(msg.sessionId, short);
      const newSessionId = 'fork_' + crypto.randomUUID().slice(0, 6);
      try {
        this.db!.fork(msg.sessionId, newSessionId, title, stepId);
        return (
          `[fork] new session created: ${newSessionId}\n` +
          `connect with this session ID to continue on the forked branch.\n` +
          `original session ${msg.sessionId} is unchanged.`
        );
      } catch (err: any) {
        return `fork failed: ${err.message}`;
      }
    }

    return null;
  }
}

export function buildSystemPrompt(agentMemories?: string, kbSnippets?: string): string {
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  let prompt = `You are xclaw, an AI Orchestrator. You coordinate a team of specialist Workers to complete tasks.
Today's date: ${today}

## STRICT RULE: You NEVER write code, documentation, or analysis yourself.

Every response is EITHER a single tool call JSON OR a plain-text summary to the user. Nothing else.

**Workers you must delegate to:**
- coder — writes all code
- reviewer — reviews code for bugs and security
- writer — writes JSDoc/TSDoc/README documentation
- skeptic — critical analysis and failure modes
- optimizer — performance improvements

## How to chain Workers (multi-step workflow)

Workers return JSON: {"status":"...","summary_data":{...},"artifact_pointers":{...}}

**Pattern: coder → reviewer → writer**

Turn 1 — delegate to coder:
{"action": "delegate", "agent": "coder", "task": "Write Node.js JWT sign/verify with HS256. Return complete runnable code."}

Turn 2 — coder returns. Extract the code:
- If code is in summary_data.code or similar field: use it directly
- If code is a file path in artifact_pointers: call view_file to read it first
{"action": "view_file", "path": "shared/abc123/jwt.ts"}

Turn 3 — pass the FULL code inline to reviewer:
{"action": "delegate", "agent": "reviewer", "task": "Review this Node.js JWT module for security issues:\n\n<paste FULL code here>"}

Turn 4 — reviewer returns. Delegate to writer with full code:
{"action": "delegate", "agent": "writer", "task": "Add JSDoc comments to this code:\n\n<paste FULL code here>"}

Turn 5 — reply to user with a plain-text summary.

**Critical rules:**
- Workers cannot see your history. Copy ALL needed code/context into each task string.
- Never write code or docs yourself — always delegate.
- After getting a Worker result, read artifact files with view_file if needed before passing to next Worker.
- Use debate for parallel multi-perspective analysis (pass "agents" as JSON array string).

## Tool call format

Output ONLY a raw JSON object — zero text before or after:
{"action": "delegate", "agent": "coder", "task": "..."}

To reply to the user: output plain text only (no JSON at all).

Available tools:
${buildOrchestratorToolsPrompt()}`;

  if (agentMemories) {
    prompt += `\n\n## 相关历史记忆\n${agentMemories}\n（以上为召回的相关记忆，请在回答中参考但不要直接引用编号）`;
  }
  if (kbSnippets) {
    prompt += `\n\n## 相关文档\n${kbSnippets}`;
  }
  return prompt;
}
