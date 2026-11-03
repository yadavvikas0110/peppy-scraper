import { fetchHTMLViaBrowser } from '../services/brightdata.service';
import { pushToDatabase } from '../cron/push-pipeline';
import {
  acquireLock,
  releaseLock,
  clearStopSignal,
  shouldStop as stopFileSet,
  NOON_LOCK_FILE,
  NOON_STOP_FILE,
} from '../utils/stop-signal';
import { BundledProduct } from '../parsers/types';
import { parseNoonMinutes } from './noon-minutes.parser';
import { itemToBundle } from './talabat-grocery.collector';
import type { TalabatGroceryItem } from './talabat-grocery.types';
import {
  NoonCategory,
  resolveNoonCategories,
  noonCategoryUrl,
  NOON_CRAWL_DEFAULTS,
  NOON_MINUTES_ORIGIN,
  NOON_MINUTES_RETAILER_ID,
  NOON_MINUTES_RETAILER_NAME,
  NOON_MINUTES_EXIT_COUNTRY,
  NOON_PRODUCT_READY_SELECTOR,
} from './noon-minutes.config';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** Clean per-product noon URL — the real product page, used as the offer's productUrl. */
function noonProductUrl(item: TalabatGroceryItem): string {
  return `${NOON_MINUTES_ORIGIN}/uae-en/now-product/${encodeURIComponent(item.sku || item.slug || '')}/`;
}

export interface NoonCollectOptions {
  max?: number;
  categories?: NoonCategory[];
  /** Injectable fetcher (tests pass a stub; production renders via Bright Data Scraping Browser). */
  fetchHtml?: (url: string) => Promise<string>;
  logger?: Pick<Console, 'log' | 'warn'>;
  now?: Date;
}

export interface NoonCollectResult {
  bundles: BundledProduct[];
  pagesFetched: number;
  itemsSeen: number;
  warnings: string[];
}

/**
 * Render each noon Minutes category page (Bright Data Scraping Browser, UAE exit so a Dubai store
 * resolves) and map the products to BundledProducts tagged "Groceries". Dedupes by SKU across
 * categories. One browser render per category (budget-capped by `max`).
 */
export async function collectNoonMinutes(opts: NoonCollectOptions = {}): Promise<NoonCollectResult> {
  const max = opts.max ?? NOON_CRAWL_DEFAULTS.maxRequests;
  const categories = opts.categories ?? resolveNoonCategories();
  const fetchHtml =
    opts.fetchHtml ??
    ((url: string) =>
      fetchHTMLViaBrowser(url, NOON_PRODUCT_READY_SELECTOR, NOON_CRAWL_DEFAULTS.renderWaitMs, NOON_MINUTES_EXIT_COUNTRY));
  const logger = opts.logger ?? console;
  const observedAt = (opts.now ?? new Date()).toISOString();

  const bundles: BundledProduct[] = [];
  const warnings: string[] = [];
  const seenSku = new Set<string>();
  let pagesFetched = 0;
  let itemsSeen = 0;

  for (const cat of categories) {
    if (pagesFetched >= max) break;
    const url = noonCategoryUrl(cat.slug);
    let html: string;
    try {
      html = await fetchHtml(url);
      pagesFetched++;
    } catch (e: any) {
      warnings.push(`fetch failed for ${cat.slug}: ${e?.message ?? e}`);
      logger.warn(`[noon] render failed: ${cat.slug} — ${e?.message ?? e}`);
      continue;
    }

    const parsed = parseNoonMinutes(html, url);
    warnings.push(...parsed.warnings.map(w => `${cat.slug}: ${w}`));
    itemsSeen += parsed.items.length;

    let added = 0;
    for (const item of parsed.items) {
      if (item.sku) {
        if (seenSku.has(item.sku)) continue;
        seenSku.add(item.sku);
      }
      const bundle = itemToBundle(item, {
        subCategory: cat.subCategory,
        tags: ['grocery', 'groceries', 'noon-minutes'],
        retailerId: NOON_MINUTES_RETAILER_ID,
        retailerName: NOON_MINUTES_RETAILER_NAME,
        sourceUrl: noonProductUrl(item), // real per-product URL (itemUrl is idempotent on it)
        observedAt,
      });
      if (bundle) { bundles.push(bundle); added++; }
    }
    logger.log(`[noon] ${cat.slug} → ${parsed.items.length} items, +${added} new (${bundles.length} total, ${pagesFetched}/${max} renders)`);
    if (NOON_CRAWL_DEFAULTS.requestDelayMs > 0) await sleep(NOON_CRAWL_DEFAULTS.requestDelayMs);
  }

  return { bundles, pagesFetched, itemsSeen, warnings };
}

export interface NoonRunOptions {
  dryRun?: boolean;
  max?: number;
  categories?: NoonCategory[];
  logger?: Pick<Console, 'log' | 'warn' | 'error'>;
}

export interface NoonRunResult {
  pagesFetched: number;
  itemsSeen: number;
  productsPushed: number;
  bundles: number;
  warnings: string[];
}

/**
 * Server entry point for the noon Minutes grocery crawl. Uses a noon-specific lock so it runs
 * concurrently with Talabat/Deliveroo; only a second noon run is blocked. Dry-run by default.
 */
export async function runNoonMinutesJob(opts: NoonRunOptions = {}): Promise<NoonRunResult | null> {
  const logger = opts.logger ?? console;
  const dryRun = opts.dryRun ?? true;
  if (!acquireLock('grocery', NOON_LOCK_FILE)) {
    logger.warn('[noon] another noon run holds the lock — not starting.');
    return null;
  }
  clearStopSignal(NOON_STOP_FILE);
  try {
    const { bundles, pagesFetched, itemsSeen, warnings } = await collectNoonMinutes({
      max: opts.max,
      categories: opts.categories,
      logger,
    });
    logger.log(`[noon] ${pagesFetched} categories, ${itemsSeen} items → ${bundles.length} bundles, dryRun=${dryRun}`);
    for (const w of warnings.slice(0, 20)) logger.warn(`[noon] warn: ${w}`);

    let productsPushed = 0;
    if (!dryRun && bundles.length && !stopFileSet(NOON_STOP_FILE)) {
      const res: any = await pushToDatabase(bundles);
      productsPushed = (res.mongoInserted ?? 0) + (res.mongoUpdated ?? 0);
      logger.log(`[noon] pushed: ${res.mongoInserted ?? 0} new, ${res.mongoUpdated ?? 0} updated`);
    } else if (dryRun) {
      logger.log(`[noon] DRY RUN — ${bundles.length} products NOT pushed`);
      for (const b of bundles.slice(0, 10)) logger.log(`   • ${b.name} — ${b.retailers[0]?.currency} ${b.retailers[0]?.price}`);
    }
    return { pagesFetched, itemsSeen, productsPushed, bundles: bundles.length, warnings };
  } finally {
    releaseLock(NOON_LOCK_FILE);
    clearStopSignal(NOON_STOP_FILE);
  }
}
