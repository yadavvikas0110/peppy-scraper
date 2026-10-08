import { Collection, ObjectId, WithId } from 'mongodb';
import type { DiningPlatform } from '../dining.types';
import { assertValid } from '../dining.validator';
import { isDuplicateKeyError } from '../repositories/document-update';
import type { DiningRestaurantMapping } from './identity.types';
import { validateRestaurantMapping } from './identity.validator';

export type IdentityConflictCode = 'RESTAURANT_ALREADY_MAPPED' | 'MAPPING_CHANGED';

export class DiningIdentityConflictError extends Error {
  readonly code: IdentityConflictCode;
  readonly restaurantId: ObjectId;
  readonly existingGroupId?: ObjectId;

  constructor(code: IdentityConflictCode, restaurantId: ObjectId, message: string, existingGroupId?: ObjectId) {
    super(message);
    this.name = 'DiningIdentityConflictError';
    this.code = code;
    this.restaurantId = restaurantId;
    this.existingGroupId = existingGroupId;
  }
}

export function createRestaurantMappingRepository(collection: Collection<DiningRestaurantMapping>) {
  return {
    findActiveByRestaurant(restaurantId: ObjectId): Promise<WithId<DiningRestaurantMapping> | null> {
      return collection.findOne({ restaurantId, isActive: true });
    },

    findActiveByGroup(groupId: ObjectId): Promise<Array<WithId<DiningRestaurantMapping>>> {
      return collection.find({ canonicalRestaurantGroupId: groupId, isActive: true }).sort({ platform: 1, _id: 1 }).toArray();
    },

    async matchedPlatformsByGroup(groupIds: ObjectId[]): Promise<Map<string, DiningPlatform[]>> {
      const out = new Map<string, DiningPlatform[]>();
      if (groupIds.length === 0) return out;
      const rows = await collection
        .find({ canonicalRestaurantGroupId: { $in: groupIds }, isActive: true, matchStatus: 'MATCHED' }, { projection: { canonicalRestaurantGroupId: 1, platform: 1 } })
        .toArray();
      for (const row of rows) {
        const key = row.canonicalRestaurantGroupId!.toHexString();
        out.set(key, [...(out.get(key) ?? []), row.platform]);
      }
      return out;
    },

    async rejectedGroupIds(restaurantId: ObjectId): Promise<Set<string>> {
      const rows = await collection.find({ restaurantId, matchStatus: 'REJECTED' }, { projection: { canonicalRestaurantGroupId: 1 } }).toArray();
      return new Set(rows.flatMap(r => (r.canonicalRestaurantGroupId ? [r.canonicalRestaurantGroupId.toHexString()] : [])));
    },

    // The unique indexes are the final guard: a second active mapping for the same source
    // restaurant is refused even under concurrent writers.
    async insert(mapping: DiningRestaurantMapping): Promise<WithId<DiningRestaurantMapping>> {
      assertValid(validateRestaurantMapping(mapping), 'restaurant mapping');
      try {
        const res = await collection.insertOne(mapping);
        return { ...mapping, _id: res.insertedId };
      } catch (err) {
        if (!isDuplicateKeyError(err)) throw err;
        const existing = await collection.findOne({ restaurantId: mapping.restaurantId, isActive: true });
        throw new DiningIdentityConflictError(
          'RESTAURANT_ALREADY_MAPPED',
          mapping.restaurantId,
          'Source restaurant already has an active mapping',
          existing?.canonicalRestaurantGroupId
        );
      }
    },

    // Optimistic replace: fails if the mapping changed since it was read.
    async replace(previous: WithId<DiningRestaurantMapping>, next: DiningRestaurantMapping): Promise<WithId<DiningRestaurantMapping>> {
      const { _id: _ignored, ...rest } = next;
      const doc: DiningRestaurantMapping = { ...rest, restaurantId: previous.restaurantId, createdAt: previous.createdAt };
      assertValid(validateRestaurantMapping(doc), 'restaurant mapping');
      const res = await collection.replaceOne({ _id: previous._id, isActive: true, updatedAt: previous.updatedAt }, doc);
      if (res.matchedCount !== 1) {
        throw new DiningIdentityConflictError('MAPPING_CHANGED', previous.restaurantId, 'Mapping changed concurrently; re-read and retry');
      }
      return { ...doc, _id: previous._id };
    },
  };
}

export type RestaurantMappingRepository = ReturnType<typeof createRestaurantMappingRepository>;
