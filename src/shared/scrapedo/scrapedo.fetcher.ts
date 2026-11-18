import { createScrapeDoClient, ScrapeDoClient } from './scrapedo.client';
import { ScrapeDoError } from './scrapedo.errors';
import { PageKind, Rung, rungsFor } from './scrapedo.profiles';

/**
 * Profile-driven Scrape.do fetch with the retry rules every pipeline shares:
 *
 *  1. Try the platform's rungs in order (cheapest working option first, see scrapedo.profiles.ts).
 *     Each rung has its own Scrape.do timeout, and our client does not retry on top (maxRetries 0),
 *     so a dead option costs one timeout, not three.
 *  2. Move to the next rung on: timeout, shop-side 5xx, network error, 403/429, an anti-bot page,
 *     or a page the caller's `isUsable` check rejects.
 *  3. Stop immediately on: Scrape.do account problems (bad token, credits used up) → ScrapeDoAccountError,
 *     which ends the whole run with a clear reason; and 404/410 → ScrapeDoNotFoundError (the product is gone,
 *     a better proxy will not bring it back).
 *  4. When every rung failed and at least one failure was temporary, wait and retry the cheapest such
 *     rung once.
 *  5. Circuit breaker per platform: after N consecutive failed pages the platform is paused for a
 *     cool-down, so a site that is down or blocking does not burn time and credits.
 *
 * Failed requests are not charged by Scrape.do; `credits` counts the Scrape.do-Request-Cost of
 * successful responses only.
 */

export class ScrapeDoAccountError extends Error {
  constructor(message: string) { super(message); this.name = 'ScrapeDoAccountError'; }
}
export class ScrapeDoNotFoundError extends Error {
  constructor(message: string) { super(message); this.name = 'ScrapeDoNotFoundError'; }
}
/** The page loads normally on two options but our parser can't read it: fix the parser, don't buy pricier IPs. */
export class ScrapeDoUnreadablePageError extends Error {
  constructor(message: string) { super(message); this.name = 'ScrapeDoUnreadablePageError'; }
}
export class ScrapeDoCircuitOpenError extends Error {
  constructor(message: string) { super(message); this.name = 'ScrapeDoCircuitOpenError'; }
}

export interface AttemptLog { rung: string; ok: boolean; credits: number; ms: number; reason?: string }

export interface ProfiledFetchResult {
  html: string;
  finalUrl: string;
  platform: string;
  rung: string;
  credits: number;
  attempts: AttemptLog[];
  durationMs: number;
}

export interface ProfiledFetchOptions {
  kind: PageKind;
  /** Extra check that the page holds the data the caller needs (e.g. the parser found products). */
  isUsable?: (html: string, finalUrl: string) => boolean;
}

export interface ScrapeDoUsage {
  pages: number;
  failedPages: number;
  credits: number;
  byPlatform: Record<string, { pages: number; failedPages: number; credits: number; rungs: Record<string, number> }>;
}

export interface ProfiledFetcherDeps {
  client?: Pick<ScrapeDoClient, 'fetchHtml'>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  logger?: Pick<Console, 'log' | 'warn'>;
  /** Consecutive failed pages before a platform pauses (default 5, env SCRAPE_DO_BREAKER_FAILURES) */
  breakerFailures?: number;
  /** Pause length in ms (default 5 min, env SCRAPE_DO_BREAKER_COOLDOWN_MS) */
  breakerCooldownMs?: number;
  /** Wait before the final retry of a temporary failure (default 5 s) */
  retryDelayMs?: number;
}

const BLOCK_TITLE_RE = /^\s*(access denied|attention required|just a moment|are you a robot|pardon our interruption|request blocked|captcha)/i;

export function looksBlocked(html: string): boolean {
  const title = html.match(/<title[^>]*>([^<]*)/i)?.[1] ?? '';
  return BLOCK_TITLE_RE.test(title) || (html.length < 3000 && /errors\.edgesuite\.net|cf-chl-|captcha-delivery/i.test(html));
}

type Outcome = 'escalate' | 'temporary' | 'account' | 'not-found' | 'unreadable';

function classify(e: unknown): { outcome: Outcome; reason: string } {
  if (e instanceof ScrapeDoError) {
    const status = e.statusCode ?? e.initialStatusCode;
    if (e.category === 'auth' || e.category === 'quota' || e.category === 'config') return { outcome: 'account', reason: e.message };
    if (status === 404 || status === 410) return { outcome: 'not-found', reason: `HTTP ${status}` };
    if (e.category === 'timeout' || e.category === 'target_5xx' || e.category === 'network') return { outcome: 'temporary', reason: e.message };
    return { outcome: 'escalate', reason: e.message }; // blocked, 403, 429, other 4xx, bad response
  }
  return { outcome: 'temporary', reason: String((e as any)?.message ?? e) };
}

const num = (v: string | undefined, d: number) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : d; };

export function createProfiledFetcher(deps: ProfiledFetcherDeps = {}) {
  const client = deps.client ?? createScrapeDoClient({ logger: { log() {}, warn() {}, error() {} } as any });
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)));
  const now = deps.now ?? (() => Date.now());
  const logger = deps.logger ?? console;
  const breakerFailures = deps.breakerFailures ?? num(process.env.SCRAPE_DO_BREAKER_FAILURES, 5);
  const breakerCooldownMs = deps.breakerCooldownMs ?? num(process.env.SCRAPE_DO_BREAKER_COOLDOWN_MS, 5 * 60_000);
  const retryDelayMs = deps.retryDelayMs ?? 5000;

  const breaker = new Map<string, { failures: number; openUntil: number }>();
  const usage: ScrapeDoUsage = { pages: 0, failedPages: 0, credits: 0, byPlatform: {} };
  const platformUsage = (key: string) => (usage.byPlatform[key] ??= { pages: 0, failedPages: 0, credits: 0, rungs: {} });

  async function attempt(url: string, rung: Rung, opts: ProfiledFetchOptions, log: AttemptLog[]) {
    const t0 = now();
    try {
      const res = await client.fetchHtml(url, { ...rung.options, timeout: rung.timeoutMs ?? 60_000, client: { maxRetries: 0 } });
      const credits = res.requestCost ?? 0;
      const finalUrl = res.finalUrl || url;
      if (looksBlocked(res.html)) {
        log.push({ rung: rung.label, ok: false, credits, ms: now() - t0, reason: 'anti-bot page' });
        return { ok: false as const, credits, outcome: 'escalate' as Outcome };
      }
      if (opts.isUsable && !opts.isUsable(res.html, finalUrl)) {
        log.push({ rung: rung.label, ok: false, credits, ms: now() - t0, reason: 'page without the expected data' });
        return { ok: false as const, credits, outcome: 'unreadable' as Outcome };
      }
      log.push({ rung: rung.label, ok: true, credits, ms: now() - t0 });
      return { ok: true as const, credits, html: res.html, finalUrl };
    } catch (e) {
      const { outcome, reason } = classify(e);
      log.push({ rung: rung.label, ok: false, credits: 0, ms: now() - t0, reason: reason.slice(0, 160) });
      return { ok: false as const, credits: 0, outcome };
    }
  }

  async function fetch(url: string, opts: ProfiledFetchOptions): Promise<ProfiledFetchResult> {
    const { key, name, rungs } = rungsFor(url, opts.kind);
    const state = breaker.get(key) ?? { failures: 0, openUntil: 0 };
    breaker.set(key, state);
    if (state.openUntil > now()) {
      throw new ScrapeDoCircuitOpenError(`${name} paused after ${state.failures} failed pages in a row (resumes in ${Math.ceil((state.openUntil - now()) / 1000)} s)`);
    }

    const started = now();
    const log: AttemptLog[] = [];
    let credits = 0;
    let firstTemporary: Rung | null = null;
    let unreadable = 0;

    const succeed = (rung: Rung, html: string, finalUrl: string): ProfiledFetchResult => {
      state.failures = 0;
      const pu = platformUsage(key);
      usage.pages++; usage.credits += credits; pu.pages++; pu.credits += credits;
      pu.rungs[rung.label] = (pu.rungs[rung.label] ?? 0) + 1;
      return { html, finalUrl, platform: key, rung: rung.label, credits, attempts: log, durationMs: now() - started };
    };

    for (const rung of rungs) {
      const r = await attempt(url, rung, opts, log);
      credits += r.credits;
      if (r.ok) return succeed(rung, r.html, r.finalUrl);
      if (r.outcome === 'account') throw new ScrapeDoAccountError(`Scrape.do account problem: ${log[log.length - 1].reason}`);
      if (r.outcome === 'not-found') { usage.credits += credits; platformUsage(key).credits += credits; throw new ScrapeDoNotFoundError(`${url} no longer exists (${log[log.length - 1].reason})`); }
      if (r.outcome === 'temporary' && !firstTemporary) firstTemporary = rung;
      if (r.outcome === 'unreadable' && ++unreadable >= 2) {
        const pu = platformUsage(key);
        usage.failedPages++; usage.credits += credits; pu.failedPages++; pu.credits += credits;
        throw new ScrapeDoUnreadablePageError(`${name}: ${url} loads but our parser can't read it (${unreadable} options tried) — check the parser`);
      }
    }

    if (firstTemporary) {
      await sleep(retryDelayMs);
      const r = await attempt(url, firstTemporary, opts, log);
      credits += r.credits;
      if (r.ok) return succeed(firstTemporary, r.html, r.finalUrl);
      if (r.outcome === 'account') throw new ScrapeDoAccountError(`Scrape.do account problem: ${log[log.length - 1].reason}`);
    }

    state.failures++;
    const pu = platformUsage(key);
    usage.failedPages++; usage.credits += credits; pu.failedPages++; pu.credits += credits;
    if (state.failures >= breakerFailures) {
      state.openUntil = now() + breakerCooldownMs;
      logger.warn(`[scrape.do] ${name}: ${state.failures} failed pages in a row — pausing ${Math.round(breakerCooldownMs / 1000)} s`);
    }
    const summary = log.map(a => `${a.rung}: ${a.reason ?? 'ok'}`).join(' | ');
    throw new Error(`Scrape.do could not fetch ${url} (${summary})`);
  }

  return {
    fetch,
    usage: (): ScrapeDoUsage => JSON.parse(JSON.stringify(usage)),
    /** For tests and admin "reset": close every open circuit */
    resetBreakers: () => breaker.clear(),
  };
}

export type ProfiledFetcher = ReturnType<typeof createProfiledFetcher>;

let shared: ProfiledFetcher | null = null;
/** One fetcher per process, so usage and circuit breakers are shared across pipelines. */
export function sharedProfiledFetcher(): ProfiledFetcher {
  return (shared ??= createProfiledFetcher());
}
