import * as cheerio from 'cheerio';
import type {
  TalabatGroceryItem,
  TalabatGroceryParseResult,
  TalabatGroceryStore,
} from './talabat-grocery.types';

// Deliveroo (incl. Deliveroo Hop grocery) server-renders its menu into script#__NEXT_DATA__ at
// props.initialState.menuPage.menu.metas.root — same technique the dining Deliveroo adapter uses.
// We reuse the Talabat grocery item/result shapes so the collector + itemToBundle are shared.
const NEXT_DATA_SELECTOR = 'script#__NEXT_DATA__';

function isObj(v: unknown): v is Record<string, any> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function cleanText(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  return t.length ? t : undefined;
}

/** Deliveroo prices are integer minor units (fils): 2604 → 26.04 AED. */
function fractionalToMajor(v: unknown): number | undefined {
  if (!isObj(v)) return undefined;
  const f = v.fractional;
  if (typeof f !== 'number' || !Number.isFinite(f) || f < 0) return undefined;
  return Math.round(f) / 100;
}

function readStore(root: Record<string, any>): TalabatGroceryStore {
  const r = isObj(root.restaurant) ? root.restaurant : {};
  return {
    branchId: r.id !== undefined ? String(r.id) : cleanText(r.uname),
    name: cleanText(r.name),
  };
}

function readItems(root: Record<string, any>, warnings: string[]): TalabatGroceryItem[] {
  const raw = Array.isArray(root.items) ? root.items : [];
  const items: TalabatGroceryItem[] = [];

  raw.forEach((r: any, i: number) => {
    if (!isObj(r)) return;
    const title = cleanText(r.name);
    if (!title) {
      warnings.push(`item #${i}: missing name — skipped`);
      return;
    }
    // Current selling price = discounted when present, else the base price. Base price is kept as
    // originalPrice so a discount is preserved.
    const base = fractionalToMajor(r.price);
    const disc = fractionalToMajor(r.priceDiscounted);
    const price = disc ?? base;
    if (price === undefined) {
      warnings.push(`item #${i} ("${title}"): missing/invalid price — skipped`);
      return;
    }
    const imageUrl = isObj(r.image) ? cleanText(r.image.url) : undefined;
    const images = imageUrl ? [imageUrl] : [];

    // Deliveroo gives `available` (bool) and sometimes `stockCount`. Map to a stock amount:
    // available→(stockCount or 1), unavailable→0, unknown→null.
    let stockAmount: number | null;
    if (typeof r.stockCount === 'number' && Number.isFinite(r.stockCount)) stockAmount = r.stockCount;
    else if (typeof r.available === 'boolean') stockAmount = r.available ? 1 : 0;
    else stockAmount = null;

    items.push({
      id: r.id !== undefined ? String(r.id) : undefined,
      sku: r.id !== undefined ? String(r.id) : undefined,
      title,
      slug: cleanText(r.uid) ?? (r.id !== undefined ? String(r.id) : undefined),
      description: cleanText(r.description),
      price,
      originalPrice: base,
      discountPercentage: undefined,
      image: imageUrl,
      images,
      stockAmount,
    });
  });

  return items;
}

/**
 * Pure Deliveroo grocery-page parser: HTML in, store + products out. Never fetches, never persists.
 * Returns an empty item list (with a warning) when the __NEXT_DATA__ menu payload is missing.
 */
export function parseDeliverooGrocery(html: string, sourceUrl: string): TalabatGroceryParseResult {
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

  const root = data?.props?.initialState?.menuPage?.menu?.metas?.root;
  if (!isObj(root)) {
    warnings.push('props.initialState.menuPage.menu.metas.root missing — no products extracted');
    return result;
  }

  result.store = readStore(root);
  result.items = readItems(root, warnings);
  // Deliveroo paginates via a cursor (paginationHasMore / paginationNextCursor), not page numbers.
  if (root.paginationHasMore === true) warnings.push('paginationHasMore=true — more items available via cursor');
  if (result.items.length === 0) warnings.push('no grocery items parsed from this page');
  return result;
}
