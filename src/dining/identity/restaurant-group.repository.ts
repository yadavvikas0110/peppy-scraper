import { Collection, Filter, ObjectId, WithId } from 'mongodb';
import { assertValid } from '../dining.validator';
import { isDuplicateKeyError } from '../repositories/document-update';
import type { DiningRestaurantGroup, RestaurantMatchSignals } from './identity.types';
import { validateRestaurantGroup } from './identity.validator';

export const MAX_GROUP_CANDIDATES = 50;

export type SeededGroup = DiningRestaurantGroup & { seedRestaurantId: ObjectId };

export function createRestaurantGroupRepository(collection: Collection<DiningRestaurantGroup>) {
  return {
    findById(id: ObjectId): Promise<WithId<DiningRestaurantGroup> | null> {
      return collection.findOne({ _id: id });
    },

    // Groups sharing a normalized name/brand (and not a different city). The matcher decides;
    // this only narrows the search.
    findCandidates(signals: RestaurantMatchSignals): Promise<Array<WithId<DiningRestaurantGroup>>> {
      const keys = [...new Set([...signals.names, ...signals.brands])];
      if (keys.length === 0) return Promise.resolve([]);
      const byName: Filter<DiningRestaurantGroup> = { $or: [{ 'signals.names': { $in: keys } }, { 'signals.brands': { $in: keys } }] };
      const filter: Filter<DiningRestaurantGroup> = signals.city
        ? { $and: [byName, { $or: [{ 'signals.city': signals.city }, { 'signals.city': { $exists: false } }] }] }
        : byName;
      return collection.find(filter).sort({ _id: 1 }).limit(MAX_GROUP_CANDIDATES).toArray();
    },

    // Idempotent: keyed by seedRestaurantId, so a retry (or a concurrent backfill) returns the
    // existing group instead of creating a second one.
    async createFromSeed(group: SeededGroup): Promise<{ group: WithId<DiningRestaurantGroup>; created: boolean }> {
      assertValid(validateRestaurantGroup(group), 'restaurant group');
      for (let attempt = 0; ; attempt++) {
        try {
          const res = await collection.updateOne({ seedRestaurantId: group.seedRestaurantId }, { $setOnInsert: group }, { upsert: true });
          const stored = await collection.findOne({ seedRestaurantId: group.seedRestaurantId });
          if (!stored) throw new Error('restaurant group vanished after upsert');
          return { group: stored, created: res.upsertedCount === 1 };
        } catch (err) {
          if (attempt === 0 && isDuplicateKeyError(err)) continue;
          throw err;
        }
      }
    },

    async addMatchedSignals(groupId: ObjectId, signals: RestaurantMatchSignals, now: Date): Promise<void> {
      await collection.updateOne(
        { _id: groupId },
        {
          $addToSet: { 'signals.names': { $each: signals.names }, 'signals.brands': { $each: signals.brands } },
          $set: { updatedAt: now },
        }
      );
    },

    async markReview(groupId: ObjectId, now: Date): Promise<void> {
      await collection.updateOne({ _id: groupId, identityStatus: 'auto' }, { $set: { identityStatus: 'review', updatedAt: now } });
    },

    async markVerified(groupId: ObjectId, now: Date): Promise<void> {
      await collection.updateOne({ _id: groupId }, { $set: { identityStatus: 'verified', updatedAt: now } });
    },
  };
}

export type RestaurantGroupRepository = ReturnType<typeof createRestaurantGroupRepository>;
