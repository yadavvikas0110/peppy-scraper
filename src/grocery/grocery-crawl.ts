import { fetchHTMLViaUnlocker } from '../services/brightdata.service';
import { pushToDatabase } from '../cron/push-pipeline';
import { acquireLock, releaseLock, clearStopSignal, shouldStop as stopFileSet } from '../utils/stop-signal';
import { BundledProduct } from '../parsers/types';
import { parseAreaStoreRefs, parseStoreSubcategories, parseTalabatGrocery } from './talabat-grocery.parser';
import { itemToBundle } from './talabat-grocery.collector';
import {
  DubaiArea,
  GROCERY_CRAWL_DEFAULTS,
  TALABAT_ORIGIN,
  TALABAT_RETAILER_ID,
  TALABAT_RETAILER_NAME,
  resolveDubaiAreas,
} from './talabat-grocery.config';
import type { StoreRef } from './talabat-grocery.types';

export interface GroceryCrawlOptions {
  areas?: DubaiArea[];
  /** Hard cap on Bright Data requests (budget guard). */
  maxRequests?: number;
  /** Limit stores crawled — use a small value (e.g. 1) for a cheap smoke run. */
  maxStores?: number;
  pushBatchSize?: number;
  /** When true, scrape + map but write nothing to the DB. */
  dryRun?: boolean;
  fetchHtml?: (url: string) => Promise<string>;
  logger?: Pick<Console, 'log' | 'warn' | 'error'>;
  now?: Date;
  /** Cooperative stop (e.g. from /api/grocery/stop). */
  shouldStop?: () => boolean;
}

export interface GroceryCrawlProgress {
  areasScanned: number;
  storesFound: number;
  storesCrawled: number;
  subcategories: number;
  pagesFetched: number;
  itemsSeen: number;
  productsPushed: number;
  requests: number;
  capReached: boolean;
  stopped: boolean;
  errors: string[];
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function humanize(slug: string): string {
  return slug.replace(/[-_]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase()).trim() || 'Groceries';
}

function areaUrl(area: DubaiArea, page: number): string {
  const base = `${TALABAT_ORIGIN}/uae/groceries/${area.id}/${area.slug}`;
  return page > 1 ? `${base}?page=${page}` : base;
}

function subcategoryUrl(storeUrl: string, categorySlug: string, subCategorySlug: string, aid: string, page: number): string {
  const base = `${storeUrl}/${categorySlug}/${subCategorySlug}?aid=${aid}`;
  return page > 1 ? `${base}&page=${page}` : base;
}

/**
 * Full Talabat (Dubai) grocery crawl, designed to run on the server:
 *   areas → stores (deduped) → subcategories → paginated product listings → products_clean.
 * Self-discovering (reads each store's category tree + each listing's pageCount), budget-capped,
 * idempotent (re-runs upsert, so a re-trigger safely resumes/refreshes), and stoppable.
 */
export async function crawlTalabatGrocery(opts: GroceryCrawlOptions = {}): Promise<GroceryCrawlProgress> {
  const d = GROCERY_CRAWL_DEFAULTS;
  const areas = opts.areas ?? resolveDubaiAreas();
  const maxRequests = opts.maxRequests ?? d.maxRequests;
  const maxStores = opts.maxStores ?? Infinity;
  const pushBatchSize = opts.pushBatchSize ?? d.pushBatchSize;
  const dryRun = opts.dryRun ?? false;
  const fetchHtml = opts.fetchHtml ?? fetchHTMLViaUnlocker;
  const logger = opts.logger ?? console;
  const observedAt = (opts.now ?? new Date()).toISOString();
  const shouldStop = opts.shouldStop ?? (() => false);

  const p: GroceryCrawlProgress = {
    areasScanned: 0, storesFound: 0, storesCrawled: 0, subcategories: 0, pagesFetched: 0,
    itemsSeen: 0, productsPushed: 0, requests: 0, capReached: false, stopped: false, errors: [],
  };

  const buffer: BundledProduct[] = [];
  const pushedSkus = new Set<string>();

  // fetch wrapper: enforces the budget cap + a polite delay, counts every request.
  const get = async (url: string): Promise<string | null> => {
    if (p.requests >= maxRequests) { p.capReached = true; return null; }
    if (shouldStop()) { p.stopped = true; return null; }
    p.requests++;
    try {
      const html = await fetchHtml(url);
      if (d.requestDelayMs > 0) await sleep(d.requestDelayMs);
      return html;
    } catch (e: any) {
      p.errors.push(`fetch failed ${url}: ${e?.message ?? e}`);
      logger.warn(`[grocery-crawl] fetch failed: ${url} — ${e?.message ?? e}`);
      return null;
    }
  };

  const flush = async (force = false): Promise<void> => {
    if (buffer.length === 0 || (!force && buffer.length < pushBatchSize)) return;
    const batch = buffer.splice(0, buffer.length);
    if (dryRun) { logger.log(`[grocery-crawl] DRY RUN — would push ${batch.length} products`); return; }
    try {
      const res: any = await pushToDatabase(batch);
      p.productsPushed += (res.mongoInserted ?? 0) + (res.mongoUpdated ?? 0);
      logger.log(`[grocery-crawl] pushed batch: ${res.mongoInserted ?? 0} new, ${res.mongoUpdated ?? 0} updated (total ${p.productsPushed})`);
    } catch (e: any) {
      p.errors.push(`push failed: ${e?.message ?? e}`);
      logger.error(`[grocery-crawl] push failed: ${e?.message ?? e}`);
    }
  };

  // ── 1. Enumerate stores across the configured Dubai areas (deduped by branch id) ──
  const stores = new Map<string, StoreRef & { aid: string }>();
  for (const area of areas) {
    if (p.requests >= maxRequests || shouldStop()) break;
    for (let page = 1; page <= d.maxAreaPages; page++) {
      const html = await get(areaUrl(area, page));
      if (!html) break;
      const { stores: refs, maxPage } = parseAreaStoreRefs(html, TALABAT_ORIGIN);
      for (const r of refs) if (!stores.has(r.branchId)) stores.set(r.branchId, { ...r, aid: area.id });
      if (page >= maxPage) break;
    }
    p.areasScanned++;
  }
  p.storesFound = stores.size;
  logger.log(`[grocery-crawl] discovered ${p.storesFound} unique stores across ${p.areasScanned} area(s)`);

  // ── 2. Crawl each store → subcategories → paginated listings ──
  let crawled = 0;
  for (const store of stores.values()) {
    if (p.requests >= maxRequests) { p.capReached = true; break; }
    if (shouldStop()) { p.stopped = true; break; }
    if (crawled >= maxStores) break;

    const storeHtml = await get(store.storeUrl);
    if (!storeHtml) continue;
    const subs = parseStoreSubcategories(storeHtml);
    crawled++; p.storesCrawled++;
    logger.log(`[grocery-crawl] store ${store.branchId}: ${subs.length} subcategories (${p.requests}/${maxRequests} requests)`);

    for (const sub of subs) {
      if (p.requests >= maxRequests) { p.capReached = true; break; }
      if (shouldStop()) { p.stopped = true; break; }
      p.subcategories++;
      let page = 1;
      let pageCount = 1;
      do {
        const url = subcategoryUrl(store.storeUrl, sub.categorySlug, sub.subCategorySlug, store.aid, page);
        const html = await get(url);
        if (!html) break;
        p.pagesFetched++;
        const parsed = parseTalabatGrocery(html, url);
        pageCount = parsed.pageCount || 1;
        p.itemsSeen += parsed.items.length;
        for (const item of parsed.items) {
          if (item.sku && pushedSkus.has(item.sku)) continue;
          if (item.sku) pushedSkus.add(item.sku);
          const bundle = itemToBundle(item, {
            subCategory: humanize(sub.categorySlug),
            tags: ['grocery', 'groceries', sub.categorySlug],
            retailerId: TALABAT_RETAILER_ID,
            retailerName: TALABAT_RETAILER_NAME,
            sourceUrl: url,
            observedAt,
          });
          if (bundle) buffer.push(bundle);
        }
        await flush();
        page++;
      } while (page <= pageCount && page <= 50); // 50-page hard stop per subcategory (safety)
    }
  }

  await flush(true);
  logger.log(`[grocery-crawl] done — stores ${p.storesCrawled}/${p.storesFound}, items ${p.itemsSeen}, pushed ${p.productsPushed}, requests ${p.requests}${p.capReached ? ' (CAP REACHED)' : ''}${p.stopped ? ' (STOPPED)' : ''}`);
  return p;
}

/**
 * Server entry point: acquires the shared process lock (so it never races the e-commerce cron),
 * wires the STOP signal (/api/stop) to a cooperative stop, runs the crawl, and always releases
 * the lock. Returns the final progress, or null if another pipeline holds the lock.
 */
export async function runGroceryCrawlJob(opts: GroceryCrawlOptions = {}): Promise<GroceryCrawlProgress | null> {
  const logger = opts.logger ?? console;
  if (!acquireLock('grocery')) {
    logger.warn('[grocery-crawl] another pipeline holds the lock — not starting.');
    return null;
  }
  clearStopSignal();
  try {
    return await crawlTalabatGrocery({ ...opts, shouldStop: opts.shouldStop ?? stopFileSet });
  } finally {
    releaseLock();
    clearStopSignal();
  }
}
