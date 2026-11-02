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
  { id: '1169', slug: 'abu-hail' },
  { id: '1170', slug: 'academic-city' },
  { id: '1172', slug: 'al-badaa' },
  { id: '1173', slug: 'al-baraha' },
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
  /** Hard cap on Bright Data requests per run (budget guard). Each request ≈ 1 Unlocker credit. */
  maxRequests: Number(process.env.GROCERY_MAX_REQUESTS || 4000),
  /** Products pushed to Mongo per batch. */
  pushBatchSize: Number(process.env.GROCERY_PUSH_BATCH || 200),
  /** Max area-listing pages to page through per area. */
  maxAreaPages: Number(process.env.GROCERY_MAX_AREA_PAGES || 15),
  /** Polite delay between requests (ms). */
  requestDelayMs: Number(process.env.GROCERY_REQUEST_DELAY_MS || 250),
};

export const TALABAT_ORIGIN = 'https://www.talabat.com';
export const TALABAT_RETAILER_ID = 'talabat';
export const TALABAT_RETAILER_NAME = 'Talabat Mart';
