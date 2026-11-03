import { fetchHTMLViaUnlocker } from '../services/brightdata.service';
import { BundledProduct, RetailerOffer, toStockStatus } from '../parsers/types';
import { parseTalabatGrocery } from './talabat-grocery.parser';
import type { TalabatGroceryItem } from './talabat-grocery.types';
import {
  GROCERY_BROAD_CATEGORY,
  GROCERY_DEFAULT_MAX,
  GroceryStoreTarget,
  TALABAT_PILOT,
} from './talabat-grocery.config';

const CURRENCY = 'AED'; // Talabat UAE serves prices in AED major units.

/**
 * Build a stable, unique URL per grocery item. Talabat serves a whole (sub)category on one page,
 * so every item on that page shares the page URL. Product identity downstream (dedupe + the
 * backend's offer matching) keys partly on the canonical URL (path only), so items MUST NOT share
 * a URL or they collapse into one document. We append the item's own slug (fallback: SKU) to the
 * category path to give each item a unique, on-domain URL.
 */
export function itemUrl(sourceUrl: string, item: TalabatGroceryItem): string {
  const token = item.slug || item.sku;
  if (!token) return sourceUrl;
  try {
    const u = new URL(sourceUrl);
    const path = u.pathname.replace(/\/+$/, '');
    // Idempotent: when the URL is already the item's own page (ends with the token), don't append
    // again (noon passes a real per-product URL). Otherwise append to make a shared page URL unique.
    if (path.endsWith(`/${encodeURIComponent(token)}`) || path.endsWith(`/${token}`)) {
      u.pathname = path;
    } else {
      u.pathname = `${path}/${encodeURIComponent(token)}`;
    }
    return u.toString();
  } catch {
    return sourceUrl;
  }
}

export interface GroceryCollectOptions {
  max?: number;
  /** Injectable fetcher (tests pass a stub; production uses Bright Data Unlocker). */
  fetchHtml?: (url: string) => Promise<string>;
  logger?: Pick<Console, 'log' | 'warn'>;
  now?: Date;
}

export interface GroceryCollectResult {
  bundles: BundledProduct[];
  pagesFetched: number;
  itemsSeen: number;
  warnings: string[];
}

export interface GroceryBundleContext {
  subCategory: string;
  tags: string[];
  retailerId: string;
  retailerName: string;
  sourceUrl: string;
  observedAt: string;
}

export function itemToBundle(
  item: TalabatGroceryItem,
  ctx: GroceryBundleContext,
): BundledProduct | null {
  const images = item.images.filter(Boolean);
  if (images.length === 0) return null; // mongo rejects image-less products; drop early.

  const inStock = item.stockAmount === null ? null : item.stockAmount > 0;
  const offer: RetailerOffer = {
    retailerId: ctx.retailerId,
    retailerName: ctx.retailerName,
    price: item.price,
    currency: CURRENCY,
    inStock,
    stockStatus: toStockStatus(inStock),
    productUrl: itemUrl(ctx.sourceUrl, item),
    imageUrl: images[0],
    ratings: null,
    reviewCount: null,
    externalId: item.sku ?? null,
    observedAt: ctx.observedAt,
  };

  return {
    name: item.title,
    description: item.description ?? null,
    category: GROCERY_BROAD_CATEGORY,
    broadCategory: GROCERY_BROAD_CATEGORY,
    subCategory: ctx.subCategory,
    tags: ctx.tags,
    images,
    lowestPrice: item.price,
    highestPrice: item.price,
    rating: null,
    reviewCount: null,
    retailerCount: 1,
    retailers: [offer],
  };
}

/**
 * Crawl a grocery store's configured category pages, parse products, and map them to
 * BundledProducts tagged "Groceries". Dedupes by SKU across pages and caps the total.
 * One Bright Data Unlocker request per category page.
 */
export async function collectTalabatGrocery(
  target: GroceryStoreTarget = TALABAT_PILOT,
  opts: GroceryCollectOptions = {},
): Promise<GroceryCollectResult> {
  const max = opts.max ?? GROCERY_DEFAULT_MAX;
  const fetchHtml = opts.fetchHtml ?? fetchHTMLViaUnlocker;
  const logger = opts.logger ?? console;
  const observedAt = (opts.now ?? new Date()).toISOString();

  const bundles: BundledProduct[] = [];
  const warnings: string[] = [];
  const seenSku = new Set<string>();
  let pagesFetched = 0;
  let itemsSeen = 0;

  for (const cat of target.categories) {
    if (bundles.length >= max) break;
    let html: string;
    try {
      html = await fetchHtml(cat.url);
      pagesFetched++;
    } catch (e: any) {
      warnings.push(`fetch failed for ${cat.url}: ${e?.message ?? e}`);
      logger.warn(`[grocery] fetch failed: ${cat.url} — ${e?.message ?? e}`);
      continue;
    }

    const parsed = parseTalabatGrocery(html, cat.url);
    warnings.push(...parsed.warnings.map(w => `${cat.url}: ${w}`));
    itemsSeen += parsed.items.length;

    for (const item of parsed.items) {
      if (bundles.length >= max) break;
      // Dedupe by SKU across pages; items without a SKU are always kept.
      if (item.sku) {
        if (seenSku.has(item.sku)) continue;
        seenSku.add(item.sku);
      }
      const bundle = itemToBundle(item, {
        subCategory: cat.subCategory,
        tags: cat.tags,
        retailerId: target.retailerId,
        retailerName: target.retailerName,
        sourceUrl: cat.url,
        observedAt,
      });
      if (bundle) bundles.push(bundle);
    }

    logger.log(`[grocery] ${cat.url} → ${parsed.items.length} items (${bundles.length}/${max} collected)`);
  }

  return { bundles, pagesFetched, itemsSeen, warnings };
}
