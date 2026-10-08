import type { ObjectId } from 'mongodb';

// ─── Shared primitives ───────────────────────────────────────────────────────

export const DINING_PLATFORMS = ['deliveroo', 'talabat', 'careem'] as const;
export type DiningPlatform = (typeof DINING_PLATFORMS)[number];

export const DINING_LOCALES = ['en', 'ar'] as const;
export type DiningLocale = (typeof DINING_LOCALES)[number];

// Each locale is written independently (e.g. `$set: { 'name.ar': ... }`) so an
// Arabic scrape never overwrites English values on the same document, and vice versa.
export interface LocalizedText {
  en?: string;
  ar?: string;
}

export type PerLocale<T> = {
  en?: T;
  ar?: T;
};

// How a document's sourceKey was derived — see dining.source-key.ts.
//   id       → platform-issued identifier (preferred)
//   anchor   → locale-neutral stable source token (URL slug, asset path, …)
//   position → 0-based order within the parent (last resort, menu reorders change it)
export type SourceKeyKind = 'id' | 'anchor' | 'position';

// ─── Restaurant ──────────────────────────────────────────────────────────────

export interface DiningLocation {
  city?: string;
  area?: string;
  address?: string;
  lat?: number;
  lng?: number;
}

export interface DiningRestaurant {
  _id?: ObjectId;
  platform: DiningPlatform;
  platformRestaurantId?: string;
  sourceKey: string;
  sourceKeyKind: Exclude<SourceKeyKind, 'position'>;
  slug?: string;
  name: LocalizedText;
  brandName?: LocalizedText;
  description?: LocalizedText;
  url: LocalizedText;
  cuisines: string[];
  tags: string[];
  rating?: number;
  ratingCount?: number;
  // Rating count as displayed when the platform shows a bucket instead of an exact number (e.g. "500+").
  ratingCountText?: string;
  currency: string;
  deliveryFee?: number;
  minimumOrder?: number;
  deliveryTimeMin?: number;
  deliveryTimeMax?: number;
  isOpen?: boolean;
  // false once the restaurant is no longer listed on the platform. Never hard-deleted.
  isActive: boolean;
  offers: string[];
  imageUrl?: string;
  location: DiningLocation;
  firstSeenAt: Date;
  lastScrapedAtByLocale: PerLocale<Date>;
  lastRunIdByLocale: PerLocale<string>;
  createdAt: Date;
  updatedAt: Date;
}

// ─── Menu category ───────────────────────────────────────────────────────────

export interface DiningMenuCategory {
  _id?: ObjectId;
  platform: DiningPlatform;
  restaurantId: ObjectId;
  // sourceKey of the parent restaurant; child sourceKeys are derived from it.
  restaurantSourceKey: string;
  platformRestaurantId?: string;
  platformCategoryId?: string;
  sourceKey: string;
  sourceKeyKind: SourceKeyKind;
  name: LocalizedText;
  sortOrder?: number;
  // false once the category disappears from the restaurant's menu. Never hard-deleted.
  isActive: boolean;
  firstSeenAt: Date;
  lastScrapedAtByLocale: PerLocale<Date>;
  lastRunIdByLocale: PerLocale<string>;
  createdAt: Date;
  updatedAt: Date;
}

// ─── Modifiers (shape only — not scraped yet) ────────────────────────────────

export interface MenuModifierOption {
  optionId?: string;
  name: LocalizedText;
  description?: LocalizedText;
  priceDelta?: number;
  currency?: string;
  isAvailable?: boolean;
}

export interface MenuModifierGroup {
  groupId?: string;
  name: LocalizedText;
  description?: LocalizedText;
  required?: boolean;
  minSelections?: number;
  maxSelections?: number;
  options: MenuModifierOption[];
}

// ─── Menu item ───────────────────────────────────────────────────────────────

export interface DiningMenuItem {
  _id?: ObjectId;
  platform: DiningPlatform;
  restaurantId: ObjectId;
  restaurantSourceKey: string;
  platformRestaurantId?: string;
  // Optional: only set when the platform exposes a verified stable item ID.
  platformItemId?: string;
  sourceKey: string;
  sourceKeyKind: SourceKeyKind;
  categoryId?: ObjectId;
  // Category label as shown on the source, kept for resilience/debugging.
  categoryName?: LocalizedText;
  name: LocalizedText;
  description?: LocalizedText;
  // Major currency units (e.g. 32.5 = AED 32.50).
  price: number;
  originalPrice?: number;
  currency: string;
  imageUrl?: string;
  // Source-reported orderability (e.g. sold out → false).
  isAvailable: boolean;
  // Whether the item was present in the latest scrape. Missing items flip to false, never deleted.
  isActive: boolean;
  isPopular?: boolean;
  dietaryTags: string[];
  calories?: number;
  modifiers?: MenuModifierGroup[];
  sourceUrl: LocalizedText;
  firstSeenAt: Date;
  lastSeenAt: Date;
  lastSeenAtByLocale: PerLocale<Date>;
  lastRunIdByLocale: PerLocale<string>;
  createdAt: Date;
  updatedAt: Date;
}

// ─── Scrape run ──────────────────────────────────────────────────────────────

export const SCRAPE_RUN_STATUSES = ['running', 'succeeded', 'partial', 'failed'] as const;
export type DiningScrapeRunStatus = (typeof SCRAPE_RUN_STATUSES)[number];

export const SCRAPE_RUN_TRIGGERS = ['manual', 'cron', 'queue'] as const;
export type DiningScrapeRunTrigger = (typeof SCRAPE_RUN_TRIGGERS)[number];

export const SCRAPE_RUN_TARGET_TYPES = ['restaurant', 'listing'] as const;
export type DiningScrapeTargetType = (typeof SCRAPE_RUN_TARGET_TYPES)[number];

// "updated" = the stored content changed; "unchanged" = seen again with identical content
// (only last-seen metadata refreshed). For dry runs these are the would-be counts.
export interface DiningScrapeRunCounts {
  restaurantsCreated: number;
  restaurantsUpdated: number;
  restaurantsUnchanged: number;
  categoriesCreated: number;
  categoriesUpdated: number;
  categoriesUnchanged: number;
  categoriesRejected: number;
  categoriesMarkedInactive: number;
  itemsSeen: number;
  itemsCreated: number;
  itemsUpdated: number;
  itemsUnchanged: number;
  itemsRejected: number;
  itemsMarkedInactive: number;
}

export const SCRAPE_RUN_COUNT_FIELDS: ReadonlyArray<keyof DiningScrapeRunCounts> = [
  'restaurantsCreated', 'restaurantsUpdated', 'restaurantsUnchanged',
  'categoriesCreated', 'categoriesUpdated', 'categoriesUnchanged', 'categoriesRejected', 'categoriesMarkedInactive',
  'itemsSeen', 'itemsCreated', 'itemsUpdated', 'itemsUnchanged', 'itemsRejected', 'itemsMarkedInactive',
];

export function emptyScrapeRunCounts(): DiningScrapeRunCounts {
  const counts = {} as DiningScrapeRunCounts;
  for (const field of SCRAPE_RUN_COUNT_FIELDS) counts[field] = 0;
  return counts;
}

export interface DiningScrapeRunError {
  stage: string;
  code: string;
  message: string;
}

// Mirrors the non-secret metadata of ScrapeDoResponse. Never holds tokens or request URLs.
export interface DiningScrapeRunFetch {
  statusCode?: number;
  initialStatusCode?: number;
  finalUrl?: string;
  requestCost?: number;
  remainingCredits?: number;
  attempts?: number;
  durationMs?: number;
}

export interface DiningScrapeRun {
  _id?: ObjectId;
  runId: string;
  platform: DiningPlatform;
  locale: DiningLocale;
  targetType: DiningScrapeTargetType;
  // The platform page URL (never the Scrape.do request URL).
  targetUrl: string;
  trigger: DiningScrapeRunTrigger;
  dryRun: boolean;
  status: DiningScrapeRunStatus;
  startedAt: Date;
  finishedAt?: Date;
  durationMs?: number;
  counts: DiningScrapeRunCounts;
  errors: DiningScrapeRunError[];
  fetch?: DiningScrapeRunFetch;
  createdAt: Date;
  updatedAt: Date;
}
