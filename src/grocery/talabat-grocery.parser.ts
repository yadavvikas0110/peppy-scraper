import * as cheerio from 'cheerio';
import type {
  StoreRef,
  SubcategoryTarget,
  TalabatGroceryItem,
  TalabatGroceryParseResult,
  TalabatGroceryStore,
} from './talabat-grocery.types';

// Grocery pages embed their state in script#__NEXT_DATA__ (same technique as the dining
// Talabat parser), but under props.pageProps.initialState rather than initialMenuState.
const NEXT_DATA_SELECTOR = 'script#__NEXT_DATA__';

function isObj(v: unknown): v is Record<string, any> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** A finite, non-negative price in major units. Rejects strings, NaN, negatives. */
function toPrice(v: unknown): number | undefined {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return undefined;
  return v;
}

function toStock(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function cleanText(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  return t.length ? t : undefined;
}

function readStore(state: Record<string, any>): TalabatGroceryStore {
  const gs = isObj(state.groceryStore) ? state.groceryStore : {};
  return {
    branchId: cleanText(gs.branchId) ?? cleanText(gs.talabatBranchId),
    name: cleanText(gs.name) ?? cleanText(gs.branchName),
    isDarkStore: typeof gs.isDarkStore === 'boolean' ? gs.isDarkStore : undefined,
    dhVendorId: cleanText(gs.dhVendorId),
  };
}

function readItems(state: Record<string, any>, warnings: string[]): TalabatGroceryItem[] {
  const raw = isObj(state.itemsData) && Array.isArray(state.itemsData.items) ? state.itemsData.items : [];
  const items: TalabatGroceryItem[] = [];

  raw.forEach((r: any, i: number) => {
    if (!isObj(r)) return;
    const title = cleanText(r.title);
    if (!title) {
      warnings.push(`item #${i}: missing title — skipped`);
      return;
    }
    const price = toPrice(r.price);
    if (price === undefined) {
      warnings.push(`item #${i} ("${title}"): missing/invalid price — skipped`);
      return;
    }
    const imageList = Array.isArray(r.images) ? r.images.filter((u: unknown): u is string => typeof u === 'string' && !!u) : [];
    const image = cleanText(r.image) ?? imageList[0];
    const images = imageList.length ? imageList : image ? [image] : [];

    items.push({
      id: cleanText(r.id),
      sku: cleanText(r.sku),
      title,
      slug: cleanText(r.slug),
      description: cleanText(r.description),
      price,
      originalPrice: toPrice(r.originalPrice),
      discountPercentage: typeof r.discountPercentage === 'number' ? r.discountPercentage : undefined,
      image,
      images,
      stockAmount: toStock(r.stockAmount),
    });
  });

  return items;
}

/**
 * Pure Talabat grocery-page parser: HTML in, store + products out. Never fetches, never persists.
 * Returns an empty item list (with a warning) when the __NEXT_DATA__ payload is missing or unusable;
 * it never invents data.
 */
export function parseTalabatGrocery(html: string, sourceUrl: string): TalabatGroceryParseResult {
  const warnings: string[] = [];
  const result: TalabatGroceryParseResult = { store: {}, items: [], sourceUrl, currentPage: 1, pageCount: 1, warnings };

  const $ = cheerio.load(html);
  const raw = $(NEXT_DATA_SELECTOR).first().text();
  if (!raw) {
    warnings.push('__NEXT_DATA__ script not found — no products extracted');
    return result;
  }

  let data: any;
  try {
    data = JSON.parse(raw);
  } catch {
    warnings.push('__NEXT_DATA__ is not valid JSON — no products extracted');
    return result;
  }

  const state = data?.props?.pageProps?.initialState;
  if (!isObj(state)) {
    warnings.push('props.pageProps.initialState missing — no products extracted');
    return result;
  }

  result.store = readStore(state);
  result.items = readItems(state, warnings);
  const idata = isObj(state.itemsData) ? state.itemsData : {};
  if (typeof idata.pageCount === 'number' && idata.pageCount > 0) result.pageCount = idata.pageCount;
  if (typeof idata.currentPage === 'number' && idata.currentPage > 0) result.currentPage = idata.currentPage;
  if (result.items.length === 0) warnings.push('no grocery items parsed from this page');
  return result;
}

function readNextDataState(html: string): Record<string, any> | null {
  const $ = cheerio.load(html);
  const raw = $(NEXT_DATA_SELECTOR).first().text();
  if (!raw) return null;
  try {
    const state = JSON.parse(raw)?.props?.pageProps?.initialState;
    return isObj(state) ? state : null;
  } catch {
    return null;
  }
}

/**
 * Read a store page's full subcategory list from its __NEXT_DATA__ category tree.
 * Each entry gives the category + subcategory slugs needed to build a listing URL, plus
 * Talabat's own product count (used only for size/cost estimation).
 */
export function parseStoreSubcategories(html: string): SubcategoryTarget[] {
  const state = readNextDataState(html);
  const cats = state && Array.isArray(state.categories) ? state.categories : [];
  const targets: SubcategoryTarget[] = [];
  for (const c of cats) {
    if (!isObj(c)) continue;
    const categorySlug = cleanText(c.slug);
    if (!categorySlug) continue;
    const subs = Array.isArray(c.subCategories) ? c.subCategories : [];
    if (subs.length === 0) continue; // every observed category exposes items under a subcategory slug
    for (const s of subs) {
      if (!isObj(s)) continue;
      const subCategorySlug = cleanText(s.slug);
      if (!subCategorySlug) continue;
      targets.push({ categorySlug, subCategorySlug, count: typeof s.count === 'number' ? s.count : 0 });
    }
  }
  return targets;
}

// A store landing page links to each of its listings as /<country>/grocery/<id>/<slug>/<cat>/<sub>.
// Parsing these anchors is a shape-independent fallback when __NEXT_DATA__ categories are absent.
const SUBCAT_PATH_RE = /^\/[a-z-]+\/grocery\/\d+\/[^/?#]+\/[^/?#]+\/[^/?#]+$/i;

/**
 * Extract absolute subcategory listing URLs from a store landing page's anchors (query preserved,
 * so the ?aid= stays). Deduped by path. Used when parseStoreSubcategories finds nothing.
 */
export function parseStoreSubcategoryHrefs(html: string, origin = 'https://www.talabat.com'): string[] {
  const $ = cheerio.load(html);
  const byPath = new Map<string, string>();
  $('a[href]').each((_i, el) => {
    const href = $(el).attr('href') || '';
    let path: string;
    try {
      path = href.startsWith('http') ? new URL(href).pathname : href.split(/[?#]/)[0];
    } catch {
      return;
    }
    if (!SUBCAT_PATH_RE.test(path)) return;
    const abs = href.startsWith('http') ? href : `${origin}${href}`;
    if (!byPath.has(path)) byPath.set(path, abs);
  });
  return [...byPath.values()];
}

const STORE_PATH_RE = /\/[a-z-]+\/grocery\/(\d+)\/[^/?#]+/i;

/**
 * Extract unique store references and the max listing page from an area grocery page.
 * Store cards are server-rendered as anchors (…/grocery/<branchId>/<slug>), and pagination
 * shows as ?page=N links; both are read straight from the HTML, no __NEXT_DATA__ shape needed.
 */
export function parseAreaStoreRefs(html: string, origin = 'https://www.talabat.com'): { stores: StoreRef[]; maxPage: number } {
  const $ = cheerio.load(html);
  const byId = new Map<string, StoreRef>();
  let maxPage = 1;
  $('a[href]').each((_i, el) => {
    const href = $(el).attr('href') || '';
    const storeMatch = STORE_PATH_RE.exec(href);
    if (storeMatch) {
      const branchId = storeMatch[1];
      const path = storeMatch[0];
      if (!byId.has(branchId)) byId.set(branchId, { branchId, storeUrl: `${origin}${path}` });
    }
    const pageMatch = /[?&]page=(\d+)\b/.exec(href);
    if (pageMatch) maxPage = Math.max(maxPage, Number(pageMatch[1]));
  });
  return { stores: [...byId.values()], maxPage };
}
