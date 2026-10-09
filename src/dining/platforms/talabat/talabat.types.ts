import type { DiningLocale } from '../../dining.types';
import type { PlatformParseWarning } from '../platform.types';

// Raw DTOs: what a Talabat restaurant menu page actually provides, in the page's own language.
// Optional means "not reliably present on the source" — never filled with guessed values.

// `next-data` → script#__NEXT_DATA__ → props.pageProps.initialMenuState (the only menu source).
// `none`      → the payload is missing/unusable; only page-level metadata (canonical URL, JSON-LD)
//               is read and no menu items are produced. There is no CSS fallback for items.
export type TalabatDataSource = 'next-data' | 'none';

export interface TalabatRawLocation {
  // initialMenuState.area — the delivery area in the URL (`aid`), localized.
  area?: string;
  city?: string;
  platformAreaId?: number;
  platformCityId?: number;
  // Branch coordinates (restaurant.latitude/longitude; the AR page formats them with Arabic decimals).
  lat?: number;
  lng?: number;
}

export interface TalabatRawRestaurant {
  // Talabat branch ID (`restaurant.branchId`, the number in /restaurant/<id>/<slug>), identical
  // across /uae and /ar/uae pages. This is the source restaurant identity.
  platformRestaurantId?: string;
  // Chain-level ID (`restaurant.restaurantId`), shared by every branch of the brand. Never an identity.
  platformBrandId?: string;
  // Branch slug from the URL path (e.g. "kamat-vegetarian-the-palm-jumeirah") — locale-neutral.
  slug?: string;
  // Brand slug (`restaurant.restaurantSlug`), shared by every branch.
  brandSlug?: string;
  // Branch display name (`restaurant.branchName`, e.g. "Kamat Vegetarian, The Palm Jumeirah").
  name?: string;
  // Brand display name (`restaurant.name`, e.g. "Kamat Vegetarian").
  brandName?: string;
  // Locale-specific canonical page URL (link[rel=canonical]).
  url?: string;
  // The exact URL that was fetched.
  sourceUrl: string;
  alternateUrls: Partial<Record<DiningLocale, string>>;
  currency?: string;
  // Cuisine labels in the page language (e.g. "Indian" / "هندي").
  cuisines: string[];
  // Talabat cuisine IDs — locale-neutral, same order as `cuisines`.
  cuisineIds: string[];
  rating?: number;
  ratingCount?: number;
  // Fee, minimum order and delivery time depend on the customer's address. The page is fetched
  // without one and reports placeholders ("0", 0, "0 mins"); kept raw, not mapped.
  deliveryFeeRaw?: string;
  minimumOrderRaw?: number;
  deliveryTimeRaw?: string;
  // Hero image without its resize query string.
  imageUrl?: string;
  logoUrl?: string;
  location: TalabatRawLocation;
}

export interface TalabatRawCategory {
  // Talabat section ID (`categories[].id`).
  platformCategoryId?: string;
  name: string;
  // 0-based display order among real menu sections (synthetic sections excluded).
  sortOrder: number;
}

export interface TalabatRawMenuItem {
  // Position of the entry in the page's category → item traversal.
  sourceIndex: number;
  // Talabat item ID (`items[].id`).
  platformItemId?: string;
  // Index into TalabatParseResult.categories.
  categoryIndex?: number;
  platformCategoryId?: string;
  categoryName?: string;
  // 0-based order within its category; input for the position fallback identity.
  positionInCategory?: number;
  name: string;
  description?: string;
  // Major currency units (AED 35 → 35).
  price: number;
  originalPrice?: number;
  currency: string;
  // `originalImage` (or `image` without its resize query) — not an identity.
  imageUrl?: string;
  // false when Talabat explicitly reports the item has no photo (`isWithImage`).
  hasImage?: boolean;
  // `hasChoices`: the item has modifier groups. The groups themselves are not embedded in the page.
  hasModifiers?: boolean;
  // Listed in Talabat's synthetic "Picks for you" section (personalised, not popularity).
  isRecommended?: boolean;
  isTopRated?: boolean;
  sourceUrl: string;
}

export interface TalabatParseStats {
  // Item entries in real menu sections.
  itemsSeen: number;
  itemsParsed: number;
  itemsRejected: number;
  // Entries in synthetic sections (e.g. "Picks for you", id -1) — duplicates of real items, skipped.
  syntheticSectionEntries: number;
  // Repeated item IDs across real sections (the first occurrence is kept).
  duplicateItemEntries: number;
  itemsWithModifiers: number;
}

export interface TalabatParseResult {
  platform: 'talabat';
  locale: DiningLocale;
  // Locale declared by the page itself (<html lang>), when present.
  detectedLocale?: DiningLocale;
  sourceUrl: string;
  dataSource: TalabatDataSource;
  restaurant: TalabatRawRestaurant | null;
  categories: TalabatRawCategory[];
  items: TalabatRawMenuItem[];
  warnings: PlatformParseWarning[];
  stats: TalabatParseStats;
}
