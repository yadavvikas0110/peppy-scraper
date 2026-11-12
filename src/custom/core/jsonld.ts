import type { CustomProduct } from './types';
import { toPrice } from './normalize';

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

/** schema.org Product (or the first variant of a ProductGroup) → product fields. Empty object when absent. */
export function extractJsonLdProduct(html: string): Partial<CustomProduct> {
  const blocks = jsonLdBlocks(html);
  let product = blocks.find(b => isType(b, 'Product'));
  const group = blocks.find(b => isType(b, 'ProductGroup'));
  if (!product && group) product = { ...group, ...(Array.isArray(group.hasVariant) ? group.hasVariant[0] : {}) };
  if (!product) return {};

  const offer = firstOffer(product.offers);
  const price = toPrice(offer?.price ?? offer?.lowPrice);
  const rating = product.aggregateRating;
  // Normalise to a 0–5 scale (the backend schema has rating max 5); unknown scales above 5 are dropped
  const best = parseFloat(String(rating?.bestRating ?? '5')) || 5;
  const rawRating = rating?.ratingValue != null ? parseFloat(String(rating.ratingValue)) : NaN;
  const scaled = best > 0 && best !== 5 ? Math.round((rawRating / best) * 5 * 100) / 100 : rawRating;
  const ratingValue = scaled <= 5 ? scaled : NaN;
  const reviewCount = parseInt(String(rating?.reviewCount ?? rating?.ratingCount ?? ''), 10);
  const brand = typeof product.brand === 'string' ? product.brand : product.brand?.name;
  const category = Array.isArray(product.category) ? product.category[0] : product.category;

  return {
    productName: typeof product.name === 'string' ? product.name : null,
    imageUrls: imageList(product.image),
    price,
    currency: price !== null ? String(offer?.priceCurrency || 'AED').toUpperCase() : null,
    inStock: availabilityToStock(offer?.availability),
    description: typeof product.description === 'string' ? product.description : null,
    ratings: Number.isFinite(ratingValue) && ratingValue > 0 ? ratingValue : null,
    reviewCount: Number.isFinite(reviewCount) && reviewCount > 0 ? reviewCount : null,
    brand: typeof brand === 'string' && brand.trim() ? brand.trim() : null,
    sku: String(product.sku ?? offer?.sku ?? '').trim() || null,
    category: typeof category === 'string' ? category : null,
  };
}
