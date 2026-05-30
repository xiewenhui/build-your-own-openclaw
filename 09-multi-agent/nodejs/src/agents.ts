import path from 'path';
import fs from 'fs';
import { Agent } from './agent.ts';

// ── Worker 注册表 ─────────────────────────────────────────────────────────────
// 所有 Worker Agent 实例在进程启动时预创建，通过名称检索。
// delegate / debate / pipeline 工具都从这里取 Agent 实例。

export const workerRegistry = new Map<string, Agent>();

interface WorkerSpec {
  name: string;
  prompt: string;
}

const WORKER_SPECS: WorkerSpec[] = [
  {
    name: 'coder',
    prompt: `You are a focused software engineer. Your only job is code implementation.
- Return complete, runnable code only — no preamble, no sign-off
- Follow the language/style specified in the task; if unspecified, use idiomatic style
- Include necessary error handling
- If the task is ambiguous, state your assumptions in a brief comment at the top`,
  },
  {
    name: 'reviewer',
    prompt: `You are a code reviewer specializing in correctness, security, and maintainability.
- Lead with a score 1–10 and one-line summary
- List concrete issues with file:line references where possible
- For each issue: what's wrong, why it matters, and the fix
- Focus on: security vulnerabilities, edge cases, performance pitfalls, error handling gaps`,
  },
  {
    name: 'writer',
    prompt: `You are a technical documentation engineer.
- Write JSDoc / TSDoc / Godoc comments as appropriate for the language
- For README requests: include purpose, installation, usage examples
- Be concise — never explain what the code obviously does; explain why non-obvious decisions were made`,
  },
  {
    name: 'skeptic',
    prompt: `You are a critical-thinking specialist and devil's advocate.
- For any proposal, identify at least 3 concrete failure modes or hidden assumptions
- Frame concerns as "what happens when X" questions, not vague warnings
- You're not trying to block progress — you're making the plan more robust`,
  },
  {
    name: 'optimizer',
    prompt: `You are a performance optimization specialist.
- Analyse time and space complexity; state Big-O clearly
- Provide the optimized code alongside the original for direct comparison
- When optimization reduces readability, explicitly state the trade-off`,
  },
];

// ── 注册所有预置 Worker ───────────────────────────────────────────────────────
// baseWorkDir: 来自 cfg.sandbox.workDir（主 Agent 的工作区根目录）
// 每个 Worker 在 {baseWorkDir}/agents/{name}/ 下拥有独立工作区，互不干扰。

export function registerDefaultWorkers(providerChain: string[], baseWorkDir: string, mode: string = 'host'): void {
  const agentsBase = path.resolve(baseWorkDir, 'agents');
  // full 模式下 Worker 在 KVM 沙箱内操作，宿主机目录仅用于 host 模式
  if (mode === 'host') fs.mkdirSync(agentsBase, { recursive: true });

  for (const spec of WORKER_SPECS) {
    let workerDir: string | undefined;
    let workspaceSection: string;

    if (mode === 'host') {
      workerDir = path.join(agentsBase, spec.name);
      fs.mkdirSync(workerDir, { recursive: true });
      workspaceSection = `\n\n## Workspace
Scratch directory for intermediate files: ${workerDir}
Use this for any work-in-progress files. Final artifacts must be submitted via the deliver tool
to the [Shared delivery dir] path provided in the task header — not to this directory.`;
    } else {
      // full (KVM) 模式：Worker 运行在独立 KVM 沙箱，用 shell 工具操作 /workspace/
      workspaceSection = `\n\n## Workspace
You run in an isolated KVM sandbox. Use the shell tool for intermediate work in /workspace/.
Submit final artifacts via the deliver tool (provide filename + content).`;
    }

    const fullPrompt = `${spec.prompt}${workspaceSection}

## Tool calls
To call a tool, output ONLY a raw JSON object — no surrounding text:
{"action": "deliver", "path": "<absolute path from [Shared delivery dir]>", "content": "<file content>"}
{"action": "view_file", "path": "<path>"}
{"action": "list_dir", "path": "<path>"}

You will receive a "tool output:" message after each call. Read the result, then continue working.
Never combine a tool call and the final result JSON in the same response — they are separate turns.

## Returning Results
**If the task starts with [Shared delivery dir:]** (called by Orchestrator via delegate):
Output ONLY this JSON — no surrounding text:
{"status":"success"|"error","summary_data":{...},"artifact_pointers":{...}}

Rules:
- summary_data: decisions and metadata only — scores, flags, key findings, assumptions. No large text bodies.
- Any file output (code, documentation, reports, diffs): call deliver first, then put the confirmed path in artifact_pointers.
- artifact_pointers: only paths that deliver confirmed with "delivered: <path>". Never invent a path.
- If nothing was delivered, set artifact_pointers to {}.

**If there is no [Shared delivery dir:] header** (talking directly with a user):
Respond in natural language. Do not output JSON.`;

    workerRegistry.set(
      spec.name,
      new Agent(providerChain, 20, null, null, 0, fullPrompt, workerDir),
    );
  }
}
