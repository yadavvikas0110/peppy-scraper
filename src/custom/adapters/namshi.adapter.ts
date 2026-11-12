import { parseNamshi } from '../../parsers/namshi.parser';
import { parseNamshiSearch } from '../../parsers/search/namshi.search.parser';
import { findOriginalPrice } from '../core/embedded-price';
import type { PlatformAdapter } from '../core/types';
import { extractHtmlProduct } from './html-adapter';

const ORIGIN = 'https://www.namshi.com';
const MAX_LISTING_PAGES = 3;

/** The product's record in Namshi's app payload is keyed by its URI without the locale: /buy-…/<SKU>/p/ */
export function namshiUri(url: string): string | null {
  const m = /\/uae-en(\/buy-[^?#]+\/p\/)/.exec(new URL(url).pathname);
  return m ? m[1] : null;
}

/**
 * Namshi — listing pages are server-rendered with product URLs embedded as JSON; product pages
 * carry a schema.org Product block, and the app payload carries normalPrice / salePrice.
 * Plain HTTP for both. target.source: listing path, e.g. "/uae-en/men-shoes/".
 */
export const namshiAdapter: PlatformAdapter = {
  site: 'namshi',
  origin: ORIGIN,
  transport: 'http',

  async discover(target, want, fetcher) {
    const urls: string[] = [];
    for (let page = 1; page <= MAX_LISTING_PAGES && urls.length < want; page++) {
      const listing = `${ORIGIN}${target.source}${page > 1 ? `?page=${page}` : ''}`;
      const { body } = await fetcher.get(listing);
      const before = urls.length;
      for (const u of parseNamshiSearch(body, listing)) if (!urls.includes(u)) urls.push(u);
      if (urls.length === before) break; // no new products — last page
    }
    return { urls };
  },

  extract(html, url) {
    const product = extractHtmlProduct(html, url, parseNamshi);
    const uri = namshiUri(url);
    product.originalPrice = findOriginalPrice(html, product.price, {
      regularKey: 'normalPrice', finalKey: 'salePrice', anchor: uri ? `uri\\":\\"${uri}` : null,
    }) ?? (uri ? findOriginalPrice(html, product.price, { regularKey: 'normalPrice', finalKey: 'salePrice', anchor: `"uri":"${uri}` }) : null);
    return product;
  },
};
