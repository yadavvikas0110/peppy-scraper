import { ProductData, normalizeGtin } from './types';
import { extractJsonLdProduct } from './jsonld';

/**
 * Landmark Group storefronts (Centrepoint, Home Centre — same Next.js platform).
 *
 * The page state is `__NEXT_DATA__.props.initialState`: base64-encoded JSON of the Redux store.
 *   • product page  → productPageReducerBL.data  (name, brand, variants with live prices, gallery, breadcrumbs)
 *   • listing page  → algoliaProductReducer.data.hits  (url per product, nbPages for pagination)
 *
 * Price rules (verified on live pages, Nov 2026): the JSON-LD offer shows the BASE price, the variant's
 * `priceInfo.price` is what the customer pays (sale price during promotions). We use the variant price
 * and keep the base price as `originalPrice` when it is higher.
 * The variant is the one whose SKU is in the URL (`/p/<sku>`); each variant carries an EAN (`externalId`).
 */

const PRODUCT_ID_RE = /\/p\/(\d{5,})(?:[/?#]|$)/;

/** Decoded Redux state, or null when the page carries none (block page, different template). */
export function landmarkState(html: string): any | null {
  const m = html.match(/<script[^>]*id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
  if (!m) return null;
  try {
    const raw = JSON.parse(m[1])?.props?.initialState;
    if (!raw) return null;
    if (typeof raw === 'object') return raw;
    const text = String(raw).trim();
    return JSON.parse(text.startsWith('{') ? text : Buffer.from(text, 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

export function landmarkProductId(url: string | null | undefined): string | null {
  if (!url) return null;
  try { return PRODUCT_ID_RE.exec(new URL(url).pathname)?.[1] ?? null; } catch { return null; }
}

const amount = (v: any): number | null => {
  const n = typeof v?.amount === 'number' ? v.amount : parseFloat(String(v?.amount ?? ''));
  return Number.isFinite(n) && n > 0 ? n : null;
};

function imagesFor(data: any, sku: string | null): string[] {
  const all: string[] = (data?.assets ?? [])
    .filter((a: any) => (a?.type ?? 'IMAGE') === 'IMAGE' && typeof a?.url === 'string')
    .map((a: any) => a.url as string)
    .filter((u: string) => !/\/swatch-/i.test(u));
  const unique = [...new Set(all)];
  // Each variant's gallery files start with its SKU: …/<sku>-<style>_01-2100.jpg
  const own = sku ? unique.filter(u => u.split('/').pop()!.startsWith(`${sku}-`)) : [];
  if (own.length) return own;
  const primary = data?.primaryAsset?.url;
  return unique.length ? unique : primary ? [primary] : [];
}

export function parseLandmark(html: string, url: string): ProductData {
  const ld = extractJsonLdProduct(html);
  const data = landmarkState(html)?.productPageReducerBL?.data ?? null;
  const urlSku = landmarkProductId(url);
  const variants: any[] = Array.isArray(data?.variants) ? data.variants : [];
  const variant = variants.find(v => String(v?.sku) === urlSku) ?? (variants.length === 1 ? variants[0] : null);

  const live = amount(variant?.priceInfo?.price);
  const base = amount(variant?.defaultPrice) ?? amount(variant?.priceInfo?.priceTypeDetails?.basePrice?.bestPrice);
  const price = live ?? base ?? ld?.price ?? null;
  const images = data ? imagesFor(data, variant ? String(variant.sku) : urlSku) : [];
  const imageUrls = images.length ? images : ld?.imageUrls ?? [];

  // Stock evidence: the JSON-LD availability of this page; a variant switched offline is unavailable
  let inStock: boolean | null = ld?.inStock ?? null;
  if (variant && (variant.online === false || variant.active === false)) inStock = false;
  if (data?.discontinued === true) inStock = false;

  const crumbs: string[] = (data?.breadcrumbs ?? []).filter((b: any) => b?.uri).map((b: any) => String(b.label));
  const name: string | null = (typeof data?.name === 'string' && data.name.trim()) || ld?.productName || null;
  const brand: string | null = data?.brand?.displayValue || ld?.brand || null;

  return {
    productName: name,
    productUrl: url,
    imageUrl: imageUrls[0] ?? null,
    imageUrls,
    price,
    currency: price !== null ? String(variant?.priceInfo?.price?.currency ?? ld?.currency ?? 'AED') : null,
    ratings: ld?.ratings ?? null,
    reviewCount: ld?.reviewCount ?? null,
    description: (typeof data?.description === 'string' ? data.description : ld?.description ?? null)?.slice(0, 1000) ?? null,
    inStock,
    category: crumbs.length ? crumbs.join(' > ') : null,
    brand,
    sku: variant?.sku ? String(variant.sku) : urlSku,
    originalPrice: price !== null && base !== null && base > price ? base : null,
    gtin: normalizeGtin(variant?.externalId) ?? ld?.gtin ?? null,
  };
}

/** Product links from a Landmark listing / search page (state first, then plain anchors). */
export function parseLandmarkSearch(html: string, baseUrl: string): string[] {
  let origin: string;
  let prefix = '/ae/en';
  try {
    const u = new URL(baseUrl);
    origin = u.origin;
    const m = u.pathname.match(/^\/([a-z]{2})\/([a-z]{2})(?:\/|$)/);
    if (m) prefix = `/${m[1]}/${m[2]}`;
  } catch {
    return [];
  }
  const links = new Set<string>();
  const hits: any[] = landmarkState(html)?.algoliaProductReducer?.data?.hits ?? [];
  for (const h of hits) {
    if (typeof h?.url !== 'string' || !PRODUCT_ID_RE.test(h.url)) continue;
    links.add(h.url.startsWith('http') ? h.url.split('?')[0] : `${origin}${h.url.startsWith(prefix) ? '' : prefix}${h.url.split('?')[0]}`);
  }
  if (links.size === 0) {
    for (const m of html.matchAll(/href=["']((?:https?:\/\/[^"']+)?\/[a-z]{2}\/[a-z]{2}\/buy-[^"'?#]+\/p\/\d{5,})/gi)) {
      links.add(m[1].startsWith('http') ? m[1] : `${origin}${m[1]}`);
    }
  }
  return [...links];
}

/** Number of listing pages the state reports (null when unknown). */
export function landmarkPageCount(html: string): number | null {
  const n = Number(landmarkState(html)?.algoliaProductReducer?.data?.nbPages);
  return Number.isInteger(n) && n >= 0 ? n : null;
}
