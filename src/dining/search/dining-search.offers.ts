import type { ObjectId, WithId } from 'mongodb';
import { resolveAvailabilityStatus } from '../dining.availability';
import { DINING_PLATFORMS, DiningLocale, DiningMenuItem, DiningRestaurant, LocalizedText } from '../dining.types';
import type { DiningItemMapping } from '../item-mappings/item-mapping.types';
import type {
  CheapestOffer,
  CheapestOfferStatus,
  OfferExclusionReason,
  OfferIneligibleReason,
  OfferPriceStatus,
  SearchOffer,
} from './dining-search.types';

/*
 * Pure offer assembly: turns confirmed mappings + their source documents into offers.
 * A mapping only becomes an offer if the whole chain is consistent:
 *   mapping (active, MATCHED, same group as the canonical item)
 *   → source menu item (same platform, same restaurant, same platformItemId)
 *   → source restaurant (same platform) whose active MATCHED restaurant mapping is the same group.
 * Anything else is counted in `excluded` and never shown as an offer.
 */

export type SearchMappingDoc = Pick<
  WithId<DiningItemMapping>,
  '_id' | 'canonicalItemId' | 'restaurantGroupId' | 'menuItemId' | 'restaurantId' | 'platform' | 'platformItemId' | 'matchStatus' | 'matchMethod' | 'confidence' | 'decidedBy' | 'isActive' | 'decidedAt'
>;

export type SearchMenuItemDoc = Pick<
  WithId<DiningMenuItem>,
  '_id' | 'platform' | 'restaurantId' | 'platformItemId' | 'name' | 'price' | 'originalPrice' | 'currency' | 'imageUrl' | 'isActive' | 'isAvailable' | 'availabilityStatus' | 'lastSeenAt'
>;

export type SearchRestaurantDoc = Pick<WithId<DiningRestaurant>, '_id' | 'platform' | 'platformRestaurantId' | 'name' | 'url' | 'isActive'>;

export interface OfferSources {
  menuItems: Map<string, SearchMenuItemDoc>;
  restaurants: Map<string, SearchRestaurantDoc>;
  // restaurantId → restaurant group id of its active MATCHED restaurant mapping.
  restaurantGroupOf: Map<string, string>;
  // Menu items whose active MATCHED mappings point at more than one canonical item.
  conflictingMenuItems: Set<string>;
}

export interface BuiltOffers {
  offers: SearchOffer[];
  excluded: { count: number; reasons: Partial<Record<OfferExclusionReason, number>> };
}

const hex = (id: ObjectId) => id.toHexString();
const otherLocale = (l: DiningLocale): DiningLocale => (l === 'en' ? 'ar' : 'en');

export function pickLocalized(text: LocalizedText | undefined, locale: DiningLocale): { text: string | null; fallback: boolean } {
  const own = text?.[locale];
  if (typeof own === 'string' && own.trim()) return { text: own, fallback: false };
  const other = text?.[otherLocale(locale)];
  if (typeof other === 'string' && other.trim()) return { text: other, fallback: true };
  return { text: null, fallback: false };
}

function localizedCopy(text: LocalizedText | undefined): LocalizedText {
  const out: LocalizedText = {};
  if (typeof text?.en === 'string') out.en = text.en;
  if (typeof text?.ar === 'string') out.ar = text.ar;
  return out;
}

function priceOf(value: unknown): { price: number | null; status: OfferPriceStatus } {
  if (value === undefined || value === null) return { price: null, status: 'MISSING' };
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return { price: value, status: 'OK' };
  return { price: null, status: 'INVALID' };
}

function currencyOf(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const code = value.trim().toUpperCase();
  return /^[A-Z]{3}$/.test(code) ? code : null;
}

const platformOrder = (p: string) => (DINING_PLATFORMS as readonly string[]).indexOf(p);

export function buildOffers(
  canonical: { _id: ObjectId; restaurantGroupId: ObjectId },
  mappings: SearchMappingDoc[],
  sources: OfferSources,
  locale: DiningLocale
): BuiltOffers {
  const reasons: Partial<Record<OfferExclusionReason, number>> = {};
  const exclude = (reason: OfferExclusionReason) => {
    reasons[reason] = (reasons[reason] ?? 0) + 1;
  };

  const confirmed = mappings
    .filter(m => m.isActive === true && m.matchStatus === 'MATCHED' && m.canonicalItemId?.equals(canonical._id))
    .sort((a, b) => b.decidedAt.getTime() - a.decidedAt.getTime() || (hex(a._id) < hex(b._id) ? -1 : 1));

  const offers: SearchOffer[] = [];
  const seenItems = new Set<string>();
  for (const m of confirmed) {
    const itemId = hex(m.menuItemId);
    if (!m.restaurantGroupId.equals(canonical.restaurantGroupId)) { exclude('CROSS_GROUP_MAPPING'); continue; }
    if (sources.conflictingMenuItems.has(itemId)) { exclude('CONFLICTING_ACTIVE_MAPPINGS'); continue; }
    if (seenItems.has(itemId)) { exclude('DUPLICATE_SOURCE_ITEM'); continue; }
    seenItems.add(itemId);

    const item = sources.menuItems.get(itemId);
    if (!item) { exclude('SOURCE_ITEM_NOT_FOUND'); continue; }
    if (item.platform !== m.platform) { exclude('PLATFORM_MISMATCH'); continue; }
    if (m.platformItemId !== undefined && item.platformItemId !== m.platformItemId) { exclude('PLATFORM_ITEM_MISMATCH'); continue; }
    if (!item.restaurantId.equals(m.restaurantId)) { exclude('RESTAURANT_MISMATCH'); continue; }
    const restaurant = sources.restaurants.get(hex(item.restaurantId));
    if (!restaurant) { exclude('RESTAURANT_NOT_FOUND'); continue; }
    if (restaurant.platform !== item.platform) { exclude('PLATFORM_MISMATCH'); continue; }
    if (sources.restaurantGroupOf.get(hex(restaurant._id)) !== hex(canonical.restaurantGroupId)) { exclude('RESTAURANT_NOT_IN_GROUP'); continue; }

    const { price, status: priceStatus } = priceOf(item.price);
    const currency = currencyOf(item.currency);
    const isActive = item.isActive === true;
    const availabilityStatus = resolveAvailabilityStatus(item);
    const isAvailable = availabilityStatus === 'available';
    const restaurantActive = restaurant.isActive === true;
    const ineligible: OfferIneligibleReason[] = [];
    if (!isActive) ineligible.push('ITEM_INACTIVE');
    if (availabilityStatus === 'unavailable') ineligible.push('ITEM_UNAVAILABLE');
    if (availabilityStatus === 'unknown') ineligible.push('ITEM_AVAILABILITY_UNKNOWN');
    if (!restaurantActive) ineligible.push('RESTAURANT_INACTIVE');
    if (priceStatus === 'MISSING') ineligible.push('PRICE_MISSING');
    if (priceStatus === 'INVALID') ineligible.push('PRICE_INVALID');
    if (!currency) ineligible.push('CURRENCY_INVALID');

    const lastSeen = item.lastSeenAt instanceof Date && !Number.isNaN(item.lastSeenAt.getTime()) ? item.lastSeenAt.toISOString() : null;
    offers.push({
      platform: item.platform,
      menuItemId: itemId,
      platformItemId: item.platformItemId ?? null,
      name: localizedCopy(item.name),
      displayName: pickLocalized(item.name, locale).text,
      price,
      originalPrice: priceOf(item.originalPrice).price,
      currency,
      priceStatus,
      imageUrl: typeof item.imageUrl === 'string' && item.imageUrl ? item.imageUrl : null,
      isActive,
      isAvailable,
      availabilityStatus,
      lastSeenAt: lastSeen,
      itemUrl: null,
      restaurantUrl: pickLocalized(restaurant.url, locale).text,
      restaurant: {
        restaurantId: hex(restaurant._id),
        platformRestaurantId: restaurant.platformRestaurantId ?? null,
        name: localizedCopy(restaurant.name),
        displayName: pickLocalized(restaurant.name, locale).text,
        isActive: restaurantActive,
      },
      mapping: { mappingId: hex(m._id), matchMethod: m.matchMethod ?? null, confidence: m.confidence, decidedBy: m.decidedBy },
      eligibleForCheapest: ineligible.length === 0,
      ineligibleReasons: ineligible,
    });
  }

  offers.sort(
    (a, b) =>
      Number(b.eligibleForCheapest) - Number(a.eligibleForCheapest) ||
      (a.price ?? Infinity) - (b.price ?? Infinity) ||
      platformOrder(a.platform) - platformOrder(b.platform) ||
      (a.menuItemId < b.menuItemId ? -1 : a.menuItemId > b.menuItemId ? 1 : 0)
  );
  const count = Object.values(reasons).reduce((s, n) => s + (n ?? 0), 0);
  return { offers, excluded: { count, reasons } };
}

/*
 * Cheapest offer = lowest current price among eligible offers (active + confirmed-available item, active
 * restaurant, valid non-negative price, valid currency; offers only exist for active MATCHED
 * mappings). Prices are only compared within one currency: with several currencies there is no
 * overall winner (MIXED_CURRENCIES) and each currency's cheapest is listed instead.
 * Ties: lower platform order (deliveroo, talabat, careem), then menuItemId; the rest are `tiedOffers`.
 */
export function computeCheapestOffer(offers: SearchOffer[]): {
  cheapestOffer: CheapestOffer | null;
  cheapestOfferStatus: CheapestOfferStatus;
  cheapestByCurrency: CheapestOffer[];
} {
  const byCurrency = new Map<string, SearchOffer[]>();
  for (const o of offers) {
    if (!o.eligibleForCheapest || o.price === null || o.currency === null) continue;
    byCurrency.set(o.currency, [...(byCurrency.get(o.currency) ?? []), o]);
  }
  const cheapestByCurrency = [...byCurrency.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([currency, list]) => {
      const sorted = [...list].sort(
        (a, b) => a.price! - b.price! || platformOrder(a.platform) - platformOrder(b.platform) || (a.menuItemId < b.menuItemId ? -1 : 1)
      );
      const [winner, ...rest] = sorted;
      return {
        platform: winner.platform,
        menuItemId: winner.menuItemId,
        price: winner.price!,
        currency,
        tiedOffers: rest.filter(o => o.price === winner.price).map(o => ({ platform: o.platform, menuItemId: o.menuItemId })),
      };
    });
  if (cheapestByCurrency.length === 0) return { cheapestOffer: null, cheapestOfferStatus: 'NO_ELIGIBLE_OFFERS', cheapestByCurrency };
  if (cheapestByCurrency.length > 1) return { cheapestOffer: null, cheapestOfferStatus: 'MIXED_CURRENCIES', cheapestByCurrency };
  return { cheapestOffer: cheapestByCurrency[0], cheapestOfferStatus: 'OK', cheapestByCurrency };
}
