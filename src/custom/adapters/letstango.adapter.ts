import { mapShopifyProduct } from '../../services/shopify.service';
import { cleanName, cleanText, normalizeImages, toPrice } from '../core/normalize';
import type { CustomProduct, PlatformAdapter } from '../core/types';

const ORIGIN = 'https://www.letstango.com';
// Product URLs keep the hostname the existing pipeline stored, so offers match existing documents
const PRODUCT_HOST = 'letstango.com';
const PAGE_SIZE = 250;
const MAX_PAGES = 4;

interface ShopifyVariant { price?: string; compare_at_price?: string | null; available?: boolean; sku?: string }

/**
 * Shopify product JSON → product: shared mapping plus SKU and compare-at price of the chosen
 * variant. Letstango is a marketplace: Shopify's `vendor` is the seller ("LetsTango",
 * "TECH-OFFER"), not the brand, so no brand is taken from it. Titles carry marketing suffixes
 * ("| FREE DELIVERY | 1 Year Warranty"), which cleanName removes.
 */
export function mapLetstangoProduct(raw: any): CustomProduct {
  const base = mapShopifyProduct(raw, PRODUCT_HOST);
  const variants: ShopifyVariant[] = raw.variants ?? [];
  // mapShopifyProduct picks the cheapest in-stock variant; find that same one for its extras
  const chosen = variants.find(v => toPrice(v.price) === base.price && (base.inStock === null || v.available === base.inStock));
  const original = toPrice(chosen?.compare_at_price);
  return {
    ...base,
    productName: cleanName(base.productName),
    imageUrls: normalizeImages(base.imageUrls, ORIGIN),
    imageUrl: normalizeImages([base.imageUrl], ORIGIN)[0] ?? null,
    description: cleanText(raw.body_html),
    brand: null,
    sku: chosen?.sku?.trim() || null,
    originalPrice: original !== null && base.price !== null && original > base.price ? original : null,
  };
}

/**
 * Letstango (Shopify) — products come as structured JSON from the public collection endpoint
 * /collections/<handle>/products.json; no product pages are fetched.
 * target.source: collection handle, e.g. "mobile-phones".
 */
export const letstangoAdapter: PlatformAdapter = {
  site: 'letstango',
  origin: ORIGIN,
  transport: 'shopify-json',

  async discover(target, want, fetcher) {
    const products: CustomProduct[] = [];
    for (let page = 1; page <= MAX_PAGES && products.length < want; page++) {
      const url = `${ORIGIN}/collections/${encodeURIComponent(target.source)}/products.json?limit=${PAGE_SIZE}&page=${page}`;
      const { status, body } = await fetcher.get(url, 'application/json');
      if (status === 404) throw new Error(`collection not found (404): ${target.source}`);
      const list: any[] = JSON.parse(body).products ?? [];
      // Only purchasable listings: priced, at least one variant available
      for (const raw of list) {
        if (!(raw.variants ?? []).some((v: ShopifyVariant) => v.available)) continue;
        products.push(mapLetstangoProduct(raw));
        if (products.length >= want) break;
      }
      if (list.length < PAGE_SIZE) break;
    }
    return { products };
  },

  extract() {
    throw new Error('letstango products come from the collection JSON; there is no page to extract');
  },
};
