import path from 'path';
import fs from 'fs/promises';
import { spawn } from 'child_process';
import type { Config } from './config.ts';
import { extSet } from './config.ts';
import type { HITLConfirmer } from './hitl.ts';
import type { SandboxPool } from './cubesandbox.ts';

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

export type ToolExecutor = (sessionId: string, params: Record<string, string>) => Promise<string>;

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

// ── Defense 1: Path canonicalization & traversal prevention ─────────────────

function canonicalize(userPath: string, workDir: string): string {
  const abs = path.resolve(workDir, userPath);
  const workAbs = path.resolve(workDir);
  if (!abs.startsWith(workAbs + path.sep) && abs !== workAbs) {
    throw new Error(`path not allowed: "${abs}" is outside workspace "${workAbs}"`);
  }
  return abs;
}

// ── Defense 3: Extension circuit breaker ────────────────────────────────────

function checkExt(filePath: string, allowed: Set<string>): void {
  const ext = path.extname(filePath).toLowerCase();
  if (!allowed.has(ext)) {
    throw new Error(`file type not allowed: "${ext || '(no extension)'}"`);
  }
}

// ── Defense 4: Least-privilege child process execution ──────────────────────

export function spawnSafe(cmd: string, args: string[]): Promise<string> {
  const opts: any = { shell: false };
  if (process.platform !== 'win32') {
    const uid = parseInt(process.env['AGENT_RUN_UID'] ?? '', 10);
    const gid = parseInt(process.env['AGENT_RUN_GID'] ?? '', 10);
    if (!isNaN(uid)) {
      opts.uid = uid;
      if (!isNaN(gid)) opts.gid = gid;
    }
  }
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, opts);
    let out = '';
    child.stdout?.on('data', (d: Buffer) => (out += d.toString()));
    child.stderr?.on('data', (d: Buffer) => (out += d.toString()));
    child.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`exit ${code}: ${out}`))));
  });
}

// ── Mode-based tool registration ─────────────────────────────────────────────

export function registerToolsForMode(
  mode: string,
  pool: SandboxPool | null,
  hitl: HITLConfirmer,
  cfg: Config,
): void {
  if (mode === 'full') {
    registerFullSandboxTools(pool!);
  } else {
    registerHostModeTools(hitl, cfg);
  }
}

function registerHostModeTools(hitl: HITLConfirmer, cfg: Config): void {
  const workDir = path.resolve(cfg.sandbox.workDir);
  const readExts = extSet(cfg.tools.file.read.allowedExtensions);
  const writeExts = extSet(cfg.tools.file.write.allowedExtensions);
  const maxReadBytes = cfg.tools.file.read.maxBytes;
  const maxWriteBytes = cfg.tools.file.write.maxBytes;

  // view_file — Defense 1 + 3 (canonicalize + ext/size), auto-approved read
  registerTool(
    {
      name: 'view_file',
      description: 'Read the content of a file inside the workspace. Only safe text formats are allowed.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'File path (must be inside workspace)' } },
        required: ['path'],
      },
    },
    async (_sessionId, params) => {
      const abs = canonicalize(params['path']!, workDir);        // Defense 1
      checkExt(abs, readExts);                                   // Defense 3: ext
      if (!await hitl.confirm(`view_file ${abs}`, '', false)) {  // Defense 2
        throw new Error('user denied');
      }
      const stat = await fs.stat(abs);
      if (stat.size > maxReadBytes) {                            // Defense 3: size
        throw new Error(`file too large (${stat.size} bytes, limit ${maxReadBytes})`);
      }
      return fs.readFile(abs, 'utf-8');
    },
  );

  // edit_file — Defense 1 + 2 + 3 (canonicalize + HITL block + ext/size)
  registerTool(
    {
      name: 'edit_file',
      description: 'Write content to a file inside the workspace. Requires user approval. Only safe text formats allowed.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path (must be inside workspace)' },
          content: { type: 'string', description: 'Full file content to write' },
        },
        required: ['path', 'content'],
      },
    },
    async (_sessionId, params) => {
      const abs = canonicalize(params['path']!, workDir);             // Defense 1
      checkExt(abs, writeExts);                                       // Defense 3: ext
      const content = params['content'] ?? '';
      const bytes = Buffer.byteLength(content, 'utf-8');
      if (bytes > maxWriteBytes) {                                    // Defense 3: size
        throw new Error(`content too large (${bytes} bytes, limit ${maxWriteBytes})`);
      }
      const detail = `path: ${abs}\nbytes: ${bytes}`;
      if (!await hitl.confirm(`edit_file ${abs}`, detail, true)) {   // Defense 2: HITL block
        throw new Error('user denied');
      }
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, content, 'utf-8');                      // all defenses passed
      return `wrote ${bytes} bytes to ${abs}`;
    },
  );

  // list_dir — Defense 1 + 2, uses fs.readdir (no shell)
  registerTool(
    {
      name: 'list_dir',
      description: 'List files and directories inside the workspace.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Directory path (must be inside workspace)' } },
        required: ['path'],
      },
    },
    async (_sessionId, params) => {
      const abs = canonicalize(params['path']!, workDir);              // Defense 1
      if (!await hitl.confirm(`list_dir ${abs}`, '', false)) {         // Defense 2
        throw new Error('user denied');
      }
      const entries = await fs.readdir(abs, { withFileTypes: true });
      return entries
        .map((e) => {
          if (e.isDirectory()) return `${e.name}/`;
          return e.name;
        })
        .join('\n');
    },
  );
}

function registerFullSandboxTools(pool: SandboxPool): void {
  registerTool(
    {
      name: 'shell',
      description: 'Execute a shell command inside the isolated sandbox VM and return stdout+stderr.',
      parameters: {
        type: 'object',
        properties: { command: { type: 'string', description: 'The shell command to execute' } },
        required: ['command'],
      },
    },
    async (sessionId, params) => {
      const sb = await pool.getOrCreate(sessionId);
      return sb.runCommand(params['command']!);
    },
  );

  registerTool(
    {
      name: 'run_python_code',
      description: 'Execute Python code inside the isolated sandbox VM and return stdout + result.',
      parameters: {
        type: 'object',
        properties: { code: { type: 'string', description: 'Python source code to execute' } },
        required: ['code'],
      },
    },
    async (sessionId, params) => {
      const sb = await pool.getOrCreate(sessionId);
      return sb.runCode(params['code']!);
    },
  );

  registerTool(
    {
      name: 'view_file',
      description: 'Read the content of a file inside the sandbox.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Absolute or relative file path inside the sandbox' } },
        required: ['path'],
      },
    },
    async (sessionId, params) => {
      const sb = await pool.getOrCreate(sessionId);
      return sb.runCommand(`cat ${params['path']}`);
    },
  );

  registerTool(
    {
      name: 'list_dir',
      description: 'List files in a directory inside the sandbox.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Directory path inside the sandbox' } },
        required: ['path'],
      },
    },
    async (sessionId, params) => {
      const sb = await pool.getOrCreate(sessionId);
      return sb.runCommand(`ls -la ${params['path']}`);
    },
  );
}

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
  if (jsonBlock) { const r = tryParse(jsonBlock[1]!.trim()); if (r) return r; }

  const rawBlock = s.match(/```\s*([\s\S]*?)```/);
  if (rawBlock) { const r = tryParse(rawBlock[1]!.trim()); if (r) return r; }

  const inlineMatch = s.match(/\{[\s\S]*\}/);
  if (inlineMatch) { const r = tryParse(inlineMatch[0]); if (r) return r; }

  return null;
}
