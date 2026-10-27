import type { ObjectId } from 'mongodb';
import type { DiningLocale, DiningPlatform } from '../dining.types';

/*
 * Restaurant-level offers (promotions a platform runs for a whole restaurant), kept apart from the menu
 * items. Offers are stored as structured rules, not display text: the apps render the wording in the
 * user's language and the cart can apply the rule (percentage, minimum order, eligible items).
 */

export const DINING_OFFER_TYPES = ['PERCENT_OFF_ITEMS', 'PERCENT_OFF_MENU', 'FREE_DELIVERY', 'BUY_ONE_GET_ONE', 'OTHER'] as const;
export type DiningOfferType = (typeof DINING_OFFER_TYPES)[number];

//   menu    → the restaurant's own menu page: structured and exact (rule, minimum order, eligible items)
//   listing → the platform's restaurant listing badge: text only, parsed into the same shape where possible
export const DINING_OFFER_SOURCES = ['menu', 'listing'] as const;
export type DiningOfferSource = (typeof DINING_OFFER_SOURCES)[number];

// What a platform parser reports for one offer, before it is stored.
export interface NormalizedOffer {
  type: DiningOfferType;
  // The platform's own type name when it has one (e.g. Deliveroo "FullMenuPercentOffOffer").
  platformTypeName?: string;
  percentage?: number;
  // Money in major units (AED 50 → 50).
  minimumOrderValue?: number;
  maxDiscount?: number;
  currency?: string;
  // Platform item ids the offer is limited to; absent when it covers the whole menu.
  platformItemIds?: string[];
  // Wording shown by the platform in the page language, when the page carries it.
  title?: string;
}

// All offers found on one page for one restaurant.
export interface PlatformOffers {
  platformRestaurantId: string;
  offers: NormalizedOffer[];
}

export interface DiningRestaurantOffer {
  _id?: ObjectId;
  platform: DiningPlatform;
  platformRestaurantId: string;
  // Our dining_restaurants document, when the restaurant has been imported.
  restaurantId?: ObjectId;
  source: DiningOfferSource;
  // Stable per rule (type + numbers), so a re-scrape updates the same document.
  offerKey: string;
  type: DiningOfferType;
  platformTypeName?: string;
  percentage?: number;
  minimumOrderValue?: number;
  maxDiscount?: number;
  currency?: string;
  platformItemIds?: string[];
  title?: Partial<Record<DiningLocale, string>>;
  isActive: boolean;
  firstSeenAt: Date;
  lastSeenAt: Date;
  // Set when a later scrape of the same source no longer shows the offer.
  endedAt?: Date;
  updatedAt: Date;
  lastRunId?: string;
}
