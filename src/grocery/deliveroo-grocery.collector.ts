import { fetchHTMLViaUnlocker } from '../services/brightdata.service';
import { pushToDatabase } from '../cron/push-pipeline';
import {
  acquireLock,
  releaseLock,
  clearStopSignal,
  shouldStop as stopFileSet,
  DELIVEROO_LOCK_FILE,
  DELIVEROO_STOP_FILE,
} from '../utils/stop-signal';
import { BundledProduct } from '../parsers/types';
import { parseDeliverooGrocery } from './deliveroo-grocery.parser';
import { itemToBundle, itemUrl } from './talabat-grocery.collector';
import {
  DELIVEROO_CRAWL_DEFAULTS,
  DELIVEROO_PILOT_STORES,
  DELIVEROO_RETAILER_ID,
  DELIVEROO_RETAILER_NAME,
} from './deliveroo-grocery.config';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// Deliveroo.ae defaults an un-prefixed path (e.g. /menu/...) to Arabic by geo; the English catalogue
// lives under an /en/ path prefix (verified: /en/menu/... returns language:"en" with identical SKUs
// and prices). Force English by ensuring the path's first segment is "en" — rewrite "ar"→"en" or
// prepend "en" when absent. Query string (geohash/day/time) is preserved.
export function ensureEnglish(url: string): string {
  try {
    const u = new URL(url);
    const seg = u.pathname.split('/').filter(Boolean);
    if (seg[0] === 'en') {
      // already English — leave as-is
    } else if (seg[0] === 'ar') {
      seg[0] = 'en';
    } else {
      seg.unshift('en');
    }
    u.pathname = `/${seg.join('/')}`;
    return u.toString();
  } catch {
    return url;
  }
}

export interface DeliverooCollectOptions {
  max?: number;
  fetchHtml?: (url: string) => Promise<string>;
  logger?: Pick<Console, 'log' | 'warn'>;
  now?: Date;
}

export interface DeliverooCollectResult {
  bundles: BundledProduct[];
  storesFetched: number;
  itemsSeen: number;
  warnings: string[];
}

/**
 * Crawl a set of Deliveroo (Hop) grocery store menus → BundledProducts tagged "Groceries".
 * One Bright Data Unlocker request per store menu (server-rendered __NEXT_DATA__). Dedupes by SKU.
 */
export async function collectDeliverooGrocery(
  storeUrls: string[] = DELIVEROO_PILOT_STORES,
  opts: DeliverooCollectOptions = {},
): Promise<DeliverooCollectResult> {
  const max = opts.max ?? DELIVEROO_CRAWL_DEFAULTS.maxRequests;
  const fetchHtml = opts.fetchHtml ?? fetchHTMLViaUnlocker;
  const logger = opts.logger ?? console;
  const observedAt = (opts.now ?? new Date()).toISOString();

  const bundles: BundledProduct[] = [];
  const warnings: string[] = [];
  const seenSku = new Set<string>();
  let storesFetched = 0;
  let itemsSeen = 0;

  for (const storeUrl of storeUrls) {
    if (bundles.length >= max) break;
    const url = ensureEnglish(storeUrl);
    let html: string;
    try {
      html = await fetchHtml(url);
      storesFetched++;
    } catch (e: any) {
      warnings.push(`fetch failed for ${url}: ${e?.message ?? e}`);
      logger.warn(`[deliveroo] fetch failed: ${url} — ${e?.message ?? e}`);
      continue;
    }

    const parsed = parseDeliverooGrocery(html, url);
    warnings.push(...parsed.warnings.map(w => `${url}: ${w}`));
    itemsSeen += parsed.items.length;

    for (const item of parsed.items) {
      if (bundles.length >= max) break;
      if (item.sku) {
        if (seenSku.has(item.sku)) continue;
        seenSku.add(item.sku);
      }
      const bundle = itemToBundle(item, {
        subCategory: 'Groceries',
        tags: ['grocery', 'groceries', 'deliveroo'],
        retailerId: DELIVEROO_RETAILER_ID,
        retailerName: DELIVEROO_RETAILER_NAME,
        sourceUrl: itemUrl(url, item), // unique per item so distinct SKUs aren't collapsed
        observedAt,
      });
      if (bundle) bundles.push(bundle);
    }
    logger.log(`[deliveroo] ${url} → ${parsed.items.length} items (${bundles.length}/${max} collected)`);
    if (DELIVEROO_CRAWL_DEFAULTS.requestDelayMs > 0) await sleep(DELIVEROO_CRAWL_DEFAULTS.requestDelayMs);
  }

  return { bundles, storesFetched, itemsSeen, warnings };
}

export interface DeliverooRunOptions {
  dryRun?: boolean;
  max?: number;
  storeUrls?: string[];
  logger?: Pick<Console, 'log' | 'warn' | 'error'>;
}

export interface DeliverooRunResult {
  storesFetched: number;
  itemsSeen: number;
  productsPushed: number;
  bundles: number;
  warnings: string[];
}

/**
 * Server entry point for the Deliveroo grocery pilot: acquires the shared lock (so it never races
 * the Talabat crawl or the e-commerce cron), crawls the pilot stores, optionally pushes, releases.
 * Returns null if another pipeline holds the lock. Dry-run by default.
 */
export async function runDeliverooGroceryJob(opts: DeliverooRunOptions = {}): Promise<DeliverooRunResult | null> {
  const logger = opts.logger ?? console;
  const dryRun = opts.dryRun ?? true;
  // Platform-scoped lock: runs concurrently with the Talabat crawl / e-commerce pipeline (which hold
  // the global lock), but still blocks a second simultaneous Deliveroo run.
  if (!acquireLock('grocery', DELIVEROO_LOCK_FILE)) {
    logger.warn('[deliveroo] another Deliveroo run holds the lock — not starting.');
    return null;
  }
  clearStopSignal(DELIVEROO_STOP_FILE);
  try {
    const { bundles, storesFetched, itemsSeen, warnings } = await collectDeliverooGrocery(
      opts.storeUrls ?? DELIVEROO_PILOT_STORES,
      { max: opts.max, logger },
    );
    logger.log(`[deliveroo] ${storesFetched} stores, ${itemsSeen} items → ${bundles.length} bundles, dryRun=${dryRun}`);
    for (const w of warnings.slice(0, 20)) logger.warn(`[deliveroo] warn: ${w}`);

    let productsPushed = 0;
    if (!dryRun && bundles.length && !stopFileSet(DELIVEROO_STOP_FILE)) {
      const res: any = await pushToDatabase(bundles);
      productsPushed = (res.mongoInserted ?? 0) + (res.mongoUpdated ?? 0);
      logger.log(`[deliveroo] pushed: ${res.mongoInserted ?? 0} new, ${res.mongoUpdated ?? 0} updated`);
    } else if (dryRun) {
      logger.log(`[deliveroo] DRY RUN — ${bundles.length} products NOT pushed`);
      for (const b of bundles.slice(0, 10)) logger.log(`   • ${b.name} — ${b.retailers[0]?.currency} ${b.retailers[0]?.price}`);
    }
    return { storesFetched, itemsSeen, productsPushed, bundles: bundles.length, warnings };
  } finally {
    releaseLock(DELIVEROO_LOCK_FILE);
    clearStopSignal(DELIVEROO_STOP_FILE);
  }
}
