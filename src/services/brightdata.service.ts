import axios from 'axios';
import { chromium, Browser } from 'playwright';
import { parseNoon } from '../parsers/noon.parser';
import { parseCarrefour } from '../parsers/carrefour.parser';
import { parseSharafDG } from '../parsers/sharafdg.parser';
import { parseAmazon } from '../parsers/amazon.parser';
import { parseJumbo } from '../parsers/jumbo.parser';
import { parseMumzworld } from '../parsers/mumzworld.parser';
import { parseNamshi } from '../parsers/namshi.parser';
import { ProductData } from '../parsers/types';
import { Semaphore } from '../utils/semaphore';

// ─── Config ──────────────────────────────────────────────────────────────────

function getApiKey(): string {
  const key = process.env.BRIGHT_DATA_API_KEY;
  if (!key) throw new Error('BRIGHT_DATA_API_KEY is not set');
  return key;
}

function getBrowserEndpoint(): string {
  const auth = process.env.BRIGHT_DATA_BROWSER_AUTH;
  if (!auth) throw new Error('BRIGHT_DATA_BROWSER_AUTH is not set');
  return `wss://${auth}@brd.superproxy.io:9222`;
}

const UNLOCKER_ZONE = () => process.env.BRIGHT_DATA_UNLOCKER_ZONE || 'web_unlocker1';

const CONNECT_TIMEOUT_MS = 30000;

// ─── Singleton browser pool ───────────────────────────────────────────────────

// Concurrency caps — tunable via env vars. Created on first use so values from
// .env apply even when dotenv loads after this module is imported.
let _pageSemaphore: Semaphore | null = null;
let _unlockSemaphore: Semaphore | null = null;

function pageSemaphore(): Semaphore {
  return _pageSemaphore ??= new Semaphore(parseInt(process.env.BD_BROWSER_CONCURRENCY || '8', 10));
}

function unlockSemaphore(): Semaphore {
  return _unlockSemaphore ??= new Semaphore(parseInt(process.env.BD_UNLOCKER_CONCURRENCY || '20', 10));
}

// ─── Blocked hosts ────────────────────────────────────────────────────────────

// Bright Data refuses some domains (robots.txt / KYC). Retrying never helps, so once a
// host is refused every later request to it fails fast for the rest of the process.
const ACCESS_DENIED_RE = /restricted in accordance with robots\.txt|start a KYC application|access_denied|requires KYC/i;
const blockedHosts = new Map<string, string>();

export function isAccessDeniedError(message: string): boolean {
  return ACCESS_DENIED_RE.test(message);
}

function assertHostAllowed(url: string): void {
  const host = new URL(url).hostname;
  const reason = blockedHosts.get(host);
  if (reason) throw new Error(`Host blocked by Bright Data (${host}): ${reason}`);
}

function recordAccessDenied(url: string, err: any): void {
  if (!isAccessDeniedError(err?.message ?? '')) return;
  const host = new URL(url).hostname;
  if (!blockedHosts.has(host)) {
    blockedHosts.set(host, 'robots.txt/KYC restriction');
    console.warn(`[BD] ${host} is restricted by Bright Data (robots.txt/KYC) — skipping it for the rest of this run`);
  }
}

// One Scraping Browser session per hostname: a session that visits several sites fails
// with navigate_domains_limit, and sites are scraped in parallel.
const _browsers = new Map<string, Browser>();
const _connecting = new Map<string, Promise<Browser>>();

// Pages still in flight on a forgotten session get this long before it is closed
const RETIRED_SESSION_GRACE_MS = 90000;

async function getBrowserFor(host: string): Promise<Browser> {
  const existing = _browsers.get(host);
  if (existing?.isConnected()) return existing;
  // Concurrent callers share one connect attempt; a failure rejects all of them.
  const pending = _connecting.get(host);
  if (pending) return pending;

  const attempt = (async () => {
    console.log(`[BD Browser] Connecting to Scraping Browser for ${host}...`);
    let browser: Browser;
    try {
      browser = await chromium.connectOverCDP(getBrowserEndpoint(), { timeout: CONNECT_TIMEOUT_MS });
    } catch (e: any) {
      // Playwright error text includes the endpoint URL, which carries the zone password
      const auth = process.env.BRIGHT_DATA_BROWSER_AUTH;
      const message = String(e?.message ?? e);
      throw new Error(`[BD Browser] Connect failed: ${auth ? message.split(auth).join('***') : message}`);
    }
    browser.on('disconnected', () => {
      console.warn(`[BD Browser] Session for ${host} disconnected — will reconnect on next request`);
      if (_browsers.get(host) === browser) _browsers.delete(host);
    });
    console.log(`[BD Browser] Connected (${host}).`);
    _browsers.set(host, browser);
    return browser;
  })();

  _connecting.set(host, attempt);
  try {
    return await attempt;
  } finally {
    _connecting.delete(host);
  }
}

// Stop handing out a session; close it once in-flight pages on it have had time to finish
function retireBrowser(host: string): void {
  const browser = _browsers.get(host);
  if (!browser) return;
  _browsers.delete(host);
  setTimeout(() => { browser.close().catch(() => {}); }, RETIRED_SESSION_GRACE_MS).unref();
}

export async function closeBrowserPool(): Promise<void> {
  const all = [..._browsers.values()];
  _browsers.clear();
  await Promise.all(all.map(b => b.close().catch(() => {})));
}

/** Forget the session for `url`'s host (or every session) so the next request reconnects. */
export function resetBrowser(url?: string): void {
  const hosts = url ? [new URL(url).hostname] : [..._browsers.keys()];
  hosts.forEach(retireBrowser);
}

// ─── Unlocker API ─────────────────────────────────────────────────────────────

export async function fetchHTMLViaUnlocker(targetUrl: string): Promise<string> {
  assertHostAllowed(targetUrl);
  return unlockSemaphore().wrap(async () => {
    const response = await axios.post(
      'https://api.brightdata.com/request',
      { zone: UNLOCKER_ZONE(), url: targetUrl, format: 'raw' },
      {
        headers: {
          Authorization: `Bearer ${getApiKey()}`,
          'Content-Type': 'application/json',
        },
        timeout: 90000,
        responseType: 'text',
        validateStatus: () => true,
      }
    );

    if (response.status !== 200) {
      const err = new Error(`Unlocker API ${response.status}: ${String(response.data).slice(0, 200)}`);
      recordAccessDenied(targetUrl, err);
      throw err;
    }

    return typeof response.data === 'string' ? response.data : JSON.stringify(response.data);
  });
}

// ─── Scraping Browser ─────────────────────────────────────────────────────────

export async function fetchHTMLViaBrowser(
  targetUrl: string,
  waitSelector?: string,
  waitMs = 10000
): Promise<string> {
  assertHostAllowed(targetUrl);
  return pageSemaphore().wrap(async () => {
    const browser = await getBrowserFor(new URL(targetUrl).hostname);
    // Isolated context per request: prevents cookies/cache leaking between concurrent scrapes
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 60000 })
        .catch((e: any) => { recordAccessDenied(targetUrl, e); throw e; });

      if (waitSelector) {
        await page.waitForSelector(waitSelector, { timeout: waitMs }).catch(() => {});
      } else {
        await page.waitForTimeout(waitMs);
      }

      return await page.content();
    } finally {
      await context.close().catch(() => {});
    }
  });
}

// Returns HTML + JS-evaluated structured data for sites that need it
export async function fetchHTMLWithEval<T>(
  targetUrl: string,
  evaluator: (page: import('playwright').Page) => Promise<T>,
  waitSelector?: string,
  waitMs = 10000
): Promise<{ html: string; evaluated: T }> {
  assertHostAllowed(targetUrl);
  return pageSemaphore().wrap(async () => {
    const browser = await getBrowserFor(new URL(targetUrl).hostname);
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 60000 })
        .catch((e: any) => { recordAccessDenied(targetUrl, e); throw e; });

      if (waitSelector) {
        await page.waitForSelector(waitSelector, { timeout: waitMs }).catch(() => {});
      } else {
        await page.waitForTimeout(waitMs);
      }

      const [html, evaluated] = await Promise.all([
        page.content(),
        evaluator(page),
      ]);
      return { html, evaluated };
    } finally {
      await context.close().catch(() => {});
    }
  });
}

// ─── Retry wrapper ────────────────────────────────────────────────────────────

async function withRetry<T>(
  url: string,
  fn: () => Promise<T>,
  maxAttempts = 3,
  baseDelayMs = 2000
): Promise<T> {
  let lastErr: Error = new Error('unknown');
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (e: any) {
      lastErr = e;
      // Routing/tunnel failures, navigation timeouts and access refusals — retrying won't help
      const isRoutingErr = /no_peer|probe_timeout|a2a_tun_open|a2a_exception|ERR_TUNNEL_CONNECTION_FAILED|Timeout \d+ms exceeded|Host blocked by Bright Data/i.test(e.message)
        || isAccessDeniedError(e.message);
      if (isRoutingErr) {
        throw e;
      }
      const isConnErr = /ENOTFOUND|ECONNRESET|ECONNREFUSED|WebSocket|disconnected|domain limit/i.test(e.message);
      if (isConnErr) {
        resetBrowser(url);
      }
      if (attempt < maxAttempts - 1) {
        const delay = baseDelayMs * Math.pow(2, attempt);
        console.warn(`[BD] Attempt ${attempt + 1} failed (${e.message}) — retrying in ${delay}ms`);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }
  throw lastErr;
}

// ─── Site selectors for product pages ────────────────────────────────────────

const PRODUCT_WAIT: Record<string, string> = {
  'noon.com':          'h1',
  'carrefouruae.com':  'h1',
  'sharafdg.com':      'h1, meta[itemprop="price"]',
  'jumbo.ae':          'h1, meta[itemprop="price"]',
  'mumzworld.com':     'h1, meta[itemprop="price"]',
  'namshi.com':        'h1',
};

// ─── Public scraping entry point ──────────────────────────────────────────────

export async function scrapeProductBD(url: string): Promise<ProductData> {
  const hostname = new URL(url).hostname;

  // Amazon: server-rendered, Unlocker works great
  if (hostname.includes('amazon.ae')) {
    return withRetry(url, async () => {
      const html = await fetchHTMLViaUnlocker(url);
      return parseAmazon(html, url);
    });
  }

  // JS-heavy sites: need Scraping Browser
  const waitSel = Object.entries(PRODUCT_WAIT).find(([h]) => hostname.includes(h))?.[1];

  return withRetry(url, async () => {
    if (hostname.includes('carrefouruae.com')) {
      // Carrefour: some products don't embed price in RSC payload.
      // Use page.evaluate() to read price from the rendered DOM.
      const { html, evaluated } = await fetchHTMLWithEval(
        url,
        (page) => page.evaluate(() => {
          // Get the rendered HTML and find the first AED price before any related-products section.
          // Carrefour renders a product details block first, then related/recommended products.
          const html = document.body.innerHTML;
          const stopMarkers = [
            'Related Products', 'You Might Also Like',
            'Customers Also Bought', 'Recently Viewed',
            'Frequently Bought', 'Sponsored', 'See all',
          ];
          let cutoff = html.length;
          for (const marker of stopMarkers) {
            const idx = html.indexOf(marker);
            if (idx > 0 && idx < cutoff) cutoff = idx;
          }
          const productSection = html.slice(0, cutoff);
          // Find all "AED NNN" patterns in the product section
          const matches = [...productSection.matchAll(/AED[^<\d]{0,3}([\d,]+\.?\d*)/g)];
          if (!matches.length) return null;
          // The first price in the product section is the current product price
          const firstPrice = matches[0][1].replace(/,/g, '');
          const num = parseFloat(firstPrice);
          // Sanity check: price must be between 1 and 100000 AED
          if (isNaN(num) || num < 1 || num > 100000) return null;
          return String(num);
        }),
        waitSel,
        12000
      );
      const product = parseCarrefour(html, url);
      if (product.price === null && evaluated) {
        product.price = parseFloat(evaluated);
        product.currency = 'AED';
      }
      return product;
    }

    // mumzworld: Magento — Unlocker is cheaper/faster; browser only if Unlocker fails
    if (hostname.includes('mumzworld.com')) {
      const html = await fetchHTMLViaUnlocker(url);
      return parseMumzworld(html, url);
    }

    // SharafDG: try Unlocker first (server-renders key fields), browser as fallback
    if (hostname.includes('sharafdg.com')) {
      try {
        const html = await fetchHTMLViaUnlocker(url);
        const product = parseSharafDG(html, url);
        if (product.price !== null) return product;
        throw new Error('Unlocker: price missing — falling back to browser');
      } catch (unlockerErr: any) {
        console.warn(`[sharafdg] Unlocker failed (${unlockerErr.message}) — trying browser`);
        const html = await fetchHTMLViaBrowser(url, waitSel, 10000);
        return parseSharafDG(html, url);
      }
    }

    const html = await fetchHTMLViaBrowser(url, waitSel, 10000);

    if (hostname.includes('noon.com')) return parseNoon(html, url);
    if (hostname.includes('jumbo.ae')) return parseJumbo(html, url);
    if (hostname.includes('namshi.com')) return parseNamshi(html, url);

    throw new Error(`Unsupported site: ${hostname}`);
  });
}
