import { createOpenAIProvider } from './providers/openai.ts';
import { createClaudeProvider } from './providers/claude.ts';
import { registerProvider, streamWithFallback } from './providers/registry.ts';
import { toolRegistry, buildToolsPrompt, extractJSON } from './tools.ts';
import type { Message } from './providers/types.ts';
import type { ACPMessage } from './gateway/types.ts';
import { log } from './logger.ts';

// ── Provider setup ────────────────────────────────────────────────────────────

registerProvider(createOpenAIProvider());
registerProvider(createClaudeProvider());

const primary  = process.env['PRIMARY_PROVIDER']  ?? 'claude';
const fallback = process.env['FALLBACK_PROVIDER'] ?? 'openai';
const providerChain = [primary, fallback].filter((v, i, a) => a.indexOf(v) === i);

// ── System prompt ─────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are an AI assistant named xclaw.

To use a tool, output a JSON object (bare or in a markdown code block):
{"action": "<tool_name>", "<param1>": "<value1>", ...}

To answer directly, output plain text — do NOT use JSON.

Available tools:
${buildToolsPrompt()}`;

// ── Agent ─────────────────────────────────────────────────────────────────────

const MAX_ITERATIONS = 10;

export class Agent {
  private sessions = new Map<string, Message[]>();

  // Process one user message; call onDelta for each streamed token.
  // Returns the final assistant reply.
  async handle(msg: ACPMessage, onDelta: (token: string) => void): Promise<string> {
    if (!this.sessions.has(msg.sessionId)) {
      this.sessions.set(msg.sessionId, [{ role: 'system', content: SYSTEM_PROMPT }]);
    }
    const messages = this.sessions.get(msg.sessionId)!;
    messages.push({ role: 'user', content: msg.content });

    let iterations = 0;
    while (true) {
      if (++iterations > MAX_ITERATIONS) {
        const notice = `[xclaw] reached max iterations (${MAX_ITERATIONS}), stopping`;
        log(notice);
        return notice;
      }

      // Buffer tokens — only flush to onDelta if this turn is a plain text reply.
      // Tool call JSON must never reach the client as raw output.
      const buffer: string[] = [];
      const reply = await streamWithFallback(messages, providerChain, (token) => {
        buffer.push(token);
      });
      messages.push({ role: 'assistant', content: reply });

      const toolCall = extractJSON(reply);
      if (toolCall && typeof toolCall.action === 'string') {
        const tool = toolRegistry.get(toolCall.action);
        if (tool) {
          const { action, ...params } = toolCall as Record<string, string>;
          log(`[agent] [${msg.sessionId}] uses [${action}]: ${JSON.stringify(params)}`);
          try {
            const output = tool.execute(params);
            log(output);
            messages.push({ role: 'user', content: `tool output:\n${output}` });
          } catch (err: any) {
            const errMsg = err.stderr ?? err.message;
            console.error(`[agent] tool error: ${errMsg}`);
            messages.push({ role: 'user', content: `tool error:\n${errMsg}` });
          }
        } else {
          const available = [...toolRegistry.keys()].join(', ');
          messages.push({ role: 'user', content: `error: unknown tool "${toolCall.action}". Available: ${available}` });
        }
      } else {
        // Plain text reply — flush buffered tokens to client then return
        for (const token of buffer) onDelta(token);
        return reply;
      }
    }
  }
}
