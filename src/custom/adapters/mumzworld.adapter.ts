import { parseMumzworld } from '../../parsers/mumzworld.parser';
import { parseMumzworldSearch } from '../../parsers/search/mumzworld.search.parser';
import { findOriginalPrice } from '../core/embedded-price';
import type { PlatformAdapter } from '../core/types';
import { extractHtmlProduct } from './html-adapter';

const ORIGIN = 'https://www.mumzworld.com';
const MAX_LISTING_PAGES = 3;

/**
 * Mumzworld — category pages and product pages are server-rendered; product pages carry a
 * schema.org Product block. Plain HTTP. robots.txt disallows /search/, so discovery uses
 * category paths only, e.g. "/en/feeding-and-nursing".
 */
export const mumzworldAdapter: PlatformAdapter = {
  site: 'mumzworld',
  origin: ORIGIN,
  transport: 'http',

  async discover(target, want, fetcher) {
    const urls: string[] = [];
    for (let page = 1; page <= MAX_LISTING_PAGES && urls.length < want; page++) {
      const listing = `${ORIGIN}${target.source}${page > 1 ? `?p=${page}` : ''}`;
      const { status, body } = await fetcher.get(listing);
      if (status === 404) throw new Error(`category page not found (404): ${listing}`);
      const before = urls.length;
      for (const u of parseMumzworldSearch(body, listing)) if (!urls.includes(u)) urls.push(u);
      if (urls.length === before) break;
    }
    return { urls };
  },

  extract(html, url) {
    const product = extractHtmlProduct(html, url, parseMumzworld);
    // Magento GraphQL cache: price_range.minimum_price.{regular_price,final_price}; the pair whose
    // final price equals this product's JSON-LD price is this product's own
    product.originalPrice = findOriginalPrice(html, product.price, { regularKey: 'regular_price', finalKey: 'final_price', maxGap: 200 });
    return product;
  },
};
