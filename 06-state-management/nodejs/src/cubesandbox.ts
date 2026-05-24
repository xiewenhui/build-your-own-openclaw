export class CubeSandbox {
  private sandboxId = '';
  private apiURL: string;
  private apiKey: string;
  private domain: string;

  private constructor(apiURL: string, apiKey: string, domain: string) {
    this.apiURL = apiURL.replace(/\/$/, '');
    this.apiKey = apiKey;
    this.domain = domain;
  }

  static async create(): Promise<CubeSandbox> {
    const apiURL = process.env['E2B_API_URL'];
    if (!apiURL) throw new Error('E2B_API_URL is not set');
    const templateID = process.env['CUBE_TEMPLATE_ID'];
    if (!templateID) throw new Error('CUBE_TEMPLATE_ID is not set');
    const apiKey = process.env['E2B_API_KEY'] ?? '';

    let domain = process.env['CUBE_SANDBOX_DOMAIN'] ?? '';
    if (!domain) domain = new URL(apiURL).hostname;

    const sb = new CubeSandbox(apiURL, apiKey, domain);
    await sb.init(templateID);
    return sb;
  }

  private async init(templateID: string): Promise<void> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.apiKey) headers['Authorization'] = `Bearer ${this.apiKey}`;

    const resp = await fetch(`${this.apiURL}/sandboxes`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ templateID, timeout: 300 }),
    });
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`create sandbox HTTP ${resp.status}: ${text}`);
    }
    const data = await resp.json() as Record<string, unknown>;
    const id = data['sandboxID'] as string | undefined;
    if (!id) throw new Error('sandboxID missing in create response');
    this.sandboxId = id;
    process.stderr.write(`[cubesandbox] created sandbox ${this.sandboxId}\n`);
  }

  async runCode(code: string): Promise<string> {
    const execURL = `http://49999-${this.sandboxId}.${this.domain}/execute`;
    const resp = await fetch(execURL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, language: 'python' }),
    });
    if (!resp.ok || !resp.body) {
      const text = await resp.text();
      throw new Error(`execute HTTP ${resp.status}: ${text}`);
    }

    const decoder = new TextDecoder();
    let buf = '';
    let out = '';

    for await (const chunk of resp.body as AsyncIterable<Uint8Array>) {
      buf += decoder.decode(chunk, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const event = JSON.parse(trimmed) as Record<string, unknown>;
          if (event['type'] === 'stdout' || event['type'] === 'result') {
            out += (event['text'] as string) ?? '';
          } else if (event['type'] === 'error') {
            const ename = event['ename'] as string ?? 'Error';
            const evalue = event['evalue'] as string ?? '';
            throw new Error(`${ename}: ${evalue}`);
          }
        } catch (e: any) {
          if (e.message.startsWith('Error') || e.message.includes(':')) throw e;
        }
      }
    }
    return out;
  }

  async runCommand(cmd: string): Promise<string> {
    const escaped = JSON.stringify(cmd);
    const code = `
import subprocess as _sp, sys as _sys
_r = _sp.run(${escaped}, shell=True, capture_output=True, text=True)
_sys.stdout.write(_r.stdout)
if _r.stderr:
    _sys.stdout.write(_r.stderr)
if _r.returncode != 0:
    raise SystemExit(_r.returncode)
`;
    return this.runCode(code);
  }

  async kill(): Promise<void> {
    if (!this.sandboxId) return;
    const headers: Record<string, string> = {};
    if (this.apiKey) headers['Authorization'] = `Bearer ${this.apiKey}`;
    await fetch(`${this.apiURL}/sandboxes/${this.sandboxId}`, { method: 'DELETE', headers }).catch(() => {});
    process.stderr.write(`[cubesandbox] killed sandbox ${this.sandboxId}\n`);
    this.sandboxId = '';
  }
}

export class SandboxPool {
  private pool = new Map<string, CubeSandbox>();

  async getOrCreate(sessionId: string): Promise<CubeSandbox> {
    if (!this.pool.has(sessionId)) {
      const sb = await CubeSandbox.create();
      this.pool.set(sessionId, sb);
      process.stderr.write(`[pool] session ${sessionId} → sandbox created\n`);
    }
    return this.pool.get(sessionId)!;
  }

  async killAll(): Promise<void> {
    for (const [, sb] of this.pool) {
      await sb.kill().catch(() => {});
    }
    this.pool.clear();
  }
}
