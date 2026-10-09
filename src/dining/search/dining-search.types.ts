import type { ObjectId } from 'mongodb';
import type { CanonicalItemVariant } from '../canonical-items/canonical-item.types';
import type { DiningAvailabilityStatus, DiningLocale, DiningPlatform, LocalizedText } from '../dining.types';
import type { ItemMatchMethod, ItemMappingDecider } from '../item-mappings/item-mapping.types';

/*
 * Canonical search + cross-platform price comparison (read-only).
 *
 *   query → dining_canonical_items → dining_item_mappings (active MATCHED only)
 *         → dining_menu_items → dining_restaurants (+ dining_restaurant_mappings)
 *         → dining_restaurant_groups → response
 *
 * Prices stay on source menu items; nothing here writes to any collection.
 */

export const DINING_SEARCH_LIMITS = {
  defaultLimit: 20,
  maxLimit: 50,
  maxQueryLength: 100,
  // Query tokens beyond this are ignored (keeps the $in / prefix clauses bounded).
  maxQueryTokens: 10,
  // Prefix matching only for tokens at least this long ("dos" → "dosa", never "d" → everything).
  minPrefixLength: 3,
  // Upper bound of canonical items read per query clause before in-memory ranking.
  candidateCap: 200,
} as const;

// ─── Input ───────────────────────────────────────────────────────────────────

export interface DiningSearchRequest {
  query: string;
  locale: DiningLocale;
  restaurantGroupId?: ObjectId;
  platforms?: DiningPlatform[];
  limit: number;
}

export type DiningSearchErrorCode =
  | 'INVALID_REQUEST'
  | 'UNSUPPORTED_LOCALE'
  | 'UNSUPPORTED_PLATFORM'
  | 'SEARCH_UNAVAILABLE';

export interface DiningSearchFieldError {
  field: string;
  code: Exclude<DiningSearchErrorCode, 'SEARCH_UNAVAILABLE'>;
  message: string;
}

export class DiningSearchError extends Error {
  readonly code: DiningSearchErrorCode;
  readonly httpStatus: number;
  readonly details?: DiningSearchFieldError[];

  constructor(code: DiningSearchErrorCode, httpStatus: number, message: string, details?: DiningSearchFieldError[]) {
    super(message);
    this.name = 'DiningSearchError';
    this.code = code;
    this.httpStatus = httpStatus;
    this.details = details;
  }
}

export function isDiningSearchError(err: unknown): err is DiningSearchError {
  return err instanceof DiningSearchError;
}

// ─── Ranking ─────────────────────────────────────────────────────────────────

// Lower rank = better. See dining-search.ranking.ts.
export const SEARCH_MATCH_TYPES = ['EXACT_NAME', 'EXACT_ALIAS', 'KEYWORD', 'PARTIAL'] as const;
export type SearchMatchType = (typeof SEARCH_MATCH_TYPES)[number];

export interface SearchMatch {
  type: SearchMatchType;
  // Query tokens equal to a stored search keyword.
  matchedTokens: string[];
  // Query tokens that only matched as the start of a keyword ("pan" → "paneer").
  prefixTokens: string[];
  // Share of query tokens found in the item's own name/alias tokens (vs. only description/category).
  nameCoverage: number;
}

// ─── Output ──────────────────────────────────────────────────────────────────

export type DisplayField = 'name' | 'description' | 'category';

export interface SearchDisplay {
  name: string | null;
  description: string | null;
  category: string | null;
  // Fields shown in the other locale because the requested one is missing.
  fallbackFields: DisplayField[];
}

export interface SearchCanonicalItem {
  id: string;
  restaurantGroupId: string;
  name: LocalizedText;
  description?: LocalizedText;
  category?: LocalizedText;
  variant?: CanonicalItemVariant;
  display: SearchDisplay;
}

export interface SearchRestaurantGroup {
  restaurantGroupId: string;
  name: LocalizedText;
  displayName: string | null;
  city?: string;
  area?: string;
}

export const OFFER_INELIGIBLE_REASONS = [
  'ITEM_INACTIVE',
  'ITEM_UNAVAILABLE',
  // The platform does not report availability (e.g. Talabat): shown, but never the confirmed cheapest.
  'ITEM_AVAILABILITY_UNKNOWN',
  'RESTAURANT_INACTIVE',
  'PRICE_MISSING',
  'PRICE_INVALID',
  'CURRENCY_INVALID',
] as const;
export type OfferIneligibleReason = (typeof OFFER_INELIGIBLE_REASONS)[number];

export type OfferPriceStatus = 'OK' | 'MISSING' | 'INVALID';

export interface SearchOffer {
  platform: DiningPlatform;
  menuItemId: string;
  platformItemId: string | null;
  // The listing's own name on that platform (may differ from the canonical name).
  name: LocalizedText;
  displayName: string | null;
  // null when the source has no usable price — never coerced to 0.
  price: number | null;
  originalPrice: number | null;
  currency: string | null;
  priceStatus: OfferPriceStatus;
  imageUrl: string | null;
  // Listed in the latest trustworthy scrape.
  isActive: boolean;
  // true only when the platform confirms it can be ordered (availabilityStatus 'available').
  isAvailable: boolean;
  availabilityStatus: DiningAvailabilityStatus;
  lastSeenAt: string | null;
  // Sources do not expose per-item links; never synthesized.
  itemUrl: null;
  // Restaurant menu page on the platform (a restaurant link, not an item link).
  restaurantUrl: string | null;
  restaurant: {
    restaurantId: string;
    platformRestaurantId: string | null;
    name: LocalizedText;
    displayName: string | null;
    isActive: boolean;
  };
  mapping: {
    mappingId: string;
    matchMethod: ItemMatchMethod | null;
    confidence: number;
    decidedBy: ItemMappingDecider;
  };
  eligibleForCheapest: boolean;
  ineligibleReasons: OfferIneligibleReason[];
}

export interface CheapestOffer {
  platform: DiningPlatform;
  menuItemId: string;
  price: number;
  currency: string;
  // Other eligible offers at exactly the same price (winner chosen deterministically).
  tiedOffers: Array<{ platform: DiningPlatform; menuItemId: string }>;
}

export type CheapestOfferStatus = 'OK' | 'NO_ELIGIBLE_OFFERS' | 'MIXED_CURRENCIES';

// Confirmed mappings that were not turned into offers because the identity graph is inconsistent.
export const OFFER_EXCLUSION_REASONS = [
  'CROSS_GROUP_MAPPING',
  'CONFLICTING_ACTIVE_MAPPINGS',
  'DUPLICATE_SOURCE_ITEM',
  'SOURCE_ITEM_NOT_FOUND',
  'PLATFORM_MISMATCH',
  'PLATFORM_ITEM_MISMATCH',
  'RESTAURANT_MISMATCH',
  'RESTAURANT_NOT_FOUND',
  'RESTAURANT_NOT_IN_GROUP',
] as const;
export type OfferExclusionReason = (typeof OFFER_EXCLUSION_REASONS)[number];

export interface SearchResult {
  canonicalItem: SearchCanonicalItem;
  restaurant: SearchRestaurantGroup;
  match: SearchMatch;
  offers: SearchOffer[];
  cheapestOffer: CheapestOffer | null;
  cheapestOfferStatus: CheapestOfferStatus;
  // Per-currency cheapest offers; more than one entry only when currencies are mixed.
  cheapestByCurrency: CheapestOffer[];
  excludedOffers: { count: number; reasons: Partial<Record<OfferExclusionReason, number>> };
}

export interface DiningSearchResponse {
  query: {
    query: string;
    normalized: string;
    tokens: string[];
    locale: DiningLocale;
    restaurantGroupId: string | null;
    platforms: DiningPlatform[] | null;
    limit: number;
  };
  total: number;
  // More canonical items matched than `limit` (or the candidate cap was reached).
  truncated: boolean;
  results: SearchResult[];
}
