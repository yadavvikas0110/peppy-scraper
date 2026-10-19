import { AnyBulkWriteOperation, Filter, MongoBulkWriteError, ObjectId, WithId } from 'mongodb';
import type { DiningMenuItem, DiningPlatform } from '../dining.types';
import { validateMenuItem } from '../dining.validator';
import { buildCanonicalItem, planCanonicalItemEnrichment } from './canonical-item.builder';
import type { DiningCanonicalItemCollections } from './canonical-item.collections';
import type { DiningCanonicalItem } from './canonical-item.types';
import { validateCanonicalItem } from './canonical-item.validator';

/*
 * Initial canonical-item backfill: one valid source menu item → one canonical item inside the
 * source restaurant's canonical group. No cross-item or cross-platform merging (that is a
 * separate mapping phase). Reads dining_menu_items, dining_restaurant_mappings and
 * dining_restaurant_groups only; writes dining_canonical_items only (never in dry run).
 *
 * Idempotent: the unique seedMenuItemId index plus $setOnInsert upserts mean re-runs and
 * concurrent runs reuse the existing canonical item instead of creating another.
 */

export const CANONICAL_BACKFILL_CHUNK = 500;
export const MAX_REPORTED_ISSUES = 200;

export interface CanonicalItemBackfillOptions {
  dryRun?: boolean;
  platform?: DiningPlatform;
  restaurantId?: ObjectId;
  restaurantGroupId?: ObjectId;
  now?: Date;
  chunkSize?: number;
}

export type CanonicalItemIssueCode =
  | 'NO_RESTAURANT_MAPPING'
  | 'RESTAURANT_NOT_MATCHED'
  | 'RESTAURANT_GROUP_NOT_FOUND'
  | 'RESTAURANT_GROUP_CHANGED'
  | 'SOURCE_ITEM_INACTIVE'
  | 'INVALID_SOURCE_ITEM'
  | 'INVALID_CANONICAL_ITEM'
  | 'DUPLICATE_KEY'
  | 'WRITE_ERROR'
  | 'BACKFILL_FAILED';

export interface CanonicalItemIssue {
  outcome: 'SKIPPED' | 'INVALID' | 'FAILED';
  code: CanonicalItemIssueCode;
  restaurantId: string;
  menuItemId?: string;
  // Issue paths / short reason only — never field values.
  message: string;
  itemCount?: number;
}

export interface CanonicalItemRestaurantSummary {
  restaurantId: string;
  platform?: DiningPlatform;
  platformRestaurantId?: string;
  restaurantGroupId?: string;
  reason?: CanonicalItemIssueCode;
  itemsInspected: number;
  created: number;
  reused: number;
  enriched: number;
  skipped: number;
  invalid: number;
  failures: number;
}

export interface CanonicalItemBackfillReport {
  dryRun: boolean;
  restaurantsInspected: number;
  restaurantsWithoutGroup: number;
  itemsInspected: number;
  canonicalItemsCreated: number;
  canonicalItemsReused: number;
  // Reused items that gained missing locale fields/aliases (subset of canonicalItemsReused).
  canonicalItemsEnriched: number;
  skipped: number;
  invalid: number;
  failures: number;
  restaurants: CanonicalItemRestaurantSummary[];
  issues: CanonicalItemIssue[];
  issuesTruncated: boolean;
}

type Op =
  | { kind: 'create'; item: WithId<DiningMenuItem>; doc: DiningCanonicalItem }
  | { kind: 'enrich'; item: WithId<DiningMenuItem>; existing: WithId<DiningCanonicalItem>; set: Record<string, unknown> };

export async function backfillCanonicalItems(
  collections: DiningCanonicalItemCollections,
  options: CanonicalItemBackfillOptions = {}
): Promise<CanonicalItemBackfillReport> {
  const dryRun = options.dryRun ?? false;
  const now = options.now ?? new Date();
  const chunkSize = options.chunkSize ?? CANONICAL_BACKFILL_CHUNK;
  const report: CanonicalItemBackfillReport = {
    dryRun,
    restaurantsInspected: 0,
    restaurantsWithoutGroup: 0,
    itemsInspected: 0,
    canonicalItemsCreated: 0,
    canonicalItemsReused: 0,
    canonicalItemsEnriched: 0,
    skipped: 0,
    invalid: 0,
    failures: 0,
    restaurants: [],
    issues: [],
    issuesTruncated: false,
  };

  const itemFilter: Filter<DiningMenuItem> = {};
  if (options.platform) itemFilter.platform = options.platform;
  const restaurantScope = await scopedRestaurantIds();
  if (restaurantScope) itemFilter.restaurantId = { $in: restaurantScope };

  const restaurantIds = ((await collections.menuItems.distinct('restaurantId', itemFilter)) as unknown[])
    .filter((id): id is ObjectId => id instanceof ObjectId)
    .sort((a, b) => a.toHexString().localeCompare(b.toHexString()));

  for (const restaurantId of restaurantIds) {
    const summary: CanonicalItemRestaurantSummary = {
      restaurantId: restaurantId.toHexString(),
      itemsInspected: 0, created: 0, reused: 0, enriched: 0, skipped: 0, invalid: 0, failures: 0,
    };
    report.restaurants.push(summary);
    report.restaurantsInspected++;
    try {
      await backfillRestaurant(restaurantId, summary);
    } catch {
      summary.failures++;
      report.failures++;
      issue({ outcome: 'FAILED', code: 'BACKFILL_FAILED', restaurantId: summary.restaurantId, message: 'Unexpected error while processing this restaurant' });
    }
  }
  return report;

  async function scopedRestaurantIds(): Promise<ObjectId[] | undefined> {
    let ids: ObjectId[] | undefined = options.restaurantId ? [options.restaurantId] : undefined;
    if (options.restaurantGroupId) {
      const mapped = await collections.restaurantMappings
        .find({ canonicalRestaurantGroupId: options.restaurantGroupId, isActive: true, matchStatus: 'MATCHED' }, { projection: { restaurantId: 1 } })
        .toArray();
      const inGroup = mapped.map(m => m.restaurantId);
      ids = ids ? ids.filter(id => inGroup.some(g => g.equals(id))) : inGroup;
    }
    return ids;
  }

  function issue(i: CanonicalItemIssue): void {
    if (report.issues.length < MAX_REPORTED_ISSUES) report.issues.push(i);
    else report.issuesTruncated = true;
  }

  async function backfillRestaurant(restaurantId: ObjectId, summary: CanonicalItemRestaurantSummary): Promise<void> {
    const scope: Filter<DiningMenuItem> = { ...itemFilter, restaurantId };
    const mapping = await collections.restaurantMappings.findOne({ restaurantId, isActive: true });
    if (mapping) {
      summary.platform = mapping.platform;
      summary.platformRestaurantId = mapping.platformRestaurantId;
    }

    let reason: CanonicalItemIssueCode | undefined;
    let groupId: ObjectId | undefined;
    if (!mapping) reason = 'NO_RESTAURANT_MAPPING';
    else if (mapping.matchStatus !== 'MATCHED' || !mapping.canonicalRestaurantGroupId) reason = 'RESTAURANT_NOT_MATCHED';
    else {
      const group = await collections.restaurantGroups.findOne({ _id: mapping.canonicalRestaurantGroupId }, { projection: { _id: 1 } });
      if (!group) reason = 'RESTAURANT_GROUP_NOT_FOUND';
      else groupId = group._id;
    }

    if (reason || !groupId) {
      const count = await collections.menuItems.countDocuments(scope);
      summary.reason = reason;
      summary.itemsInspected = summary.skipped = count;
      report.itemsInspected += count;
      report.skipped += count;
      report.restaurantsWithoutGroup++;
      issue({ outcome: 'SKIPPED', code: reason ?? 'RESTAURANT_GROUP_NOT_FOUND', restaurantId: summary.restaurantId, message: 'Restaurant has no matched canonical restaurant group', itemCount: count });
      return;
    }
    summary.restaurantGroupId = groupId.toHexString();

    let chunk: Array<WithId<DiningMenuItem>> = [];
    for await (const item of collections.menuItems.find(scope).sort({ _id: 1 })) {
      chunk.push(item);
      if (chunk.length >= chunkSize) {
        await processChunk(groupId, chunk, summary);
        chunk = [];
      }
    }
    if (chunk.length) await processChunk(groupId, chunk, summary);
  }

  async function processChunk(groupId: ObjectId, items: Array<WithId<DiningMenuItem>>, summary: CanonicalItemRestaurantSummary): Promise<void> {
    const ids = items.map(i => i._id).filter((id): id is ObjectId => id instanceof ObjectId);
    const existing = new Map(
      (await collections.canonicalItems.find({ seedMenuItemId: { $in: ids } }).toArray()).map(c => [c.seedMenuItemId.toHexString(), c])
    );
    const ops: Op[] = [];

    for (const item of items) {
      summary.itemsInspected++;
      report.itemsInspected++;
      const itemRef = { restaurantId: summary.restaurantId, menuItemId: String(item._id) };

      const sourceCheck = validateMenuItem(item);
      if (!sourceCheck.valid || !(item._id instanceof ObjectId)) {
        summary.invalid++;
        report.invalid++;
        const paths = [...new Set(sourceCheck.issues.map(i => i.path))].slice(0, 10).join(', ') || '_id';
        issue({ outcome: 'INVALID', code: 'INVALID_SOURCE_ITEM', ...itemRef, message: `Invalid fields: ${paths}` });
        continue;
      }

      const current = existing.get(item._id.toHexString());
      if (current) {
        if (!current.restaurantGroupId.equals(groupId)) {
          summary.skipped++;
          report.skipped++;
          issue({ outcome: 'SKIPPED', code: 'RESTAURANT_GROUP_CHANGED', ...itemRef, message: 'Canonical item belongs to a different restaurant group; needs a manual decision' });
          continue;
        }
        summary.reused++;
        report.canonicalItemsReused++;
        const plan = planCanonicalItemEnrichment(current, item, now);
        if (plan) {
          const check = validateCanonicalItem(plan.merged);
          if (!check.valid) {
            summary.invalid++;
            report.invalid++;
            issue({ outcome: 'INVALID', code: 'INVALID_CANONICAL_ITEM', ...itemRef, message: `Invalid fields: ${check.issues.map(i => i.path).join(', ')}` });
            continue;
          }
          ops.push({ kind: 'enrich', item, existing: current, set: plan.set });
        }
        continue;
      }

      if (item.isActive === false) {
        summary.skipped++;
        report.skipped++;
        issue({ outcome: 'SKIPPED', code: 'SOURCE_ITEM_INACTIVE', ...itemRef, message: 'Source item is no longer on the menu' });
        continue;
      }

      const doc = buildCanonicalItem(groupId, item, now);
      const check = validateCanonicalItem(doc);
      if (!check.valid) {
        summary.invalid++;
        report.invalid++;
        issue({ outcome: 'INVALID', code: 'INVALID_CANONICAL_ITEM', ...itemRef, message: `Invalid fields: ${check.issues.map(i => i.path).join(', ')}` });
        continue;
      }
      ops.push({ kind: 'create', item, doc });
    }

    await execute(ops, summary);
  }

  async function execute(ops: Op[], summary: CanonicalItemRestaurantSummary): Promise<void> {
    if (ops.length === 0) return;
    const creates = ops.filter(o => o.kind === 'create').length;
    const enriches = ops.length - creates;
    if (dryRun) {
      summary.created += creates;
      report.canonicalItemsCreated += creates;
      summary.enriched += enriches;
      report.canonicalItemsEnriched += enriches;
      return;
    }

    const writes: Array<AnyBulkWriteOperation<DiningCanonicalItem>> = ops.map(op =>
      op.kind === 'create'
        ? { updateOne: { filter: { seedMenuItemId: op.doc.seedMenuItemId }, update: { $setOnInsert: op.doc }, upsert: true } }
        : { updateOne: { filter: { _id: op.existing._id, updatedAt: op.existing.updatedAt }, update: { $set: op.set } } }
    );

    let upserted = new Set<number>();
    const failed = new Map<number, number | undefined>();
    try {
      const res = await collections.canonicalItems.bulkWrite(writes, { ordered: false });
      upserted = new Set(Object.keys(res.upsertedIds).map(Number));
    } catch (err) {
      if (!(err instanceof MongoBulkWriteError)) throw err;
      upserted = new Set(Object.keys(err.result?.upsertedIds ?? {}).map(Number));
      const errors = Array.isArray(err.writeErrors) ? err.writeErrors : [err.writeErrors];
      for (const e of errors) failed.set(e.index, e.code);
    }

    ops.forEach((op, index) => {
      const itemRef = { restaurantId: summary.restaurantId, menuItemId: op.item._id.toHexString() };
      if (failed.has(index)) {
        summary.failures++;
        report.failures++;
        if (op.kind === 'enrich') {
          summary.reused--;
          report.canonicalItemsReused--;
        }
        const code = failed.get(index) === 11000 ? 'DUPLICATE_KEY' : 'WRITE_ERROR';
        issue({ outcome: 'FAILED', code, ...itemRef, message: code === 'DUPLICATE_KEY' ? 'Unique index rejected the write' : 'Write failed' });
      } else if (op.kind === 'create') {
        if (upserted.has(index)) {
          summary.created++;
          report.canonicalItemsCreated++;
        } else {
          // Another run created it between our read and write.
          summary.reused++;
          report.canonicalItemsReused++;
        }
      } else {
        summary.enriched++;
        report.canonicalItemsEnriched++;
      }
    });
  }
}
