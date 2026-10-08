import { Collection, Filter, WithId } from 'mongodb';
import type { DiningMenuCategory, SourceKeyKind } from '../dining.types';
import { validateMenuCategory } from '../dining.validator';
import type { DiningMenuCategoryDto } from '../platforms/platform.mapper';
import { countStatuses, executeBulkUpserts, PlannedUpsert, resolveIds } from './bulk-upsert';
import { applyUpdate, createUpdate, DocumentUpdate, setField, setLocalized, setOnInsertField } from './document-update';
import {
  BulkUpsertOutcome,
  DiningWriteContext,
  issuesMessage,
  RejectedRecord,
  RestaurantRef,
} from './repository.types';

/*
 * Identity: restaurant + platformCategoryId when the platform exposes one, otherwise sourceKey.
 * (restaurantId is the canonical restaurant resolved from platform + platformRestaurantId.)
 */

export function categoryIdentityFilter(restaurant: RestaurantRef, dto: DiningMenuCategoryDto): Filter<DiningMenuCategory> {
  return dto.platformCategoryId
    ? { restaurantId: restaurant._id, platformCategoryId: dto.platformCategoryId }
    : { sourceKey: dto.sourceKey };
}

export function buildCategoryUpdate(restaurant: RestaurantRef, dto: DiningMenuCategoryDto, ctx: DiningWriteContext): DocumentUpdate {
  const u = createUpdate();
  const { locale, now, runId } = ctx;
  setField(u, 'platform', restaurant.platform);
  setField(u, 'restaurantId', restaurant._id);
  setField(u, 'restaurantSourceKey', restaurant.sourceKey);
  setField(u, 'platformRestaurantId', restaurant.platformRestaurantId);
  setField(u, 'platformCategoryId', dto.platformCategoryId);
  setField(u, 'sourceKey', dto.sourceKey);
  setField(u, 'sourceKeyKind', dto.sourceKeyKind);
  setLocalized(u, 'name', locale, dto.name);
  setField(u, 'sortOrder', dto.sortOrder);
  setField(u, 'isActive', true);
  setField(u, `lastScrapedAtByLocale.${locale}`, now);
  setField(u, `lastRunIdByLocale.${locale}`, runId);
  setField(u, 'updatedAt', now);
  setOnInsertField(u, 'firstSeenAt', now);
  setOnInsertField(u, 'createdAt', now);
  return u;
}

export function createMenuCategoryRepository(collection: Collection<DiningMenuCategory>) {
  async function findByRestaurant(restaurant: RestaurantRef): Promise<WithId<DiningMenuCategory>[]> {
    if (!restaurant.persisted) return [];
    return collection.find({ restaurantId: restaurant._id }).toArray();
  }

  async function upsertMany(
    restaurant: RestaurantRef,
    dtos: DiningMenuCategoryDto[],
    ctx: DiningWriteContext
  ): Promise<BulkUpsertOutcome> {
    const existingDocs = await findByRestaurant(restaurant);
    const byPlatformId = new Map(existingDocs.filter(d => d.platformCategoryId).map(d => [d.platformCategoryId as string, d]));
    const byKey = new Map(existingDocs.map(d => [d.sourceKey, d]));

    const rejected: RejectedRecord[] = [];
    const planned: PlannedUpsert<DiningMenuCategory>[] = [];
    for (const dto of dtos) {
      const existing = (dto.platformCategoryId ? byPlatformId.get(dto.platformCategoryId) : byKey.get(dto.sourceKey)) ?? null;
      const update = buildCategoryUpdate(restaurant, dto, ctx);
      const merged = applyUpdate<DiningMenuCategory>(existing, update);
      const check = validateMenuCategory(merged);
      if (!check.valid) {
        rejected.push({ sourceKey: dto.sourceKey, code: 'VALIDATION_FAILED', message: issuesMessage(check.issues), issues: check.issues });
        continue;
      }
      planned.push({ sourceKey: dto.sourceKey, filter: categoryIdentityFilter(restaurant, dto), update, existing, merged });
    }

    const execution = await executeBulkUpserts(collection, planned, { dryRun: ctx.dryRun });
    rejected.push(...execution.rejected);
    const idsBySourceKey = await resolveIds(collection, restaurant._id, planned, execution.rejected, !!ctx.dryRun);
    return { ...countStatuses(execution.statuses), rejected, idsBySourceKey };
  }

  // Categories of this restaurant that were active but not in `seenSourceKeys` → isActive=false.
  async function markMissingInactive(restaurant: RestaurantRef, seenSourceKeys: string[], ctx: DiningWriteContext): Promise<number> {
    if (!restaurant.persisted) return 0;
    const filter: Filter<DiningMenuCategory> = { restaurantId: restaurant._id, isActive: true, sourceKey: { $nin: seenSourceKeys } };
    if (ctx.dryRun) return collection.countDocuments(filter);
    const res = await collection.updateMany(filter, { $set: { isActive: false, updatedAt: ctx.now } });
    return res.modifiedCount;
  }

  async function activeSourceKeyKinds(restaurant: RestaurantRef): Promise<SourceKeyKind[]> {
    if (!restaurant.persisted) return [];
    return collection.distinct('sourceKeyKind', { restaurantId: restaurant._id, isActive: true }) as Promise<SourceKeyKind[]>;
  }

  return { findByRestaurant, upsertMany, markMissingInactive, activeSourceKeyKinds };
}

export type MenuCategoryRepository = ReturnType<typeof createMenuCategoryRepository>;
