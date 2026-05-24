import { execSync } from 'child_process';
import { readFileSync } from 'fs';

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

export const toolRegistry = new Map<string, Tool>();

export function registerTool(definition: ToolDefinition, execute: ToolExecutor) {
  toolRegistry.set(definition.name, { definition, execute });
}

export function buildToolsPrompt(): string {
  return [...toolRegistry.values()]
    .map(({ definition: d }) => {
      const params = Object.entries(d.parameters.properties)
        .map(([k, v]) => `  - ${k} (${v.type}): ${v.description}`)
        .join('\n');
      return `### ${d.name}\n${d.description}\nParameters:\n${params}`;
    })
    .join('\n\n');
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

// ── JSON parsing helpers ─────────────────────────────────────────────────────

function repairJSON(s: string): string {
  return s.replace(/\\([^"\\/bfnrtu\d])/g, '\\\\$1');
}

function tryParse(candidate: string): Record<string, unknown> | null {
  try { return JSON.parse(candidate); } catch {}
  try { return JSON.parse(repairJSON(candidate)); } catch {}
  return null;
}

export function extractJSON(text: string): Record<string, unknown> | null {
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
