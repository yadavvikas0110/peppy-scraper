/// <reference types="node" />
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDeliverooMenu } from '../../src/dining/platforms/deliveroo/deliveroo.parser';
import { deliverooMapper, mapDeliverooMenu } from '../../src/dining/platforms/deliveroo/deliveroo.mapper';
import { DiningMappingError } from '../../src/dining/platforms/platform.mapper';
import type { DiningLocale, DiningRestaurant } from '../../src/dining/dining.types';
import { validateRestaurant } from '../../src/dining/dining.validator';
import { applyUpdate } from '../../src/dining/repositories/document-update';
import { buildRestaurantUpdate } from '../../src/dining/repositories/restaurant.repository';
import {
  COCA_COLA,
  FIXTURE_URL,
  fixtureHtml,
  GOLDEN_MILE_URL,
  goldenMileFixtureHtml,
  mappedMenu,
  STUFFED_NAN,
  THALI,
  withMenuRoot,
  withNextData,
  withoutNextData,
} from './helpers';

const EN = mappedMenu('en');
const AR = mappedMenu('ar');
const RESTAURANT_KEY = 'deliveroo:restaurant:id:76728';

const item = (menu: typeof EN, id: string) => menu.items.find(i => i.platformItemId === id)!;

describe('Deliveroo mapper — restaurant', () => {
  test('EN: canonical restaurant DTO with only fields present on the page', () => {
    assert.equal(deliverooMapper.platform, 'deliveroo');
    const r = EN.restaurant;
    assert.equal(r.platform, 'deliveroo');
    assert.equal(r.platformRestaurantId, '76728');
    assert.equal(r.sourceKey, RESTAURANT_KEY);
    assert.equal(r.sourceKeyKind, 'id');
    assert.equal(r.slug, 'kamat-dt');
    assert.deepEqual(r.name, { en: 'Kamat Vegetarian - Business Bay' });
    assert.deepEqual(r.url, { en: 'https://deliveroo.ae/en/menu/Dubai/dubai-business-bay/kamat-dt/' });
    assert.deepEqual(r.cuisines, ['Vegetarian', 'Indian', 'South Indian']);
    assert.deepEqual(r.location, {
      city: 'dubai', area: 'Dubai Business Bay', address: 'Ground Level, Bay Avenue, Executive Tower G, Dubai',
      lat: 25.189217736842103, lng: 55.26528257142861,
    });
    assert.equal(r.rating, 4.8);
    assert.equal(r.ratingCountText, '500+');
    assert.equal(r.currency, 'AED');
    assert.equal(r.minimumOrder, 20);
    assert.equal(r.deliveryFee, 4.95);
    assert.match(r.imageUrl!, /^https:\/\/rs-menus-api\.roocdn\.com\/images\//);
    for (const absent of ['ratingCount', 'deliveryTimeMin', 'deliveryTimeMax', 'isOpen', 'brandName', 'tags'] as const) {
      assert.equal(r[absent], undefined, absent);
    }
  });

  test('AR: only `.ar` localized fields; EN-reference fields (cuisines, address) are not provided', () => {
    const r = AR.restaurant;
    assert.equal(r.sourceKey, RESTAURANT_KEY);
    assert.deepEqual(r.name, { ar: 'Kamat Vegetarian - Business Bay' });
    assert.deepEqual(r.url, { ar: 'https://deliveroo.ae/ar/menu/Dubai/dubai-business-bay/kamat-dt/' });
    assert.equal(r.cuisines, undefined);
    assert.equal(r.location, undefined);
    assert.equal(r.rating, 4.8);
    assert.equal(r.deliveryFee, 4.95);
  });
});

describe('Deliveroo mapper — restaurant coordinates', () => {
  const ctx = (locale: DiningLocale) => ({ locale, runId: `run_${locale}`, now: new Date('2026-10-09T12:00:00.000Z') });
  const store = (existing: DiningRestaurant | null, menu: typeof EN) => applyUpdate<DiningRestaurant>(existing, buildRestaurantUpdate(menu.restaurant, ctx(menu.locale)));
  const withoutMapPin = (page: string) => withNextData(page, d => {
    for (const g of d.props.initialState.menuPage.menu.layoutGroups) g.layouts = g.layouts.filter((l: any) => l.actionId !== 'layout-list-map');
  });

  test('Golden Mile: map-pin coordinates reach the canonical location; still no brand name', () => {
    const gm = mapDeliverooMenu(parseDeliverooMenu(goldenMileFixtureHtml(), { locale: 'en', sourceUrl: GOLDEN_MILE_URL }));
    assert.equal(gm.restaurant.sourceKey, 'deliveroo:restaurant:id:735078');
    assert.deepEqual(gm.restaurant.location, { city: 'dubai', area: 'The Palm', address: 'The Palm, Dubai', lat: 25.11087931092437, lng: 55.14177102521007 });
    assert.equal(gm.restaurant.brandName, undefined);
    assert.equal(gm.categories.length, 28);
    assert.equal(gm.items.length, 333);
    assert.deepEqual(gm.completeness.reasons, ['MENU_DISABLED']);
  });

  test('no pin on the page → location without coordinates (never 0,0 or guessed)', () => {
    const r = mappedMenu('en', withoutMapPin(fixtureHtml('en'))).restaurant;
    assert.deepEqual(r.location, { city: 'dubai', area: 'Dubai Business Bay', address: 'Ground Level, Bay Avenue, Executive Tower G, Dubai' });
  });

  test('stored document: EN sets coordinates; an AR update (with or without a pin) keeps them', () => {
    const afterEn = store(null, EN);
    assert.equal(afterEn.location.lat, 25.189217736842103);
    assert.equal(afterEn.location.lng, 55.26528257142861);
    for (const ar of [AR, mappedMenu('ar', withoutMapPin(fixtureHtml('ar')))]) {
      assert.equal(ar.restaurant.location, undefined);
      const afterAr = store(afterEn, ar);
      assert.deepEqual(afterAr.location, afterEn.location);
      assert.deepEqual(afterAr.name, { en: 'Kamat Vegetarian - Business Bay', ar: 'Kamat Vegetarian - Business Bay' });
    }
  });

  test('stored document validates with coordinates', () => {
    const check = validateRestaurant(store(null, EN));
    assert.equal(check.valid, true, JSON.stringify(check.issues));
  });
});

describe('Deliveroo mapper — categories and items', () => {
  test('categories: Deliveroo IDs, single-locale names, display order', () => {
    assert.equal(EN.categories.length, 28);
    assert.deepEqual(EN.categories[0], {
      sourceKey: `${RESTAURANT_KEY}:category:id:967617571`,
      sourceKeyKind: 'id',
      platformCategoryId: '967617571',
      name: { en: 'Thali' },
      sortOrder: 0,
    });
    assert.deepEqual(AR.categories[0].name, { ar: 'ثالي' });
    assert.deepEqual(AR.categories.map(c => c.sourceKey), EN.categories.map(c => c.sourceKey));
  });

  test('items: identity, price, image, availability, category link, source URL', () => {
    assert.equal(EN.items.length, 332);
    const thali = item(EN, THALI);
    assert.equal(thali.sourceKey, `${RESTAURANT_KEY}:item:id:${THALI}`);
    assert.equal(thali.sourceKeyKind, 'id');
    assert.equal(thali.categorySourceKey, `${RESTAURANT_KEY}:category:id:967617571`);
    assert.deepEqual(thali.categoryName, { en: 'Thali' });
    assert.deepEqual(thali.name, { en: 'Thali' });
    assert.match(thali.description!.en!, /^Dry Veg\. South Indian/);
    assert.equal(thali.price, 35);
    assert.equal(thali.originalPrice, undefined);
    assert.equal(thali.currency, 'AED');
    assert.equal(thali.imageUrl, 'https://rs-menus-api.roocdn.com/images/7f753dc1-9afd-4d3b-94fb-584a79a6d65c/image.jpeg');
    assert.equal(thali.isAvailable, true);
    assert.equal(thali.isPopular, false);
    assert.deepEqual(thali.sourceUrl, { en: 'https://deliveroo.ae/en/menu/Dubai/dubai-business-bay/kamat-dt/' });
    assert.equal(thali.dietaryTags, undefined);
    assert.equal(thali.calories, undefined);
    assert.deepEqual(thali.clear, ['originalPrice']);
  });

  test('missing description is cleared for this locale only', () => {
    const coke = item(EN, COCA_COLA);
    assert.equal(coke.description, undefined);
    assert.ok(coke.clear.includes('description'));
  });

  test('EN and AR produce identical keys; no locale or Arabic text in any key', () => {
    assert.deepEqual(AR.items.map(i => i.sourceKey), EN.items.map(i => i.sourceKey));
    for (const key of [...EN.items, ...EN.categories].map(x => x.sourceKey)) {
      assert.doesNotMatch(key, /:(en|ar)(:|$)|[\u0600-\u06FF]|\s/);
    }
    const arThali = item(AR, THALI);
    assert.deepEqual(arThali.name, { ar: 'ثالي' });
    assert.equal(Object.keys(arThali.description!).join(), 'ar');
  });

  test('modifiers: canonical groups with required/min/max and localized names', () => {
    const [group] = item(EN, STUFFED_NAN).modifiers!;
    assert.deepEqual(group, {
      groupId: '2508273894',
      name: { en: 'Your Choice Of' },
      required: true,
      minSelections: 1,
      maxSelections: 1,
      options: [
        { optionId: '1560783827', name: { en: 'Potato' }, priceDelta: 0, currency: 'AED', isAvailable: true },
        { optionId: '1560783829', name: { en: 'Cauliflower' }, priceDelta: 0, currency: 'AED', isAvailable: true },
      ],
    });
    assert.deepEqual(item(AR, STUFFED_NAN).modifiers![0].options.map(o => o.name), [{ ar: 'بطاطا' }, { ar: 'قرنبيط' }]);
    const addOns = EN.items.flatMap(i => i.modifiers ?? []).find(g => g.groupId === '2508273903')!;
    assert.equal(addOns.required, false);
    assert.equal(addOns.maxSelections, 11);
  });

  test('complete scrape metadata', () => {
    assert.deepEqual(EN.completeness, { complete: true, reasons: [], itemsSeen: 332, itemsMapped: 332, itemsRejected: 0 });
    assert.deepEqual(EN.warnings, []);
  });
});

describe('Deliveroo mapper — fallbacks and failures', () => {
  test('DOM fallback: slug anchor + position keys, no modifiers, marked incomplete', () => {
    const menu = mappedMenu('en', withoutNextData(fixtureHtml('en')));
    assert.equal(menu.restaurant.sourceKey, 'deliveroo:restaurant:anchor:kamat-dt');
    assert.equal(menu.restaurant.platformRestaurantId, undefined);
    assert.equal(menu.items[0].sourceKey, 'deliveroo:restaurant:anchor:kamat-dt:category:id:967617571:item:pos:0');
    assert.ok(menu.items.every(i => i.platformItemId === undefined && i.modifiers === undefined));
    assert.ok(menu.items.every(i => !i.clear.includes('imageUrl') && !i.clear.includes('originalPrice')));
    assert.equal(menu.completeness.complete, false);
    assert.ok(menu.completeness.reasons.includes('DOM_FALLBACK'));
  });

  test('no restaurant on the page → DiningMappingError', () => {
    const blocked = parseDeliverooMenu('<html><body>blocked</body></html>', { locale: 'en', sourceUrl: FIXTURE_URL.en });
    assert.throws(() => mapDeliverooMenu(blocked), (e: unknown) => e instanceof DiningMappingError && e.code === 'MISSING_RESTAURANT_NAME');
    assert.throws(
      () => mapDeliverooMenu({ ...blocked, restaurant: null }),
      (e: unknown) => e instanceof DiningMappingError && e.code === 'NO_RESTAURANT'
    );
  });

  test('duplicate item identity on the page: first kept, duplicate rejected with a warning', () => {
    const parsed = parseDeliverooMenu(fixtureHtml('en'), { locale: 'en', sourceUrl: FIXTURE_URL.en });
    parsed.items.push({ ...parsed.items[0], sourceIndex: 9999 });
    const menu = mapDeliverooMenu(parsed);
    assert.equal(menu.items.length, 332);
    assert.deepEqual(menu.warnings.map(w => [w.code, w.itemIndex]), [['DUPLICATE_SOURCE_KEY', 9999]]);
    assert.equal(menu.completeness.itemsRejected, 1);
  });

  test('invalid modifier group is dropped, the item is kept', () => {
    const page = withMenuRoot(fixtureHtml('en'), root => {
      const g = root.modifierGroups.find((x: any) => String(x.id) === '2508273894');
      g.minSelection = 3;
      g.maxSelection = 1;
    });
    const menu = mappedMenu('en', page);
    assert.deepEqual(item(menu, STUFFED_NAN).modifiers, []);
    assert.ok(menu.warnings.some(w => w.code === 'INVALID_MODIFIER_GROUP'));
  });

  test('too many rejected items makes the scrape incomplete', () => {
    const page = withMenuRoot(fixtureHtml('en'), root => {
      root.items.slice(0, 200).forEach((i: any) => { i.price = null; });
    });
    const menu = mappedMenu('en', page);
    assert.equal(menu.completeness.complete, false);
    assert.ok(menu.completeness.reasons.includes('TOO_MANY_REJECTED_ITEMS'));
  });

  test('deterministic', () => {
    assert.deepEqual(mappedMenu('en'), EN);
  });
});
