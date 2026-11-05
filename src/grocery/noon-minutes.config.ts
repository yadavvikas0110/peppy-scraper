// noon Minutes (noon's UAE quick-commerce grocery) — scraped via the Bright Data Scraping Browser
// because the catalogue is a client-rendered SPA: products appear only after a Dubai dark-store
// resolves (verified live). The /uae-en/ site is English by default and resolves a Dubai store from
// a UAE exit (x-nooninstant-zonecode), so a UAE-pinned browser render yields the Dubai catalogue.

export const NOON_MINUTES_RETAILER_ID = 'noon-minutes';
export const NOON_MINUTES_RETAILER_NAME = 'Noon Minutes';
export const NOON_MINUTES_ORIGIN = 'https://minutes.noon.com';
export const NOON_MINUTES_EXIT_COUNTRY = (process.env.NOON_UNLOCKER_COUNTRY || 'ae').toLowerCase();

/** A noon Minutes category: its slug + the Peppy "Groceries" subcategory it maps to. */
export interface NoonCategory {
  slug: string;
  subCategory: string;
}

// Confirmed category slugs (from minutes.noon.com/uae-en/categories/). Default crawl targets the
// food/grocery set; the rest (beauty, household, baby, electronics…) can be added via NOON_CATEGORIES.
// All map to Peppy broad category "Groceries"; subCategory groups them for the storefront.
export const NOON_FOOD_CATEGORIES: NoonCategory[] = [
  { slug: 'fruits_vegetables', subCategory: 'Fruits & Vegetables' },
  { slug: 'meat_seafood', subCategory: 'Fruits & Vegetables' },
  { slug: 'dairy_eggs', subCategory: 'Dairy & Eggs' },
  { slug: 'milk', subCategory: 'Dairy & Eggs' },
  { slug: 'bakery', subCategory: 'Bakery' },
  { slug: 'deli', subCategory: 'Bakery' },
  { slug: 'dates_arabic_sweets', subCategory: 'Bakery' },
  { slug: 'beverages', subCategory: 'Beverages' },
  { slug: 'water_ice', subCategory: 'Beverages' },
  { slug: 'tea_coffee', subCategory: 'Beverages' },
  { slug: 'snacks', subCategory: 'Snacks' },
  { slug: 'candies_gum', subCategory: 'Snacks' },
  { slug: 'chocolates_biscuits', subCategory: 'Snacks' },
  { slug: 'ice_cream', subCategory: 'Snacks' },
  { slug: 'breakfast', subCategory: 'Pantry & Staples' },
  { slug: 'rice_pasta_and_pulses', subCategory: 'Pantry & Staples' },
  { slug: 'oils_seasonings_nuts', subCategory: 'Pantry & Staples' },
  { slug: 'canned_food_and_sauces', subCategory: 'Pantry & Staples' },
  { slug: 'baking_sugars', subCategory: 'Pantry & Staples' },
  { slug: 'instant_food', subCategory: 'Pantry & Staples' },
  { slug: 'frozen', subCategory: 'Pantry & Staples' },
  { slug: 'healthy_corner', subCategory: 'Pantry & Staples' },
];

/** Full category slug list (for optional expansion beyond food via the NOON_CATEGORIES override). */
export const NOON_ALL_CATEGORY_SLUGS: string[] = [
  'minutes_kitchen', 'imported', 'ReadyGo', 'chocolates_biscuits', 'ice_cream', 'fruits_vegetables',
  'meat_seafood', 'deli', 'bakery', 'dairy_eggs', 'dates_arabic_sweets', 'milk', 'fresh_flowers',
  'snacks', 'candies_gum', 'healthy_corner', 'beverages', 'instant_food', 'water_ice',
  'oils_seasonings_nuts', 'rice_pasta_and_pulses', 'tea_coffee', 'baking_sugars', 'breakfast',
  'canned_food_and_sauces', 'frozen', 'makeup_cosmetics', 'fragrances', 'skin_care', 'bath_body',
  'hair_care', 'feminine_care', 'oral_care', 'sun_care', 'mens_grooming', 'ae_laundry_care',
  'ae_tissues_rolls', 'ae_household_cleaning', 'ae_disposables', 'diapers_wipes', 'baby_care',
  'baby_food', 'formula', 'baby_feeding', 'pets',
];

/**
 * Every noon Minutes category (food set with proper Peppy subcategories + all remaining non-food
 * categories mapped to "General"). This is the default crawl target for maximum coverage.
 */
export const NOON_FULL_CATEGORIES: NoonCategory[] = (() => {
  const foodBySlug = new Map(NOON_FOOD_CATEGORIES.map(c => [c.slug, c]));
  const allSlugs = Array.from(new Set([...NOON_ALL_CATEGORY_SLUGS, ...NOON_FOOD_CATEGORIES.map(c => c.slug)]));
  return allSlugs.map(slug => foodBySlug.get(slug) ?? { slug, subCategory: 'General' });
})();

/**
 * Resolve the category list to crawl. Default = FULL set (every category, for maximum data).
 * Override with NOON_CATEGORIES, a JSON array of {slug,subCategory} or a comma-separated list of
 * slugs (each mapped to "General"). Set NOON_CATEGORIES=food to crawl only the food set.
 */
export function resolveNoonCategories(env: NodeJS.ProcessEnv = process.env): NoonCategory[] {
  const raw = env.NOON_CATEGORIES?.trim();
  if (!raw) return NOON_FULL_CATEGORIES;
  if (raw.toLowerCase() === 'food') return NOON_FOOD_CATEGORIES;
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.every(c => c && typeof c.slug === 'string')) {
      return parsed.map((c: any) => ({ slug: c.slug, subCategory: c.subCategory || 'General' }));
    }
  } catch {
    // comma-separated slugs
    return raw.split(',').map(s => s.trim()).filter(Boolean).map(slug => ({ slug, subCategory: 'General' }));
  }
  return NOON_FULL_CATEGORIES;
}

/** Category listing URL. `rows` asks noon for a larger first page so one render yields more items. */
export function noonCategoryUrl(slug: string, rows = NOON_CRAWL_DEFAULTS.rowsPerCategory): string {
  return `${NOON_MINUTES_ORIGIN}/uae-en/search/?f%5Bcategory%5D=${encodeURIComponent(slug)}&rows=${rows}`;
}

export const NOON_CRAWL_DEFAULTS = {
  /**
   * Budget guard on browser renders per run (renders cost more than Unlocker requests).
   * NO CAP by default — render every category. Re-impose a cap with NOON_MAX_REQUESTS.
   */
  maxRequests: process.env.NOON_MAX_REQUESTS ? Number(process.env.NOON_MAX_REQUESTS) : Infinity,
  /** Products requested per category page render (higher = more items per render = more data). */
  rowsPerCategory: Number(process.env.NOON_ROWS || 500),
  /** Products pushed to Mongo per batch. */
  pushBatchSize: Number(process.env.GROCERY_PUSH_BATCH || 200),
  /** How long to wait for the product grid to render (ms). */
  renderWaitMs: Number(process.env.NOON_RENDER_WAIT_MS || 12000),
  /** Polite delay between renders (ms). */
  requestDelayMs: Number(process.env.GROCERY_REQUEST_DELAY_MS || 400),
};

/** CSS selector that signals the product grid has rendered. */
export const NOON_PRODUCT_READY_SELECTOR = 'a[href*="/now-product/"]';
