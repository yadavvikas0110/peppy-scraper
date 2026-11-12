import type { ProductData } from '../../parsers/types';
import type { SiteKey } from '../../config/sites';

/**
 * Custom scraper — our own transport (plain HTTP + local headless Chromium), no third-party
 * scraping provider. Sites it covers are a subset of the e-commerce SiteKeys so offers keep the
 * same retailerId as the rest of products_clean.
 */
export type CustomSite = Extract<SiteKey, 'namshi' | 'mumzworld' | 'jumbo' | 'letstango'>;

export const CUSTOM_SITES: readonly CustomSite[] = ['namshi', 'mumzworld', 'jumbo', 'letstango'];

/** One category to scrape on one platform (from config/custom-scraper.json). */
export interface CategoryTarget {
  /** Stable key, unique per site (e.g. "women-bags") */
  key: string;
  label: string;
  /** Peppy taxonomy (src/config/taxonomy.ts) */
  broadCategory: string;
  subCategory: string;
  /** Platform-specific source: listing path (/uae-en/men-shoes/) or Shopify collection handle */
  source: string;
  /** Valid products wanted from this category */
  limit: number;
}

/** ProductData plus fields our structured-data extraction can also provide. */
export interface CustomProduct extends ProductData {
  brand?: string | null;
  sku?: string | null;
  /** Struck-through price when the page states one */
  originalPrice?: number | null;
}

export interface FetchResult {
  url: string;
  status: number;
  body: string;
}

export interface CustomFetcher {
  /** Plain HTTP GET (rate-limited per host, robots.txt-checked, retried on transient errors) */
  get(url: string, accept?: string): Promise<FetchResult>;
  /** Local headless Chromium render, for client-rendered listing pages */
  render(url: string, waitMs?: number): Promise<string>;
}

/** Discovery returns product URLs to fetch, or finished products when the source is structured (Shopify JSON). */
export interface Discovery {
  urls?: string[];
  products?: CustomProduct[];
}

export interface PlatformAdapter {
  site: CustomSite;
  /** Origin requests go to, e.g. https://www.namshi.com */
  origin: string;
  transport: 'http' | 'browser-listing+http' | 'shopify-json';
  discover(target: CategoryTarget, want: number, fetcher: CustomFetcher): Promise<Discovery>;
  /** Pure: product page HTML → product. Never throws for missing fields. */
  extract(html: string, url: string): CustomProduct;
}
