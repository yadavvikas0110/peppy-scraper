import type { DiningLocale } from '../../dining.types';
import type { PlatformParseWarning } from '../platform.types';

// Raw DTOs: what a Deliveroo menu page actually provides, in the page's own language.
// Optional means "not reliably present on the source" — never filled with guessed values.

// `next-data` → the server-rendered Next.js state (script#__NEXT_DATA__), primary source.
// `dom`       → the rendered markup, used only when __NEXT_DATA__ is missing/unusable.
export type DeliverooDataSource = 'next-data' | 'dom';

// Deliveroo image URLs are templates (`…/image.jpeg?width={w}&height={h}&…`).
// `imageUrl` is the template without its query string; `imageUrlTemplate` keeps the original.
export type DeliverooImageSource = 'next-data' | 'inline-style';

export interface DeliverooRawLocation {
  address?: string;
  area?: string;
  city?: string;
  country?: string;
  platformCityId?: number;
  platformZoneId?: number;
}

export interface DeliverooRawRestaurant {
  // Deliveroo restaurant ID (`restaurant.id`), identical across /en and /ar pages.
  platformRestaurantId?: string;
  drnId?: string;
  // `restaurant.uname`, e.g. "kamat-dt" — locale-neutral, used as the anchor fallback.
  slug?: string;
  name?: string;
  // Locale-specific canonical page URL (link[rel=canonical]), without customer query params.
  url?: string;
  // The exact URL that was fetched.
  sourceUrl: string;
  alternateUrls: Partial<Record<DiningLocale, string>>;
  currency?: string;
  // Header tags, in the page language (e.g. "Indian" / "هندي").
  cuisines: string[];
  rating?: number;
  ratingText?: string;
  // Deliveroo shows a bucket like "(500+)", not an exact count, so only the text is kept.
  ratingCountText?: string;
  minimumOrder?: number;
  deliveryFee?: number;
  // e.g. "Closes at 23:00" / "يغلق الساعة 23:00". Open/closed is not derived from it.
  openingStatusText?: string;
  imageUrl?: string;
  imageUrlTemplate?: string;
  location: DeliverooRawLocation;
  menuDisabled?: boolean;
}

export interface DeliverooRawCategory {
  platformCategoryId?: string;
  name: string;
  // 0-based display order on the page.
  sortOrder: number;
}

export interface DeliverooRawModifierOption {
  optionId?: string;
  drnId?: string;
  name: string;
  description?: string;
  priceDelta?: number;
  currency?: string;
  isAvailable?: boolean;
  // Options can reference further groups; the canonical model is flat, so they are kept raw.
  nestedModifierGroupIds: string[];
}

export interface DeliverooRawModifierGroup {
  groupId?: string;
  drnId?: string;
  name: string;
  minSelections?: number;
  maxSelections?: number;
  multiselect?: boolean;
  options: DeliverooRawModifierOption[];
}

export interface DeliverooRawMenuItem {
  // Position of the item in the source list (next-data items array, or DOM card order).
  sourceIndex: number;
  // Deliveroo item ID (`items[].id`). Undefined for DOM-only parses: cards expose no item ID.
  platformItemId?: string;
  drnId?: string;
  // Index into DeliverooParseResult.categories.
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
  imageUrl?: string;
  imageUrlTemplate?: string;
  imageSource?: DeliverooImageSource;
  // Locale-neutral image asset path (e.g. "images/<uuid>/image.jpeg"). Not an identity:
  // the same photo can be reused by several items.
  imageAnchor?: string;
  isAvailable?: boolean;
  isPopular?: boolean;
  modifierGroupIds: string[];
  modifiers: DeliverooRawModifierGroup[];
  sourceUrl: string;
}

export interface DeliverooParseStats {
  itemsSeen: number;
  itemsParsed: number;
  itemsRejected: number;
  // Modifier options that Deliveroo also lists as items in a hidden category; excluded from `items`.
  hiddenOptionItems: number;
  modifierGroups: number;
}

export interface DeliverooParseResult {
  platform: 'deliveroo';
  locale: DiningLocale;
  // Locale declared by the page itself (<html lang>), when present.
  detectedLocale?: DiningLocale;
  sourceUrl: string;
  dataSource: DeliverooDataSource;
  restaurant: DeliverooRawRestaurant | null;
  categories: DeliverooRawCategory[];
  items: DeliverooRawMenuItem[];
  warnings: PlatformParseWarning[];
  stats: DeliverooParseStats;
}

// Future item-detail/modal extraction (not scraped yet). Shape only, so a modal parser can
// return modifier data without touching the Dining domain model.
export interface DeliverooItemDetail {
  locale: DiningLocale;
  platformItemId?: string;
  name?: string;
  description?: string;
  price?: number;
  currency?: string;
  isAvailable?: boolean;
  modifiers: DeliverooRawModifierGroup[];
}
