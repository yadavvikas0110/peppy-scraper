import { Collection, Filter, ObjectId, WithId } from 'mongodb';
import { stripUndefined } from '../dining.object';
import type {
  DiningLocale,
  DiningMenuItem,
  LocalizedText,
  MenuModifierGroup,
  MenuModifierOption,
  SourceKeyKind,
} from '../dining.types';
import { validateMenuItem } from '../dining.validator';
import type { DiningMenuItemDto } from '../platforms/platform.mapper';
import { countStatuses, executeBulkUpserts, PlannedUpsert, resolveIds } from './bulk-upsert';
import {
  applyUpdate,
  createUpdate,
  DocumentUpdate,
  setField,
  setLocalized,
  setOnInsertField,
  unsetField,
  unsetLocalized,
} from './document-update';
import {
  BulkUpsertOutcome,
  DiningWriteContext,
  issuesMessage,
  RejectedRecord,
  RestaurantRef,
} from './repository.types';

/*
 * Identity: platform + platformRestaurantId (→ restaurantId) + platformItemId when available,
 * otherwise sourceKey.
 *
 * Localized fields merge per locale. Everything else (price, image, availability, popularity,
 * modifier structure) is the latest observation, whichever locale it came from.
 */

export function itemIdentityFilter(restaurant: RestaurantRef, dto: DiningMenuItemDto): Filter<DiningMenuItem> {
  return dto.platformItemId
    ? { restaurantId: restaurant._id, platformItemId: dto.platformItemId }
    : { sourceKey: dto.sourceKey };
}

// ─── Modifier merge ──────────────────────────────────────────────────────────

function mergeLocalized(previous: LocalizedText | undefined, next: LocalizedText | undefined, locale: DiningLocale): LocalizedText | undefined {
  const out: LocalizedText = { ...(previous ?? {}) };
  delete out[locale];
  if (next?.[locale] !== undefined) out[locale] = next[locale];
  return Object.keys(out).length ? stripUndefined(out) : undefined;
}

function matchById<T>(list: T[] | undefined, id: string | undefined, index: number, getId: (v: T) => string | undefined): T | undefined {
  if (!list) return undefined;
  if (id !== undefined) return list.find(v => getId(v) === id);
  const candidate = list[index];
  return candidate && getId(candidate) === undefined ? candidate : undefined;
}

// Structure (groups, options, limits, prices, availability) comes from `incoming`; names and
// descriptions keep the other locale's text from `existing` where the group/option still exists.
export function mergeModifierGroups(
  existing: MenuModifierGroup[] | undefined,
  incoming: MenuModifierGroup[],
  locale: DiningLocale
): MenuModifierGroup[] {
  return incoming.map((group, gi) => {
    const prev = matchById(existing, group.groupId, gi, g => g.groupId);
    const options: MenuModifierOption[] = group.options.map((option, oi) => {
      const prevOption = matchById(prev?.options, option.optionId, oi, o => o.optionId);
      return stripUndefined({
        ...option,
        name: mergeLocalized(prevOption?.name, option.name, locale) ?? option.name,
        description: mergeLocalized(prevOption?.description, option.description, locale),
      });
    });
    return stripUndefined({
      ...group,
      name: mergeLocalized(prev?.name, group.name, locale) ?? group.name,
      description: mergeLocalized(prev?.description, group.description, locale),
      options,
    });
  });
}

// ─── Update builder ──────────────────────────────────────────────────────────

export function buildItemUpdate(
  restaurant: RestaurantRef,
  dto: DiningMenuItemDto,
  categoryId: ObjectId | undefined,
  existing: DiningMenuItem | null,
  ctx: DiningWriteContext
): DocumentUpdate {
  const u = createUpdate();
  const { locale, now, runId } = ctx;
  const current = existing as unknown as Record<string, unknown> | null;

  setField(u, 'platform', restaurant.platform);
  setField(u, 'restaurantId', restaurant._id);
  setField(u, 'restaurantSourceKey', restaurant.sourceKey);
  setField(u, 'platformRestaurantId', restaurant.platformRestaurantId);
  setField(u, 'platformItemId', dto.platformItemId);
  setField(u, 'sourceKey', dto.sourceKey);
  setField(u, 'sourceKeyKind', dto.sourceKeyKind);
  setField(u, 'categoryId', categoryId);
  setLocalized(u, 'categoryName', locale, dto.categoryName);
  setLocalized(u, 'name', locale, dto.name);
  setLocalized(u, 'description', locale, dto.description);
  setField(u, 'price', dto.price);
  setField(u, 'originalPrice', dto.originalPrice);
  setField(u, 'currency', dto.currency);
  setField(u, 'imageUrl', dto.imageUrl);
  setField(u, 'isAvailable', dto.isAvailable);
  setField(u, 'isPopular', dto.isPopular);
  setField(u, 'dietaryTags', dto.dietaryTags);
  setField(u, 'calories', dto.calories);
  if (dto.modifiers) setField(u, 'modifiers', mergeModifierGroups(existing?.modifiers, dto.modifiers, locale));
  setLocalized(u, 'sourceUrl', locale, dto.sourceUrl);
  setField(u, 'isActive', true);
  setField(u, 'lastSeenAt', now);
  setField(u, `lastSeenAtByLocale.${locale}`, now);
  setField(u, `lastRunIdByLocale.${locale}`, runId);
  setField(u, 'updatedAt', now);

  setOnInsertField(u, 'dietaryTags', []);
  // A listed item with unknown orderability (DOM fallback only) is stored as available on first
  // sight; later scrapes that observe availability overwrite it.
  setOnInsertField(u, 'isAvailable', true);
  setOnInsertField(u, 'firstSeenAt', now);
  setOnInsertField(u, 'createdAt', now);

  for (const field of dto.clear) {
    if (field === 'description') unsetLocalized(u, current, 'description', locale);
    else if (field === 'categoryId') {
      unsetField(u, current, 'categoryId');
      unsetLocalized(u, current, 'categoryName', locale);
    } else unsetField(u, current, field);
  }
  return u;
}

// ─── Repository ──────────────────────────────────────────────────────────────

export function createMenuItemRepository(collection: Collection<DiningMenuItem>) {
  async function findByRestaurant(restaurant: RestaurantRef): Promise<WithId<DiningMenuItem>[]> {
    if (!restaurant.persisted) return [];
    return collection.find({ restaurantId: restaurant._id }).toArray();
  }

  async function upsertMany(
    restaurant: RestaurantRef,
    dtos: DiningMenuItemDto[],
    categoryIds: Map<string, ObjectId>,
    ctx: DiningWriteContext
  ): Promise<BulkUpsertOutcome> {
    const existingDocs = await findByRestaurant(restaurant);
    const byPlatformId = new Map(existingDocs.filter(d => d.platformItemId).map(d => [d.platformItemId as string, d]));
    const byKey = new Map(existingDocs.map(d => [d.sourceKey, d]));

    const rejected: RejectedRecord[] = [];
    const planned: PlannedUpsert<DiningMenuItem>[] = [];
    for (const dto of dtos) {
      const existing = (dto.platformItemId ? byPlatformId.get(dto.platformItemId) : byKey.get(dto.sourceKey)) ?? null;
      const categoryId = dto.categorySourceKey ? categoryIds.get(dto.categorySourceKey) : undefined;
      const update = buildItemUpdate(restaurant, dto, categoryId, existing, ctx);
      const merged = applyUpdate<DiningMenuItem>(existing, update);
      const check = validateMenuItem(merged);
      if (!check.valid) {
        rejected.push({ sourceKey: dto.sourceKey, code: 'VALIDATION_FAILED', message: issuesMessage(check.issues), issues: check.issues });
        continue;
      }
      planned.push({ sourceKey: dto.sourceKey, filter: itemIdentityFilter(restaurant, dto), update, existing, merged });
    }

    const execution = await executeBulkUpserts(collection, planned, { dryRun: ctx.dryRun });
    rejected.push(...execution.rejected);
    const idsBySourceKey = await resolveIds(collection, restaurant._id, planned, execution.rejected, !!ctx.dryRun);
    return { ...countStatuses(execution.statuses), rejected, idsBySourceKey };
  }

  async function countActive(restaurant: RestaurantRef): Promise<number> {
    if (!restaurant.persisted) return 0;
    return collection.countDocuments({ restaurantId: restaurant._id, isActive: true });
  }

  async function activeSourceKeyKinds(restaurant: RestaurantRef): Promise<SourceKeyKind[]> {
    if (!restaurant.persisted) return [];
    return collection.distinct('sourceKeyKind', { restaurantId: restaurant._id, isActive: true }) as Promise<SourceKeyKind[]>;
  }

  // Never deletes: items of this restaurant that were active but not seen → isActive=false.
  async function markMissingInactive(restaurant: RestaurantRef, seenSourceKeys: string[], ctx: DiningWriteContext): Promise<number> {
    if (!restaurant.persisted) return 0;
    const filter: Filter<DiningMenuItem> = { restaurantId: restaurant._id, isActive: true, sourceKey: { $nin: seenSourceKeys } };
    if (ctx.dryRun) return collection.countDocuments(filter);
    const res = await collection.updateMany(filter, { $set: { isActive: false, updatedAt: ctx.now } });
    return res.modifiedCount;
  }

  return { findByRestaurant, upsertMany, countActive, activeSourceKeyKinds, markMissingInactive };
}

export type MenuItemRepository = ReturnType<typeof createMenuItemRepository>;
