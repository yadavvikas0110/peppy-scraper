import * as cheerio from 'cheerio';
import { DINING_LOCALES, DiningLocale } from '../../dining.types';
import type { PlatformParseContext, PlatformParseWarning } from '../platform.types';
import {
  DELIVEROO_CATEGORY_SECTION_ID,
  DELIVEROO_HEADER_PATTERNS,
  DELIVEROO_HEADER_SEPARATOR,
  DELIVEROO_NEXT_DATA_PATHS,
  DELIVEROO_RATING,
  DELIVEROO_RATING_COUNT,
  DELIVEROO_SELECTORS as S,
} from './deliveroo.selectors';
import type {
  DeliverooParseResult,
  DeliverooRawCategory,
  DeliverooRawMenuItem,
  DeliverooRawModifierGroup,
  DeliverooRawModifierOption,
  DeliverooRawRestaurant,
} from './deliveroo.types';

/*
 * Pure Deliveroo menu-page parser: HTML in, raw DTOs + warnings out.
 * No network, no database, no globals; the same input always yields the same output.
 *
 * Source priority:
 *   1. script#__NEXT_DATA__ → props.initialState.menuPage.menu.metas.root (restaurant, categories,
 *      items, modifierGroups with Deliveroo IDs, prices in minor units, image URL templates)
 *   2. Rendered DOM (only if 1 is missing): category sections, item cards, inline background images.
 */

type Obj = Record<string, unknown>;
type CheerioRoot = cheerio.CheerioAPI;

const BIDI_CONTROLS = /[\u200E\u200F\u202A-\u202E\u2066-\u2069]/g;
const ARABIC_INDIC_DIGITS = /[\u0660-\u0669]/g;
const CURRENCY_CODE = /^[A-Z]{3}$/;
const MONEY_TEXT = /([A-Z]{3})\s*([0-9\u0660-\u0669][0-9\u0660-\u0669.,\u066B]*)|([0-9\u0660-\u0669][0-9\u0660-\u0669.,\u066B]*)\s*([A-Z]{3})/;
// ISO 4217 minor units for currencies Deliveroo operates in; everything else uses 2.
const MINOR_UNITS: Record<string, number> = { KWD: 3, BHD: 3, OMR: 3, JOD: 3 };

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

function idString(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'string' && value.trim() !== '' && !/\s/.test(value.trim())) return value.trim();
  return undefined;
}

function idList(value: unknown): string[] {
  return Array.isArray(value) ? value.map(idString).filter((v): v is string => v !== undefined) : [];
}

function parseNumberText(raw: string): number | undefined {
  const normalized = raw
    .replace(ARABIC_INDIC_DIGITS, d => String(d.charCodeAt(0) - 0x0660))
    .replace(/\u066B/g, '.')
    .replace(/,(?=\d{3}(\D|$))/g, '')
    .replace(',', '.');
  const value = Number(normalized);
  return Number.isFinite(value) ? value : undefined;
}

export function parseMoneyText(text: string): { amount: number; currency: string } | null {
  const match = MONEY_TEXT.exec(text.replace(BIDI_CONTROLS, ''));
  if (!match) return null;
  const currency = match[1] ?? match[4];
  const amount = parseNumberText(match[2] ?? match[3]);
  return amount === undefined || amount < 0 ? null : { amount, currency };
}

function moneyFromMinorUnits(value: unknown): { amount: number; currency: string } | null {
  if (!isObj(value)) return null;
  const { fractional, code } = value;
  if (typeof fractional !== 'number' || !Number.isInteger(fractional) || fractional < 0) return null;
  if (typeof code !== 'string' || !CURRENCY_CODE.test(code)) return null;
  const amount = fractional / Math.pow(10, MINOR_UNITS[code] ?? 2);
  return { amount, currency: code };
}

// "https://…/images/<uuid>/image.jpeg?width={w}&height={h}&…" → base URL + locale-neutral asset path.
export function normalizeDeliverooImageUrl(template: string): { imageUrl: string; imageAnchor?: string } | null {
  const base = template.split('?')[0];
  let parsed: URL;
  try {
    parsed = new URL(base);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
  const anchor = parsed.pathname.replace(/^\/+/, '');
  return { imageUrl: parsed.toString(), imageAnchor: anchor && !/\s/.test(anchor) ? anchor : undefined };
}

export function readInlineBackgroundImage(style: string | undefined): string | undefined {
  if (!style) return undefined;
  const match = /background-image\s*:\s*url\(\s*(['"]?)(.*?)\1\s*\)/i.exec(style);
  return match && match[2] ? match[2] : undefined;
}

function localeFromLang(lang: string | undefined): DiningLocale | undefined {
  const primary = lang?.toLowerCase().split('-')[0];
  return (DINING_LOCALES as readonly string[]).includes(primary ?? '') ? (primary as DiningLocale) : undefined;
}

function readAlternateUrls($: CheerioRoot): Partial<Record<DiningLocale, string>> {
  const out: Partial<Record<DiningLocale, string>> = {};
  $(S.restaurantAlternateUrl).each((_, el) => {
    const locale = localeFromLang($(el).attr('hreflang'));
    const href = $(el).attr('href');
    if (locale && href && !out[locale]) out[locale] = href;
  });
  return out;
}

function slugFromUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const segments = new URL(url).pathname.split('/').filter(Boolean);
    return segments.length ? idString(segments[segments.length - 1]) : undefined;
  } catch {
    return undefined;
  }
}

// ─── Header (cuisines, rating, minimum order, delivery fee) ──────────────────

interface HeaderFields {
  cuisines: string[];
  rating?: number;
  ratingText?: string;
  ratingCountText?: string;
  minimumOrder?: number;
  deliveryFee?: number;
  openingStatusText?: string;
}

function headerLineTexts(line: unknown): string[] {
  const spans = isObj(line) && Array.isArray(line.spans) ? line.spans : [];
  return spans
    .filter(s => isObj(s) && s.typeName === 'UISpanText')
    .map(s => cleanText((s as Obj).text))
    .filter((t): t is string => t !== undefined && t !== DELIVEROO_HEADER_SEPARATOR);
}

function parseHeader(header: unknown, locale: DiningLocale): HeaderFields {
  const out: HeaderFields = { cuisines: [] };
  const lines = getPath(header, ['headerTags', 'lines']);
  if (!Array.isArray(lines)) return out;
  const patterns = DELIVEROO_HEADER_PATTERNS[locale];

  for (const line of lines) {
    const texts = headerLineTexts(line);
    const isInfoLine = texts.some(t => DELIVEROO_RATING_COUNT.test(t) || parseMoneyText(t) !== null);
    if (!isInfoLine) {
      out.cuisines.push(...texts);
      continue;
    }
    texts.forEach((text, i) => {
      const countMatch = DELIVEROO_RATING_COUNT.exec(text);
      if (countMatch && i > 0 && out.rating === undefined) {
        const ratingMatch = DELIVEROO_RATING.exec(texts[i - 1]);
        const rating = ratingMatch ? parseNumberText(ratingMatch[1]) : undefined;
        if (rating !== undefined && rating >= 0 && rating <= 5) {
          out.rating = rating;
          out.ratingText = texts[i - 1];
          out.ratingCountText = text;
        }
        return;
      }
      const money = parseMoneyText(text);
      if (money && patterns.minimumOrder.test(text) && out.minimumOrder === undefined) out.minimumOrder = money.amount;
      else if (money && patterns.deliveryFee.test(text) && out.deliveryFee === undefined) out.deliveryFee = money.amount;
      else if (patterns.openingStatus.test(text) && out.openingStatusText === undefined) out.openingStatusText = text;
    });
  }
  return out;
}

// ─── __NEXT_DATA__ parsing ───────────────────────────────────────────────────

function readNextData($: CheerioRoot): { root: Obj; header: unknown } | null {
  const raw = $(S.nextData).first().text();
  if (!raw) return null;
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  const root = getPath(data, DELIVEROO_NEXT_DATA_PATHS.menuRoot);
  if (!isObj(root) || !Array.isArray(root.items)) return null;
  return { root, header: getPath(data, DELIVEROO_NEXT_DATA_PATHS.header) };
}

function parseModifierGroups(raw: unknown, warnings: PlatformParseWarning[]): Map<string, DeliverooRawModifierGroup> {
  const groups = new Map<string, DeliverooRawModifierGroup>();
  if (!Array.isArray(raw)) return groups;

  raw.forEach((g, groupIndex) => {
    const groupId = isObj(g) ? idString(g.id) : undefined;
    const name = isObj(g) ? cleanText(g.name) : undefined;
    if (!isObj(g) || !groupId || !name) {
      warnings.push({ scope: 'page', code: 'INVALID_MODIFIER_GROUP', field: 'modifierGroups', message: `Modifier group #${groupIndex} has no id or name` });
      return;
    }
    const options: DeliverooRawModifierOption[] = [];
    (Array.isArray(g.modifierOptions) ? g.modifierOptions : []).forEach((o, optionIndex) => {
      const optionName = isObj(o) ? cleanText(o.name) : undefined;
      if (!isObj(o) || !optionName) {
        warnings.push({ scope: 'page', code: 'INVALID_MODIFIER_OPTION', field: `modifierGroups.${groupId}`, message: `Option #${optionIndex} has no name` });
        return;
      }
      const price = moneyFromMinorUnits(o.price);
      options.push({
        optionId: idString(o.id),
        drnId: idString(o.drnId),
        name: optionName,
        description: cleanText(o.description),
        priceDelta: price?.amount,
        currency: price?.currency,
        isAvailable: typeof o.available === 'boolean' ? o.available : undefined,
        nestedModifierGroupIds: idList(o.modifierGroupIds),
      });
    });
    groups.set(groupId, {
      groupId,
      drnId: idString(g.drnId),
      name,
      minSelections: Number.isInteger(g.minSelection) ? (g.minSelection as number) : undefined,
      maxSelections: Number.isInteger(g.maxSelection) ? (g.maxSelection as number) : undefined,
      multiselect: typeof g.multiselect === 'boolean' ? g.multiselect : undefined,
      options,
    });
  });
  return groups;
}

function parseFromNextData(
  $: CheerioRoot,
  data: { root: Obj; header: unknown },
  ctx: PlatformParseContext,
  result: DeliverooParseResult
): void {
  const { root, header } = data;
  const warnings = result.warnings;

  // Restaurant
  const r = isObj(root.restaurant) ? root.restaurant : {};
  const address = getPath(r, ['location', 'address']);
  const headerFields = parseHeader(header, ctx.locale);
  const headerImage = cleanText(getPath(header, ['image', 'url']));
  const image = headerImage ? normalizeDeliverooImageUrl(headerImage) : null;
  const currency = typeof r.currencyCode === 'string' && CURRENCY_CODE.test(r.currencyCode) ? r.currencyCode : undefined;
  const canonical = $(S.restaurantUrl).attr('href');

  const restaurant: DeliverooRawRestaurant = {
    platformRestaurantId: idString(r.id),
    drnId: idString(r.drnId),
    slug: idString(r.uname),
    name: cleanText(r.name) ?? cleanText($(S.restaurantName).first().text()),
    url: canonical,
    sourceUrl: ctx.sourceUrl,
    alternateUrls: readAlternateUrls($),
    currency,
    ...headerFields,
    imageUrl: image?.imageUrl,
    imageUrlTemplate: headerImage,
    location: {
      address: cleanText(getPath(address, ['address1'])),
      area: cleanText(getPath(address, ['neighborhood'])),
      city: cleanText(getPath(address, ['city'])),
      country: cleanText(getPath(address, ['country'])),
      platformCityId: Number.isInteger(getPath(r, ['location', 'cityId'])) ? (getPath(r, ['location', 'cityId']) as number) : undefined,
      platformZoneId: Number.isInteger(getPath(r, ['location', 'zoneId'])) ? (getPath(r, ['location', 'zoneId']) as number) : undefined,
    },
    menuDisabled: typeof r.menuDisabled === 'boolean' ? r.menuDisabled : undefined,
  };
  if (!restaurant.platformRestaurantId) {
    warnings.push({ scope: 'restaurant', code: 'MISSING_RESTAURANT_ID', field: 'restaurant.id', message: 'Restaurant ID not found in __NEXT_DATA__' });
  }
  result.restaurant = restaurant;

  // Categories (array order = display order)
  const categoryIndexById = new Map<string, number>();
  (Array.isArray(root.categories) ? root.categories : []).forEach((c, i) => {
    const id = isObj(c) ? idString(c.id) : undefined;
    const name = isObj(c) ? cleanText(c.name) : undefined;
    if (!id || !name) {
      warnings.push({ scope: 'category', categoryIndex: i, code: 'INVALID_CATEGORY', field: !id ? 'id' : 'name', message: `Category #${i} has no ${!id ? 'id' : 'name'}` });
      return;
    }
    categoryIndexById.set(id, result.categories.length);
    result.categories.push({ platformCategoryId: id, name, sortOrder: result.categories.length });
  });

  // Modifier groups
  const groups = parseModifierGroups(root.modifierGroups, warnings);
  result.stats.modifierGroups = groups.size;
  const optionIds = new Set<string>();
  for (const g of groups.values()) for (const o of g.options) if (o.optionId) optionIds.add(o.optionId);

  // Items
  const rawItems = root.items as unknown[];
  const positions = new Map<number, number>();
  result.stats.itemsSeen = rawItems.length;

  rawItems.forEach((raw, sourceIndex) => {
    const reject = (field: string, code: string, message: string) => {
      result.stats.itemsRejected++;
      warnings.push({ scope: 'item', itemIndex: sourceIndex, field, code, message });
    };
    try {
      if (!isObj(raw)) return reject('item', 'INVALID_ITEM', 'Item is not an object');

      const platformItemId = idString(raw.id);
      const platformCategoryId = idString(raw.categoryId);
      const categoryIndex = platformCategoryId !== undefined ? categoryIndexById.get(platformCategoryId) : undefined;

      if (categoryIndex === undefined && platformItemId && optionIds.has(platformItemId)) {
        result.stats.hiddenOptionItems++;
        return;
      }

      const name = cleanText(raw.name);
      if (!name) return reject('name', 'MISSING_NAME', 'Item has no name');

      const listPrice = moneyFromMinorUnits(raw.price);
      if (!listPrice) return reject('price', 'INVALID_PRICE', 'Item price is missing or not a valid { fractional, code } amount');

      let price = listPrice.amount;
      let originalPrice: number | undefined;
      if (raw.priceDiscounted !== null && raw.priceDiscounted !== undefined) {
        const discounted = moneyFromMinorUnits(raw.priceDiscounted);
        if (!discounted || discounted.currency !== listPrice.currency) {
          warnings.push({ scope: 'item', itemIndex: sourceIndex, field: 'priceDiscounted', code: 'INVALID_DISCOUNT_PRICE', message: 'Discounted price ignored: invalid amount or currency' });
        } else if (discounted.amount < listPrice.amount) {
          price = discounted.amount;
          originalPrice = listPrice.amount;
        }
      }

      if (platformCategoryId && categoryIndex === undefined) {
        warnings.push({ scope: 'item', itemIndex: sourceIndex, field: 'categoryId', code: 'UNKNOWN_CATEGORY', message: `Item references unknown category ${platformCategoryId}` });
      }

      const imageTemplate = cleanText(getPath(raw, ['image', 'url']));
      const image = imageTemplate ? normalizeDeliverooImageUrl(imageTemplate) : null;

      const modifierGroupIds = idList(raw.modifierGroupIds);
      const modifiers: DeliverooRawModifierGroup[] = [];
      for (const groupId of modifierGroupIds) {
        const group = groups.get(groupId);
        if (group) modifiers.push(group);
        else warnings.push({ scope: 'item', itemIndex: sourceIndex, field: 'modifierGroupIds', code: 'MISSING_MODIFIER_GROUP', message: `Modifier group ${groupId} not found` });
      }

      let positionInCategory: number | undefined;
      if (categoryIndex !== undefined) {
        positionInCategory = positions.get(categoryIndex) ?? 0;
        positions.set(categoryIndex, positionInCategory + 1);
      }

      result.items.push({
        sourceIndex,
        platformItemId,
        drnId: idString(raw.drnId),
        categoryIndex,
        platformCategoryId,
        categoryName: categoryIndex !== undefined ? result.categories[categoryIndex].name : undefined,
        positionInCategory,
        name,
        description: cleanText(raw.description),
        price,
        originalPrice,
        currency: listPrice.currency,
        imageUrl: image?.imageUrl,
        imageUrlTemplate: imageTemplate,
        imageSource: image ? 'next-data' : undefined,
        imageAnchor: image?.imageAnchor,
        isAvailable: typeof raw.available === 'boolean' ? raw.available : undefined,
        isPopular: typeof raw.popular === 'boolean' ? raw.popular : undefined,
        modifierGroupIds,
        modifiers,
        sourceUrl: ctx.sourceUrl,
      });
    } catch (err) {
      reject('item', 'PARSE_ERROR', (err as Error).message);
    }
  });
}

// ─── DOM fallback ────────────────────────────────────────────────────────────

function cardTexts($: CheerioRoot, card: ReturnType<CheerioRoot>): string[] {
  const texts: string[] = [];
  card.find(S.itemText).each((_, el) => {
    const node = $(el);
    if (node.children().length > 0) return;
    if (node.closest(S.itemControls).length || node.closest(S.itemImageContainer).length) return;
    const text = cleanText(node.text());
    if (text && texts[texts.length - 1] !== text) texts.push(text);
  });
  return texts;
}

function parseFromDom($: CheerioRoot, ctx: PlatformParseContext, result: DeliverooParseResult): void {
  const warnings = result.warnings;
  const canonical = $(S.restaurantUrl).attr('href');
  const name = cleanText($(S.restaurantName).first().text());

  let sourceIndex = 0;
  $(S.categorySection).each((_, section) => {
    const idMatch = DELIVEROO_CATEGORY_SECTION_ID.exec($(section).attr('id') ?? '');
    if (!idMatch) return;
    const categoryName = cleanText($(section).find(S.categoryName).first().text());
    if (!categoryName) {
      warnings.push({ scope: 'category', categoryIndex: result.categories.length, code: 'INVALID_CATEGORY', field: 'name', message: `Section ${idMatch[1]} has no heading` });
      return;
    }
    const categoryIndex = result.categories.length;
    // Section ids are "layout-<category id>"; the number equals the Deliveroo category ID in __NEXT_DATA__.
    result.categories.push({ platformCategoryId: idMatch[1], name: categoryName, sortOrder: categoryIndex });

    let position = 0;
    $(section).find(S.menuItem).each((__, overlay) => {
      const card = $(overlay).parent();
      const index = sourceIndex++;
      result.stats.itemsSeen++;
      const texts = cardTexts($, card);
      const priceIndex = texts.map(t => parseMoneyText(t)).findIndex(Boolean);
      const itemName = texts[0];
      if (!itemName || priceIndex <= 0) {
        result.stats.itemsRejected++;
        warnings.push({
          scope: 'item', itemIndex: index, field: !itemName ? 'name' : 'price',
          code: !itemName ? 'MISSING_NAME' : 'INVALID_PRICE', message: 'Item card has no parsable name/price',
        });
        return;
      }
      const money = parseMoneyText(texts[priceIndex])!;
      const description = texts.slice(1, priceIndex).join(' ') || undefined;
      const inline = readInlineBackgroundImage(card.find(S.itemImage).first().attr('style'));
      const image = inline ? normalizeDeliverooImageUrl(inline) : null;

      result.items.push({
        sourceIndex: index,
        categoryIndex,
        platformCategoryId: idMatch[1],
        categoryName,
        positionInCategory: position++,
        name: itemName,
        description,
        price: money.amount,
        currency: money.currency,
        imageUrl: image?.imageUrl,
        imageUrlTemplate: inline,
        imageSource: image ? 'inline-style' : undefined,
        imageAnchor: image?.imageAnchor,
        modifierGroupIds: [],
        modifiers: [],
        sourceUrl: ctx.sourceUrl,
      });
    });
  });

  const currencies = new Set(result.items.map(i => i.currency));
  result.restaurant = {
    name,
    slug: slugFromUrl(canonical),
    url: canonical,
    sourceUrl: ctx.sourceUrl,
    alternateUrls: readAlternateUrls($),
    currency: currencies.size === 1 ? [...currencies][0] : undefined,
    cuisines: [],
    location: {},
  };
}

// ─── Entry point ─────────────────────────────────────────────────────────────

export function parseDeliverooMenu(html: string, ctx: PlatformParseContext): DeliverooParseResult {
  if (!(DINING_LOCALES as readonly string[]).includes(ctx.locale)) {
    throw new Error(`Unsupported locale: ${String(ctx.locale)}`);
  }

  const result: DeliverooParseResult = {
    platform: 'deliveroo',
    locale: ctx.locale,
    sourceUrl: ctx.sourceUrl,
    dataSource: 'next-data',
    restaurant: null,
    categories: [],
    items: [],
    warnings: [],
    stats: { itemsSeen: 0, itemsParsed: 0, itemsRejected: 0, hiddenOptionItems: 0, modifierGroups: 0 },
  };

  const $ = cheerio.load(typeof html === 'string' ? html : '');
  result.detectedLocale = localeFromLang($(S.htmlRoot).attr('lang'));
  if (result.detectedLocale && result.detectedLocale !== ctx.locale) {
    result.warnings.push({
      scope: 'page', code: 'LOCALE_MISMATCH', field: 'html[lang]',
      message: `Page language is "${result.detectedLocale}" but "${ctx.locale}" was requested`,
    });
  }

  const nextData = readNextData($);
  if (nextData) {
    parseFromNextData($, nextData, ctx, result);
  } else {
    result.dataSource = 'dom';
    result.warnings.push({ scope: 'page', code: 'NEXT_DATA_UNAVAILABLE', message: '__NEXT_DATA__ menu payload missing; parsed rendered DOM instead (no item IDs or modifiers)' });
    parseFromDom($, ctx, result);
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
