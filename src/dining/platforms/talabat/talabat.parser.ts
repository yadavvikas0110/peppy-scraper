import * as cheerio from 'cheerio';
import { DINING_LOCALES, DiningLocale } from '../../dining.types';
import type { PlatformParseContext, PlatformParseWarning } from '../platform.types';
import { isSyntheticTalabatCategoryId, TALABAT_NEXT_DATA_PATHS, TALABAT_SELECTORS as S } from './talabat.selectors';
import type {
  TalabatParseResult,
  TalabatRawCategory,
  TalabatRawLocation,
  TalabatRawMenuItem,
  TalabatRawRestaurant,
} from './talabat.types';

/*
 * Pure Talabat menu-page parser: HTML in, raw DTOs + warnings out.
 * No network, no database, no globals; the same input always yields the same output.
 *
 * Source: script#__NEXT_DATA__ → props.pageProps.initialMenuState
 *   restaurant  branch/brand IDs, names, cuisines, rating, coordinates, images
 *   area        delivery area + city (localized)
 *   currentCountry.currencyISO
 *   menuData.categories[]  sections in display order, each with its items
 *     (prices in major units, oldPrice -1 = no discount, originalImage, hasChoices)
 * menuData.items is the same entries flattened; sections are used because they carry the
 * category membership (items[].sectionName is only filled on a section's first item).
 *
 * Without that payload no menu is produced (dataSource "none"): Talabat item cards carry no IDs,
 * and selectors that were never verified are not guessed.
 */

type Obj = Record<string, unknown>;
type CheerioRoot = cheerio.CheerioAPI;

const BIDI_CONTROLS = /[\u200E\u200F\u202A-\u202E\u2066-\u2069]/g;
const ARABIC_INDIC_DIGITS = /[\u0660-\u0669]/g;
const CURRENCY_CODE = /^[A-Z]{3}$/;

// ─── Small pure helpers ──────────────────────────────────────────────────────

function isObj(value: unknown): value is Obj {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getPath(root: unknown, path: readonly string[]): unknown {
  let current: unknown = root;
  for (const key of path) {
    if (!isObj(current)) return undefined;
    current = current[key];
  }
  return current;
}

function cleanText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.replace(BIDI_CONTROLS, '').replace(/\s+/g, ' ').trim();
  return text === '' ? undefined : text;
}

// Talabat IDs are positive integers; 0 and negative values mark synthetic/absent entries.
function idString(value: unknown): string | undefined {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value > 0 ? String(value) : undefined;
  if (typeof value === 'string' && /^[1-9]\d{0,18}$/.test(value.trim())) return value.trim();
  return undefined;
}

function rawIdString(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'string' && value.trim() !== '' && !/\s/.test(value.trim())) return value.trim();
  return undefined;
}

// Accepts numbers and numeric strings, including Arabic-Indic digits and the Arabic decimal separator.
export function parseTalabatNumber(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value !== 'string') return undefined;
  const normalized = value
    .replace(BIDI_CONTROLS, '')
    .trim()
    .replace(ARABIC_INDIC_DIGITS, d => String(d.charCodeAt(0) - 0x0660))
    .replace(/\u066B/g, '.')
    .replace(/\u066C/g, '');
  if (!/^-?\d+(\.\d+)?$/.test(normalized)) return undefined;
  const n = Number(normalized);
  return Number.isFinite(n) ? n : undefined;
}

// Talabat image URLs carry resize params (`?width=172&amp;height=172`, with a literal "&amp;").
// The stored URL is the original asset without the query string.
export function normalizeTalabatImageUrl(raw: unknown): string | undefined {
  const text = cleanText(raw);
  if (!text) return undefined;
  const base = text.replace(/&amp;/g, '&').split('?')[0];
  let parsed: URL;
  try {
    parsed = new URL(base);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return undefined;
  if (parsed.pathname === '/' || /\s/.test(parsed.pathname)) return undefined;
  return parsed.toString();
}

function localeFromLang(lang: string | undefined): DiningLocale | undefined {
  const primary = lang?.toLowerCase().split('-')[0];
  return (DINING_LOCALES as readonly string[]).includes(primary ?? '') ? (primary as DiningLocale) : undefined;
}

function readAlternateUrls($: CheerioRoot): Partial<Record<DiningLocale, string>> {
  const out: Partial<Record<DiningLocale, string>> = {};
  $(S.alternateUrl).each((_, el) => {
    const locale = localeFromLang($(el).attr('hreflang'));
    const href = $(el).attr('href');
    if (locale && href && !out[locale]) out[locale] = href;
  });
  return out;
}

// /[ar/]<country>/restaurant/<branchId>/<branchSlug>
export function readTalabatUrlIdentity(url: string | undefined): { branchId?: string; slug?: string } {
  if (!url) return {};
  try {
    const segments = new URL(url, 'https://www.talabat.com').pathname.split('/').filter(Boolean);
    const at = segments.indexOf('restaurant');
    if (at < 0) return {};
    return { branchId: idString(segments[at + 1]), slug: rawIdString(segments[at + 2]) };
  } catch {
    return {};
  }
}

function readJsonLdRestaurant($: CheerioRoot): Obj | undefined {
  let found: Obj | undefined;
  $(S.jsonLd).each((_, el) => {
    if (found) return;
    try {
      const data: unknown = JSON.parse($(el).text());
      if (isObj(data) && data['@type'] === 'Restaurant') found = data;
    } catch {
      // Malformed JSON-LD is ignored; it is only used when the menu payload is missing.
    }
  });
  return found;
}

function coordinate(value: unknown, limit: number): number | undefined {
  const n = parseTalabatNumber(value);
  return n !== undefined && Math.abs(n) <= limit && n !== 0 ? n : undefined;
}

// ─── __NEXT_DATA__ parsing ───────────────────────────────────────────────────

function readMenuState($: CheerioRoot): { state: Obj; query: Obj } | null {
  const raw = $(S.nextData).first().text();
  if (!raw) return null;
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  const state = getPath(data, TALABAT_NEXT_DATA_PATHS.menuState);
  if (!isObj(state) || !isObj(state.menuData) || !Array.isArray(state.menuData.categories)) return null;
  const query = getPath(data, TALABAT_NEXT_DATA_PATHS.query);
  return { state, query: isObj(query) ? query : {} };
}

function parseRestaurant(
  $: CheerioRoot,
  state: Obj,
  query: Obj,
  ctx: PlatformParseContext,
  warnings: PlatformParseWarning[]
): TalabatRawRestaurant {
  const r = isObj(state.restaurant) ? state.restaurant : {};
  const area = isObj(state.area) ? state.area : {};
  const canonical = $(S.canonicalUrl).attr('href');
  const fromUrl = readTalabatUrlIdentity(canonical ?? ctx.sourceUrl);

  const branchId = idString(r.branchId);
  const queryBranchId = idString(query.branchId);
  if (!branchId) {
    warnings.push({ scope: 'restaurant', code: 'MISSING_RESTAURANT_ID', field: 'restaurant.branchId', message: 'Branch ID not found in the menu payload' });
  } else if ((queryBranchId && queryBranchId !== branchId) || (fromUrl.branchId && fromUrl.branchId !== branchId)) {
    warnings.push({
      scope: 'restaurant', code: 'RESTAURANT_ID_MISMATCH', field: 'restaurant.branchId',
      message: `Payload branch ${branchId} differs from the page URL branch ${queryBranchId ?? fromUrl.branchId}`,
    });
  }

  const countryCurrency = getPath(state, ['currentCountry', 'currencyISO']) ?? getPath(state, ['currentCountry', 'currency']);
  const currency = typeof countryCurrency === 'string' && CURRENCY_CODE.test(countryCurrency) ? countryCurrency : undefined;
  if (!currency) {
    warnings.push({ scope: 'restaurant', code: 'MISSING_CURRENCY', field: 'currentCountry.currencyISO', message: 'Menu currency not found' });
  }

  const cuisineObjects = Array.isArray(r.cuisines) ? r.cuisines.filter(isObj) : [];
  const cuisines = cuisineObjects.length
    ? cuisineObjects.map(c => cleanText(c.name)).filter((n): n is string => n !== undefined)
    : (cleanText(r.cuisineString)?.split(/\s*[,،]\s*/).filter(Boolean) ?? []);
  const cuisineIds = cuisineObjects.map(c => idString(c.id)).filter((id): id is string => id !== undefined);

  const rating = parseTalabatNumber(r.rate);
  const ratingCount = parseTalabatNumber(r.totalRatings);
  const location: TalabatRawLocation = {
    area: cleanText(area.name) ?? cleanText(r.areaName),
    city: cleanText(area.cityName),
    platformAreaId: Number.isSafeInteger(area.id) ? (area.id as number) : undefined,
    platformCityId: Number.isSafeInteger(area.cityId) ? (area.cityId as number) : undefined,
    lat: coordinate(r.latitude, 90),
    lng: coordinate(r.longitude, 180),
  };
  if ((location.lat === undefined) !== (location.lng === undefined)) {
    location.lat = undefined;
    location.lng = undefined;
    warnings.push({ scope: 'restaurant', code: 'INVALID_COORDINATES', field: 'restaurant.latitude', message: 'Branch coordinates are incomplete' });
  }

  return {
    platformRestaurantId: branchId ?? queryBranchId,
    platformBrandId: idString(r.restaurantId) ?? idString(r.id),
    slug: rawIdString(query.branchSlug) ?? fromUrl.slug,
    brandSlug: rawIdString(r.restaurantSlug),
    name: cleanText(r.branchName) ?? cleanText(r.name),
    brandName: cleanText(r.name),
    url: canonical,
    sourceUrl: ctx.sourceUrl,
    alternateUrls: readAlternateUrls($),
    currency,
    cuisines,
    cuisineIds,
    rating: rating !== undefined && rating > 0 && rating <= 5 ? rating : undefined,
    ratingCount: ratingCount !== undefined && Number.isInteger(ratingCount) && ratingCount > 0 ? ratingCount : undefined,
    deliveryFeeRaw: cleanText(typeof r.deliveryFee === 'number' ? String(r.deliveryFee) : r.deliveryFee),
    minimumOrderRaw: typeof r.minimumOrderAmount === 'number' ? r.minimumOrderAmount : undefined,
    deliveryTimeRaw: cleanText(r.avgDeliveryTime),
    imageUrl: normalizeTalabatImageUrl(r.heroImage),
    logoUrl: normalizeTalabatImageUrl(r.logo),
    location,
  };
}

function parseItem(
  raw: Obj,
  ctx: { sourceIndex: number; currency: string | undefined; sourceUrl: string },
  warnings: PlatformParseWarning[]
): TalabatRawMenuItem | { reject: { field: string; code: string; message: string } } {
  const name = cleanText(raw.name);
  if (!name) return { reject: { field: 'name', code: 'MISSING_NAME', message: 'Item has no name' } };

  const price = parseTalabatNumber(raw.price);
  if (price === undefined || price < 0) {
    return { reject: { field: 'price', code: 'INVALID_PRICE', message: 'Item price is missing or not a non-negative number' } };
  }
  if (!ctx.currency) {
    return { reject: { field: 'price', code: 'INVALID_PRICE', message: 'Item price has no known currency' } };
  }

  let originalPrice: number | undefined;
  if (raw.oldPrice !== undefined && raw.oldPrice !== null) {
    const old = parseTalabatNumber(raw.oldPrice);
    if (old === undefined) {
      warnings.push({ scope: 'item', itemIndex: ctx.sourceIndex, field: 'oldPrice', code: 'INVALID_ORIGINAL_PRICE', message: 'Old price ignored: not a number' });
    } else if (old > price) {
      originalPrice = old;
    }
  }

  const hasImage = typeof raw.isWithImage === 'boolean' ? raw.isWithImage : undefined;
  let imageUrl: string | undefined;
  if (hasImage !== false) {
    imageUrl = normalizeTalabatImageUrl(raw.originalImage) ?? normalizeTalabatImageUrl(raw.image);
    if (!imageUrl && (cleanText(raw.originalImage) || cleanText(raw.image))) {
      warnings.push({ scope: 'item', itemIndex: ctx.sourceIndex, field: 'image', code: 'INVALID_IMAGE_URL', message: 'Item image URL is not a valid http(s) URL' });
    }
  }

  return {
    sourceIndex: ctx.sourceIndex,
    platformItemId: idString(raw.id),
    name,
    description: cleanText(raw.description),
    price,
    originalPrice,
    currency: ctx.currency,
    imageUrl,
    hasImage,
    hasModifiers: typeof raw.hasChoices === 'boolean' ? raw.hasChoices : undefined,
    isTopRated: typeof raw.isTopRatedItem === 'boolean' ? raw.isTopRatedItem : undefined,
    sourceUrl: ctx.sourceUrl,
  };
}

function parseFromMenuState($: CheerioRoot, data: { state: Obj; query: Obj }, ctx: PlatformParseContext, result: TalabatParseResult): void {
  const { state, query } = data;
  const warnings = result.warnings;
  const restaurant = parseRestaurant($, state, query, ctx, warnings);
  result.restaurant = restaurant;

  const menuData = state.menuData as Obj;
  const sections = menuData.categories as unknown[];
  const recommendedIds = new Set<string>();
  const seenItemIds = new Map<string, number>();
  let sourceIndex = 0;

  sections.forEach((section, sectionIndex) => {
    if (!isObj(section)) {
      warnings.push({ scope: 'category', code: 'INVALID_CATEGORY', message: `Section #${sectionIndex} is not an object` });
      return;
    }
    const rawId = rawIdString(section.id);
    const entries = Array.isArray(section.items) ? section.items : [];

    if (rawId !== undefined && isSyntheticTalabatCategoryId(rawId)) {
      result.stats.syntheticSectionEntries += entries.length;
      for (const e of entries) {
        const id = isObj(e) ? idString(e.id) : undefined;
        if (id) recommendedIds.add(id);
      }
      return;
    }

    const categoryName = cleanText(section.name);
    const platformCategoryId = idString(section.id);
    let categoryIndex: number | undefined;
    if (!categoryName) {
      warnings.push({ scope: 'category', code: 'INVALID_CATEGORY', field: 'name', message: `Section #${sectionIndex} has no name; its items are kept without a category` });
    } else {
      if (!platformCategoryId) {
        warnings.push({ scope: 'category', categoryIndex: result.categories.length, code: 'MISSING_CATEGORY_ID', field: 'id', message: `Section "${categoryName}" has no Talabat ID` });
      }
      categoryIndex = result.categories.length;
      const category: TalabatRawCategory = { platformCategoryId, name: categoryName, sortOrder: categoryIndex };
      result.categories.push(category);
    }

    let position = 0;
    for (const entry of entries) {
      const index = sourceIndex++;
      result.stats.itemsSeen++;
      const reject = (field: string, code: string, message: string) => {
        result.stats.itemsRejected++;
        warnings.push({ scope: 'item', itemIndex: index, field, code, message });
      };
      try {
        if (!isObj(entry)) {
          reject('item', 'INVALID_ITEM', 'Item is not an object');
          continue;
        }
        const id = idString(entry.id);
        if (id && seenItemIds.has(id)) {
          result.stats.duplicateItemEntries++;
          warnings.push({ scope: 'item', itemIndex: index, field: 'id', code: 'DUPLICATE_ITEM_ID', message: `Item ${id} is listed in more than one section; the first is kept` });
          continue;
        }
        if (!id && entry.id !== undefined && entry.id !== null) {
          warnings.push({ scope: 'item', itemIndex: index, field: 'id', code: 'INVALID_ITEM_ID', message: 'Item ID is not a positive integer; falling back to its position' });
        }
        const sectionId = idString(entry.sectionId);
        if (sectionId && platformCategoryId && sectionId !== platformCategoryId) {
          warnings.push({ scope: 'item', itemIndex: index, field: 'sectionId', code: 'SECTION_MISMATCH', message: `Item sectionId ${sectionId} differs from its section ${platformCategoryId}` });
        }

        const parsed = parseItem(entry, { sourceIndex: index, currency: restaurant.currency, sourceUrl: ctx.sourceUrl }, warnings);
        if ('reject' in parsed) {
          reject(parsed.reject.field, parsed.reject.code, parsed.reject.message);
          continue;
        }
        if (id) seenItemIds.set(id, index);
        if (categoryIndex !== undefined) {
          parsed.categoryIndex = categoryIndex;
          parsed.platformCategoryId = platformCategoryId;
          parsed.categoryName = categoryName;
          parsed.positionInCategory = position++;
        }
        if (parsed.hasModifiers) result.stats.itemsWithModifiers++;
        result.items.push(parsed);
      } catch (err) {
        reject('item', 'PARSE_ERROR', (err as Error).message);
      }
    }
  });

  for (const item of result.items) {
    if (item.platformItemId && recommendedIds.has(item.platformItemId)) item.isRecommended = true;
  }

  // Flat list sanity check: every listed item should belong to a parsed section.
  const flat = Array.isArray(menuData.items) ? menuData.items : [];
  const outside = new Set<string>();
  for (const e of flat) {
    const id = isObj(e) ? idString(e.id) : undefined;
    if (id && !seenItemIds.has(id) && !recommendedIds.has(id)) outside.add(id);
  }
  if (outside.size) {
    warnings.push({ scope: 'page', code: 'ITEMS_OUTSIDE_SECTIONS', field: 'menuData.items', message: `${outside.size} listed item(s) are not in any menu section and were not parsed` });
  }
}

// Page metadata only (canonical URL + JSON-LD). Produces no categories or items.
function parseWithoutMenu($: CheerioRoot, ctx: PlatformParseContext, result: TalabatParseResult): void {
  const canonical = $(S.canonicalUrl).attr('href');
  const fromUrl = readTalabatUrlIdentity(canonical);
  const ld = readJsonLdRestaurant($);
  result.restaurant = {
    platformRestaurantId: fromUrl.branchId,
    slug: fromUrl.slug,
    name: cleanText(ld?.name),
    url: canonical,
    sourceUrl: ctx.sourceUrl,
    alternateUrls: readAlternateUrls($),
    cuisines: [],
    cuisineIds: [],
    location: {
      lat: coordinate(getPath(ld, ['geo', 'latitude']), 90),
      lng: coordinate(getPath(ld, ['geo', 'longitude']), 180),
    },
  };
}

// ─── Entry point ─────────────────────────────────────────────────────────────

export function parseTalabatMenu(html: string, ctx: PlatformParseContext): TalabatParseResult {
  if (!(DINING_LOCALES as readonly string[]).includes(ctx.locale)) {
    throw new Error(`Unsupported locale: ${String(ctx.locale)}`);
  }

  const result: TalabatParseResult = {
    platform: 'talabat',
    locale: ctx.locale,
    sourceUrl: ctx.sourceUrl,
    dataSource: 'next-data',
    restaurant: null,
    categories: [],
    items: [],
    warnings: [],
    stats: { itemsSeen: 0, itemsParsed: 0, itemsRejected: 0, syntheticSectionEntries: 0, duplicateItemEntries: 0, itemsWithModifiers: 0 },
  };

  const $ = cheerio.load(typeof html === 'string' ? html : '');
  result.detectedLocale = localeFromLang($(S.htmlRoot).attr('lang'));
  if (result.detectedLocale && result.detectedLocale !== ctx.locale) {
    result.warnings.push({
      scope: 'page', code: 'LOCALE_MISMATCH', field: 'html[lang]',
      message: `Page language is "${result.detectedLocale}" but "${ctx.locale}" was requested`,
    });
  }

  const menuState = readMenuState($);
  if (menuState) {
    parseFromMenuState($, menuState, ctx, result);
  } else {
    result.dataSource = 'none';
    result.warnings.push({ scope: 'page', code: 'NEXT_DATA_UNAVAILABLE', message: '__NEXT_DATA__ menu payload missing or unusable; no menu items can be extracted' });
    parseWithoutMenu($, ctx, result);
  }

  if (!result.restaurant?.name) {
    result.warnings.push({ scope: 'restaurant', code: 'MISSING_RESTAURANT_NAME', field: 'name', message: 'Restaurant name not found' });
  }
  if (result.items.length === 0) {
    result.warnings.push({ scope: 'page', code: 'NO_ITEMS', message: 'No menu items were parsed' });
  }
  result.stats.itemsParsed = result.items.length;
  return result;
}
