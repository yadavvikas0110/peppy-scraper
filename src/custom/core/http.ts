import { ALLOW_ALL, isAllowed, parseRobots, RobotsRules } from './robots';
import type { FetchResult } from './types';

/** The site refused us (anti-bot page, 403/429 storm) — stop scraping that site for this run. */
export class SiteBlockedError extends Error {
  constructor(public readonly host: string, reason: string) {
    super(`Blocked by ${host}: ${reason}`);
    this.name = 'SiteBlockedError';
  }
}

/** robots.txt disallows the URL — never fetched. */
export class RobotsDisallowedError extends Error {
  constructor(url: string) {
    super(`robots.txt disallows ${url}`);
    this.name = 'RobotsDisallowedError';
  }
}

const BLOCK_TITLE_RE = /^\s*(access denied|attention required|just a moment|are you a robot|pardon our interruption|request blocked|captcha)/i;

/** Anti-bot interstitials (Cloudflare, Akamai, captchas) — not a real page. */
export function isBlockPage(html: string): boolean {
  const title = html.match(/<title[^>]*>([^<]*)/i)?.[1] ?? '';
  return BLOCK_TITLE_RE.test(title) || (html.length < 3000 && /errors\.edgesuite\.net|cf-chl-|captcha-delivery/i.test(html));
}

/** Spaces requests to one host at least `minIntervalMs` apart, also across concurrent callers. */
export class HostRateLimiter {
  private nextSlot = new Map<string, number>();
  constructor(
    private readonly minIntervalMs: number,
    private readonly now: () => number = Date.now,
    private readonly sleep: (ms: number) => Promise<void> = ms => new Promise(r => setTimeout(r, ms)),
  ) {}

  async wait(host: string): Promise<void> {
    const t = this.now();
    const slot = Math.max(t, this.nextSlot.get(host) ?? 0);
    this.nextSlot.set(host, slot + this.minIntervalMs);
    if (slot > t) await this.sleep(slot - t);
  }
}

export interface HttpOptions {
  userAgent: string;
  minIntervalMs: number;
  timeoutMs: number;
  maxRetries: number;
  respectRobots: boolean;
}

type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

export class HttpFetcher {
  private robots = new Map<string, Promise<RobotsRules>>();
  readonly limiter: HostRateLimiter;
  /** Requests actually sent (robots.txt included) — reported per run */
  requests = 0;

  constructor(
    private readonly opts: HttpOptions,
    private readonly fetchFn: FetchFn = (u, i) => fetch(u, i),
    private readonly sleep: (ms: number) => Promise<void> = ms => new Promise(r => setTimeout(r, ms)),
  ) {
    this.limiter = new HostRateLimiter(opts.minIntervalMs, Date.now, sleep);
  }

  private headers(accept: string): Record<string, string> {
    return { 'User-Agent': this.opts.userAgent, Accept: accept, 'Accept-Language': 'en-US,en;q=0.9' };
  }

  /**
   * robots.txt per origin, cached. 4xx → no rules (allow all, as RFC 9309 says);
   * unreachable or 5xx → disallow everything, so we never crawl a site whose rules we could not read.
   */
  rulesFor(origin: string): Promise<RobotsRules> {
    let p = this.robots.get(origin);
    if (!p) {
      p = (async () => {
        const host = new URL(origin).host;
        await this.limiter.wait(host);
        this.requests++;
        try {
          const res = await this.fetchFn(`${origin}/robots.txt`, {
            headers: this.headers('text/plain,*/*'), redirect: 'follow', signal: AbortSignal.timeout(this.opts.timeoutMs),
          });
          if (res.status >= 400 && res.status < 500) return ALLOW_ALL;
          if (res.status >= 500) return { allow: [], disallow: ['/'] };
          return parseRobots(await res.text());
        } catch (e: any) {
          console.warn(`[custom] robots.txt for ${origin} unreachable (${e.message}) — treating the site as disallowed`);
          return { allow: [], disallow: ['/'] };
        }
      })();
      this.robots.set(origin, p);
    }
    return p;
  }

  async assertAllowed(url: string): Promise<void> {
    if (!this.opts.respectRobots) return;
    const u = new URL(url);
    const rules = await this.rulesFor(u.origin);
    if (!isAllowed(rules, u.pathname + u.search)) throw new RobotsDisallowedError(url);
  }

  async get(url: string, accept = 'text/html,application/xhtml+xml,*/*;q=0.8'): Promise<FetchResult> {
    await this.assertAllowed(url);
    const host = new URL(url).host;
    let lastErr: Error = new Error('unknown');

    for (let attempt = 0; attempt <= this.opts.maxRetries; attempt++) {
      await this.limiter.wait(host);
      this.requests++;
      try {
        const res = await this.fetchFn(url, {
          headers: this.headers(accept), redirect: 'follow', signal: AbortSignal.timeout(this.opts.timeoutMs),
        });
        const body = await res.text();
        if (isBlockPage(body)) throw new SiteBlockedError(host, `anti-bot page (HTTP ${res.status})`);
        if (res.status === 429 || res.status >= 500) {
          lastErr = new Error(`HTTP ${res.status} for ${url}`);
        } else {
          return { url: res.url || url, status: res.status, body };
        }
      } catch (e: any) {
        if (e instanceof SiteBlockedError) throw e;
        lastErr = e;
      }
      if (attempt < this.opts.maxRetries) await this.sleep(2000 * 2 ** attempt);
    }
    throw lastErr;
  }
}
