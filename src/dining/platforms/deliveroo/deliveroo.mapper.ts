import {
  buildCategorySourceKey,
  buildMenuItemSourceKey,
  buildRestaurantSourceKey,
} from '../../dining.source-key';
import type { DiningLocale, DiningLocation, LocalizedText, MenuModifierGroup, MenuModifierOption } from '../../dining.types';
import { validateModifierGroup } from '../../dining.validator';
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
import { getDeliverooIdentityInputs } from './deliveroo.adapter';
import type { DeliverooParseResult, DeliverooRawMenuItem, DeliverooRawModifierGroup } from './deliveroo.types';

/*
 * Deliveroo raw parse result → canonical Dining DTOs for the parse locale. Pure: no I/O.
 *
 *   - Keys come from getDeliverooIdentityInputs() + the source-key helpers; never from names,
 *     descriptions, image URLs or CSS. Items without a usable identity are rejected with a warning.
 *   - Localized fields contain only `result.locale`.
 *   - Cuisine labels and the address are locale-neutral canonical fields but appear as translated
 *     text on the page: they are taken from the reference locale (EN) only.
 *   - Prices are already in major units. `originalPrice` only when a discount exists.
 *   - Not provided because Deliveroo's page does not carry them reliably: delivery time, open/closed
 *     (only a "Closes at" text), lat/lng, exact rating count, brand name, dietary tags, calories.
 */

export const DELIVEROO_REFERENCE_LOCALE: DiningLocale = 'en';
// More rejected items than this (share of items seen) makes a scrape incomplete.
export const DELIVEROO_MAX_REJECTED_RATIO = 0.1;

function localized(locale: DiningLocale, value: string | undefined): LocalizedText | undefined {
  return value === undefined ? undefined : { [locale]: value };
}

function mapRestaurant(result: DeliverooParseResult, warnings: PlatformParseWarning[]): DiningRestaurantDto {
  const r = result.restaurant;
  if (!r) throw new DiningMappingError('NO_RESTAURANT', 'No restaurant data was parsed from the page');
  if (!r.name) throw new DiningMappingError('MISSING_RESTAURANT_NAME', 'Restaurant name is missing');

  const identity = getDeliverooIdentityInputs(result).restaurant;
  if (!identity) throw new DiningMappingError('NO_RESTAURANT_IDENTITY', 'Restaurant has neither a Deliveroo ID nor a URL slug');

  let sourceKey: string;
  try {
    sourceKey = buildRestaurantSourceKey('deliveroo', identity);
  } catch (err) {
    throw new DiningMappingError('INVALID_RESTAURANT_IDENTITY', (err as Error).message);
  }

  const itemCurrencies = new Set(result.items.map(i => i.currency));
  const currency = r.currency ?? (itemCurrencies.size === 1 ? [...itemCurrencies][0] : undefined);
  if (!currency) throw new DiningMappingError('MISSING_CURRENCY', 'Restaurant currency could not be determined');

  const locale = result.locale;
  const isReference = locale === DELIVEROO_REFERENCE_LOCALE;
  const location: DiningLocation = stripUndefined({ city: r.location.city, area: r.location.area, address: r.location.address });
  const ratingCount = r.ratingCountText?.replace(/^\((.*)\)$/, '$1').trim();

  if (r.menuDisabled) {
    warnings.push({ scope: 'restaurant', code: 'MENU_DISABLED', message: 'Deliveroo reports the menu as disabled' });
  }

  return stripUndefined({
    platform: 'deliveroo' as const,
    sourceKey,
    sourceKeyKind: identity.kind,
    platformRestaurantId: identity.kind === 'id' ? identity.value : undefined,
    slug: r.slug,
    name: { [locale]: r.name },
    url: { [locale]: r.url ?? result.sourceUrl },
    cuisines: isReference && r.cuisines.length ? [...r.cuisines] : undefined,
    location: isReference && Object.keys(location).length ? location : undefined,
    rating: r.rating,
    ratingCountText: ratingCount || undefined,
    currency,
    deliveryFee: r.deliveryFee,
    minimumOrder: r.minimumOrder,
    imageUrl: r.imageUrl,
  });
}

function mapModifiers(
  groups: DeliverooRawModifierGroup[],
  locale: DiningLocale,
  itemIndex: number,
  warnings: PlatformParseWarning[]
): MenuModifierGroup[] {
  const out: MenuModifierGroup[] = [];
  for (const g of groups) {
    const options: MenuModifierOption[] = g.options.map(o => stripUndefined({
      optionId: o.optionId,
      name: { [locale]: o.name },
      description: localized(locale, o.description),
      priceDelta: o.priceDelta,
      currency: o.currency,
      isAvailable: o.isAvailable,
    }));
    if (g.options.some(o => o.nestedModifierGroupIds.length)) {
      warnings.push({ scope: 'item', itemIndex, code: 'NESTED_MODIFIERS_IGNORED', field: 'modifiers', message: `Group ${g.groupId ?? g.name} has nested groups; only the first level is stored` });
    }
    const group: MenuModifierGroup = stripUndefined({
      groupId: g.groupId,
      name: { [locale]: g.name },
      required: g.minSelections !== undefined ? g.minSelections > 0 : undefined,
      minSelections: g.minSelections,
      // 0 has no defined meaning on Deliveroo; leave the maximum unknown rather than guess.
      maxSelections: g.maxSelections !== undefined && g.maxSelections >= 1 ? g.maxSelections : undefined,
      options,
    });
    const check = validateModifierGroup(group);
    if (!check.valid) {
      warnings.push({
        scope: 'item', itemIndex, code: 'INVALID_MODIFIER_GROUP', field: 'modifiers',
        message: `Modifier group ${g.groupId ?? g.name} dropped: ${check.issues.map(i => `${i.path} ${i.message}`).join('; ')}`,
      });
      continue;
    }
    out.push(group);
  }
  return out;
}

function itemClearFields(item: DeliverooRawMenuItem, fromNextData: boolean, hasCategory: boolean): DiningMenuItemClearableField[] {
  const clear: DiningMenuItemClearableField[] = [];
  if (item.description === undefined) clear.push('description');
  // The DOM fallback cannot see discounts, popularity or lazy-loaded images: absence there is not evidence.
  if (fromNextData) {
    if (item.originalPrice === undefined) clear.push('originalPrice');
    if (item.imageUrl === undefined) clear.push('imageUrl');
    if (item.isPopular === undefined) clear.push('isPopular');
    if (!hasCategory) clear.push('categoryId');
  }
  return clear;
}

export function mapDeliverooMenu(result: DeliverooParseResult): DiningMappedMenu {
  const warnings: PlatformParseWarning[] = [...result.warnings];
  const locale = result.locale;
  const restaurant = mapRestaurant(result, warnings);
  const identity = getDeliverooIdentityInputs(result);
  const fromNextData = result.dataSource === 'next-data';
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
  const reject = (item: DeliverooRawMenuItem, code: string, message: string) => {
    mapperRejected++;
    warnings.push({ scope: 'item', itemIndex: item.sourceIndex, code, message });
  };
  for (const index of identity.unresolvedItemIndexes) {
    reject(result.items[index], 'UNRESOLVED_IDENTITY', 'Item has no Deliveroo ID and no category position');
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
      isAvailable: item.isAvailable,
      isPopular: item.isPopular,
      modifiers: fromNextData ? mapModifiers(item.modifiers, locale, item.sourceIndex, warnings) : undefined,
      sourceUrl: { [locale]: restaurantUrl },
      clear: itemClearFields(item, fromNextData, categorySourceKey !== undefined),
    }));
  }

  // Completeness: may this mapping be used to mark unseen items inactive?
  const itemsSeen = result.stats.itemsSeen - result.stats.hiddenOptionItems;
  const itemsRejected = result.stats.itemsRejected + mapperRejected;
  const reasons: string[] = [];
  if (!fromNextData) reasons.push('DOM_FALLBACK');
  if (items.length === 0) reasons.push('NO_ITEMS');
  if (result.restaurant?.menuDisabled) reasons.push('MENU_DISABLED');
  if (itemsSeen > 0 && itemsRejected / itemsSeen > DELIVEROO_MAX_REJECTED_RATIO) reasons.push('TOO_MANY_REJECTED_ITEMS');
  if (categories.length < result.categories.length) reasons.push('CATEGORY_IDENTITY_MISSING');

  return {
    platform: 'deliveroo',
    locale,
    sourceUrl: result.sourceUrl,
    restaurant,
    categories,
    items,
    completeness: { complete: reasons.length === 0, reasons, itemsSeen, itemsMapped: items.length, itemsRejected },
    warnings,
  };
}

export type DeliverooMapper = DiningPlatformMapper<DeliverooParseResult>;

export const deliverooMapper: DeliverooMapper = {
  platform: 'deliveroo',
  map: mapDeliverooMenu,
};
