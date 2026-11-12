import type { CustomProduct } from './types';

const MAX_PLAUSIBLE_PRICE = 1_000_000;
const MAX_IMAGES = 20;

/** "1,299.00", 1299, "AED 1,299" → 1299. Anything not a plausible positive amount → null. */
export function toPrice(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'number' ? value : parseFloat(String(value).replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) && n > 0 && n < MAX_PLAUSIBLE_PRICE ? Math.round(n * 100) / 100 : null;
}

/** Absolute https URLs, deduplicated, order kept. */
export function normalizeImages(urls: Array<string | null | undefined>, base: string): string[] {
  const out: string[] = [];
  for (const raw of urls) {
    if (!raw || typeof raw !== 'string') continue;
    let u: URL;
    try { u = new URL(raw.trim(), base); } catch { continue; }
    if (u.protocol === 'http:') u.protocol = 'https:';
    if (u.protocol !== 'https:') continue;
    const s = u.toString();
    if (!out.includes(s)) out.push(s);
    if (out.length >= MAX_IMAGES) break;
  }
  return out;
}

/** Strips SEO decoration retailers add to titles ("Buy …", "| Best Price UAE", "in UAE | Mumzworld"). */
export function cleanName(name: string | null | undefined): string | null {
  if (!name) return null;
  const s = name
    .replace(/&amp;/g, '&').replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"')
    .replace(/^\s*buy\s+/i, '')
    .replace(/\s*\|.*$/, '')
    .replace(/\s+(online\s+)?in\s+(the\s+)?uae.*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  return s || null;
}

export function cleanText(text: string | null | undefined, max = 500): string | null {
  if (!text) return null;
  const s = text.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
  return s ? s.slice(0, max) : null;
}

/**
 * Field-wise merge: `primary` (structured data) wins when it has a value, `fallback` (the
 * existing CSS/meta parser) fills the gaps. Images come from ONE source: structured data lists
 * only the product's own gallery, while page-wide <img> scraping also picks up banners, payment
 * badges and other products' thumbnails — so fallback images are used only when primary has none.
 */
export function mergeProducts(primary: Partial<CustomProduct>, fallback: Partial<CustomProduct>, url: string): CustomProduct {
  const pick = <K extends keyof CustomProduct>(k: K): CustomProduct[K] | null =>
    (primary[k] ?? fallback[k] ?? null) as CustomProduct[K] | null;
  const primaryImages = normalizeImages([...(primary.imageUrls ?? []), primary.imageUrl], url);
  const imageUrls = primaryImages.length ? primaryImages : normalizeImages([...(fallback.imageUrls ?? []), fallback.imageUrl], url);
  return {
    productName: cleanName(pick('productName')),
    productUrl: url,
    imageUrl: imageUrls[0] ?? null,
    imageUrls,
    price: toPrice(pick('price')),
    currency: pick('currency') ?? (toPrice(pick('price')) !== null ? 'AED' : null),
    ratings: pick('ratings'),
    reviewCount: pick('reviewCount'),
    description: cleanText(pick('description')),
    inStock: primary.inStock ?? fallback.inStock ?? null,
    category: pick('category'),
    brand: pick('brand'),
    sku: pick('sku'),
    originalPrice: toPrice(pick('originalPrice')),
  };
}
