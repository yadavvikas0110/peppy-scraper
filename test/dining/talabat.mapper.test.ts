/// <reference types="node" />
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';
import { ObjectId } from 'mongodb';
import { parseSourceKey } from '../../src/dining/dining.source-key';
import type { DiningLocale, DiningRestaurant, LocalizedText } from '../../src/dining/dining.types';
import { evaluateCandidate } from '../../src/dining/identity/identity.matcher';
import { extractSourceSignals, toGroupSignals } from '../../src/dining/identity/identity.signals';
import { DiningMappedMenu, DiningMappingError, DiningRestaurantDto } from '../../src/dining/platforms/platform.mapper';
import { mapTalabatMenu, talabatMapper } from '../../src/dining/platforms/talabat/talabat.mapper';
import { parseTalabatMenu } from '../../src/dining/platforms/talabat/talabat.parser';
import { makeRestaurant } from './fixtures';
import { mappedMenu as deliverooMappedMenu } from './helpers';

const FIXTURES = join(__dirname, 'fixtures');
const HTML: Record<DiningLocale, string> = {
  en: readFileSync(join(FIXTURES, 'talabat-en.html'), 'utf8'),
  ar: readFileSync(join(FIXTURES, 'talabat-ar.html'), 'utf8'),
};
const URLS: Record<DiningLocale, string> = {
  en: 'https://www.talabat.com/uae/restaurant/773429/kamat-vegetarian-the-palm-jumeirah?aid=1333',
  ar: 'https://www.talabat.com/ar/uae/restaurant/773429/kamat-vegetarian-the-palm-jumeirah?aid=1333',
};
const NEXT_DATA_RE = /(<script id="__NEXT_DATA__"[^>]*>)([\s\S]*?)(<\/script>)/;
const RESTAURANT_KEY = 'talabat:restaurant:id:773429';
const THALI = '3145591979';

function withMenuState(html: string, mutate: (state: any) => void): string {
  return html.replace(NEXT_DATA_RE, (_m, open, json, close) => {
    const data = JSON.parse(json);
    mutate(data.props.pageProps.initialMenuState);
    return `${open}${JSON.stringify(data).replace(/</g, '\\u003c')}${close}`;
  });
}

function mapped(locale: DiningLocale, html = HTML[locale]): DiningMappedMenu {
  return mapTalabatMenu(parseTalabatMenu(html, { locale, sourceUrl: URLS[locale] }));
}

const EN = mapped('en');
const AR = mapped('ar');

describe('Talabat mapper — restaurant', () => {
  test('EN: branch-level restaurant DTO with only fields present on the page', () => {
    assert.equal(talabatMapper.platform, 'talabat');
    const r = EN.restaurant;
    assert.deepEqual(r, {
      platform: 'talabat',
      sourceKey: RESTAURANT_KEY,
      sourceKeyKind: 'id',
      platformRestaurantId: '773429',
      slug: 'kamat-vegetarian-the-palm-jumeirah',
      name: { en: 'Kamat Vegetarian, The Palm Jumeirah' },
      brandName: { en: 'Kamat Vegetarian' },
      url: { en: URLS.en },
      cuisines: ['Vegetarian', 'Indian', 'Asian', 'South indian', 'Street food', 'North indian', 'Veg only'],
      location: { city: 'Dubai', area: 'The Palm Jumeirah', lat: 25.111222348578067, lng: 55.141854912966906 },
      rating: 4.9,
      ratingCount: 500,
      currency: 'AED',
      imageUrl: 'https://talabat.dhmedia.io/image/talabat/restaurants/KAMAT_1638350200016715497.jpg',
    } satisfies DiningRestaurantDto);
  });

  test('AR: only `.ar` localized fields; EN-reference fields (cuisines, location) are not provided', () => {
    const r = AR.restaurant;
    assert.equal(r.sourceKey, RESTAURANT_KEY);
    assert.deepEqual(r.name, { ar: 'كامات فيجتريان, نخلة الجميرا' });
    assert.deepEqual(r.brandName, { ar: 'كامات فيجتريان' });
    assert.deepEqual(r.url, { ar: URLS.ar });
    assert.equal(r.cuisines, undefined);
    assert.equal(r.location, undefined);
    assert.equal(r.currency, 'AED');
  });

  test('address-dependent and unobserved fields are never mapped', () => {
    for (const r of [EN.restaurant, AR.restaurant]) {
      for (const absent of ['deliveryFee', 'minimumOrder', 'deliveryTimeMin', 'deliveryTimeMax', 'isOpen', 'ratingCountText', 'tags'] as const) {
        assert.equal(r[absent], undefined, absent);
      }
    }
  });
});

describe('Talabat mapper — categories and items', () => {
  test('28 categories and 333 items keyed by Talabat IDs', () => {
    assert.equal(EN.categories.length, 28);
    assert.deepEqual(EN.categories[0], {
      sourceKey: `${RESTAURANT_KEY}:category:id:20581457`, sourceKeyKind: 'id', platformCategoryId: '20581457', name: { en: 'Thali' }, sortOrder: 0,
    });
    assert.equal(EN.items.length, 333);
    for (const item of EN.items) {
      assert.equal(item.sourceKeyKind, 'id');
      assert.equal(item.sourceKey, `${RESTAURANT_KEY}:item:id:${item.platformItemId}`);
      assert.deepEqual(parseSourceKey(item.sourceKey), { platform: 'talabat', entity: 'item', kind: 'id', value: item.platformItemId });
      assert.ok(item.categorySourceKey?.startsWith(`${RESTAURANT_KEY}:category:id:`));
    }
  });

  test('item DTO: availability is explicitly unknown and hasChoices becomes hasModifiers without modifier groups', () => {
    for (const menu of [EN, AR]) {
      assert.ok(menu.items.every(i => i.availabilityStatus === 'unknown' && !('isAvailable' in i)));
      assert.equal(menu.items.filter(i => i.hasModifiers === true).length, 153);
      assert.equal(menu.items.filter(i => i.hasModifiers === false).length, 180);
      assert.ok(menu.items.every(i => i.modifiers === undefined && !i.clear.includes('hasModifiers')));
    }
    const arById = new Map(AR.items.map(i => [i.platformItemId, i]));
    assert.ok(EN.items.every(i => arById.get(i.platformItemId)!.hasModifiers === i.hasModifiers));
  });

  test('item DTO: localized text, price, image; no modifiers, availability or popularity are invented', () => {
    const thali = EN.items.find(i => i.platformItemId === THALI)!;
    assert.deepEqual(thali.name, { en: 'Thali' });
    assert.deepEqual(thali.categoryName, { en: 'Thali' });
    assert.equal(thali.price, 35);
    assert.equal(thali.currency, 'AED');
    assert.equal(thali.imageUrl, 'https://talabat.dhmedia.io/image/talabat/MenuItems/82C81FF00D451C2711F13728E6C8D608');
    assert.deepEqual(thali.sourceUrl, { en: URLS.en });
    assert.deepEqual(thali.clear, ['originalPrice']);
    for (const item of EN.items) {
      for (const absent of ['modifiers', 'isAvailable', 'isPopular', 'dietaryTags', 'calories', 'originalPrice'] as const) {
        assert.equal(item[absent], undefined, absent);
      }
    }
    const noDescription = EN.items.filter(i => i.description === undefined);
    assert.equal(noDescription.length, 10);
    assert.ok(noDescription.every(i => i.clear.includes('description')));
  });

  test('complete mapping; modifiers missing from the page are reported once', () => {
    assert.deepEqual(EN.completeness, { complete: true, reasons: [], itemsSeen: 333, itemsMapped: 333, itemsRejected: 0 });
    assert.deepEqual(AR.completeness, EN.completeness);
    const modifierWarnings = EN.warnings.filter(w => w.code === 'MODIFIERS_NOT_EMBEDDED');
    assert.equal(modifierWarnings.length, 1);
    assert.match(modifierWarnings[0].message, /^153 item\(s\)/);
  });
});

describe('Talabat mapper — EN and AR describe the same records', () => {
  test('identical restaurant, category and item keys in both locales', () => {
    assert.equal(AR.restaurant.sourceKey, EN.restaurant.sourceKey);
    assert.deepEqual(AR.categories.map(c => c.sourceKey), EN.categories.map(c => c.sourceKey));
    assert.deepEqual(new Set(AR.items.map(i => i.sourceKey)), new Set(EN.items.map(i => i.sourceKey)));
  });

  test('merging both locales by sourceKey yields 333 items with both names — no duplicates from differing names', () => {
    const merged = new Map<string, { name: LocalizedText; price: number }>();
    for (const menu of [EN, AR]) {
      for (const item of menu.items) {
        const current = merged.get(item.sourceKey);
        merged.set(item.sourceKey, current ? { ...current, name: { ...current.name, ...item.name } } : { name: { ...item.name }, price: item.price });
      }
    }
    assert.equal(merged.size, 333);
    for (const [key, value] of merged) {
      assert.ok(value.name.en && value.name.ar, key);
      assert.notEqual(value.name.en, value.name.ar);
    }
    const thali = merged.get(`${RESTAURANT_KEY}:item:id:${THALI}`)!;
    assert.deepEqual(thali.name, { en: 'Thali', ar: 'ثالي' });
    const arPrices = new Map(AR.items.map(i => [i.sourceKey, i.price]));
    assert.ok(EN.items.every(i => arPrices.get(i.sourceKey) === i.price));
  });
});

describe('Talabat mapper — failures and incomplete pages', () => {
  test('page-level problems throw DiningMappingError', () => {
    const noName = withMenuState(HTML.en, s => { delete s.restaurant.branchName; delete s.restaurant.name; });
    assert.throws(() => mapped('en', noName), (e: unknown) => e instanceof DiningMappingError && e.code === 'MISSING_RESTAURANT_NAME');
    const noCurrency = withMenuState(HTML.en, s => { s.currentCountry = null; });
    assert.throws(() => mapped('en', noCurrency), (e: unknown) => e instanceof DiningMappingError && e.code === 'MISSING_CURRENCY');
  });

  test('without the menu payload the page is unusable (no currency, no menu)', () => {
    assert.throws(
      () => mapped('en', HTML.en.replace(NEXT_DATA_RE, '')),
      (e: unknown) => e instanceof DiningMappingError && e.code === 'MISSING_CURRENCY'
    );
  });

  test('an empty menu maps the restaurant but is incomplete, so it cannot deactivate items', () => {
    const r = mapped('en', withMenuState(HTML.en, s => { s.menuData.categories = []; s.menuData.items = []; }));
    assert.equal(r.restaurant.sourceKey, RESTAURANT_KEY);
    assert.equal(r.items.length, 0);
    assert.equal(r.completeness.complete, false);
    assert.deepEqual(r.completeness.reasons, ['NO_ITEMS']);
  });

  test('more than 10% rejected items marks the mapping incomplete', () => {
    const page = withMenuState(HTML.en, s => {
      for (const c of s.menuData.categories.slice(1, 6)) for (const i of c.items) i.price = 'bad';
    });
    const r = mapped('en', page);
    assert.ok(r.completeness.itemsRejected > 33);
    assert.ok(r.completeness.reasons.includes('TOO_MANY_REJECTED_ITEMS'));
  });

  test('items without a Talabat ID map to position keys inside their category', () => {
    const page = withMenuState(HTML.en, s => { delete s.menuData.categories[1].items[0].id; });
    const r = mapped('en', page);
    const thali = r.items.find(i => i.name.en === 'Thali')!;
    assert.equal(thali.sourceKeyKind, 'position');
    assert.equal(thali.platformItemId, undefined);
    assert.equal(thali.sourceKey, `${RESTAURANT_KEY}:category:id:20581457:item:pos:0`);
  });
});

describe('Talabat mapper — restaurant identity boundary', () => {
  function asRestaurant(dto: DiningRestaurantDto, names: Partial<DiningRestaurant> = {}): DiningRestaurant {
    return makeRestaurant({
      platform: dto.platform,
      platformRestaurantId: dto.platformRestaurantId,
      sourceKey: dto.sourceKey,
      sourceKeyKind: dto.sourceKeyKind,
      slug: dto.slug,
      name: dto.name,
      brandName: dto.brandName,
      url: dto.url,
      location: dto.location ?? {},
      ...names,
    });
  }

  const talabatPalm = asRestaurant({ ...EN.restaurant, name: { ...EN.restaurant.name, ...AR.restaurant.name }, brandName: { ...EN.restaurant.brandName, ...AR.restaurant.brandName } });
  const deliverooBusinessBay = deliverooMappedMenu('en').restaurant;

  test('the Talabat Palm Jumeirah branch and the Deliveroo Business Bay branch are different listings', () => {
    assert.equal(talabatPalm.platformRestaurantId, '773429');
    assert.equal(deliverooBusinessBay.platformRestaurantId, '76728');
    assert.notEqual(talabatPalm.sourceKey, deliverooBusinessBay.sourceKey);
  });

  test('the matcher does not group them: names differ and the areas conflict', () => {
    const source = extractSourceSignals(talabatPalm);
    const candidate = { groupId: new ObjectId(), signals: toGroupSignals(extractSourceSignals(asRestaurant(deliverooBusinessBay))), matchedPlatforms: ['deliveroo' as const] };
    assert.equal(evaluateCandidate(source, candidate).verdict, 'none');

    // Even when both carry the same brand name, the branch conflict blocks the match.
    const sameBrand = { ...candidate, signals: { ...candidate.signals, brands: source.brands } };
    const verdict = evaluateCandidate(source, sameBrand);
    assert.equal(verdict.verdict, 'none');
    assert.ok(verdict.evidence.signals.includes('BRAND_EXACT'));
    assert.ok(verdict.evidence.conflicts.includes('AREA_MISMATCH'));
  });
});
