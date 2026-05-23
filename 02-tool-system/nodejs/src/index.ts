import OpenAI from 'openai';
import * as readline from 'readline';
import { execSync } from 'child_process';
import { readFileSync } from 'fs';

const client = new OpenAI({
  apiKey: process.env['OPENAI_API_KEY'],
  baseURL: process.env['OPENAI_API_BASE_URL'],
});

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

const ask = (prompt: string) => new Promise<string>((resolve) => rl.question(prompt, resolve));

// ── Tool type definitions ────────────────────────────────────────────────────

interface ToolParam {
  type: string;
  description: string;
}

interface ToolDefinition {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, ToolParam>;
    required: string[];
  };
}

type ToolExecutor = (params: Record<string, string>) => string;

interface Tool {
  definition: ToolDefinition;
  execute: ToolExecutor;
}

// ── Tool registry ────────────────────────────────────────────────────────────

const toolRegistry = new Map<string, Tool>();

function registerTool(definition: ToolDefinition, execute: ToolExecutor) {
  toolRegistry.set(definition.name, { definition, execute });
}

// ── Register tools ───────────────────────────────────────────────────────────

registerTool(
  {
    name: 'shell',
    description: 'Execute a bash shell command and return stdout',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The bash command to execute' },
      },
      required: ['command'],
    },
  },
  ({ command }) => execSync(command, { encoding: 'utf-8' }),
);

registerTool(
  {
    name: 'read_file',
    description: 'Read the content of a file',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute or relative file path' },
      },
      required: ['path'],
    },
  },
  ({ path }) => readFileSync(path, 'utf-8'),
);

// ── Auto-generate tool descriptions for the system prompt ────────────────────

function buildToolsPrompt(): string {
  return [...toolRegistry.values()]
    .map(({ definition: d }) => {
      const params = Object.entries(d.parameters.properties)
        .map(([k, v]) => `  - ${k} (${v.type}): ${v.description}`)
        .join('\n');
      return `### ${d.name}\n${d.description}\nParameters:\n${params}`;
    })
    .join('\n\n');
}

// ── System prompt (built from registry) ─────────────────────────────────────

const SYSTEM_PROMPT = `You are an AI assistant named xclaw.

To use a tool, output a JSON object (bare or in a markdown code block):
{"action": "<tool_name>", "<param1>": "<value1>", ...}

To answer directly, output plain text — do NOT use JSON.

Available tools:
${buildToolsPrompt()}`;

// ── JSON parsing helpers ─────────────────────────────────────────────────────

// Fix invalid JSON escape sequences like \; \: that LLMs sometimes emit
function repairJSON(s: string): string {
  return s.replace(/\\([^"\\/bfnrtu\d])/g, '\\\\$1');
}

function tryParse(candidate: string): Record<string, unknown> | null {
  try { return JSON.parse(candidate); } catch {}
  try { return JSON.parse(repairJSON(candidate)); } catch {}
  return null;
}

// Robust JSON extractor: handles bare JSON, ```json blocks, ``` blocks, and inline JSON
function extractJSON(text: string): Record<string, unknown> | null {
  const s = text.trim();

  const r1 = tryParse(s);
  if (r1) return r1;

  const jsonBlock = s.match(/```json\s*([\s\S]*?)```/);
  if (jsonBlock) { const r = tryParse(jsonBlock[1].trim()); if (r) return r; }

  const rawBlock = s.match(/```\s*([\s\S]*?)```/);
  if (rawBlock) { const r = tryParse(rawBlock[1].trim()); if (r) return r; }

  const inlineMatch = s.match(/\{[\s\S]*\}/);
  if (inlineMatch) { const r = tryParse(inlineMatch[0]); if (r) return r; }

  return null;
}

// ── Main loop ────────────────────────────────────────────────────────────────

const MAX_ITERATIONS = 10;

const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
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

    const completion = await client.chat.completions.create({
      model: process.env['OPENAI_MODEL'] ?? 'GLM-5',
      messages,
    });

    const reply = completion.choices[0].message.content ?? '';
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
        // Unknown tool: feed available tools back so the model can self-correct
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
