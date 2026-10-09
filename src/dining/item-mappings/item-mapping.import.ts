import { AnyBulkWriteOperation, Filter, MongoBulkWriteError, ObjectId, WithId } from 'mongodb';
import type { DiningCanonicalItem } from '../canonical-items/canonical-item.types';
import type { DiningPlatform } from '../dining.types';
import type { DiningItemMappingCollections } from './item-mapping.collections';
import type { DiningItemMapping } from './item-mapping.types';
import { validateItemMapping } from './item-mapping.validator';

/*
 * Seed import: every canonical item already points at the source item it was created from
 * (seedMenuItemId). That direct relationship becomes a MATCHED / IMPORT / confidence 1 mapping.
 * The matcher is NOT used here — this is a source import, not an inferred match.
 *
 * Idempotent: upsert on { menuItemId, isActive: true } (unique partial index). Existing decisions
 * (including manual ones) and previously rejected pairings are respected, never overwritten.
 * Canonical items are only read.
 */

export const ITEM_IMPORT_CHUNK = 500;
export const MAX_IMPORT_ISSUES = 200;

export interface ItemMappingImportOptions {
  dryRun?: boolean;
  restaurantGroupId?: ObjectId;
  // Seed platform of the canonical items to import (e.g. deliveroo).
  platform?: DiningPlatform;
  now?: Date;
  chunkSize?: number;
}

export type ItemImportIssueCode =
  | 'SEED_ITEM_NOT_FOUND'
  | 'SEED_PLATFORM_MISMATCH'
  | 'RESTAURANT_NOT_MAPPED'
  | 'RESTAURANT_GROUP_MISMATCH'
  | 'EXISTING_DECISION'
  | 'PREVIOUSLY_REJECTED'
  | 'INVALID_MAPPING'
  | 'WRITE_ERROR';

export interface ItemImportIssue {
  code: ItemImportIssueCode;
  canonicalItemId: string;
  menuItemId?: string;
  message: string;
}

export interface ItemMappingImportReport {
  dryRun: boolean;
  canonicalItemsInspected: number;
  mappingsCreated: number;
  mappingsReused: number;
  skipped: number;
  invalid: number;
  failures: number;
  skippedByReason: Partial<Record<ItemImportIssueCode, number>>;
  issues: ItemImportIssue[];
  issuesTruncated: boolean;
}

export async function importSeedItemMappings(
  collections: DiningItemMappingCollections,
  options: ItemMappingImportOptions = {}
): Promise<ItemMappingImportReport> {
  const dryRun = options.dryRun ?? false;
  const now = options.now ?? new Date();
  const chunkSize = options.chunkSize ?? ITEM_IMPORT_CHUNK;
  const report: ItemMappingImportReport = {
    dryRun,
    canonicalItemsInspected: 0,
    mappingsCreated: 0,
    mappingsReused: 0,
    skipped: 0,
    invalid: 0,
    failures: 0,
    skippedByReason: {},
    issues: [],
    issuesTruncated: false,
  };
  const groupByRestaurant = new Map<string, ObjectId | null>();

  const filter: Filter<DiningCanonicalItem> = {};
  if (options.restaurantGroupId) filter.restaurantGroupId = options.restaurantGroupId;
  if (options.platform) filter.seedPlatform = options.platform;

  let chunk: Array<WithId<DiningCanonicalItem>> = [];
  for await (const canonical of collections.canonicalItems.find(filter).sort({ _id: 1 })) {
    chunk.push(canonical);
    if (chunk.length >= chunkSize) {
      await processChunk(chunk);
      chunk = [];
    }
  }
  if (chunk.length) await processChunk(chunk);
  return report;

  function issue(i: ItemImportIssue, kind: 'skipped' | 'invalid' | 'failures'): void {
    report[kind]++;
    if (kind === 'skipped') report.skippedByReason[i.code] = (report.skippedByReason[i.code] ?? 0) + 1;
    if (report.issues.length < MAX_IMPORT_ISSUES) report.issues.push(i);
    else report.issuesTruncated = true;
  }

  async function groupOf(restaurantId: ObjectId): Promise<ObjectId | null> {
    const key = restaurantId.toHexString();
    if (!groupByRestaurant.has(key)) {
      const mapping = await collections.restaurantMappings.findOne({ restaurantId, isActive: true, matchStatus: 'MATCHED' });
      const group = mapping?.canonicalRestaurantGroupId
        ? await collections.restaurantGroups.findOne({ _id: mapping.canonicalRestaurantGroupId }, { projection: { _id: 1 } })
        : null;
      groupByRestaurant.set(key, group?._id ?? null);
    }
    return groupByRestaurant.get(key)!;
  }

  async function processChunk(canonicals: Array<WithId<DiningCanonicalItem>>): Promise<void> {
    const seedIds = canonicals.map(c => c.seedMenuItemId);
    const [items, active, rejected] = await Promise.all([
      collections.menuItems.find({ _id: { $in: seedIds } }, { projection: { platform: 1, restaurantId: 1, platformItemId: 1 } }).toArray(),
      collections.itemMappings.find({ menuItemId: { $in: seedIds }, isActive: true }).toArray(),
      collections.itemMappings.find({ menuItemId: { $in: seedIds }, matchStatus: 'REJECTED' }, { projection: { menuItemId: 1, canonicalItemId: 1 } }).toArray(),
    ]);
    const itemById = new Map(items.map(i => [i._id.toHexString(), i]));
    const activeByItem = new Map(active.map(m => [m.menuItemId.toHexString(), m]));
    const rejectedPairs = new Set(rejected.map(r => `${r.menuItemId.toHexString()}:${r.canonicalItemId?.toHexString()}`));

    const planned: Array<{ canonical: WithId<DiningCanonicalItem>; doc: DiningItemMapping }> = [];
    for (const canonical of canonicals) {
      report.canonicalItemsInspected++;
      const ref = { canonicalItemId: canonical._id.toHexString(), menuItemId: canonical.seedMenuItemId.toHexString() };
      const item = itemById.get(ref.menuItemId);
      if (!item) {
        issue({ ...ref, code: 'SEED_ITEM_NOT_FOUND', message: 'Seed source item no longer exists' }, 'skipped');
        continue;
      }
      if (item.platform !== canonical.seedPlatform) {
        issue({ ...ref, code: 'SEED_PLATFORM_MISMATCH', message: 'Seed source item platform differs from canonical seedPlatform' }, 'invalid');
        continue;
      }
      const groupId = await groupOf(item.restaurantId);
      if (!groupId) {
        issue({ ...ref, code: 'RESTAURANT_NOT_MAPPED', message: 'Source restaurant has no matched restaurant group' }, 'skipped');
        continue;
      }
      if (!groupId.equals(canonical.restaurantGroupId)) {
        issue({ ...ref, code: 'RESTAURANT_GROUP_MISMATCH', message: 'Source restaurant group differs from canonical item group' }, 'skipped');
        continue;
      }
      const current = activeByItem.get(ref.menuItemId);
      if (current) {
        if (current.matchStatus === 'MATCHED' && current.canonicalItemId?.equals(canonical._id)) report.mappingsReused++;
        else issue({ ...ref, code: 'EXISTING_DECISION', message: `Source item already has an active ${current.matchStatus} decision` }, 'skipped');
        continue;
      }
      if (rejectedPairs.has(`${ref.menuItemId}:${ref.canonicalItemId}`)) {
        issue({ ...ref, code: 'PREVIOUSLY_REJECTED', message: 'This pairing was rejected manually' }, 'skipped');
        continue;
      }

      const doc: DiningItemMapping = {
        canonicalItemId: canonical._id,
        restaurantGroupId: groupId,
        menuItemId: item._id,
        restaurantId: item.restaurantId,
        platform: item.platform,
        ...(item.platformItemId ? { platformItemId: item.platformItemId } : {}),
        matchStatus: 'MATCHED',
        matchMethod: 'IMPORT',
        confidence: 1,
        evidence: { reasons: ['SEED_SOURCE_ITEM'], conflicts: [] },
        isActive: true,
        decidedBy: 'import',
        decidedAt: now,
        createdAt: now,
        updatedAt: now,
      };
      const check = validateItemMapping(doc);
      if (!check.valid) {
        issue({ ...ref, code: 'INVALID_MAPPING', message: `Invalid fields: ${check.issues.map(i => i.path).join(', ')}` }, 'invalid');
        continue;
      }
      planned.push({ canonical, doc });
    }

    if (planned.length === 0) return;
    if (dryRun) {
      report.mappingsCreated += planned.length;
      return;
    }

    const writes: Array<AnyBulkWriteOperation<DiningItemMapping>> = planned.map(({ doc }) => {
      const { menuItemId, isActive, ...onInsert } = doc;
      return { updateOne: { filter: { menuItemId, isActive }, update: { $setOnInsert: onInsert }, upsert: true } };
    });
    let upserted = new Set<number>();
    const failed = new Map<number, number | undefined>();
    try {
      const res = await collections.itemMappings.bulkWrite(writes, { ordered: false });
      upserted = new Set(Object.keys(res.upsertedIds).map(Number));
    } catch (err) {
      if (!(err instanceof MongoBulkWriteError)) throw err;
      upserted = new Set(Object.keys(err.result?.upsertedIds ?? {}).map(Number));
      for (const e of Array.isArray(err.writeErrors) ? err.writeErrors : [err.writeErrors]) failed.set(e.index, e.code);
    }
    planned.forEach(({ canonical, doc }, index) => {
      if (upserted.has(index)) report.mappingsCreated++;
      else if (failed.get(index) === 11000) report.mappingsReused++;
      else if (failed.has(index)) {
        issue({ canonicalItemId: canonical._id.toHexString(), menuItemId: doc.menuItemId.toHexString(), code: 'WRITE_ERROR', message: 'Write failed' }, 'failures');
      } else report.mappingsReused++;
    });
  }
}
