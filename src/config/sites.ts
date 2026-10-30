import { parseAmazonSearch } from '../parsers/search/amazon.search.parser';
import { parseNoonSearch } from '../parsers/search/noon.search.parser';
import { parseCarrefourSearch } from '../parsers/search/carrefour.search.parser';
import { parseSharafDGSearch } from '../parsers/search/sharafdg.search.parser';
import { parseJumboSearch } from '../parsers/search/jumbo.search.parser';
import { parseMumzworldSearch } from '../parsers/search/mumzworld.search.parser';
import { parseNamshiSearch } from '../parsers/search/namshi.search.parser';
import { carrefourSitemapSearch } from '../services/carrefour.sitemap';

export type SiteKey =
  | 'amazon'
  | 'noon'
  | 'carrefour'
  | 'sharafdg'
  | 'jumbo'
  | 'mumzworld'
  | 'namshi'
  | 'letstango';

export interface SiteConfig {
  hostname: string;
  /** If true: use Shopify /products.json API — no individual page scraping */
  shopify?: boolean;
  buildSearchUrl: (category: string, page: number) => string;
  parseSearchLinks: (html: string, baseUrl: string) => string[];
  collectLinks?: (category: string, count: number) => Promise<string[]>;
  /** Category browse URLs — keyed by categoryKey (e.g. 'smartphones', 'laptops') */
  categories?: Record<string, (page: number) => string>;
}

export const SITES: Record<SiteKey, SiteConfig> = {
  // ── Existing sites ─────────────────────────────────────────────────────────
  amazon: {
    hostname: 'amazon.ae',
    buildSearchUrl: (category, page) =>
      `https://www.amazon.ae/s?k=${encodeURIComponent(category)}&page=${page}`,
    parseSearchLinks: parseAmazonSearch,
  },

  noon: {
    hostname: 'noon.com',
    buildSearchUrl: (category, page) =>
      `https://www.noon.com/uae-en/search/?q=${encodeURIComponent(category)}&page=${page}`,
    parseSearchLinks: parseNoonSearch,
  },

  carrefour: {
    hostname: 'carrefouruae.com',
    buildSearchUrl: (category, page) =>
      `https://www.carrefouruae.com/mafuae/en/search?keyword=${encodeURIComponent(category)}&page=${page}`,
    parseSearchLinks: parseCarrefourSearch,
    collectLinks: (category, count) => carrefourSitemapSearch(category, count),
  },

  sharafdg: {
    hostname: 'sharafdg.com',
    buildSearchUrl: (category, page) =>
      page === 1
        ? `https://uae.sharafdg.com/?q=${encodeURIComponent(category)}&post_type=product`
        : `https://uae.sharafdg.com/page/${page}/?q=${encodeURIComponent(category)}&post_type=product`,
    parseSearchLinks: parseSharafDGSearch,
    categories: {
      // /c/{taxonomy}/ URLs confirmed via browser — pagination: ?page=N
      'smartphones':        (p) => p === 1 ? 'https://uae.sharafdg.com/c/mobiles_tablets/mobiles/'         : `https://uae.sharafdg.com/c/mobiles_tablets/mobiles/?page=${p}`,
      'laptops':            (p) => p === 1 ? 'https://uae.sharafdg.com/c/computing/laptops/'               : `https://uae.sharafdg.com/c/computing/laptops/?page=${p}`,
      'tablets':            (p) => p === 1 ? 'https://uae.sharafdg.com/c/mobiles_tablets/tablets/'         : `https://uae.sharafdg.com/c/mobiles_tablets/tablets/?page=${p}`,
      'tvs':                (p) => p === 1 ? 'https://uae.sharafdg.com/c/tv_video_audio/tvs/'              : `https://uae.sharafdg.com/c/tv_video_audio/tvs/?page=${p}`,
      'audio':              (p) => p === 1 ? 'https://uae.sharafdg.com/c/tv_video_audio/audio/'            : `https://uae.sharafdg.com/c/tv_video_audio/audio/?page=${p}`,
      'cameras':            (p) => p === 1 ? 'https://uae.sharafdg.com/c/cameras_camcorders/'              : `https://uae.sharafdg.com/c/cameras_camcorders/?page=${p}`,
      'wearables':          (p) => p === 1 ? 'https://uae.sharafdg.com/c/wearables_smartwatches/smartwatches/' : `https://uae.sharafdg.com/c/wearables_smartwatches/smartwatches/?page=${p}`,
      'gaming':             (p) => p === 1 ? 'https://uae.sharafdg.com/c/gaming/'                          : `https://uae.sharafdg.com/c/gaming/?page=${p}`,
      'kitchen-appliances': (p) => p === 1 ? 'https://uae.sharafdg.com/c/home_appliances/small_appliances/' : `https://uae.sharafdg.com/c/home_appliances/small_appliances/?page=${p}`,
      'large-appliances':   (p) => p === 1 ? 'https://uae.sharafdg.com/c/home_appliances/'                 : `https://uae.sharafdg.com/c/home_appliances/?page=${p}`,
      'personal-care':      (p) => p === 1 ? 'https://uae.sharafdg.com/c/health_fitness_beauty/'           : `https://uae.sharafdg.com/c/health_fitness_beauty/?page=${p}`,
    },
  },

  // ── New sites ──────────────────────────────────────────────────────────────

  jumbo: {
    hostname: 'jumbo.ae',
    buildSearchUrl: (category, page) =>
      `https://www.jumbo.ae/search/${encodeURIComponent(category)}?pageNo=${page}`,
    parseSearchLinks: parseJumboSearch,
    categories: {
      // Confirmed via browser — all use ?pageNo=N pagination
      'smartphones':        (p) => `https://www.jumbo.ae/mobile-phones.html?pageNo=${p}`,
      'laptops':            (p) => `https://www.jumbo.ae/personal-computers/laptops.html?pageNo=${p}`,
      'tablets':            (p) => `https://www.jumbo.ae/personal-computers/tablets.html?pageNo=${p}`,
      'tvs':                (p) => `https://www.jumbo.ae/television-home-theaters.html?pageNo=${p}`,
      'audio':              (p) => `https://www.jumbo.ae/headphones-speakers.html?pageNo=${p}`,
      'cameras':            (p) => `https://www.jumbo.ae/cameras.html?pageNo=${p}`,
      'wearables':          (p) => `https://www.jumbo.ae/wearables.html?pageNo=${p}`,
      'gaming':             (p) => `https://www.jumbo.ae/gaming.html?pageNo=${p}`,
      'kitchen-appliances': (p) => `https://www.jumbo.ae/home-appliances.html?pageNo=${p}`,
      'large-appliances':   (p) => `https://www.jumbo.ae/home-appliances.html?pageNo=${p}`,
      'personal-care':      (p) => `https://www.jumbo.ae/health-and-personal-care.html?pageNo=${p}`,
    },
  },

  mumzworld: {
    hostname: 'mumzworld.com',
    buildSearchUrl: (category, page) =>
      page === 1
        ? `https://mumzworld.com/en/search?q=${encodeURIComponent(category)}`
        : `https://mumzworld.com/en/search?q=${encodeURIComponent(category)}&p=${page}`,
    parseSearchLinks: parseMumzworldSearch,
    categories: {
      'baby-strollers':  (p) => p === 1 ? 'https://www.mumzworld.com/en/baby-gear/strollers'    : `https://www.mumzworld.com/en/baby-gear/strollers?p=${p}`,
      'baby-carriers':   (p) => p === 1 ? 'https://www.mumzworld.com/en/baby-gear/baby-carriers' : `https://www.mumzworld.com/en/baby-gear/baby-carriers?p=${p}`,
      'baby-monitors':   (p) => p === 1 ? 'https://www.mumzworld.com/en/nursery/baby-monitors'   : `https://www.mumzworld.com/en/nursery/baby-monitors?p=${p}`,
      'nursery':         (p) => p === 1 ? 'https://www.mumzworld.com/en/nursery'                 : `https://www.mumzworld.com/en/nursery?p=${p}`,
      'baby-feeding':    (p) => p === 1 ? 'https://www.mumzworld.com/en/feeding'                 : `https://www.mumzworld.com/en/feeding?p=${p}`,
      'baby-care':       (p) => p === 1 ? 'https://www.mumzworld.com/en/baby-care'               : `https://www.mumzworld.com/en/baby-care?p=${p}`,
      'toys':            (p) => p === 1 ? 'https://www.mumzworld.com/en/toys-games'              : `https://www.mumzworld.com/en/toys-games?p=${p}`,
      'baby-clothing':   (p) => p === 1 ? 'https://www.mumzworld.com/en/clothing'                : `https://www.mumzworld.com/en/clothing?p=${p}`,
    },
  },

  namshi: {
    hostname: 'namshi.com',
    buildSearchUrl: (category, page) =>
      `https://www.namshi.com/uae-en/search/?q=${encodeURIComponent(category)}&page=${page}`,
    parseSearchLinks: parseNamshiSearch,
    categories: {
      // Product listing pages. /uae-en/women/ etc. are landing pages with banners only (no products).
      'women-fashion':   (p) => `https://www.namshi.com/uae-en/women-clothing/?page=${p}`,
      'men-fashion':     (p) => `https://www.namshi.com/uae-en/men-clothing/?page=${p}`,
      'kids-fashion':    (p) => `https://www.namshi.com/uae-en/kids-clothing/?page=${p}`,
      'women-shoes':     (p) => `https://www.namshi.com/uae-en/women-shoes/?page=${p}`,
      'men-shoes':       (p) => `https://www.namshi.com/uae-en/men-shoes/?page=${p}`,
      'bags':            (p) => `https://www.namshi.com/uae-en/women-bags/?page=${p}`,
      'abayas':          (p) => `https://www.namshi.com/uae-en/women-clothing-arabian_clothing-abayas/?page=${p}`,
      'sports-fashion':  (p) => `https://www.namshi.com/uae-en/women-clothing-sportswear/?page=${p}`,
    },
  },

  letstango: {
    hostname: 'letstango.com',
    shopify: true,
    // Unused for Shopify — collectShopifyProducts handles everything
    buildSearchUrl: () => '',
    parseSearchLinks: () => [],
  },
};
