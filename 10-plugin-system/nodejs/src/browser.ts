import { chromium } from 'playwright';
import type { Browser, BrowserContext, Page } from 'playwright';
import type { Config } from './config.ts';

export class BrowserPool {
  private browser!: Browser;
  private contexts = new Map<string, { ctx: BrowserContext; page: Page }>();
  private cfg: Config['browser'];

  constructor(cfg: Config['browser']) {
    this.cfg = cfg;
  }

  async init(): Promise<void> {
    this.browser = await chromium.launch({ headless: this.cfg.headless });
  }

  async getPage(sessionId: string): Promise<Page> {
    if (!this.contexts.has(sessionId)) {
      const ctx = await this.browser.newContext({
        viewport: this.cfg.viewport,
        userAgent: 'Mozilla/5.0 (compatible; xclaw-agent/1.0)',
      });
      const page = await ctx.newPage();
      this.contexts.set(sessionId, { ctx, page });
    }
    return this.contexts.get(sessionId)!.page;
  }

  async closeSession(sessionId: string): Promise<void> {
    const entry = this.contexts.get(sessionId);
    if (entry) {
      await entry.ctx.close();
      this.contexts.delete(sessionId);
    }
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.contexts.values()].map(e => e.ctx.close().catch(() => {})));
    this.contexts.clear();
    await this.browser.close().catch(() => {});
  }
}
