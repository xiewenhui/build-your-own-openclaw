import * as readline from 'readline';
import { createOpenAIProvider }  from './providers/openai.ts';
import { createClaudeProvider }  from './providers/claude.ts';
import { registerProvider, chatWithFallback } from './providers/registry.ts';
import { toolRegistry, buildToolsPrompt, extractJSON } from './tools.ts';
import type { Message } from './providers/types.ts';

// ── Register providers ───────────────────────────────────────────────────────

registerProvider(createOpenAIProvider());
registerProvider(createClaudeProvider());

const primary  = process.env['PRIMARY_PROVIDER']  ?? 'claude';
const fallback = process.env['FALLBACK_PROVIDER'] ?? 'openai';
const providerChain = [primary, fallback].filter((v, i, a) => a.indexOf(v) === i);

// ── System prompt ────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are an AI assistant named xclaw.

To use a tool, output a JSON object (bare or in a markdown code block):
{"action": "<tool_name>", "<param1>": "<value1>", ...}

To answer directly, output plain text — do NOT use JSON.

Available tools:
${buildToolsPrompt()}`;

// ── Main loop ────────────────────────────────────────────────────────────────

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (prompt: string) => new Promise<string>((resolve) => rl.question(prompt, resolve));

const MAX_ITERATIONS = 10;

const messages: Message[] = [
  { role: 'system', content: SYSTEM_PROMPT },
];

while (true) {
  const userInput = await ask('You: ');
  if (userInput.trim().toLowerCase() === 'exit') break;

  messages.push({ role: 'user', content: userInput });

  let iterations = 0;
  while (true) {
    if (++iterations > MAX_ITERATIONS) {
      console.log(`[xclaw] reached max iterations (${MAX_ITERATIONS}), stopping`);
      break;
    }

    const reply = await chatWithFallback(messages, providerChain);
    messages.push({ role: 'assistant', content: reply });

    const toolCall = extractJSON(reply);
    if (toolCall && typeof toolCall.action === 'string') {
      const tool = toolRegistry.get(toolCall.action);
      if (tool) {
        const { action, ...params } = toolCall as Record<string, string>;
        console.log(`xclaw uses [${action}]:`, params);
        try {
          const output = tool.execute(params);
          console.log(output);
          messages.push({ role: 'user', content: `tool output:\n${output}` });
        } catch (err: any) {
          const errMsg = err.stderr ?? err.message;
          console.error(`error: ${errMsg}`);
          messages.push({ role: 'user', content: `tool error:\n${errMsg}` });
        }
      } else {
        const available = [...toolRegistry.keys()].join(', ');
        messages.push({ role: 'user', content: `error: unknown tool "${toolCall.action}". Available: ${available}` });
      }
    } else {
      console.log(`xclaw: ${reply}`);
      break;
    }
  }
}

rl.close();
