import { normalizeGtin, type ProductData } from './types';

/**
 * schema.org JSON-LD reader for product pages (shared by the site parsers).
 * Same rules as the custom scraper's src/custom/core/jsonld.ts: Product or the first variant of a
 * ProductGroup; rating normalised to a 0–5 scale; availability → true / false / null.
 */

/** All parseable <script type="application/ld+json"> blocks, flattened (arrays and @graph). */
export function jsonLdBlocks(html: string): any[] {
  const out: any[] = [];
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  for (const m of html.matchAll(re)) {
    try {
      const parsed = JSON.parse(m[1].trim());
      const stack = Array.isArray(parsed) ? [...parsed] : [parsed];
      while (stack.length) {
        const node = stack.shift();
        if (!node || typeof node !== 'object') continue;
        out.push(node);
        if (Array.isArray(node['@graph'])) stack.push(...node['@graph']);
      }
    } catch { /* malformed block — skip */ }
  }
  return out;
}

const isType = (node: any, type: string) =>
  node?.['@type'] === type || (Array.isArray(node?.['@type']) && node['@type'].includes(type));

function toPrice(v: unknown): number | null {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? '').replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) && n > 0 ? n : null;
}

function availabilityToStock(value: unknown): boolean | null {
  const s = String(value ?? '');
  if (/InStock|LimitedAvailability|OnlineOnly|PreOrder/i.test(s)) return true;
  if (/OutOfStock|SoldOut|Discontinued/i.test(s)) return false;
  return null;
}

function firstOffer(offers: any): any {
  if (!offers) return null;
  if (Array.isArray(offers)) return offers.find(o => toPrice(o?.price ?? o?.lowPrice) !== null) ?? offers[0];
  return offers;
}

function imageList(image: any): string[] {
  const list = Array.isArray(image) ? image : image ? [image] : [];
  return list.map(i => (typeof i === 'string' ? i : i?.url ?? i?.contentUrl)).filter((s): s is string => typeof s === 'string');
}

export interface JsonLdProduct {
  productName: string | null;
  imageUrls: string[];
  price: number | null;
  currency: string | null;
  inStock: boolean | null;
  description: string | null;
  ratings: number | null;
  reviewCount: number | null;
  gtin: string | null;
  brand: string | null;
}

function gtinOf(node: any, offer: any): string | null {
  for (const src of [node, offer]) {
    for (const key of ['gtin13', 'gtin', 'gtin12', 'gtin14', 'gtin8', 'ean']) {
      const g = normalizeGtin(src?.[key]);
      if (g) return g;
    }
  }
  return null;
}

function brandName(brand: any): string | null {
  const name = typeof brand === 'string' ? brand : brand?.name;
  return typeof name === 'string' && name.trim() ? name.trim() : null;
}

/** schema.org Product → product fields; null when the page has no Product block. */
export function extractJsonLdProduct(html: string): JsonLdProduct | null {
  const blocks = jsonLdBlocks(html);
  let product = blocks.find(b => isType(b, 'Product'));
  const group = blocks.find(b => isType(b, 'ProductGroup'));
  if (!product && group) product = { ...group, ...(Array.isArray(group.hasVariant) ? group.hasVariant[0] : {}) };
  if (!product) return null;

  const offer = firstOffer(product.offers);
  const price = toPrice(offer?.price ?? offer?.lowPrice);
  const rating = product.aggregateRating;
  const best = parseFloat(String(rating?.bestRating ?? '5')) || 5;
  const raw = rating?.ratingValue != null ? parseFloat(String(rating.ratingValue)) : NaN;
  const scaled = best > 0 && best !== 5 ? Math.round((raw / best) * 5 * 100) / 100 : raw;
  const ratingValue = scaled <= 5 ? scaled : NaN;
  const reviewCount = parseInt(String(rating?.reviewCount ?? rating?.ratingCount ?? ''), 10);

  return {
    productName: typeof product.name === 'string' ? product.name.trim() || null : null,
    imageUrls: imageList(product.image),
    price,
    currency: price !== null ? String(offer?.priceCurrency || 'AED').toUpperCase() : null,
    inStock: availabilityToStock(offer?.availability),
    description: typeof product.description === 'string' ? product.description : null,
    ratings: Number.isFinite(ratingValue) && ratingValue > 0 ? ratingValue : null,
    reviewCount: Number.isFinite(reviewCount) && reviewCount > 0 ? reviewCount : null,
    gtin: gtinOf(product, offer),
    brand: brandName(product.brand),
  };
}

/**
 * Fills only the fields the site parser left empty, from the page's JSON-LD Product.
 * Never overwrites a value the parser found (site-specific selectors stay authoritative).
 */
export function fillFromJsonLd(product: ProductData, html: string): ProductData {
  const ld = extractJsonLdProduct(html);
  if (!ld) return product;
  const out = { ...product };
  if (!out.productName && ld.productName) out.productName = ld.productName;
  if ((out.price == null || out.price <= 0) && ld.price != null) { out.price = ld.price; out.currency = ld.currency; }
  if (!out.imageUrls?.length && ld.imageUrls.length) { out.imageUrls = ld.imageUrls; out.imageUrl = ld.imageUrls[0]; }
  if (out.ratings == null && ld.ratings != null) out.ratings = ld.ratings;
  if (out.reviewCount == null && ld.reviewCount != null) out.reviewCount = ld.reviewCount;
  if (out.inStock == null && ld.inStock != null) out.inStock = ld.inStock;
  if (!out.description && ld.description) out.description = ld.description;
  if (!out.gtin && ld.gtin) out.gtin = ld.gtin;
  if (!out.brand && ld.brand) out.brand = ld.brand;
  return out;
}
