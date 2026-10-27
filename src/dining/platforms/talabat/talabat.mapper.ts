import {
  buildCategorySourceKey,
  buildMenuItemSourceKey,
  buildRestaurantSourceKey,
} from '../../dining.source-key';
import type { DiningLocale, DiningLocation, LocalizedText } from '../../dining.types';
import { stripUndefined } from '../../dining.object';
import {
  DiningMappedMenu,
  DiningMappingError,
  DiningMenuCategoryDto,
  DiningMenuItemClearableField,
  DiningMenuItemDto,
  DiningPlatformMapper,
  DiningRestaurantDto,
} from '../platform.mapper';
import type { PlatformParseWarning } from '../platform.types';
import { getTalabatIdentityInputs } from './talabat.adapter';
import type { TalabatParseResult, TalabatRawMenuItem } from './talabat.types';

/*
 * Talabat raw parse result → canonical Dining DTOs for the parse locale. Pure: no I/O.
 *
 *   - Keys come from getTalabatIdentityInputs() + the source-key helpers (branch ID, section ID,
 *     item ID); never from names, prices or image URLs. Unkeyable items are rejected with a warning.
 *   - `name` is the branch name ("Kamat Vegetarian, The Palm Jumeirah"); the brand name goes to
 *     `brandName`. The chain-level restaurant ID is not an identity.
 *   - Localized fields contain only `result.locale`.
 *   - Cuisine labels and location (area, city, coordinates) come from the reference locale (EN) only.
 *   - Prices are already in major units. `originalPrice` only when oldPrice > price.
 *   - Item availability is not on the page: every item is `availabilityStatus: 'unknown'` and no
 *     `isAvailable` is sent, so nothing is stored as available or unavailable.
 *   - `hasChoices` → `hasModifiers`; the modifier groups themselves are not on the page.
 *   - Not provided: delivery fee / minimum order / delivery time (address-dependent placeholders on a
 *     page fetched without an address), open/closed, popularity, dietary tags, calories.
 */

export const TALABAT_REFERENCE_LOCALE: DiningLocale = 'en';
// More rejected items than this (share of items seen) makes a scrape incomplete.
export const TALABAT_MAX_REJECTED_RATIO = 0.1;

function localized(locale: DiningLocale, value: string | undefined): LocalizedText | undefined {
  return value === undefined ? undefined : { [locale]: value };
}

function mapRestaurant(result: TalabatParseResult, warnings: PlatformParseWarning[]): DiningRestaurantDto {
  const r = result.restaurant;
  if (!r) throw new DiningMappingError('NO_RESTAURANT', 'No restaurant data was parsed from the page');
  if (!r.name) throw new DiningMappingError('MISSING_RESTAURANT_NAME', 'Restaurant name is missing');

  const identity = getTalabatIdentityInputs(result).restaurant;
  if (!identity) throw new DiningMappingError('NO_RESTAURANT_IDENTITY', 'Restaurant has neither a Talabat branch ID nor a URL slug');

  let sourceKey: string;
  try {
    sourceKey = buildRestaurantSourceKey('talabat', identity);
  } catch (err) {
    throw new DiningMappingError('INVALID_RESTAURANT_IDENTITY', (err as Error).message);
  }

  const itemCurrencies = new Set(result.items.map(i => i.currency));
  const currency = r.currency ?? (itemCurrencies.size === 1 ? [...itemCurrencies][0] : undefined);
  if (!currency) throw new DiningMappingError('MISSING_CURRENCY', 'Restaurant currency could not be determined');

  if (identity.kind === 'anchor') {
    warnings.push({ scope: 'restaurant', code: 'RESTAURANT_ANCHOR_IDENTITY', message: 'No Talabat branch ID on the page; identified by URL slug' });
  }

  const locale = result.locale;
  const isReference = locale === TALABAT_REFERENCE_LOCALE;
  const location: DiningLocation = stripUndefined({
    city: r.location.city,
    area: r.location.area,
    lat: r.location.lat,
    lng: r.location.lng,
  });

  return stripUndefined({
    platform: 'talabat' as const,
    sourceKey,
    sourceKeyKind: identity.kind,
    platformRestaurantId: identity.kind === 'id' ? identity.value : undefined,
    slug: r.slug,
    name: { [locale]: r.name },
    brandName: localized(locale, r.brandName),
    url: { [locale]: r.url ?? result.sourceUrl },
    cuisines: isReference && r.cuisines.length ? [...r.cuisines] : undefined,
    location: isReference && Object.keys(location).length ? location : undefined,
    rating: r.rating,
    ratingCount: r.ratingCount,
    currency,
    imageUrl: r.imageUrl,
  });
}

function itemClearFields(item: TalabatRawMenuItem, hasCategory: boolean): DiningMenuItemClearableField[] {
  // The payload always carries description, oldPrice (-1 = none) and image fields, so their
  // absence is evidence. Popularity is never reported by Talabat and is not cleared.
  const clear: DiningMenuItemClearableField[] = [];
  if (item.description === undefined) clear.push('description');
  if (item.originalPrice === undefined) clear.push('originalPrice');
  if (item.imageUrl === undefined) clear.push('imageUrl');
  if (item.hasModifiers === undefined) clear.push('hasModifiers');
  if (!hasCategory) clear.push('categoryId');
  return clear;
}

export function mapTalabatMenu(result: TalabatParseResult): DiningMappedMenu {
  const warnings: PlatformParseWarning[] = [...result.warnings];
  const locale = result.locale;
  const restaurant = mapRestaurant(result, warnings);
  const identity = getTalabatIdentityInputs(result);
  const restaurantUrl = result.restaurant?.url ?? result.sourceUrl;

  // Categories
  const categoryKeys: Array<string | undefined> = [];
  const categories: DiningMenuCategoryDto[] = [];
  for (const { categoryIndex, identity: catIdentity } of identity.categories) {
    const c = result.categories[categoryIndex];
    try {
      const sourceKey = buildCategorySourceKey(restaurant.sourceKey, catIdentity);
      categoryKeys[categoryIndex] = sourceKey;
      categories.push(stripUndefined({
        sourceKey,
        sourceKeyKind: catIdentity.kind,
        platformCategoryId: catIdentity.kind === 'id' ? catIdentity.value : undefined,
        name: { [locale]: c.name },
        sortOrder: c.sortOrder,
      }));
    } catch (err) {
      warnings.push({ scope: 'category', categoryIndex, code: 'INVALID_CATEGORY_IDENTITY', message: (err as Error).message });
    }
  }

  // Items
  let mapperRejected = 0;
  const reject = (item: TalabatRawMenuItem, code: string, message: string) => {
    mapperRejected++;
    warnings.push({ scope: 'item', itemIndex: item.sourceIndex, code, message });
  };
  for (const index of identity.unresolvedItemIndexes) {
    reject(result.items[index], 'UNRESOLVED_IDENTITY', 'Item has no Talabat ID and no category position');
  }

  const items: DiningMenuItemDto[] = [];
  const seenKeys = new Set<string>();
  for (const { itemIndex, identity: itemIdentity, categoryIndex } of identity.items) {
    const item = result.items[itemIndex];
    const categorySourceKey = categoryIndex !== undefined ? categoryKeys[categoryIndex] : undefined;
    let sourceKey: string;
    try {
      sourceKey = buildMenuItemSourceKey(restaurant.sourceKey, itemIdentity, categorySourceKey);
    } catch (err) {
      reject(item, 'INVALID_ITEM_IDENTITY', (err as Error).message);
      continue;
    }
    if (seenKeys.has(sourceKey)) {
      reject(item, 'DUPLICATE_SOURCE_KEY', `Another item on the page already uses ${sourceKey}`);
      continue;
    }
    seenKeys.add(sourceKey);

    items.push(stripUndefined({
      sourceKey,
      sourceKeyKind: itemIdentity.kind,
      platformItemId: itemIdentity.kind === 'id' ? itemIdentity.value : undefined,
      categorySourceKey,
      categoryName: categorySourceKey ? localized(locale, item.categoryName) : undefined,
      name: { [locale]: item.name },
      description: localized(locale, item.description),
      price: item.price,
      originalPrice: item.originalPrice,
      currency: item.currency,
      imageUrl: item.imageUrl,
      // The menu page carries no availability signal for items.
      availabilityStatus: 'unknown',
      hasModifiers: item.hasModifiers,
      sourceUrl: { [locale]: restaurantUrl },
      clear: itemClearFields(item, categorySourceKey !== undefined),
    }));
  }

  if (result.stats.itemsWithModifiers > 0) {
    warnings.push({
      scope: 'page', code: 'MODIFIERS_NOT_EMBEDDED', field: 'hasChoices',
      message: `${result.stats.itemsWithModifiers} item(s) have modifier groups that the menu page does not include; modifiers were not mapped`,
    });
  }

  // Completeness: may this mapping be used to mark unseen items inactive?
  const itemsSeen = result.stats.itemsSeen - result.stats.duplicateItemEntries;
  const itemsRejected = result.stats.itemsRejected + mapperRejected;
  const reasons: string[] = [];
  if (result.dataSource !== 'next-data') reasons.push('NO_MENU_DATA');
  if (items.length === 0) reasons.push('NO_ITEMS');
  if (itemsSeen > 0 && itemsRejected / itemsSeen > TALABAT_MAX_REJECTED_RATIO) reasons.push('TOO_MANY_REJECTED_ITEMS');
  if (categories.length < result.categories.length) reasons.push('CATEGORY_IDENTITY_MISSING');

  return {
    platform: 'talabat',
    locale,
    sourceUrl: result.sourceUrl,
    restaurant,
    categories,
    items,
    completeness: { complete: reasons.length === 0, reasons, itemsSeen, itemsMapped: items.length, itemsRejected },
    warnings,
  };
}

export type TalabatMapper = DiningPlatformMapper<TalabatParseResult>;

export const talabatMapper: TalabatMapper = {
  platform: 'talabat',
  map: mapTalabatMenu,
};
