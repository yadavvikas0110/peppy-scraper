import { parseAmazonSearch } from '../parsers/search/amazon.search.parser';
import { parseNoonSearch } from '../parsers/search/noon.search.parser';
import { parseCarrefourSearch } from '../parsers/search/carrefour.search.parser';
import { parseSharafDGSearch } from '../parsers/search/sharafdg.search.parser';
import { parseJumboSearch } from '../parsers/search/jumbo.search.parser';
import { parseMumzworldSearch } from '../parsers/search/mumzworld.search.parser';
import { parseNamshiSearch } from '../parsers/search/namshi.search.parser';
import { carrefourSitemapSearch } from '../services/carrefour.sitemap';
import { parseLandmarkSearch } from '../parsers/landmark.parser';
import { parseOunassSearch, OUNASS_PAGE_SIZE } from '../parsers/ounass.parser';

export type SiteKey =
  | 'amazon'
  | 'noon'
  | 'carrefour'
  | 'sharafdg'
  | 'jumbo'
  | 'mumzworld'
  | 'namshi'
  | 'letstango'
  | 'ounass'
  | 'centrepoint'
  | 'homecentre';

/** Every site key, in display order (used by config validation and the bulk runner). */
export const SITE_KEYS: SiteKey[] = ['amazon', 'noon', 'carrefour', 'sharafdg', 'jumbo', 'mumzworld', 'namshi', 'letstango', 'ounass', 'centrepoint', 'homecentre'];

export interface SiteConfig {
  hostname: string;
  /** If true: use Shopify /products.json API — no individual page scraping */
  shopify?: boolean;
  buildSearchUrl: (category: string, page: number) => string;
  parseSearchLinks: (html: string, baseUrl: string) => string[];
  collectLinks?: (category: string, count: number) => Promise<string[]>;
  /**
   * Use the search / category pages instead of collectLinks when the site runs on Scrape.do.
   * (Carrefour: its sitemap keyword match returns old, mostly out-of-stock listings; the search page
   * through Scrape.do returns current, ranked products for 1 credit — measured 25 Nov 2026.)
   */
  listingPagesOnScrapeDo?: boolean;
  /** Category browse URLs — keyed by categoryKey (e.g. 'smartphones', 'laptops') */
  categories?: Record<string, (page: number) => string>;
}

// Landmark Group (Centrepoint, Home Centre): category pages /ae/en/c/<code>, pagination ?p=N (1-based;
// verified Nov 2026: the last pagination link equals nbPages). Search: /ae/en/search/?q=… (same state).
const landmarkCategory = (host: string, code: string) => (p: number) =>
  `https://${host}/ae/en/c/${code}${p > 1 ? `?p=${p}` : ''}`;
const landmarkCategories = (host: string, map: Record<string, string>) =>
  Object.fromEntries(Object.entries(map).map(([key, code]) => [key, landmarkCategory(host, code)]));

// Ounass: 24 products per page, pagination ?fh_start_index=<offset> (verified Nov 2026)
const ounassCategory = (path: string) => (p: number) =>
  `https://www.ounass.ae${path}${p > 1 ? `?fh_start_index=${(p - 1) * OUNASS_PAGE_SIZE}` : ''}`;

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
    listingPagesOnScrapeDo: true,
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
    // Mumzworld moved categories to /en/c/… in Nov 2026 (old paths return 404). Further pages load by
    // JavaScript: ?p=N returns page 1 again, so these pages give the first ~27 products per category only.
    categories: {
      'baby-strollers':  (p) => p === 1 ? 'https://www.mumzworld.com/en/c/travel-gear/strollers-prams' : `https://www.mumzworld.com/en/c/travel-gear/strollers-prams?p=${p}`,
      'baby-carriers':   (p) => p === 1 ? 'https://www.mumzworld.com/en/c/travel-gear/baby-carriers' : `https://www.mumzworld.com/en/c/travel-gear/baby-carriers?p=${p}`,
      'baby-monitors':   (p) => p === 1 ? 'https://www.mumzworld.com/en/c/health-safety/monitors' : `https://www.mumzworld.com/en/c/health-safety/monitors?p=${p}`,
      'nursery':         (p) => p === 1 ? 'https://www.mumzworld.com/en/c/nursery-bedroom' : `https://www.mumzworld.com/en/c/nursery-bedroom?p=${p}`,
      'baby-feeding':    (p) => p === 1 ? 'https://www.mumzworld.com/en/c/feeding-and-nursing' : `https://www.mumzworld.com/en/c/feeding-and-nursing?p=${p}`,
      'baby-care':       (p) => p === 1 ? 'https://www.mumzworld.com/en/c/bath-and-skin-care' : `https://www.mumzworld.com/en/c/bath-and-skin-care?p=${p}`,
      'toys':            (p) => p === 1 ? 'https://www.mumzworld.com/en/c/toys-learning' : `https://www.mumzworld.com/en/c/toys-learning?p=${p}`,
      'baby-clothing':   (p) => p === 1 ? 'https://www.mumzworld.com/en/c/baby-clothing-shoes' : `https://www.mumzworld.com/en/c/baby-clothing-shoes?p=${p}`,
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

  // ── Scrape.do-only sites (Cloudflare; no Bright Data parser) ────────────────
  // Category paths below were read from the live sites' navigation (Nov 2026).

  ounass: {
    hostname: 'ounass.ae',
    buildSearchUrl: (category, page) =>
      `https://www.ounass.ae/search?q=${encodeURIComponent(category)}${page > 1 ? `&fh_start_index=${(page - 1) * OUNASS_PAGE_SIZE}` : ''}`,
    parseSearchLinks: parseOunassSearch,
    categories: {
      'women-fashion': ounassCategory('/women/clothing'),
      'women-dresses': ounassCategory('/women/clothing/dresses'),
      'abayas':        ounassCategory('/women/clothing/abayas'),
      'women-shoes':   ounassCategory('/women/shoes'),
      'bags':          ounassCategory('/women/bags'),
      'beauty':        ounassCategory('/women/beauty'),
      'jewellery':     ounassCategory('/women/jewellery'),
      'accessories':   ounassCategory('/women/accessories'),
    },
  },

  centrepoint: {
    hostname: 'centrepointstores.com',
    buildSearchUrl: (category, page) =>
      `https://www.centrepointstores.com/ae/en/search/?q=${encodeURIComponent(category)}${page > 1 ? `&p=${page}` : ''}`,
    parseSearchLinks: parseLandmarkSearch,
    categories: landmarkCategories('www.centrepointstores.com', {
      'fragrance':      'beautyandpersonalcare-fragrance',
      'makeup':         'beautyandpersonalcare-makeup',
      'women-fashion':  'women-clothing',
      'women-dresses':  'women-clothing-dresses',
      'men-fashion':    'men-clothing',
      'women-shoes':    'women-shoes',
      'men-shoes':      'men-shoes',
      'sneakers':       'men-shoes-sneakers',
      'bags':           'women-bagsandwallets',
      'toys':           'toys',
      'baby-strollers': 'baby-gear-strollersandprams',
      'bedding':        'household-bedding',
      'cookware':       'household-kitchen',
      'dinnerware':     'household-dining',
    }),
  },

  homecentre: {
    hostname: 'homecentre.com',
    buildSearchUrl: (category, page) =>
      `https://www.homecentre.com/ae/en/search/?q=${encodeURIComponent(category)}${page > 1 ? `&p=${page}` : ''}`,
    parseSearchLinks: parseLandmarkSearch,
    categories: landmarkCategories('www.homecentre.com', {
      'kitchen-appliances': 'household-appliances-kitchenappliances',
      'air-fryers':         'household-appliances-kitchenappliances-airfryers',
      'coffee-machines':    'household-appliances-kitchenappliances-coffeemachines',
      'kettles':            'household-appliances-kitchenappliances-electrickettles',
      'blenders':           'household-appliances-kitchenappliances-blendersmixersandgrinders',
      'microwaves':         'household-appliances-kitchenappliances-microwavesandovens',
      'vacuum-cleaners':    'household-appliances-homeappliances-vacuumcleaners',
      'air-purifiers':      'household-appliances-homeappliances-airpurifiers',
      'irons':              'household-appliances-homeappliances-ironandsteamers',
      'tvs':                'household-appliances-televisions',
      'large-appliances':   'household-appliances-largeappliances',
      'office-chairs':      'furniture-office-officechairs',
      'mattresses':         'furniture-mattresses',
      'sofas':              'furniture-sofaandseating',
      'bedding':            'household-bedding',
      'cookware':           'household-kitchen-cookware',
      'dinnerware':         'household-dining-dinnerware',
    }),
  },
};
