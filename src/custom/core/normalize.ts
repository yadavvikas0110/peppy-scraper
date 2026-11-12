import type { CustomProduct } from './types';

const MAX_PLAUSIBLE_PRICE = 1_000_000;
const MAX_IMAGES = 20;

/** "1,299.00", 1299, "AED 1,299" → 1299. Anything not a plausible positive amount (incl. "-5") → null. */
export function toPrice(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'string' && /-\s*\d/.test(value)) return null;
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

// "|" segments that are marketing / SEO decoration, never part of the product's identity
const MARKETING_SEGMENT = /^(best price.*|free\b.*|(\d+\s*(year|yr|month)s?\s*)?warranty.*|buy\b.*online.*|.*\b(uae|dubai)\b.*|namshi|mumzworld|jumbo( electronics)?|letstango|lets tango|official.*|genuine.*|original.*|cash on delivery.*|same day delivery.*|express delivery.*)$/i;

/**
 * Strips SEO decoration retailers add to titles ("Buy …", "| Best Price UAE", "in UAE | Mumzworld",
 * "| FREE DELIVERY | 1 Year Warranty"). Other "|" segments are kept: "iPhone 15 Pro | Natural
 * Titanium" names a variant, and dropping it would merge two colours into one product.
 */
export function cleanName(name: string | null | undefined): string | null {
  if (!name) return null;
  const decoded = name.replace(/&amp;/g, '&').replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"');
  const [first, ...rest] = decoded.split('|').map(p => p.trim());
  const kept = [first, ...rest.filter(p => p && !MARKETING_SEGMENT.test(p))].join(' | ');
  const s = kept
    .replace(/^\s*buy\s+/i, '')
    .replace(/\s+(online\s+)?in\s+(the\s+)?uae\b.*$/i, '')
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
