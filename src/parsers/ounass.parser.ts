import { ProductData, normalizeGtin } from './types';
import { extractJsonLdProduct } from './jsonld';

/**
 * Ounass UAE (luxury fashion). Pages embed `window.initialState = {...}`:
 *   • product page → initialState.pdp   (designer, name, price, slashedPrice, images, sizes with stock, barcode)
 *   • listing page → initialState.plp   (styleColors[].url, pagination via ?fh_start_index=N, 24 per page)
 * JSON-LD (ProductGroup) is the fallback for name / price / availability / gtin13.
 */

/** The page's `window.initialState` object, or null. */
export function ounassState(html: string): any | null {
  const m = /window\.initialState\s*=\s*/.exec(html);
  if (!m) return null;
  const start = m.index + m[0].length;
  if (html[start] !== '{') return null;
  // Scan to the matching closing brace (strings may contain braces)
  let depth = 0;
  let inString = false;
  for (let i = start; i < html.length; i++) {
    const c = html[i];
    if (inString) {
      if (c === '\\') i++;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) {
      try { return JSON.parse(html.slice(start, i + 1)); } catch { return null; }
    }
  }
  return null;
}

const httpsUrl = (u: unknown): string | null =>
  typeof u === 'string' && u ? (u.startsWith('//') ? `https:${u}` : u) : null;

const num = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? ''));
  return Number.isFinite(n) && n > 0 ? n : null;
};

/** Ounass listing id: the styleColorId at the end of /shop-<slug>-<styleColorId>.html */
export function ounassStyleColorId(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return /-([a-z0-9]+_\d+)\.html$/i.exec(new URL(url).pathname)?.[1]?.toLowerCase() ?? null;
  } catch {
    return null;
  }
}

export function parseOunass(html: string, url: string): ProductData {
  const ld = extractJsonLdProduct(html);
  const pdp = ounassState(html)?.pdp ?? null;

  const designer: string | null = pdp?.designerCategoryEnglishName || pdp?.designerCategoryName || ld?.brand || null;
  const rawName: string | null = pdp?.nameInEnglish || pdp?.name || ld?.productName || null;
  // Other retailers put the brand in the title; do the same so cross-platform names compare
  const productName = rawName && designer && !rawName.toLowerCase().startsWith(designer.toLowerCase())
    ? `${designer} ${rawName}` : rawName;

  const price = num(pdp?.priceInAED ?? pdp?.price) ?? ld?.price ?? null;
  const slashed = num(pdp?.slashedPriceInAED ?? pdp?.slashedPrice);

  const images = (Array.isArray(pdp?.images) ? pdp.images : [])
    .map((i: any) => httpsUrl(i?.twoX ?? i?.oneX ?? i?.thumbnail))
    .filter((u: string | null): u is string => !!u);
  const imageUrls = images.length ? [...new Set<string>(images)] : ld?.imageUrls ?? [];

  // Evidence: outOfStock flag, else any size with stock, else JSON-LD availability
  let inStock: boolean | null = null;
  if (typeof pdp?.outOfStock === 'boolean') inStock = !pdp.outOfStock;
  else if (Array.isArray(pdp?.sizes) && pdp.sizes.length) inStock = pdp.sizes.some((s: any) => Number(s?.stock) > 0 && !s?.disabled);
  else inStock = ld?.inStock ?? null;

  const crumbs: string[] = (pdp?.breadcrumbs ?? []).map((b: any) => b?.name).filter(Boolean);

  return {
    productName,
    productUrl: url,
    imageUrl: imageUrls[0] ?? null,
    imageUrls,
    price,
    currency: price !== null ? 'AED' : null,
    ratings: ld?.ratings ?? null,
    reviewCount: ld?.reviewCount ?? null,
    description: (pdp?.descriptionText ?? ld?.description ?? null)?.slice(0, 1000) ?? null,
    inStock,
    category: crumbs.length ? crumbs.join(' > ') : null,
    brand: designer,
    sku: pdp?.visibleSku ? String(pdp.visibleSku) : null,
    originalPrice: price !== null && slashed !== null && slashed > price ? slashed : null,
    gtin: normalizeGtin(pdp?.barcode) ?? ld?.gtin ?? null,
  };
}

export const OUNASS_PAGE_SIZE = 24;

/** Product links from an Ounass listing page. */
export function parseOunassSearch(html: string, _baseUrl: string): string[] {
  const links = new Set<string>();
  const items: any[] = ounassState(html)?.plp?.styleColors ?? [];
  for (const s of items) {
    if (typeof s?.url === 'string' && /\.html$/.test(s.url)) links.add(`https://www.ounass.ae${s.url.startsWith('/') ? '' : '/'}${s.url}`);
  }
  if (links.size === 0) {
    for (const m of html.matchAll(/href=["'](?:https:\/\/www\.ounass\.ae)?(\/shop-[a-z0-9-]+_\d+\.html)/gi)) links.add(`https://www.ounass.ae${m[1]}`);
  }
  return [...links];
}
