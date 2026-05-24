import { streamWithFallback } from './providers/registry.ts';
import { toolRegistry, buildToolsPrompt, extractJSON } from './tools.ts';
import type { Message } from './providers/types.ts';
import type { ACPMessage } from './gateway/types.ts';
import { log } from './logger.ts';
import { DB, expandStepId, shortStepId } from './db.ts';

export class Agent {
  private sessions = new Map<string, Message[]>();
  private providerChain: string[];
  private maxIterations: number;
  private db: DB | null;

  constructor(providerChain: string[], maxIterations: number, db: DB | null = null) {
    this.providerChain = providerChain;
    this.maxIterations = maxIterations;
    this.db = db;
  }

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
          const loaded = this.db.loadMessages(msg.sessionId, buildSystemPrompt());
          this.sessions.set(msg.sessionId, loaded);
          log(`[agent] [${msg.sessionId}] restored ${loaded.length} messages from DB (status: ${status})`);
        }
      }
      if (!this.sessions.has(msg.sessionId)) {
        this.sessions.set(msg.sessionId, [{ role: 'system', content: buildSystemPrompt() }]);
      }
    }
    const messages = [...this.sessions.get(msg.sessionId)!];

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
          try {
            const output = await tool.execute(msg.sessionId, params);
            log(output);
            if (this.db && toolStepId) this.db.completeTrace(toolStepId, output);
            messages.push({ role: 'user', content: `tool output:\n${output}` });
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

export function buildSystemPrompt(): string {
  return `You are an AI assistant named xclaw.

To use a tool, output a JSON object (bare or in a markdown code block):
{"action": "<tool_name>", "<param1>": "<value1>", ...}

To answer directly, output plain text — do NOT use JSON.

Available tools:
${buildToolsPrompt()}`;
}
