/// <reference types="node" />
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  buildCategorySourceKey,
  buildMenuItemSourceKey,
  buildRestaurantSourceKey,
  checkIdentityToken,
} from '../../src/dining/dining.source-key';
import type { DiningLocale } from '../../src/dining/dining.types';
import { getDeliverooIdentityInputs, getDeliverooItemDetail } from '../../src/dining/platforms/deliveroo/deliveroo.adapter';
import {
  normalizeDeliverooImageUrl,
  parseDeliverooMenu,
  parseMoneyText,
  readInlineBackgroundImage,
} from '../../src/dining/platforms/deliveroo/deliveroo.parser';
import type { DeliverooParseResult } from '../../src/dining/platforms/deliveroo/deliveroo.types';
import type { PlatformIdentityInputs } from '../../src/dining/platforms/platform.types';
import { parseTalabatMenu } from '../../src/dining/platforms/talabat/talabat.parser';
import { distanceMeters } from '../../src/dining/identity/identity.signals';
import { GOLDEN_MILE_URL, goldenMileFixtureHtml, withNextData } from './helpers';

// All tests use the saved fixtures (captured once with Scrape.do). No network access.

const FIXTURES = join(__dirname, 'fixtures');
const HTML: Record<DiningLocale, string> = {
  en: readFileSync(join(FIXTURES, 'deliveroo-en.html'), 'utf8'),
  ar: readFileSync(join(FIXTURES, 'deliveroo-ar.html'), 'utf8'),
};
const URLS: Record<DiningLocale, string> = {
  en: 'https://deliveroo.ae/en/menu/Dubai/dubai-business-bay/kamat-dt/',
  ar: 'https://deliveroo.ae/ar/menu/Dubai/dubai-business-bay/kamat-dt/',
};
const NEXT_DATA_RE = /(<script id="__NEXT_DATA__"[^>]*>)([\s\S]*?)(<\/script>)/;

function parse(locale: DiningLocale, html = HTML[locale]): DeliverooParseResult {
  return parseDeliverooMenu(html, { locale, sourceUrl: URLS[locale] });
}

function withoutNextData(html: string): string {
  return html.replace(NEXT_DATA_RE, '');
}

// Mutates a copy of the real fixture payload (to exercise malformed/missing-field paths).
function withMenuRoot(html: string, mutate: (root: any) => void): string {
  return html.replace(NEXT_DATA_RE, (_m, open, json, close) => {
    const data = JSON.parse(json);
    mutate(data.props.initialState.menuPage.menu.metas.root);
    return `${open}${JSON.stringify(data).replace(/</g, '\\u003c')}${close}`;
  });
}

function rawItem(root: any, id: string): any {
  return root.items.find((i: any) => String(i.id) === id);
}

function rawIndex(root: any, id: string): number {
  return root.items.findIndex((i: any) => String(i.id) === id);
}

function keysFor(inputs: PlatformIdentityInputs): { restaurant: string; categories: string[]; items: string[] } {
  const restaurant = buildRestaurantSourceKey('deliveroo', inputs.restaurant!);
  const categories = inputs.categories.map(c => buildCategorySourceKey(restaurant, c.identity));
  const items = inputs.items.map(i =>
    buildMenuItemSourceKey(restaurant, i.identity, i.categoryIndex !== undefined ? categories[i.categoryIndex] : undefined)
  );
  return { restaurant, categories, items };
}

const EN = parse('en');
const AR = parse('ar');
const THALI = '1560778015';
const STUFFED_NAN = '1560778003';
const COCA_COLA = '1560784058';

describe('Deliveroo parser — English fixture', () => {
  test('uses __NEXT_DATA__ and parses without warnings', () => {
    assert.equal(EN.platform, 'deliveroo');
    assert.equal(EN.locale, 'en');
    assert.equal(EN.detectedLocale, 'en');
    assert.equal(EN.dataSource, 'next-data');
    assert.deepEqual(EN.warnings, []);
    assert.deepEqual(EN.stats, { itemsSeen: 460, itemsParsed: 332, itemsRejected: 0, hiddenOptionItems: 128, modifierGroups: 38 });
  });

  test('restaurant extraction', () => {
    const r = EN.restaurant!;
    assert.equal(r.platformRestaurantId, '76728');
    assert.equal(r.slug, 'kamat-dt');
    assert.equal(r.name, 'Kamat Vegetarian - Business Bay');
    assert.equal(r.currency, 'AED');
    assert.deepEqual(r.cuisines, ['Vegetarian', 'Indian', 'South Indian']);
    assert.equal(r.rating, 4.8);
    assert.equal(r.ratingCountText, '(500+)');
    assert.equal(r.minimumOrder, 20);
    assert.equal(r.deliveryFee, 4.95);
    assert.equal(r.openingStatusText, 'Closes at 23:00');
    assert.equal(r.menuDisabled, false);
    assert.equal(r.location.area, 'Dubai Business Bay');
    assert.equal(r.location.city, 'dubai');
    assert.equal(r.location.country, 'AE');
    assert.match(r.imageUrl!, /^https:\/\/rs-menus-api\.roocdn\.com\/images\/[0-9a-f-]+\/image\.jpeg$/);
  });

  test('restaurant URL: canonical page URL, source URL and both locale alternates', () => {
    const r = EN.restaurant!;
    assert.equal(r.url, 'https://deliveroo.ae/en/menu/Dubai/dubai-business-bay/kamat-dt/');
    assert.equal(r.sourceUrl, URLS.en);
    assert.match(r.alternateUrls.en!, /^https:\/\/deliveroo\.ae\/en\/menu\/Dubai\/dubai-business-bay\/kamat-dt\//);
    assert.match(r.alternateUrls.ar!, /^https:\/\/deliveroo\.ae\/ar\/menu\/Dubai\/dubai-business-bay\/kamat-dt\//);
  });

  test('multiple categories in display order with Deliveroo category IDs', () => {
    assert.equal(EN.categories.length, 28);
    assert.deepEqual(EN.categories[0], { platformCategoryId: '967617571', name: 'Thali', sortOrder: 0 });
    assert.deepEqual(EN.categories[27], { platformCategoryId: '274148245', name: 'Stimulators', sortOrder: 27 });
    EN.categories.forEach((c, i) => assert.equal(c.sortOrder, i));
    assert.equal(new Set(EN.categories.map(c => c.platformCategoryId)).size, 28);
  });

  test('multiple items: every visible item is in a known category, positions are contiguous', () => {
    assert.equal(EN.items.length, 332);
    const perCategory = new Map<number, number[]>();
    for (const item of EN.items) {
      assert.ok(item.categoryIndex !== undefined);
      assert.equal(item.categoryName, EN.categories[item.categoryIndex!].name);
      perCategory.set(item.categoryIndex!, [...(perCategory.get(item.categoryIndex!) ?? []), item.positionInCategory!]);
    }
    assert.equal(perCategory.size, 28);
    for (const positions of perCategory.values()) assert.deepEqual(positions, positions.map((_, i) => i));
  });

  test('item name, description, price, currency, image, availability', () => {
    const thali = EN.items.find(i => i.platformItemId === THALI)!;
    assert.equal(thali.name, 'Thali');
    assert.match(thali.description!, /^Dry Veg\. South Indian, Curry Veg\. South Indian/);
    assert.equal(thali.price, 35);
    assert.equal(thali.originalPrice, undefined);
    assert.equal(thali.currency, 'AED');
    assert.equal(thali.platformCategoryId, '967617571');
    assert.equal(thali.imageSource, 'next-data');
    assert.equal(thali.imageUrl, 'https://rs-menus-api.roocdn.com/images/7f753dc1-9afd-4d3b-94fb-584a79a6d65c/image.jpeg');
    assert.match(thali.imageUrlTemplate!, /\?width=\{w\}&height=\{h\}/);
    assert.equal(thali.imageAnchor, 'images/7f753dc1-9afd-4d3b-94fb-584a79a6d65c/image.jpeg');
    assert.equal(thali.isAvailable, true);
    assert.equal(thali.isPopular, false);
    assert.equal(thali.sourceUrl, URLS.en);
  });

  test('all prices are positive major units; all items have AED currency and an image', () => {
    for (const item of EN.items) {
      assert.ok(item.price > 0 && Number.isFinite(item.price), item.name);
      assert.equal(item.currency, 'AED');
      assert.ok(item.imageUrl, item.name);
    }
  });

  test('popular flag', () => {
    const popular = EN.items.filter(i => i.isPopular).map(i => i.name).sort();
    assert.deepEqual(popular, ['Aloo Gobi Methi', 'Dal Khichdi', 'Dal Makhani', 'Dal Tadka', 'Vegetable Biryani']);
  });

  test('missing optional field: description absent on the source stays undefined', () => {
    const coke = EN.items.find(i => i.platformItemId === COCA_COLA)!;
    assert.equal(coke.name, 'Coca Cola');
    assert.equal(coke.price, 5);
    assert.equal(coke.description, undefined);
    assert.equal(EN.items.filter(i => i.description === undefined).length, 10);
  });

  test('hidden modifier-option items are excluded from the menu', () => {
    const optionIds = new Set(EN.items.flatMap(i => i.modifiers).flatMap(g => g.options).map(o => o.optionId));
    assert.ok(EN.items.every(i => !optionIds.has(i.platformItemId) || i.categoryIndex !== undefined));
    assert.equal(EN.items.find(i => i.name === 'Potato'), undefined);
  });
});

describe('Deliveroo parser — Arabic fixture', () => {
  test('Arabic extraction: same structure, Arabic display names', () => {
    assert.equal(AR.detectedLocale, 'ar');
    assert.equal(AR.dataSource, 'next-data');
    assert.deepEqual(AR.warnings, []);
    assert.deepEqual(AR.stats, EN.stats);
    assert.equal(AR.categories.length, 28);
    assert.equal(AR.categories[0].name, 'ثالي');
    assert.equal(AR.categories[27].name, 'المنبهات');

    const nan = AR.items.find(i => i.platformItemId === STUFFED_NAN)!;
    assert.equal(nan.name, 'محشو نان');
    assert.equal(nan.categoryName, 'الخبز الهندي');
    assert.equal(nan.price, 13);
    assert.equal(AR.items.find(i => i.platformItemId === COCA_COLA)!.name, 'كوكاكولا');
  });

  test('Arabic restaurant header: localized texts, bidi controls stripped, numbers parsed', () => {
    const r = AR.restaurant!;
    assert.equal(r.platformRestaurantId, '76728');
    assert.equal(r.name, 'Kamat Vegetarian - Business Bay');
    assert.equal(r.url, 'https://deliveroo.ae/ar/menu/Dubai/dubai-business-bay/kamat-dt/');
    assert.deepEqual(r.cuisines, ['نباتي', 'هندي', 'جنوب هندي']);
    assert.equal(r.rating, 4.8);
    assert.equal(r.ratingText, '4.8 ممتاز');
    assert.equal(r.minimumOrder, 20);
    assert.equal(r.deliveryFee, 4.95);
    assert.equal(r.openingStatusText, 'يغلق الساعة 23:00');
    for (const text of [r.ratingText!, r.openingStatusText!, ...r.cuisines]) {
      assert.doesNotMatch(text, /[\u200E\u200F\u202A-\u202E\u2066-\u2069]/);
    }
  });

  test('EN and AR agree on every locale-neutral field', () => {
    assert.equal(AR.items.length, EN.items.length);
    AR.items.forEach((ar, i) => {
      const en = EN.items[i];
      assert.equal(ar.platformItemId, en.platformItemId);
      assert.equal(ar.platformCategoryId, en.platformCategoryId);
      assert.equal(ar.positionInCategory, en.positionInCategory);
      assert.equal(ar.price, en.price);
      assert.equal(ar.imageAnchor, en.imageAnchor);
      assert.equal(ar.isAvailable, en.isAvailable);
      assert.deepEqual(ar.modifierGroupIds, en.modifierGroupIds);
    });
  });
});

describe('Deliveroo parser — modifiers (present in the fixture)', () => {
  test('required single-choice group on Stuffed Nan', () => {
    const nan = EN.items.find(i => i.platformItemId === STUFFED_NAN)!;
    assert.equal(nan.name, 'Stuffed Nan');
    assert.equal(nan.modifiers.length, 1);
    const [group] = nan.modifiers;
    assert.equal(group.groupId, '2508273894');
    assert.equal(group.name, 'Your Choice Of');
    assert.equal(group.minSelections, 1);
    assert.equal(group.maxSelections, 1);
    assert.equal(group.multiselect, false);
    assert.deepEqual(group.options.map(o => [o.optionId, o.name, o.priceDelta, o.isAvailable]), [
      ['1560783827', 'Potato', 0, true],
      ['1560783829', 'Cauliflower', 0, true],
    ]);
  });

  test('optional add-on group with priced options', () => {
    const group = EN.items.flatMap(i => i.modifiers).find(g => g.groupId === '2508273903')!;
    assert.equal(group.name, "Add On's");
    assert.equal(group.minSelections, 0);
    assert.equal(group.maxSelections, 11);
    assert.equal(group.options.length, 15);
    const bhatura = group.options.find(o => o.optionId === '1560780126')!;
    assert.equal(bhatura.name, 'Bhatura (1 Pc)');
    assert.equal(bhatura.priceDelta, 9);
    assert.equal(bhatura.currency, 'AED');
  });

  test('every referenced group resolves; Arabic modifier names are localized', () => {
    assert.equal(EN.items.filter(i => i.modifiers.length > 0).length, 153);
    for (const item of EN.items) assert.equal(item.modifiers.length, item.modifierGroupIds.length);
    const arNan = AR.items.find(i => i.platformItemId === STUFFED_NAN)!;
    assert.equal(arNan.modifiers[0].name, 'إختيارك من');
    assert.deepEqual(arNan.modifiers[0].options.map(o => o.name), ['بطاطا', 'قرنبيط']);
  });

  test('item detail is available from embedded data without a modal request', () => {
    const detail = getDeliverooItemDetail(EN, STUFFED_NAN)!;
    assert.equal(detail.name, 'Stuffed Nan');
    assert.equal(detail.modifiers[0].name, 'Your Choice Of');
    assert.equal(getDeliverooItemDetail(EN, 'does-not-exist'), null);
  });
});

describe('Deliveroo parser — malformed and missing data (mutated copies of the real fixture)', () => {
  test('malformed items produce structured warnings and parsing continues', () => {
    let thaliIndex = -1;
    let idliIndex = -1;
    const html = withMenuRoot(HTML.en, root => {
      thaliIndex = rawIndex(root, THALI);
      idliIndex = rawIndex(root, '1560784130');
      rawItem(root, THALI).price = { code: 'AED', fractional: 'abc' };
      rawItem(root, '1560784130').name = '   ';
    });
    const result = parse('en', html);
    assert.equal(result.items.length, 330);
    assert.equal(result.stats.itemsRejected, 2);
    assert.deepEqual(
      result.warnings.map(w => [w.scope, w.code, w.field, w.itemIndex]),
      [
        ['item', 'INVALID_PRICE', 'price', thaliIndex],
        ['item', 'MISSING_NAME', 'name', idliIndex],
      ]
    );
    assert.ok(result.items.find(i => i.platformItemId === STUFFED_NAN));
  });

  test('a non-object item and an unknown modifier group are reported, not fatal', () => {
    const html = withMenuRoot(HTML.en, root => {
      root.items.push('garbage');
      rawItem(root, THALI).modifierGroupIds.push('999');
    });
    const result = parse('en', html);
    assert.equal(result.items.length, 332);
    assert.deepEqual(result.warnings.map(w => w.code).sort(), ['INVALID_ITEM', 'MISSING_MODIFIER_GROUP']);
  });

  test('missing image URL leaves image fields undefined', () => {
    const html = withMenuRoot(HTML.en, root => { rawItem(root, THALI).image = null; });
    const thali = parse('en', html).items.find(i => i.platformItemId === THALI)!;
    assert.equal(thali.imageUrl, undefined);
    assert.equal(thali.imageUrlTemplate, undefined);
    assert.equal(thali.imageSource, undefined);
    assert.equal(thali.imageAnchor, undefined);
  });

  test('discounted price (field is null in the fixture): price = discounted, originalPrice = list price', () => {
    const html = withMenuRoot(HTML.en, root => { rawItem(root, THALI).priceDiscounted = { code: 'AED', fractional: 3000 }; });
    const thali = parse('en', html).items.find(i => i.platformItemId === THALI)!;
    assert.equal(thali.price, 30);
    assert.equal(thali.originalPrice, 35);
  });

  test('locale mismatch and empty pages are reported, never thrown', () => {
    assert.deepEqual(parse('ar', HTML.en).warnings.map(w => w.code), ['LOCALE_MISMATCH']);
    const empty = parse('en', '');
    assert.equal(empty.items.length, 0);
    assert.deepEqual(empty.warnings.map(w => w.code), ['NEXT_DATA_UNAVAILABLE', 'MISSING_RESTAURANT_NAME', 'NO_ITEMS']);
  });
});

describe('Deliveroo parser — DOM fallback (no __NEXT_DATA__)', () => {
  const DOM_EN = parse('en', withoutNextData(HTML.en));
  const DOM_AR = parse('ar', withoutNextData(HTML.ar));

  test('restaurant, categories and items come from the rendered markup', () => {
    assert.equal(DOM_EN.dataSource, 'dom');
    assert.deepEqual(DOM_EN.warnings.map(w => w.code), ['NEXT_DATA_UNAVAILABLE']);
    assert.equal(DOM_EN.restaurant!.name, 'Kamat Vegetarian - Business Bay');
    assert.equal(DOM_EN.restaurant!.slug, 'kamat-dt');
    assert.equal(DOM_EN.restaurant!.platformRestaurantId, undefined);
    assert.equal(DOM_EN.categories.length, 28);
    assert.equal(DOM_EN.items.length, 332);
    assert.ok(DOM_EN.items.every(i => i.platformItemId === undefined && i.modifiers.length === 0));
    assert.ok(DOM_EN.items.every(i => i.isAvailable === undefined));
  });

  test('DOM values match __NEXT_DATA__ values at the same category position (EN and AR)', () => {
    for (const [dom, json] of [[DOM_EN, EN], [DOM_AR, AR]] as const) {
      const byPos = new Map(dom.items.map(i => [`${i.categoryIndex}:${i.positionInCategory}`, i]));
      for (const item of json.items) {
        const d = byPos.get(`${item.categoryIndex}:${item.positionInCategory}`)!;
        assert.equal(d.name, item.name);
        assert.equal(d.price, item.price);
        assert.equal(d.currency, item.currency);
        assert.equal(d.description, item.description);
      }
    }
  });

  test('images: only lazily-rendered inline background images are available', () => {
    const withImage = DOM_EN.items.filter(i => i.imageUrl);
    assert.equal(withImage.length, 2);
    for (const item of withImage) {
      assert.equal(item.imageSource, 'inline-style');
      assert.equal(item.imageUrl, EN.items.find(i => i.name === item.name)!.imageUrl);
    }
    assert.equal(DOM_AR.items.filter(i => i.imageUrl).length, 0);
  });
});

describe('Deliveroo source identity', () => {
  test('source IDs: restaurant, category and item keys use Deliveroo IDs', () => {
    const inputs = getDeliverooIdentityInputs(EN);
    assert.deepEqual(inputs.restaurant, { kind: 'id', value: '76728' });
    assert.deepEqual(inputs.unresolvedItemIndexes, []);
    const keys = keysFor(inputs);
    assert.equal(keys.restaurant, 'deliveroo:restaurant:id:76728');
    assert.equal(keys.categories[0], 'deliveroo:restaurant:id:76728:category:id:967617571');
    assert.equal(keys.items[0], `deliveroo:restaurant:id:76728:item:id:${THALI}`);
    assert.equal(new Set(keys.items).size, 332);
  });

  test('EN and AR produce identical identities and keys (no locale, no names)', () => {
    const en = getDeliverooIdentityInputs(EN);
    assert.deepEqual(getDeliverooIdentityInputs(AR), en);
    assert.deepEqual(keysFor(getDeliverooIdentityInputs(AR)), keysFor(en));
    for (const key of [...keysFor(en).items, ...keysFor(en).categories]) {
      assert.doesNotMatch(key, /:(en|ar):|[\u0600-\u06FF]|\s/);
    }
    for (const i of en.items) assert.equal(checkIdentityToken(i.identity.value), null);
  });

  test('fallback identity: slug anchor + category ID + item position when IDs are unavailable', () => {
    const en = getDeliverooIdentityInputs(parse('en', withoutNextData(HTML.en)));
    const ar = getDeliverooIdentityInputs(parse('ar', withoutNextData(HTML.ar)));
    assert.deepEqual(en.restaurant, { kind: 'anchor', value: 'kamat-dt' });
    assert.deepEqual(en.categories[0].identity, { kind: 'id', value: '967617571' });
    assert.ok(en.items.every(i => i.identity.kind === 'position'));
    assert.deepEqual(ar, en);
    const keys = keysFor(en);
    assert.equal(keys.items[0], 'deliveroo:restaurant:anchor:kamat-dt:category:id:967617571:item:pos:0');
    assert.equal(new Set(keys.items).size, 332);
  });

  test('image paths are never item identities: the fixture reuses photos across items', () => {
    const anchors = EN.items.map(i => i.imageAnchor);
    assert.ok(new Set(anchors).size < anchors.length);
    const masala = EN.items.find(i => i.name === 'Masala Nan')!;
    const stuffed = EN.items.find(i => i.name === 'Stuffed Nan')!;
    assert.equal(masala.imageAnchor, stuffed.imageAnchor);
    assert.notEqual(masala.platformItemId, stuffed.platformItemId);

    const dom = parse('en', withoutNextData(HTML.en));
    assert.ok(dom.items.some(i => i.imageAnchor));
    assert.ok(getDeliverooIdentityInputs(dom).items.every(i => i.identity.kind === 'position'));
  });

  test('items with no id and no category position are unresolved', () => {
    const dom = parse('en', withoutNextData(HTML.en));
    const orphan: DeliverooParseResult = { ...dom, items: [{ ...dom.items[0], categoryIndex: undefined, positionInCategory: undefined }] };
    const inputs = getDeliverooIdentityInputs(orphan);
    assert.deepEqual(inputs.items, []);
    assert.deepEqual(inputs.unresolvedItemIndexes, [0]);
  });
});

describe('Deliveroo parser — restaurant coordinates (info panel map pin)', () => {
  const BUSINESS_BAY_PIN = { lat: 25.189217736842103, lng: 55.26528257142861 };
  const GOLDEN_MILE_PIN = { lat: 25.11087931092437, lng: 55.14177102521007 };
  const menuOf = (data: any) => data.props.initialState.menuPage.menu;
  const mapLayout = (data: any) => menuOf(data).layoutGroups.flatMap((g: any) => g.layouts).find((l: any) => l.actionId === 'layout-list-map');
  const setPins = (page: string, pins: unknown[]) => withNextData(page, d => { mapLayout(d).blocks[0].map.pins = pins; });
  const withoutMapLayout = (page: string) => withNextData(page, d => {
    for (const g of menuOf(d).layoutGroups) g.layouts = g.layouts.filter((l: any) => l.actionId !== 'layout-list-map');
  });
  const coordinateWarnings = (r: DeliverooParseResult) => r.warnings.filter(w => /COORDINATES/.test(w.code)).map(w => w.code);
  const parseGoldenMile = (page = goldenMileFixtureHtml()) => parseDeliverooMenu(page, { locale: 'en', sourceUrl: GOLDEN_MILE_URL });

  test('Business Bay fixture: pin read in EN and AR (locale-neutral), no warnings', () => {
    assert.equal(EN.restaurant!.location.lat, BUSINESS_BAY_PIN.lat);
    assert.equal(EN.restaurant!.location.lng, BUSINESS_BAY_PIN.lng);
    assert.equal(AR.restaurant!.location.lat, BUSINESS_BAY_PIN.lat);
    assert.equal(AR.restaurant!.location.lng, BUSINESS_BAY_PIN.lng);
    assert.deepEqual(coordinateWarnings(EN), []);
    assert.deepEqual(coordinateWarnings(AR), []);
  });

  test('Golden Mile fixture: source coordinates preserved exactly, menu unchanged', () => {
    const gm = parseGoldenMile();
    const r = gm.restaurant!;
    assert.equal(r.platformRestaurantId, '735078');
    assert.equal(r.slug, 'kamat-golden-mile-galleria');
    assert.equal(r.name, 'Kamat Vegetarian - Golden Mile Galleria');
    assert.deepEqual(r.location, {
      address: 'The Palm, Dubai', area: 'The Palm', city: 'dubai', country: 'AE',
      platformCityId: 40, platformZoneId: 308, ...GOLDEN_MILE_PIN,
    });
    assert.equal(r.menuDisabled, true);
    assert.deepEqual(gm.warnings, []);
    assert.deepEqual(gm.stats, { itemsSeen: 461, itemsParsed: 333, itemsRejected: 0, hiddenOptionItems: 128, modifierGroups: 38 });
    assert.equal(gm.categories.length, 28);
    assert.equal(new Set(gm.items.map(i => i.platformItemId)).size, 333);
  });

  test('Golden Mile pin is ~39 m from the Talabat Palm Jumeirah branch; Business Bay is kilometres away', () => {
    const talabat = parseTalabatMenu(readFileSync(join(FIXTURES, 'talabat-en.html'), 'utf8'), {
      locale: 'en', sourceUrl: 'https://www.talabat.com/uae/restaurant/773429/kamat-vegetarian-the-palm-jumeirah?aid=1333',
    }).restaurant!.location;
    const palm = { lat: talabat.lat!, lng: talabat.lng! };
    assert.equal(Math.round(distanceMeters(GOLDEN_MILE_PIN, palm)), 39);
    assert.ok(distanceMeters(BUSINESS_BAY_PIN, palm) > 10_000);
  });

  test('missing map layout or pins: no coordinates and no warning', () => {
    for (const page of [withoutMapLayout(goldenMileFixtureHtml()), setPins(goldenMileFixtureHtml(), []), withNextData(goldenMileFixtureHtml(), d => { delete menuOf(d).layoutGroups; })]) {
      const r = parseGoldenMile(page);
      assert.equal(r.restaurant!.location.lat, undefined);
      assert.equal(r.restaurant!.location.lng, undefined);
      assert.deepEqual(coordinateWarnings(r), []);
      assert.equal(r.items.length, 333);
    }
  });

  test('malformed pins are rejected with INVALID_COORDINATES, never partially stored', () => {
    const malformed: unknown[] = [
      { lat: '25.11', lon: 55.14 },
      { lat: 25.11 },
      { lat: 25.11, lng: 55.14 },
      { lat: 95, lon: 55.14 },
      { lat: 25.11, lon: 181 },
      { lat: 0, lon: 0 },
      { lat: null, lon: null },
      'not-a-pin',
    ];
    for (const pin of malformed) {
      const r = parseGoldenMile(setPins(goldenMileFixtureHtml(), [pin]));
      assert.equal(r.restaurant!.location.lat, undefined, JSON.stringify(pin));
      assert.equal(r.restaurant!.location.lng, undefined, JSON.stringify(pin));
      assert.deepEqual(coordinateWarnings(r), ['INVALID_COORDINATES'], JSON.stringify(pin));
    }
  });

  test('one valid pin among malformed ones is used; duplicates collapse; distinct pins are ambiguous', () => {
    const mixed = parseGoldenMile(setPins(goldenMileFixtureHtml(), [{ lat: 'x' }, { lat: GOLDEN_MILE_PIN.lat, lon: GOLDEN_MILE_PIN.lng }]));
    assert.equal(mixed.restaurant!.location.lat, GOLDEN_MILE_PIN.lat);
    assert.deepEqual(coordinateWarnings(mixed), ['INVALID_COORDINATES']);

    const pin = { lat: GOLDEN_MILE_PIN.lat, lon: GOLDEN_MILE_PIN.lng };
    const duplicate = parseGoldenMile(setPins(goldenMileFixtureHtml(), [pin, { ...pin }]));
    assert.equal(duplicate.restaurant!.location.lng, GOLDEN_MILE_PIN.lng);
    assert.deepEqual(coordinateWarnings(duplicate), []);

    const ambiguous = parseGoldenMile(setPins(goldenMileFixtureHtml(), [pin, { lat: BUSINESS_BAY_PIN.lat, lon: BUSINESS_BAY_PIN.lng }]));
    assert.equal(ambiguous.restaurant!.location.lat, undefined);
    assert.deepEqual(coordinateWarnings(ambiguous), ['AMBIGUOUS_COORDINATES']);
  });

  test('customer location is never used: 0,0 visitor location, address state and home map are ignored', () => {
    const customerOnly = withNextData(fixtureWithoutPin(), d => {
      menuOf(d).metas.root.customerLocation = { lat: 25.2, lon: 55.27, city: 'dubai' };
    });
    const r1 = parse('en', customerOnly);
    assert.equal(r1.restaurant!.location.lat, undefined);
    assert.equal(r1.restaurant!.location.lng, undefined);

    const elsewhere = withNextData(fixtureWithoutPin(), d => {
      d.props.initialState.address.coordinates = { lat: 25.2, lng: 55.27 };
      d.props.initialState.home.map.pins = [{ lat: 25.2, lon: 55.27 }];
      menuOf(d).layoutGroups[1].layouts.push({ typeName: 'UILayoutList', actionId: 'layout-list-description', blocks: [{ map: { pins: [{ lat: 25.2, lon: 55.27 }] } }] });
    });
    const r2 = parse('en', elsewhere);
    assert.equal(r2.restaurant!.location.lat, undefined);
    assert.equal(r2.restaurant!.location.lng, undefined);

    // Real captures: Business Bay was fetched with a delivery geohash (customer in Downtown), Golden Mile anonymously (0,0).
    const customerOf = (page: string) => menuOf(JSON.parse(NEXT_DATA_RE.exec(page)![2])).metas.root.customerLocation;
    const bbCustomer = customerOf(HTML.en);
    assert.deepEqual([bbCustomer.lat, bbCustomer.lon], [25.2048499, 55.2707799]);
    assert.notEqual(EN.restaurant!.location.lat, bbCustomer.lat);
    assert.notEqual(EN.restaurant!.location.lng, bbCustomer.lon);
    const gmCustomer = customerOf(goldenMileFixtureHtml());
    assert.deepEqual([gmCustomer.lat, gmCustomer.lon], [0, 0]);
    assert.notEqual(parseGoldenMile().restaurant!.location.lat, 0);
  });

  test('a pin identical to the customer location is rejected', () => {
    const page = withNextData(goldenMileFixtureHtml(), d => {
      menuOf(d).metas.root.customerLocation = { lat: GOLDEN_MILE_PIN.lat, lon: GOLDEN_MILE_PIN.lng };
    });
    const r = parseGoldenMile(page);
    assert.equal(r.restaurant!.location.lat, undefined);
    assert.deepEqual(coordinateWarnings(r), ['COORDINATES_MATCH_CUSTOMER_LOCATION']);
  });

  function fixtureWithoutPin(): string {
    return withNextData(HTML.en, d => {
      for (const g of menuOf(d).layoutGroups) g.layouts = g.layouts.filter((l: any) => l.actionId !== 'layout-list-map');
    });
  }
});

describe('Deliveroo parser — purity and helpers', () => {
  test('deterministic: same input gives deep-equal output', () => {
    assert.deepEqual(parse('en'), EN);
    assert.deepEqual(parse('ar'), AR);
  });

  test('money text handles bidi isolates and Arabic-Indic digits', () => {
    assert.deepEqual(parseMoneyText('\u2066AED 29\u2069'), { amount: 29, currency: 'AED' });
    assert.deepEqual(parseMoneyText('الحد الأدنى AED ٢٠'), { amount: 20, currency: 'AED' });
    assert.deepEqual(parseMoneyText('AED 1,250.50'), { amount: 1250.5, currency: 'AED' });
    assert.equal(parseMoneyText('Closes at 23:00'), null);
  });

  test('image helpers', () => {
    assert.equal(readInlineBackgroundImage('background-image: url("https://x.test/a.jpg?w=1")'), 'https://x.test/a.jpg?w=1');
    assert.equal(readInlineBackgroundImage('color: red'), undefined);
    assert.deepEqual(normalizeDeliverooImageUrl('https://x.test/images/u/image.jpeg?width={w}'), {
      imageUrl: 'https://x.test/images/u/image.jpeg',
      imageAnchor: 'images/u/image.jpeg',
    });
    assert.equal(normalizeDeliverooImageUrl('javascript:alert(1)'), null);
  });
});
