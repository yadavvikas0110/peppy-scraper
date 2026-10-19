import { Collection, ObjectId, WithId } from 'mongodb';
import { isDuplicateKeyError } from '../repositories/document-update';
import type { DiningItemMapping } from './item-mapping.types';
import { validateItemMapping } from './item-mapping.validator';

export type ItemMappingErrorCode =
  | 'SOURCE_ITEM_NOT_FOUND'
  | 'INVALID_SOURCE_ITEM'
  | 'RESTAURANT_NOT_MAPPED'
  | 'RESTAURANT_GROUP_NOT_FOUND'
  | 'CANONICAL_ITEM_NOT_FOUND'
  | 'CANONICAL_ITEM_INACTIVE'
  | 'RESTAURANT_GROUP_MISMATCH'
  | 'SOURCE_ALREADY_MAPPED'
  | 'MAPPING_NOT_FOUND'
  | 'MAPPING_CHANGED'
  | 'NOTHING_TO_APPROVE'
  | 'INVALID_MAPPING';

export class DiningItemMappingError extends Error {
  readonly code: ItemMappingErrorCode;

  constructor(code: ItemMappingErrorCode, message: string) {
    super(message);
    this.name = 'DiningItemMappingError';
    this.code = code;
  }
}

export function assertValidItemMapping(doc: DiningItemMapping): void {
  const result = validateItemMapping(doc);
  if (!result.valid) {
    throw new DiningItemMappingError('INVALID_MAPPING', `Invalid item mapping: ${result.issues.map(i => `${i.path} ${i.message}`).join('; ')}`);
  }
}

export function createItemMappingRepository(collection: Collection<DiningItemMapping>) {
  const repo = {
    findActiveByMenuItem(menuItemId: ObjectId): Promise<WithId<DiningItemMapping> | null> {
      return collection.findOne({ menuItemId, isActive: true });
    },

    findActiveMatchedByCanonical(canonicalItemIds: ObjectId[]): Promise<Array<WithId<DiningItemMapping>>> {
      if (canonicalItemIds.length === 0) return Promise.resolve([]);
      return collection.find({ canonicalItemId: { $in: canonicalItemIds }, isActive: true, matchStatus: 'MATCHED' }).toArray();
    },

    history(menuItemId: ObjectId): Promise<Array<WithId<DiningItemMapping>>> {
      return collection.find({ menuItemId }).sort({ createdAt: 1, _id: 1 }).toArray();
    },

    async rejectedCanonicalIds(menuItemId: ObjectId): Promise<Set<string>> {
      const rows = await collection.find({ menuItemId, matchStatus: 'REJECTED' }, { projection: { canonicalItemId: 1 } }).toArray();
      return new Set(rows.flatMap(r => (r.canonicalItemId ? [r.canonicalItemId.toHexString()] : [])));
    },

    // The unique active index is the final guard against two active decisions for one source item.
    async insert(doc: DiningItemMapping): Promise<WithId<DiningItemMapping>> {
      assertValidItemMapping(doc);
      try {
        const res = await collection.insertOne(doc);
        return { ...doc, _id: res.insertedId };
      } catch (err) {
        if (isDuplicateKeyError(err)) throw new DiningItemMappingError('SOURCE_ALREADY_MAPPED', 'Source item already has an active mapping');
        throw err;
      }
    },

    /*
     * Records a new decision for a source item. The previous active decision (if any) is kept as
     * history (isActive=false, supersededAt) — never deleted or edited in place. `extra` docs
     * (e.g. a REJECTED record for the old pairing) are inserted as inactive history first.
     */
    async replaceDecision(
      previous: WithId<DiningItemMapping> | null,
      next: DiningItemMapping,
      now: Date,
      extra: DiningItemMapping[] = []
    ): Promise<WithId<DiningItemMapping>> {
      const linked = (doc: DiningItemMapping): DiningItemMapping => (previous ? { ...doc, supersedesMappingId: previous._id } : doc);
      for (const doc of [...extra, next]) assertValidItemMapping(linked(doc));

      if (previous) {
        const res = await collection.updateOne(
          { _id: previous._id, isActive: true, updatedAt: previous.updatedAt },
          { $set: { isActive: false, supersededAt: now, updatedAt: now } }
        );
        if (res.matchedCount !== 1) throw new DiningItemMappingError('MAPPING_CHANGED', 'Mapping changed concurrently; re-read and retry');
      }
      try {
        for (const doc of extra) await repo.insert(linked(doc));
        return await repo.insert(linked(next));
      } catch (err) {
        if (previous) {
          // Best effort: reactivate the previous decision if nothing else became active meanwhile.
          await collection
            .updateOne({ _id: previous._id, supersededAt: now }, { $set: { isActive: true, updatedAt: previous.updatedAt }, $unset: { supersededAt: '' } })
            .catch(() => undefined);
        }
        throw err;
      }
    },
  };
  return repo;
}

export type ItemMappingRepository = ReturnType<typeof createItemMappingRepository>;
