import { Collection, Filter, ObjectId } from 'mongodb';
import type { DiningRestaurant } from '../dining.types';
import { DiningValidationError, validateRestaurant } from '../dining.validator';
import type { DiningRestaurantDto } from '../platforms/platform.mapper';
import {
  applyUpdate,
  createUpdate,
  DocumentUpdate,
  isDuplicateKeyError,
  setField,
  setLocalized,
  setOnInsertField,
  toMongoUpdate,
  UpsertStatus,
  upsertStatus,
} from './document-update';
import { DiningIdentityDowngradeError, DiningWriteContext, RestaurantRef } from './repository.types';

/*
 * Identity: platform + platformRestaurantId when the platform exposes an ID, otherwise sourceKey.
 * EN and AR scrapes resolve to the same document; localized fields are merged per locale.
 */

export function restaurantIdentityFilter(dto: Pick<DiningRestaurantDto, 'platform' | 'platformRestaurantId' | 'sourceKey'>): Filter<DiningRestaurant> {
  return dto.platformRestaurantId
    ? { platform: dto.platform, platformRestaurantId: dto.platformRestaurantId }
    : { sourceKey: dto.sourceKey };
}

export function buildRestaurantUpdate(dto: DiningRestaurantDto, ctx: DiningWriteContext): DocumentUpdate {
  const u = createUpdate();
  const { locale, now, runId } = ctx;
  setField(u, 'platform', dto.platform);
  setField(u, 'sourceKey', dto.sourceKey);
  setField(u, 'sourceKeyKind', dto.sourceKeyKind);
  setField(u, 'platformRestaurantId', dto.platformRestaurantId);
  setField(u, 'slug', dto.slug);
  setLocalized(u, 'name', locale, dto.name);
  setLocalized(u, 'url', locale, dto.url);
  setLocalized(u, 'brandName', locale, dto.brandName);
  setField(u, 'cuisines', dto.cuisines);
  setField(u, 'tags', dto.tags);
  setField(u, 'location', dto.location);
  setField(u, 'rating', dto.rating);
  setField(u, 'ratingCount', dto.ratingCount);
  setField(u, 'ratingCountText', dto.ratingCountText);
  setField(u, 'currency', dto.currency);
  setField(u, 'deliveryFee', dto.deliveryFee);
  setField(u, 'minimumOrder', dto.minimumOrder);
  setField(u, 'deliveryTimeMin', dto.deliveryTimeMin);
  setField(u, 'deliveryTimeMax', dto.deliveryTimeMax);
  setField(u, 'isOpen', dto.isOpen);
  setField(u, 'imageUrl', dto.imageUrl);
  setField(u, 'isActive', true);
  setField(u, `lastScrapedAtByLocale.${locale}`, now);
  setField(u, `lastRunIdByLocale.${locale}`, runId);
  setField(u, 'updatedAt', now);

  setOnInsertField(u, 'cuisines', []);
  setOnInsertField(u, 'tags', []);
  setOnInsertField(u, 'offers', []);
  setOnInsertField(u, 'location', {});
  setOnInsertField(u, 'firstSeenAt', now);
  setOnInsertField(u, 'createdAt', now);
  return u;
}

export interface RestaurantUpsertResult {
  restaurant: RestaurantRef;
  status: UpsertStatus;
  document: DiningRestaurant;
}

export function createRestaurantRepository(collection: Collection<DiningRestaurant>) {
  async function findByIdentity(dto: Pick<DiningRestaurantDto, 'platform' | 'platformRestaurantId' | 'sourceKey'>) {
    return collection.findOne(restaurantIdentityFilter(dto));
  }

  async function upsertOnce(dto: DiningRestaurantDto, ctx: DiningWriteContext): Promise<RestaurantUpsertResult> {
    const existing = await findByIdentity(dto);
    if (!existing && !dto.platformRestaurantId && dto.slug) {
      const idKeyed = await collection.findOne({ platform: dto.platform, slug: dto.slug, sourceKeyKind: 'id' });
      if (idKeyed) {
        throw new DiningIdentityDowngradeError(
          `Restaurant "${dto.slug}" is stored with platform ID ${idKeyed.platformRestaurantId}; this page exposed no ID`
        );
      }
    }
    const update = buildRestaurantUpdate(dto, ctx);
    const merged = applyUpdate<DiningRestaurant>(existing, update);
    const check = validateRestaurant(merged);
    if (!check.valid) throw new DiningValidationError('restaurant', check.issues);

    let _id = existing?._id;
    let persisted = !!existing;
    if (!ctx.dryRun) {
      const res = await collection.updateOne(restaurantIdentityFilter(dto), toMongoUpdate<DiningRestaurant>(update), { upsert: true });
      _id = _id ?? (res.upsertedId as ObjectId | null) ?? undefined;
      persisted = true;
    }
    if (!_id) _id = new ObjectId();

    return {
      restaurant: { _id, platform: dto.platform, sourceKey: dto.sourceKey, platformRestaurantId: dto.platformRestaurantId, persisted },
      status: upsertStatus(existing, merged),
      document: { ...merged, _id },
    };
  }

  // A concurrent first insert of the same restaurant loses on the unique index; the retry then
  // finds and updates the winner's document.
  async function upsert(dto: DiningRestaurantDto, ctx: DiningWriteContext): Promise<RestaurantUpsertResult> {
    try {
      return await upsertOnce(dto, ctx);
    } catch (err) {
      if (!isDuplicateKeyError(err)) throw err;
      return upsertOnce(dto, ctx);
    }
  }

  return { findByIdentity, upsert };
}

export type RestaurantRepository = ReturnType<typeof createRestaurantRepository>;
