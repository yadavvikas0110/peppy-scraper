import type { Browser } from 'playwright';
import { HttpFetcher, isBlockPage, SiteBlockedError } from './http';

/**
 * Local headless Chromium (plain Playwright — no stealth plugin, no proxy, no remote browser).
 * Used only for listing pages whose product grid is rendered client-side (Jumbo).
 * Shares the HTTP fetcher's robots.txt rules and per-host rate limit.
 */
export class LocalBrowser {
  private browser: Promise<Browser> | null = null;
  renders = 0;

  constructor(private readonly http: HttpFetcher, private readonly userAgent: string) {}

  private launch(): Promise<Browser> {
    return this.browser ??= import('playwright').then(pw => pw.chromium.launch({ headless: true }));
  }

  async render(url: string, waitMs = 8000): Promise<string> {
    await this.http.assertAllowed(url);
    await this.http.limiter.wait(new URL(url).host);
    const browser = await this.launch();
    const context = await browser.newContext({ userAgent: this.userAgent, locale: 'en-US' });
    try {
      const page = await context.newPage();
      this.renders++;
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await page.waitForTimeout(waitMs);
      const html = await page.content();
      if (isBlockPage(html)) throw new SiteBlockedError(new URL(url).host, 'anti-bot page in browser');
      return html;
    } finally {
      await context.close().catch(() => {});
    }
  }

  async close(): Promise<void> {
    if (!this.browser) return;
    const b = await this.browser.catch(() => null);
    this.browser = null;
    await b?.close().catch(() => {});
  }
}
