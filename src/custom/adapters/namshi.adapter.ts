import { parseNamshi } from '../../parsers/namshi.parser';
import { parseNamshiSearch } from '../../parsers/search/namshi.search.parser';
import type { PlatformAdapter } from '../core/types';
import { extractHtmlProduct } from './html-adapter';

const ORIGIN = 'https://www.namshi.com';
const MAX_LISTING_PAGES = 3;

/**
 * Namshi — listing pages are server-rendered with product URLs embedded as JSON; product pages
 * carry a schema.org Product block. Plain HTTP for both.
 * target.source: listing path, e.g. "/uae-en/men-shoes/".
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

  extract: (html, url) => extractHtmlProduct(html, url, parseNamshi),
};
