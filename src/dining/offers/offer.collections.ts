import { Collection, Db, IndexDescription } from 'mongodb';
import type { DiningRestaurantOffer } from './offer.types';

export const DINING_OFFERS_COLLECTION = 'dining_restaurant_offers' as const;

export function getDiningOfferCollection(db: Db): Collection<DiningRestaurantOffer> {
  return db.collection<DiningRestaurantOffer>(DINING_OFFERS_COLLECTION);
}

export const DINING_OFFER_INDEXES: IndexDescription[] = [
  { name: 'uniq_platform_restaurant_source_offerKey', key: { platform: 1, platformRestaurantId: 1, source: 1, offerKey: 1 }, unique: true },
  { name: 'restaurantId_isActive', key: { restaurantId: 1, isActive: 1 }, partialFilterExpression: { restaurantId: { $type: 'objectId' } } },
  { name: 'platform_isActive_lastSeenAt', key: { platform: 1, isActive: 1, lastSeenAt: -1 } },
];

export async function ensureDiningOfferIndexes(db: Db): Promise<string[]> {
  return getDiningOfferCollection(db).createIndexes(DINING_OFFER_INDEXES);
}
