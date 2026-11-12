import { parseJumbo } from '../../parsers/jumbo.parser';
import { parseJumboSearch } from '../../parsers/search/jumbo.search.parser';
import { findOriginalPrice } from '../core/embedded-price';
import type { PlatformAdapter } from '../core/types';
import { extractHtmlProduct } from './html-adapter';

const ORIGIN = 'https://www.jumbo.ae';
const MAX_LISTING_PAGES = 2;

// Single-segment pages that are not comparable products but pass the product-slug heuristic:
// landing pages, and "advance-for-…" pre-order deposits (the price is a deposit, not the product's)
const NON_PRODUCT_SLUGS = /^(deal-of-the-day|best-sellers?|new-arrivals?|top-deals|clearance-sale)$|^advance-for-/;

/**
 * Jumbo (Vue Storefront) — the category grid is rendered client-side, so listing pages are
 * rendered once in local headless Chromium; product pages are server-rendered with a schema.org
 * Product block and are fetched with plain HTTP. target.source: listing path, e.g. "/mobile-phones.html".
 */
export const jumboAdapter: PlatformAdapter = {
  site: 'jumbo',
  origin: ORIGIN,
  transport: 'browser-listing+http',

  async discover(target, want, fetcher) {
    const urls: string[] = [];
    for (let page = 1; page <= MAX_LISTING_PAGES && urls.length < want; page++) {
      const listing = `${ORIGIN}${target.source}?pageNo=${page}`;
      const html = await fetcher.render(listing);
      const before = urls.length;
      for (const u of parseJumboSearch(html, listing)) {
        const slug = new URL(u).pathname.replace(/^\/|\.html$/g, '');
        if (!NON_PRODUCT_SLUGS.test(slug) && !urls.includes(u)) urls.push(u);
      }
      if (urls.length === before) break;
    }
    return { urls };
  },

  extract(html, url) {
    const product = extractHtmlProduct(html, url, parseJumbo);
    // Nuxt state: regular_price / final_price next to this product's own sku:"…"
    product.originalPrice = product.sku
      ? findOriginalPrice(html, product.price, { regularKey: 'regular_price', finalKey: 'final_price', anchor: `sku:"${product.sku}"` })
      : null;
    return product;
  },
};
