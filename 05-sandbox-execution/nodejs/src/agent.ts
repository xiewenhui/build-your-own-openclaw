import { streamWithFallback } from './providers/registry.ts';
import { toolRegistry, buildToolsPrompt, extractJSON } from './tools.ts';
import type { Message } from './providers/types.ts';
import type { ACPMessage } from './gateway/types.ts';
import { log } from './logger.ts';

export class Agent {
  private sessions = new Map<string, Message[]>();
  private providerChain: string[];
  private maxIterations: number;

  constructor(providerChain: string[], maxIterations: number) {
    this.providerChain = providerChain;
    this.maxIterations = maxIterations;
  }

  // Process one user message; call onDelta for each streamed token.
  async handle(msg: ACPMessage, onDelta: (token: string) => void): Promise<string> {
    if (!this.sessions.has(msg.sessionId)) {
      this.sessions.set(msg.sessionId, [{ role: 'system', content: buildSystemPrompt() }]);
    }
    const messages = this.sessions.get(msg.sessionId)!;
    messages.push({ role: 'user', content: msg.content });

    let iterations = 0;
    while (true) {
      if (++iterations > this.maxIterations) {
        const notice = `[xclaw] reached max iterations (${this.maxIterations}), stopping`;
        log(notice);
        return notice;
      }

      const buffer: string[] = [];
      const reply = await streamWithFallback(messages, this.providerChain, (token) => {
        buffer.push(token);
      });
      messages.push({ role: 'assistant', content: reply });

      const toolCall = extractJSON(reply);
      if (toolCall && typeof toolCall['action'] === 'string') {
        const tool = toolRegistry.get(toolCall['action']);
        if (tool) {
          const { action, ...rawParams } = toolCall as Record<string, string>;
          const params: Record<string, string> = {};
          for (const [k, v] of Object.entries(rawParams)) {
            if (typeof v === 'string') params[k] = v;
          }
          log(`[agent] [${msg.sessionId}] uses [${action}]: ${JSON.stringify(params)}`);
          try {
            const output = await tool.execute(msg.sessionId, params);
            log(output);
            messages.push({ role: 'user', content: `tool output:\n${output}` });
          } catch (err: any) {
            const errMsg = err.stderr ?? err.message;
            console.error(`[agent] tool error: ${errMsg}`);
            messages.push({ role: 'user', content: `tool error:\n${errMsg}` });
          }
        } else {
          const available = [...toolRegistry.keys()].join(', ');
          messages.push({ role: 'user', content: `error: unknown tool "${toolCall['action']}". Available: ${available}` });
        }
      } else {
        for (const token of buffer) onDelta(token);
        return reply;
      }
    }
  }
}

function buildSystemPrompt(): string {
  return `You are an AI assistant named xclaw.

To use a tool, output a JSON object (bare or in a markdown code block):
{"action": "<tool_name>", "<param1>": "<value1>", ...}

To answer directly, output plain text — do NOT use JSON.

Available tools:
${buildToolsPrompt()}`;
}
