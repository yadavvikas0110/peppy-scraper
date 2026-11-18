/**
 * Scrape.do as the transport for the shopping and grocery pipelines (dining already uses it).
 *
 * Switched on per platform with SCRAPE_DO_SITES (comma-separated profile keys, or "all"):
 *   amazon, noon, carrefour, sharafdg, jumbo, namshi, mumzworld, letstango, talabat, deliveroo, noon-minutes
 * Unset → nothing changes (Bright Data stays the transport). This module never imports Bright Data.
 *
 * Every fetch goes through the per-platform profiles and retry rules (shared/scrapedo/), and is
 * validated with OUR parser before it counts as a success, so a cheap option that returns a page
 * without the data escalates to the next option instead of producing empty products.
 */
import { ProductData } from '../parsers/types';
import { parseAmazon } from '../parsers/amazon.parser';
import { parseNoon } from '../parsers/noon.parser';
import { parseCarrefour } from '../parsers/carrefour.parser';
import { parseSharafDG } from '../parsers/sharafdg.parser';
import { parseJumbo } from '../parsers/jumbo.parser';
import { parseMumzworld } from '../parsers/mumzworld.parser';
import { parseNamshi } from '../parsers/namshi.parser';
import { parseAmazonSearch } from '../parsers/search/amazon.search.parser';
import { parseNoonSearch } from '../parsers/search/noon.search.parser';
import { parseCarrefourSearch } from '../parsers/search/carrefour.search.parser';
import { parseSharafDGSearch } from '../parsers/search/sharafdg.search.parser';
import { parseJumboSearch } from '../parsers/search/jumbo.search.parser';
import { parseMumzworldSearch } from '../parsers/search/mumzworld.search.parser';
import { parseNamshiSearch } from '../parsers/search/namshi.search.parser';
import { fillFromJsonLd } from '../parsers/jsonld';
import { profileForUrl, SCRAPE_DO_PROFILES } from '../shared/scrapedo/scrapedo.profiles';
import { ProfiledFetcher, sharedProfiledFetcher } from '../shared/scrapedo/scrapedo.fetcher';

export const SCRAPE_DO_PLATFORM_KEYS = Object.keys(SCRAPE_DO_PROFILES);

/** Platforms switched to Scrape.do by SCRAPE_DO_SITES. */
export function scrapeDoPlatforms(env: NodeJS.ProcessEnv = process.env): Set<string> {
  const raw = (env.SCRAPE_DO_SITES || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  if (raw.includes('all')) return new Set(SCRAPE_DO_PLATFORM_KEYS);
  return new Set(raw.filter(k => SCRAPE_DO_PLATFORM_KEYS.includes(k)));
}

export function scrapeDoEnabledFor(platformKey: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return !!env.SCRAPE_DO_TOKEN?.trim() && scrapeDoPlatforms(env).has(platformKey);
}

export function scrapeDoEnabledForUrl(url: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const match = profileForUrl(url);
  return !!match && scrapeDoEnabledFor(match.key, env);
}

type ProductParser = (html: string, url: string) => ProductData;
type SearchParser = (html: string, baseUrl: string) => string[];

const PRODUCT_PARSERS: Record<string, ProductParser> = {
  amazon: parseAmazon, noon: parseNoon, carrefour: parseCarrefour, sharafdg: parseSharafDG,
  jumbo: parseJumbo, mumzworld: parseMumzworld, namshi: parseNamshi,
};
const SEARCH_PARSERS: Record<string, SearchParser> = {
  amazon: parseAmazonSearch, noon: parseNoonSearch, carrefour: parseCarrefourSearch, sharafdg: parseSharafDGSearch,
  jumbo: parseJumboSearch, mumzworld: parseMumzworldSearch, namshi: parseNamshiSearch,
};

function parseProduct(key: string, html: string, url: string): ProductData {
  const parser = PRODUCT_PARSERS[key];
  if (!parser) throw new Error(`No product parser for ${key}`);
  return fillFromJsonLd(parser(html, url), html);
}

/** A product page is loaded when it shows a product name. No price (e.g. no seller offer) is real data, not a block. */
const isProductPage = (p: ProductData) => !!p.productName;

/** Search / category listing page: usable when our search parser finds product links. */
export async function fetchListingViaScrapeDo(url: string, fetcher: ProfiledFetcher = sharedProfiledFetcher()): Promise<string> {
  const key = profileForUrl(url)?.key ?? 'default';
  const parse = SEARCH_PARSERS[key];
  const res = await fetcher.fetch(url, { kind: 'listing', isUsable: parse ? (h, u) => parse(h, u).length > 0 : h => h.length > 5000 });
  return res.html;
}

/** Product page → ProductData via our site parser, gaps filled from the page's JSON-LD. */
export async function scrapeProductViaScrapeDo(url: string, fetcher: ProfiledFetcher = sharedProfiledFetcher()): Promise<ProductData> {
  const key = profileForUrl(url)?.key ?? 'default';
  const res = await fetcher.fetch(url, { kind: 'product', isUsable: (h, u) => isProductPage(parseProduct(key, h, u)) });
  return { ...parseProduct(key, res.html, res.finalUrl || url), productUrl: url };
}

/** Grocery pages (Talabat Mart, Deliveroo HOP, Noon Minutes): usable when the page carries its data. */
export async function fetchGroceryPageViaScrapeDo(url: string, fetcher: ProfiledFetcher = sharedProfiledFetcher()): Promise<string> {
  const key = profileForUrl(url)?.key;
  const isUsable = key === 'noon-minutes'
    ? (h: string) => h.includes('/now-product/')
    : (h: string) => h.includes('__NEXT_DATA__');
  const res = await fetcher.fetch(url, { kind: 'listing', isUsable });
  return res.html;
}

/** XML sitemaps (Carrefour product discovery). */
export async function fetchSitemapViaScrapeDo(url: string, fetcher: ProfiledFetcher = sharedProfiledFetcher()): Promise<string> {
  const res = await fetcher.fetch(url, { kind: 'listing', isUsable: h => /<(urlset|sitemapindex)\b/i.test(h) || h.includes('<loc>') });
  return res.html;
}

/** Credits and pages per platform since the process started (for run summaries and the admin panel). */
export function scrapeDoUsage() {
  return sharedProfiledFetcher().usage();
}
