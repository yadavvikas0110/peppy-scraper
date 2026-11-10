// Pilot target for the Talabat Mart grocery scrape. Every URL below was confirmed to load
// anonymously (no login) and to embed products in __NEXT_DATA__ at ~1 Unlocker credit.
//
// NOTE: store 690014 ("just fruits & veg") is a produce dark-store, so the pilot catalogue is
// fruit & veg only — enough to prove the pipeline end-to-end. A full-range Talabat Mart store
// (dairy/bakery/beverages/household) is added when we move past the pilot.

export interface GroceryCategoryTarget {
  /** A confirmed Talabat grocery (sub)category page URL. */
  url: string;
  /** Peppy subcategory this page maps to. */
  subCategory: string;
  /** Base tags always applied to products from this page. */
  tags: string[];
}

export interface GroceryStoreTarget {
  /** Stable platform key (used as the retailer id for cross-platform price comparison later). */
  retailerId: string;
  /** Display name shown as the offer's retailer. */
  retailerName: string;
  /** Talabat exit country for Bright Data Unlocker (catalogue is location-gated). */
  country: 'ae';
  categories: GroceryCategoryTarget[];
}

const STORE = 'https://www.talabat.com/uae/grocery/690014/talabat-mart-just-fruits-veg-jumeirah-1';
const AID = '1172'; // Al Bada'a, Dubai

const PRODUCE_TAGS = ['grocery', 'groceries', 'fresh', 'fruits-vegetables'];

export const TALABAT_PILOT: GroceryStoreTarget = {
  retailerId: 'talabat',
  retailerName: 'Talabat Mart',
  country: 'ae',
  categories: [
    { url: `${STORE}/bananas/local?aid=${AID}`,            subCategory: 'Fruits & Vegetables', tags: PRODUCE_TAGS },
    { url: `${STORE}/apples-pears/green-apples?aid=${AID}`, subCategory: 'Fruits & Vegetables', tags: PRODUCE_TAGS },
    { url: `${STORE}/citrus/orange?aid=${AID}`,             subCategory: 'Fruits & Vegetables', tags: PRODUCE_TAGS },
    { url: `${STORE}/berries/blueberry?aid=${AID}`,         subCategory: 'Fruits & Vegetables', tags: PRODUCE_TAGS },
    { url: `${STORE}/mangoes-melons/mangoes?aid=${AID}`,    subCategory: 'Fruits & Vegetables', tags: PRODUCE_TAGS },
  ],
};

/** Hard cap on products pushed by a pilot run, regardless of how many pages are crawled. */
export const GROCERY_DEFAULT_MAX = 20;

/** Peppy canonical broad category for all grocery products. */
export const GROCERY_BROAD_CATEGORY = 'Groceries';

// ─── Full-crawl configuration (server job) ────────────────────────────────────

export interface DubaiArea {
  id: string;
  slug: string;
}

/**
 * Dubai grocery delivery areas to enumerate stores from. The crawler dedupes stores by branch id,
 * so overlapping areas are harmless; coverage grows as areas are added here (or via the
 * GROCERY_DUBAI_AREAS env override — a JSON array of {id,slug}). Seeded with confirmed Dubai areas.
 */
export const DUBAI_AREAS: DubaiArea[] = [
  // Original seed areas
  { id: '1169', slug: 'abu-hail' },
  { id: '1170', slug: 'academic-city' },
  { id: '1172', slug: 'al-badaa' },
  { id: '1173', slug: 'al-baraha' },
  // Coverage for the Talabat Mart dark-store node list (ops, 2026-11-10). Area ids/slugs
  // confirmed live from talabat.com/uae/all-areas/groceries.
  // TM-MARINA-01/02 — Dubai Marina, JBR, Jumeirah Heights
  { id: '1272', slug: 'dubai-marina' },
  { id: '1305', slug: 'jumeirah-beach-residence-jbr' },
  { id: '4009', slug: 'jumeirah-heights' },
  // TM-SUFOUH-04 — Al Sufouh 2, Media City, Internet City
  { id: '1232', slug: 'al-sufouh-2' },
  { id: '1274', slug: 'dubai-media-city' },
  { id: '1266', slug: 'dubai-internet-city-dic' },
  // TM-SILICON-09 — Dubai Silicon Oasis, Liwan
  { id: '1277', slug: 'dubai-silicon-oasis' },
  { id: '5553', slug: 'liwan' },
  // TM-DLAND-12 — Dubailand, Damac Hills
  { id: '8909', slug: 'damac-hills' },
  { id: '4006', slug: 'city-of-arabia' },
  // TM-WARSAN-03 — International City, Warsan, Al Warqa
  { id: '1292', slug: 'international-city' },
  { id: '6801', slug: 'international-city-2' },
  { id: '1363', slug: 'warsan-1' },
  { id: '1241', slug: 'al-warqa-1' },
  { id: '1242', slug: 'al-warqa-2' },
  // TM-BBAY-07 — Downtown Dubai, Business Bay
  { id: '1252', slug: 'business-bay' },
  { id: '1258', slug: 'downtown-burj-khalifa' },
  // TM-BARSHA-02 — Al Barsha 1, 2, 3
  { id: '1174', slug: 'al-barsha-1' },
  { id: '1175', slug: 'al-barsha-2' },
  { id: '1176', slug: 'al-barsha-3' },
];

export function resolveDubaiAreas(env: NodeJS.ProcessEnv = process.env): DubaiArea[] {
  const raw = env.GROCERY_DUBAI_AREAS?.trim();
  if (!raw) return DUBAI_AREAS;
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.every(a => a && typeof a.id === 'string' && typeof a.slug === 'string')) {
      return parsed;
    }
  } catch { /* fall through to default */ }
  return DUBAI_AREAS;
}

export const GROCERY_CRAWL_DEFAULTS = {
  /**
   * Budget guard on Bright Data requests per run (each request ≈ 1 Unlocker credit).
   * NO CAP by default: the crawl runs exhaustively until the whole Dubai catalogue is scraped
   * (client has approved full credit spend). Re-impose a cap by setting GROCERY_MAX_REQUESTS.
   */
  maxRequests: process.env.GROCERY_MAX_REQUESTS ? Number(process.env.GROCERY_MAX_REQUESTS) : Infinity,
  /** Products pushed to Mongo per batch. */
  pushBatchSize: Number(process.env.GROCERY_PUSH_BATCH || 200),
  /** Max area-listing pages to page through per area. No cap by default (page until no more stores). */
  maxAreaPages: process.env.GROCERY_MAX_AREA_PAGES ? Number(process.env.GROCERY_MAX_AREA_PAGES) : Infinity,
  /**
   * Polite delay between requests (ms). Stays ON even with no budget cap: it prevents rate-limit
   * bans that would otherwise burn credits on failed requests and REDUCE total data collected.
   */
  requestDelayMs: Number(process.env.GROCERY_REQUEST_DELAY_MS || 250),
};

export const TALABAT_ORIGIN = 'https://www.talabat.com';
export const TALABAT_RETAILER_ID = 'talabat';
export const TALABAT_RETAILER_NAME = 'Talabat Mart';
