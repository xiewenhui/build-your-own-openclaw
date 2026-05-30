import path from 'path';
import fs from 'fs/promises';
import fsSync from 'fs';
import { spawn } from 'child_process';
import crypto from 'crypto';
import type { Agent } from './agent.ts';
import type { Page } from 'playwright';
import type { Config } from './config.ts';
import { extSet } from './config.ts';
import type { HITLConfirmer } from './hitl.ts';
import type { SandboxPool } from './cubesandbox.ts';
import type { BrowserPool } from './browser.ts';
import type { MemoryStore } from './memory.ts';
import { embed } from './memory.ts';
import { indexDocument } from './knowledgebase.ts';

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

export type ToolExecutor = (sessionId: string, params: Record<string, string>, onDelta?: (token: string) => void) => Promise<string>;

interface Tool {
  definition: ToolDefinition;
  execute: ToolExecutor;
}

// ── Tool registry ────────────────────────────────────────────────────────────

export const toolRegistry = new Map<string, Tool>();

export function registerTool(definition: ToolDefinition, execute: ToolExecutor) {
  toolRegistry.set(definition.name, { definition, execute });
}

// Orchestrator only sees delegation + read tools — never file-write or browser tools.
// This forces it to delegate instead of doing the work itself.
const ORCHESTRATOR_TOOLS = new Set([
  'delegate', 'debate', 'pipeline',
  'view_file', 'list_dir',
  'memory_save', 'memory_search', 'kb_search',
]);

export function buildOrchestratorToolsPrompt(): string {
  return [...toolRegistry.values()]
    .filter(({ definition }) => ORCHESTRATOR_TOOLS.has(definition.name))
    .map(({ definition: d }) => {
      const params = Object.entries(d.parameters.properties)
        .map(([k, v]) => `  - ${k} (${v.type}): ${v.description}`)
        .join('\n');
      return `### ${d.name}\n${d.description}\nParameters:\n${params}`;
    })
    .join('\n\n');
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

// ── Browser: HTML distillation ───────────────────────────────────────────────

export function distillHTML(html: string, maxChars = 8000, offsetChars = 0): string {
  let r = html;

  // Step 0: remove the entire <head> block (scripts/styles/meta already gone, just blank lines left)
  r = r.replace(/<head\b[^>]*>[\s\S]*?<\/head>/gi, '');

  // Step 1: remove block-level noise tags (including their content)
  r = r.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
  r = r.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '');
  r = r.replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, '');

  // Step 2: remove HTML comments
  r = r.replace(/<!--[\s\S]*?-->/g, '');

  // Step 3: remove semantic-less self-closing tags
  r = r.replace(/<(meta|link|svg|path|polygon|circle|rect|use|defs)\b[^>]*\/?>/gi, '');

  // Step 4: strip attributes except the ones useful to LLM; preserve data-agent-id
  r = r.replace(/<a\b([^>]*)>/gi, (_m, attrs) => {
    const href = (attrs.match(/href="([^"]*)"/) || [])[1] ?? '';
    const aid  = (attrs.match(/data-agent-id="([^"]*)"/) || [])[1] ?? '';
    return `<a${href ? ` href="${href}"` : ''}${aid ? ` data-agent-id="${aid}"` : ''}>`;
  });
  r = r.replace(/<input\b([^>]*)>/gi, (_m, attrs) => {
    const get = (a: string) => (attrs.match(new RegExp(`${a}="([^"]*)"`))||[])[1] ?? '';
    const aid  = get('data-agent-id');
    const kept = ['name','type','placeholder','value'].map(a => { const v=get(a); return v?`${a}="${v}"`:''; }).filter(Boolean).join(' ');
    return `<input${aid ? ` data-agent-id="${aid}"` : ''}${kept ? ' '+kept : ''}>`;
  });
  r = r.replace(/<button\b([^>]*)>/gi, (_m, attrs) => {
    const aid = (attrs.match(/data-agent-id="([^"]*)"/) || [])[1] ?? '';
    return aid ? `<button data-agent-id="${aid}">` : '<button>';
  });
  r = r.replace(/<select\b([^>]*)>/gi, (_m, attrs) => {
    const aid = (attrs.match(/data-agent-id="([^"]*)"/) || [])[1] ?? '';
    return aid ? `<select data-agent-id="${aid}">` : '<select>';
  });
  // Strip all other tags' attributes
  r = r.replace(/<(?!\/?(a|button|input|select|option|h[1-6]|p|li|ul|ol|td|th|tr|table|label|form|main|article|section|nav|header|footer|title|head|html|body)\b)[^>]+>/gi, '');

  // Step 5: collapse whitespace
  r = r.replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();

  // Step 6: apply offset then truncate
  if (offsetChars > 0) r = r.slice(offsetChars);
  if (r.length > maxChars) {
    r = r.slice(0, maxChars) + `\n[内容已截断，共约 ${offsetChars + r.length} 字符；如需继续请使用 browser_content 并设置 offset=${offsetChars + maxChars}]`;
  }

  return r;
}

export function injectLocatorIds(html: string): string {
  let agentId = 0;
  return html.replace(/<(a|button|input|select)\b/gi, (tag) => {
    return `${tag} data-agent-id="${++agentId}"`;
  });
}

// Inject data-agent-id into the live DOM so browser_click/browser_type can find elements by number.
// Must be called before page.content() so the IDs appear in the returned HTML string too.
async function injectLocatorIdsIntoDom(page: Page): Promise<void> {
  await page.evaluate(() => {
    let id = 0;
    // Include ARIA-standard interactive roles so calendars (gridcell) and
    // autocomplete dropdowns (option) get agent-IDs without CSS-selector guessing.
    document.querySelectorAll('a, button, input, select, td[role="gridcell"], li[role="option"]').forEach(el => {
      el.setAttribute('data-agent-id', String(++id));
    });
  });
}

// Dismiss common cookie/popup overlays without blocking.
async function dismissPopups(page: Page): Promise<void> {
  // Handle full-page PIPL consent redirect (Booking.com China compliance).
  // Input checkboxes are hidden under <span> overlays — use JS click to bypass.
  if (page.url().includes('pipl_consent')) {
    try {
      await page.evaluate(() => {
        (document.querySelector('input[name="selectAll"]') as HTMLInputElement | null)?.click();
      });
      const agreeBtn = await page.$('button:has-text("同意")');
      if (agreeBtn) await agreeBtn.click();
      await page.waitForNavigation({ waitUntil: 'networkidle', timeout: 15000 }).catch(() => {});
    } catch { /* best-effort */ }
    return;
  }

  const candidates = [
    '[aria-label*="close" i]', '[aria-label*="关闭"]',
    'button:has-text("Accept")', 'button:has-text("同意")',
    'button:has-text("Got it")', 'button:has-text("知道了")',
    'button:has-text("OK")', 'button:has-text("确定")',
    '.modal-close', '.popup-close', '#cookie-accept', '#gdpr-accept',
  ];
  for (const sel of candidates) {
    try {
      const el = await page.$(sel);
      if (el && await el.isVisible()) await el.click();
    } catch { /* element absent — skip */ }
  }
}

// Selectors that indicate a destructive browser action requiring HITL approval.
const DESTRUCTIVE_PATTERNS = [
  /submit/i, /pay/i, /purchase/i, /buy/i, /checkout/i,
  /delete/i, /remove/i, /confirm/i, /\bsend\b/i,
];

function isDestructiveSelector(sel: string): boolean {
  return DESTRUCTIVE_PATTERNS.some(p => p.test(sel));
}

// ── Browser: tool registration ────────────────────────────────────────────────

export function registerBrowserTools(pool: BrowserPool, hitl: HITLConfirmer, cfg: Config): void {
  const maxChars = cfg.browser.maxContentChars;

  // browser_navigate — go to URL, wait for network idle, dismiss popups
  registerTool(
    {
      name: 'browser_navigate',
      description: 'Navigate to a URL and wait for the page to fully load (including JavaScript-rendered content).',
      parameters: {
        type: 'object',
        properties: { url: { type: 'string', description: 'The URL to navigate to' } },
        required: ['url'],
      },
    },
    async (sessionId, params) => {
      const page = await pool.getPage(sessionId);
      // networkidle never fires on pages that continuously poll (e.g. search results);
      // fall back to 'load' so we don't time out on those pages.
      await page.goto(params['url']!, { waitUntil: 'networkidle', timeout: 15000 })
        .catch(() => page.waitForLoadState('load', { timeout: 15000 }));
      await dismissPopups(page);
      const title = await page.title();
      // Inject IDs into DOM first so the returned HTML string and the live DOM share the same numbers.
      await injectLocatorIdsIntoDom(page);
      const html = await page.content();
      const preview = distillHTML(html, 3000); // IDs already in html; distillHTML preserves them
      return `navigated to: ${title}\nurl: ${page.url()}\n\n${preview}`;
    },
  );

  // browser_content — get distilled + locator-tagged page content
  registerTool(
    {
      name: 'browser_content',
      description: 'Get the current page content. Returns distilled HTML with data-agent-id attributes on interactive elements so you can reference them by number in browser_click / browser_type. If the result is truncated, call again with a higher offset to read the next section.',
      parameters: {
        type: 'object',
        properties: {
          mode: { type: 'string', description: 'Output mode: "text" (default) strips all tags; "html" returns simplified HTML with locator IDs' },
          offset: { type: 'string', description: 'Character offset into the distilled content (default 0). Use the offset value shown in the truncation message to read the next chunk of the page.' },
        },
        required: [],
      },
    },
    async (sessionId, params) => {
      const page = await pool.getPage(sessionId);
      const mode = params['mode'] ?? 'html';
      const offsetChars = parseInt(params['offset'] ?? '0', 10);
      if (mode !== 'text') {
        // Inject IDs into live DOM so browser_click/browser_type can resolve them.
        await injectLocatorIdsIntoDom(page);
      }
      const raw = await page.content();
      let result = distillHTML(raw, maxChars, offsetChars);
      if (mode === 'text') {
        // text mode: strip all remaining tags after distillHTML
        result = result.replace(/<[^>]+>/g, ' ').replace(/\s{2,}/g, ' ').trim();
      }
      return result;
    },
  );

  // browser_screenshot — take a viewport screenshot, return data URL
  registerTool(
    {
      name: 'browser_screenshot',
      description: 'Take a screenshot of the current viewport. The image will be attached to the next LLM message for visual analysis.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
    async (sessionId, _params) => {
      const page = await pool.getPage(sessionId);
      const buf = await page.screenshot({ type: 'png', fullPage: false });
      return `data:image/png;base64,${buf.toString('base64')}`;
    },
  );

  // browser_screenshot_annotated — screenshot with numbered red bounding boxes
  registerTool(
    {
      name: 'browser_screenshot_annotated',
      description: 'Take a screenshot with numbered red bounding boxes drawn around all interactive elements (links, buttons, inputs, selects). Use the element numbers with browser_click/browser_type agent_id parameter.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
    async (sessionId, _params) => {
      const page = await pool.getPage(sessionId);

      // Ensure DOM IDs are up-to-date (may not have been set if navigate was the last action).
      await injectLocatorIdsIntoDom(page);

      // Collect bounding boxes, using the DOM's data-agent-id for consistent numbering.
      const elements = await page.evaluate(() => {
        return [...document.querySelectorAll('a, button, input, select, td[role="gridcell"], li[role="option"]')]
          .map((el) => {
            const aid = el.getAttribute('data-agent-id');
            if (!aid) return null;
            const r = el.getBoundingClientRect();
            const label = (
              (el as HTMLElement).innerText?.trim().slice(0, 15) ||
              el.getAttribute('placeholder') ||
              el.getAttribute('aria-label') || ''
            ).trim();
            return { id: parseInt(aid), x: r.x, y: r.y, w: r.width, h: r.height, label };
          })
          .filter((e): e is NonNullable<typeof e> => e !== null && e.w > 0 && e.h > 0);
      });

      // Inject a canvas overlay with red boxes + numbers
      await page.evaluate((elems: Array<{ id: number; x: number; y: number; w: number; h: number }>) => {
        const canvas = document.createElement('canvas');
        canvas.id = '__xclaw_overlay__';
        canvas.style.cssText = 'position:fixed;top:0;left:0;z-index:2147483647;pointer-events:none';
        canvas.width = window.innerWidth;
        canvas.height = window.innerHeight;
        document.body.appendChild(canvas);
        const ctx = canvas.getContext('2d')!;
        for (const e of elems) {
          ctx.strokeStyle = 'red';
          ctx.lineWidth = 2;
          ctx.strokeRect(e.x, e.y, e.w, e.h);
          const labelW = 22;
          ctx.fillStyle = 'red';
          ctx.fillRect(e.x, e.y - 16, labelW, 16);
          ctx.fillStyle = 'white';
          ctx.font = 'bold 11px sans-serif';
          ctx.fillText(String(e.id), e.x + 3, e.y - 3);
        }
      }, elements);

      const buf = await page.screenshot({ type: 'png', fullPage: false });

      // Remove overlay
      await page.evaluate(() => {
        document.getElementById('__xclaw_overlay__')?.remove();
      });

      return `data:image/png;base64,${buf.toString('base64')}`;
    },
  );

  // browser_click — click by agent_id or CSS selector, HITL for destructive actions
  registerTool(
    {
      name: 'browser_click',
      description: 'Click an element. Prefer agent_id (the number from browser_content / browser_screenshot_annotated) over selector.',
      parameters: {
        type: 'object',
        properties: {
          agent_id: { type: 'string', description: 'Element number from browser_content or annotated screenshot' },
          selector: { type: 'string', description: 'CSS selector (fallback when agent_id is unavailable)' },
        },
        required: [],
      },
    },
    async (sessionId, params) => {
      const page = await pool.getPage(sessionId);
      const locator = params['agent_id']
        ? `[data-agent-id="${params['agent_id']}"]`
        : params['selector']!;
      if (!locator) return 'error: provide agent_id or selector';

      const destructive = isDestructiveSelector(locator);
      if (!await hitl.confirm(`browser_click ${locator}`, `url: ${page.url()}`, destructive)) {
        return 'action denied by user';
      }

      const urlBefore = page.url();
      // Start navigation listener BEFORE click so no events are missed.
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'networkidle', timeout: 8000 }).catch(() => null),
        page.click(locator).catch(async () => {
          // Pointer events may be intercepted by a label/span overlay — fall back to JS click.
          await page.evaluate((sel) => {
            (document.querySelector(sel) as HTMLElement | null)?.click();
          }, locator);
        }),
      ]);

      const urlAfter = page.url();
      if (urlBefore !== urlAfter) {
        await dismissPopups(page);
        await injectLocatorIdsIntoDom(page);
        return `clicked: ${locator}\nnavigated to: ${await page.title()}\nurl: ${urlAfter}`;
      }
      // No navigation, but DOM may have changed (dropdown opened, content loaded) — refresh IDs.
      await injectLocatorIdsIntoDom(page);
      return `clicked: ${locator}\nurl: ${urlAfter}`;
    },
  );

  // browser_type — fill text into an input, cleared first
  registerTool(
    {
      name: 'browser_type',
      description: 'Clear an input element and type text into it. Prefer agent_id over selector.',
      parameters: {
        type: 'object',
        properties: {
          agent_id: { type: 'string', description: 'Element number from browser_content or annotated screenshot' },
          selector: { type: 'string', description: 'CSS selector (fallback)' },
          text: { type: 'string', description: 'Text to type' },
        },
        required: ['text'],
      },
    },
    async (sessionId, params) => {
      const page = await pool.getPage(sessionId);
      const locator = params['agent_id']
        ? `[data-agent-id="${params['agent_id']}"]`
        : params['selector']!;
      if (!locator) return 'error: provide agent_id or selector';
      await page.fill(locator, params['text']!);
      // Autocomplete dropdowns appear after typing — refresh IDs so li[role="option"] elements are addressable.
      await injectLocatorIdsIntoDom(page);
      return `typed "${params['text']}" into: ${locator}`;
    },
  );

  // browser_key — press a keyboard key on the focused element or page
  registerTool(
    {
      name: 'browser_key',
      description: 'Press a keyboard key. Use for: Enter (confirm autocomplete selection or submit form), Escape (close popup/dropdown), ArrowDown/ArrowUp (navigate dropdown options), Tab (move focus to next field).',
      parameters: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'Key name: Enter, Escape, Tab, ArrowDown, ArrowUp, ArrowLeft, ArrowRight, Backspace, Space' },
        },
        required: ['key'],
      },
    },
    async (sessionId, params) => {
      const page = await pool.getPage(sessionId);
      const urlBefore = page.url();
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'networkidle', timeout: 8000 }).catch(() => null),
        page.keyboard.press(params['key']!),
      ]);
      const urlAfter = page.url();
      if (urlBefore !== urlAfter) {
        await dismissPopups(page);
        await injectLocatorIdsIntoDom(page);
        return `pressed ${params['key']}\nnavigated to: ${await page.title()}\nurl: ${urlAfter}`;
      }
      await injectLocatorIdsIntoDom(page);
      return `pressed ${params['key']}\nurl: ${urlAfter}`;
    },
  );

  // browser_scroll — scroll the page up or down
  registerTool(
    {
      name: 'browser_scroll',
      description: 'Scroll the page up or down to reveal more content (e.g. for infinite scroll pages).',
      parameters: {
        type: 'object',
        properties: {
          direction: { type: 'string', description: '"up" or "down"' },
          pixels: { type: 'string', description: 'Pixels to scroll (default 500)' },
        },
        required: ['direction'],
      },
    },
    async (sessionId, params) => {
      const page = await pool.getPage(sessionId);
      const px = parseInt(params['pixels'] ?? '500', 10);
      const dy = params['direction'] === 'up' ? -px : px;
      await page.evaluate((d) => window.scrollBy(0, d), dy);
      const scrollY = await page.evaluate(() => window.scrollY);
      return `scrolled ${params['direction']} ${px}px — current scroll position: ${scrollY}px`;
    },
  );
}

// ── Memory tools ──────────────────────────────────────────────────────────────

export function registerMemoryTools(store: MemoryStore): void {
  registerTool(
    {
      name: 'memory_save',
      description: '将重要事实、用户偏好、项目背景保存到长期记忆，以便在未来会话中自动召回。',
      parameters: {
        type: 'object',
        properties: {
          content: { type: 'string', description: '要记住的内容（1-3 句话，简洁完整）' },
          tags: { type: 'string', description: 'JSON 数组字符串，可选标签，如 ["preference","code-style"]' },
        },
        required: ['content'],
      },
    },
    async (sessionId, params) => {
      const content = params['content']!;
      const tags = params['tags'] ? (JSON.parse(params['tags']) as string[]) : [];
      const embedding = await embed(content);
      const id = await store.save({ sessionId, source: 'agent', content, embedding, tags });
      return `memory saved: ${id}`;
    },
  );

  registerTool(
    {
      name: 'memory_search',
      description: '语义搜索长期记忆，返回与查询最相关的历史记录。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '查询文本' },
          top_k: { type: 'string', description: '返回条数（默认 5）' },
        },
        required: ['query'],
      },
    },
    async (_sessionId, params) => {
      const embedding = await embed(params['query']!);
      const topK = parseInt(params['top_k'] ?? '5', 10);
      const results = await store.search(embedding, topK, { source: 'agent' });
      if (results.length === 0) return 'no relevant memories found';
      return results.map((r, i) => `[${i + 1}] ${r.content}`).join('\n');
    },
  );
}

// ── Knowledge-base tools ──────────────────────────────────────────────────────

export function registerKBTools(store: MemoryStore, cfg: Config): void {
  const workDir = path.resolve(cfg.sandbox.workDir);

  registerTool(
    {
      name: 'kb_index',
      description: '将文件批量索引到知识库，支持 .txt / .md 等文本格式。索引后可用 kb_search 语义检索。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '文件路径（workspace 内）' },
          doc_id: { type: 'string', description: '文档标识符，便于后续按文档过滤' },
        },
        required: ['path', 'doc_id'],
      },
    },
    async (_sessionId, params) => {
      const abs = path.resolve(workDir, params['path']!);
      if (!abs.startsWith(path.resolve(workDir))) {
        return `error: path outside workspace`;
      }
      const count = await indexDocument(abs, params['doc_id']!, store);
      return `indexed ${count} chunks from ${params['path']}`;
    },
  );

  registerTool(
    {
      name: 'kb_search',
      description: '在知识库中语义搜索，返回最相关的文档片段。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '搜索问题' },
          top_k: { type: 'string', description: '返回条数（默认 3）' },
          doc_id: { type: 'string', description: '限定文档范围（可选）' },
        },
        required: ['query'],
      },
    },
    async (_sessionId, params) => {
      const embedding = await embed(params['query']!);
      const topK = parseInt(params['top_k'] ?? '3', 10);
      const filter: { source: 'kb'; docId?: string } = { source: 'kb' };
      if (params['doc_id']) filter.docId = params['doc_id'];
      const results = await store.search(embedding, topK, filter);
      if (results.length === 0) return 'no relevant documents found';
      return results.map((r, i) => `[${i + 1}] (doc: ${r.docId ?? '?'})\n${r.content}`).join('\n\n');
    },
  );
}

// ── Multi-agent orchestration tools ──────────────────────────────────────────
// Called by index.ts after registerDefaultWorkers() so the registry is populated.

export function initOrchestratorTools(registry: Map<string, Agent>, sharedDir: string, mode: string): void {
  function getWorker(name: string): Agent | null {
    return registry.get(name) ?? null;
  }

  // ── deliver：将重量级成果文件提交到全局交付区 ────────────────────────────────
  // host 模式：path 为 [Shared delivery dir: ...] 内的绝对路径，直接写宿主机文件系统。
  // full 模式：path 为目标文件名（如 output.ts），content 为文件内容；taskId 从 sessionId 推断。
  registerTool(
    {
      name: 'deliver',
      description: mode === 'full'
        ? '将最终成果文件提交到共享交付区。path: 目标文件名（如 jwt.ts），content: 文件内容。轻量级结果（< 2000 chars）直接放 summary_data，不需要调用此工具。'
        : '将重量级成果文件（源码、报告、diff 等）提交到全局交付区（workspace/shared/）。path 参数使用任务头部 [Shared delivery dir: ...] 提供的绝对路径。轻量级结果直接放 summary_data，不需要调用此工具。',
      parameters: {
        type: 'object',
        properties: {
          path:    { type: 'string', description: mode === 'full' ? '目标文件名，如 output.ts' : '交付文件绝对路径，必须位于 [Shared delivery dir: ...] 目录内' },
          content: { type: 'string', description: '要写入的文件内容' },
        },
        required: ['path', 'content'],
      },
    },
    async (sessionId, params) => {
      if (mode === 'full') {
        // full 模式：从 sub-session ID（格式：parent:workerName:taskId）末段提取 taskId
        const taskId = sessionId.split(':').at(-1) ?? 'unknown';
        const hostDeliveryDir = path.join(sharedDir, taskId);
        const filename = path.basename(params['path']!);
        const hostPath = path.join(hostDeliveryDir, filename);
        await fs.mkdir(hostDeliveryDir, { recursive: true });
        await fs.writeFile(hostPath, params['content']!, 'utf-8');
        return `delivered: ${hostPath}`;
      }
      // host 模式：path 必须在 sharedDir 内
      const deliveryPath = path.resolve(params['path']!);
      const sharedAbs = path.resolve(sharedDir);
      if (!deliveryPath.startsWith(sharedAbs + path.sep) && deliveryPath !== sharedAbs) {
        return `error: path must be inside ${sharedDir}`;
      }
      await fs.mkdir(path.dirname(deliveryPath), { recursive: true });
      await fs.writeFile(deliveryPath, params['content']!, 'utf-8');
      return `delivered: ${deliveryPath}`;
    },
  );

  // ── delegate：委托子任务给指定 Worker ──────────────────────────────────────
  // Worker 回复须为结构化 JSON：{ status, summary_data, artifact_pointers }
  // 大体积成果物由 Worker 调用 deliver 写文件后在 artifact_pointers 中附路径。
  registerTool(
    {
      name: 'delegate',
      description: '将子任务委托给指定的专家 Agent 执行。Worker 返回结构化 JSON：{ status, summary_data（轻量决策数据）, artifact_pointers（重量级文件路径） }。每次调用都是独立会话，Worker 不保留上次历史。子任务描述必须自包含（含足够背景和代码片段）。',
      parameters: {
        type: 'object',
        properties: {
          agent: {
            type: 'string',
            description: '目标 Agent 名称：coder（代码实现）/ reviewer（代码审查）/ writer（文档注释）/ skeptic（批判性分析）/ optimizer（性能优化）',
          },
          task: {
            type: 'string',
            description: '子任务的完整描述。必须自包含：含所有必要背景、代码片段、约束条件。不要用"上面的代码"这类引用。',
          },
        },
        required: ['agent', 'task'],
      },
    },
    async (sessionId, params, onDelta) => {
      const workerName = params['agent']!;
      const worker = getWorker(workerName);
      if (!worker) {
        const available = [...registry.keys()].join(', ');
        return `error: unknown agent "${workerName}". Available: ${available}`;
      }

      const taskId = crypto.randomUUID().slice(0, 6);
      const subSessionId = `${sessionId}:${workerName}:${taskId}`;

      const headers: string[] = [];

      if (mode === 'host') {
        // host 模式：注入任务专属目录路径，Worker 系统 prompt 已包含工具调用格式和返回规则
        const workerDir = worker.agentWorkDir;
        if (workerDir) {
          fsSync.mkdirSync(path.join(workerDir, taskId), { recursive: true });
          headers.push(`[Task workspace: ${path.join(workerDir, taskId)}]`);
        }
        const deliveryDir = path.join(sharedDir, taskId);
        fsSync.mkdirSync(deliveryDir, { recursive: true });
        headers.push(`[Shared delivery dir: ${deliveryDir}]`);
      }
      // full 模式：无宿主机路径可注入；deliver 工具从 sessionId 推断 taskId

      const taskContent = [...headers, params['task']!].join('\n\n');

      const msg = {
        id: crypto.randomUUID(),
        sessionId: subSessionId,
        channel: 'internal',
        content: taskContent,
        timestamp: Date.now(),
        caller: 'agent' as const,
        parentSessionId: sessionId,
      };

      onDelta?.(`\n[${workerName}] working...\n`);
      const result = await worker.handle(msg, (token) => onDelta?.(token));
      onDelta?.(`\n[${workerName}] done\n`);
      return result;
    },
  );

  // ── debate：并行征求多个 Agent 意见 ─────────────────────────────────────────
  registerTool(
    {
      name: 'debate',
      description: '向多个专家 Agent 同时发送同一问题，并行征求意见。适合需要多视角审视的决策（架构选型、风险评估）。返回所有 Agent 的回复，用 --- 分隔。',
      parameters: {
        type: 'object',
        properties: {
          question: {
            type: 'string',
            description: '需要多方意见的问题，必须自包含',
          },
          agents: {
            type: 'string',
            description: 'JSON 数组，参与讨论的 Agent 名称，如 ["coder","reviewer","skeptic"]',
          },
        },
        required: ['question', 'agents'],
      },
    },
    async (sessionId, params, onDelta) => {
      let names: string[];
      try {
        names = JSON.parse(params['agents']!) as string[];
      } catch {
        return 'error: agents must be a JSON array, e.g. ["coder","reviewer"]';
      }

      onDelta?.(`\n[debate] asking ${names.join(', ')} in parallel...\n`);
      const results = await Promise.all(
        names.map(async (name) => {
          const worker = getWorker(name);
          if (!worker) return `[${name}]: not found`;
          const msg = {
            id: crypto.randomUUID(),
            sessionId: `${sessionId}:debate:${name}:${crypto.randomUUID().slice(0, 6)}`,
            channel: 'internal',
            content: params['question']!,
            timestamp: Date.now(),
            caller: 'agent' as const,
            parentSessionId: sessionId,
          };
          onDelta?.(`[${name}] started\n`);
          const reply = await worker.handle(msg, () => {});
          onDelta?.(`[${name}] done\n`);
          return `[${name}]\n${reply}`;
        }),
      );

      return results.join('\n\n---\n\n');
    },
  );

  // ── pipeline：顺序执行多步任务 ───────────────────────────────────────────────
  registerTool(
    {
      name: 'pipeline',
      description: '按顺序执行多个 Agent 任务，前一步输出自动注入下一步（用 {{input}} 占位符引用）。适合数据处理管道、文档转换等流水线场景。',
      parameters: {
        type: 'object',
        properties: {
          steps: {
            type: 'string',
            description: 'JSON 数组，每项格式为 {"agent":"名称","task":"任务描述"}。task 中用 {{input}} 引用上一步输出，第一步的 {{input}} 为空字符串。',
          },
        },
        required: ['steps'],
      },
    },
    async (sessionId, params, onDelta) => {
      let steps: Array<{ agent: string; task: string }>;
      try {
        steps = JSON.parse(params['steps']!) as Array<{ agent: string; task: string }>;
      } catch {
        return 'error: steps must be a JSON array of {agent, task} objects';
      }

      let prevOutput = '';
      for (let i = 0; i < steps.length; i++) {
        const step = steps[i]!;
        const worker = getWorker(step.agent);
        if (!worker) return `error: step ${i + 1}: unknown agent "${step.agent}"`;

        const taskWithInput = step.task.replace(/\{\{input\}\}/g, prevOutput);
        const msg = {
          id: crypto.randomUUID(),
          sessionId: `${sessionId}:pipe:step${i}:${crypto.randomUUID().slice(0, 6)}`,
          channel: 'internal',
          content: taskWithInput,
          timestamp: Date.now(),
          caller: 'agent' as const,
          parentSessionId: sessionId,
        };
        onDelta?.(`\n[pipeline step ${i + 1}/${steps.length}: ${step.agent}]\n`);
        prevOutput = await worker.handle(msg, (token) => onDelta?.(token));
      }

      return prevOutput;
    },
  );
}

// ── JSON parsing helpers ─────────────────────────────────────────────────────

function repairJSON(s: string): string {
  let r = s;
  // Fix invalid escape sequences.
  r = r.replace(/\\([^"\\/bfnrtu\d])/g, '\\\\$1');
  // LLM sometimes writes {"action": "name": {}} instead of {"action": "name"}.
  // Strip the spurious trailing `: <object>` after the action string value.
  r = r.replace(/("action"\s*:\s*"[^"]+")\s*:\s*\{[^}]*\}/g, '$1');
  return r;
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
