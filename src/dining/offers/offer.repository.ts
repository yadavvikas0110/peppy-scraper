import type { Collection, ObjectId } from 'mongodb';
import { stripUndefined } from '../dining.object';
import type { DiningLocale, DiningPlatform } from '../dining.types';
import { offerKeyOf } from './offer.key';
import type { DiningOfferSource, DiningRestaurantOffer, NormalizedOffer } from './offer.types';

export interface SyncRestaurantOffersInput {
  platform: DiningPlatform;
  platformRestaurantId: string;
  restaurantId?: ObjectId;
  source: DiningOfferSource;
  locale: DiningLocale;
  // Every offer the source currently shows for the restaurant (empty = none running).
  offers: NormalizedOffer[];
  runId?: string;
  now?: Date;
}

export interface SyncRestaurantOffersResult {
  active: number;
  ended: number;
}

/*
 * Makes the stored offers of one restaurant + source match what the source shows now: every shown offer is
 * upserted (and re-activated), every stored active offer of the same source that is no longer shown is
 * ended, never deleted, so the history of when an offer ran stays. Idempotent.
 */
export async function syncRestaurantOffers(
  collection: Collection<DiningRestaurantOffer>,
  input: SyncRestaurantOffersInput
): Promise<SyncRestaurantOffersResult> {
  const now = input.now ?? new Date();
  const scope = { platform: input.platform, platformRestaurantId: input.platformRestaurantId, source: input.source };

  const seen = new Map<string, NormalizedOffer>();
  for (const offer of input.offers) seen.set(offerKeyOf(offer), offer);

  if (seen.size) {
    await collection.bulkWrite(
      [...seen].map(([offerKey, offer]) => ({
        updateOne: {
          filter: { ...scope, offerKey },
          update: {
            $set: stripUndefined({
              restaurantId: input.restaurantId,
              type: offer.type,
              platformTypeName: offer.platformTypeName,
              percentage: offer.percentage,
              minimumOrderValue: offer.minimumOrderValue,
              maxDiscount: offer.maxDiscount,
              currency: offer.currency,
              platformItemIds: offer.platformItemIds,
              ...(offer.title ? { [`title.${input.locale}`]: offer.title } : {}),
              isActive: true,
              lastSeenAt: now,
              updatedAt: now,
              lastRunId: input.runId,
            }),
            $unset: { endedAt: '' as const },
            $setOnInsert: { firstSeenAt: now },
          },
          upsert: true,
        },
      })),
      { ordered: false }
    );
  }

  const ended = await collection.updateMany(
    { ...scope, isActive: true, offerKey: { $nin: [...seen.keys()] } },
    { $set: { isActive: false, endedAt: now, updatedAt: now } }
  );
  return { active: seen.size, ended: ended.modifiedCount };
}
