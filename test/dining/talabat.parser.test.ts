/// <reference types="node" />
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';
import type { DiningLocale } from '../../src/dining/dining.types';
import { getDiningPlatformModule } from '../../src/dining/platforms/platform.registry';
import {
  detectTalabatLocale,
  fetchTalabatMenu,
  getTalabatFetchOptions,
  getTalabatIdentityInputs,
  isTalabatMenuUrl,
  talabatAdapter,
  toTalabatLocaleUrl,
} from '../../src/dining/platforms/talabat/talabat.adapter';
import {
  normalizeTalabatImageUrl,
  parseTalabatMenu,
  parseTalabatNumber,
  readTalabatUrlIdentity,
} from '../../src/dining/platforms/talabat/talabat.parser';
import type { TalabatParseResult } from '../../src/dining/platforms/talabat/talabat.types';
import { FAKE_SCRAPE_DO_TOKEN, fakeScrapeDo } from './helpers';
import { sanitizeTalabatHtml } from './tools/talabat-fixture.sanitize';

// All tests use the sanitized fixtures (captured once with Scrape.do). No network access.

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

const THALI = '3145591979';
const TANDOORI_ROTI = '3145592188';
const INDIAN_BREAD = '20581473';

function parse(locale: DiningLocale, html = HTML[locale]): TalabatParseResult {
  return parseTalabatMenu(html, { locale, sourceUrl: URLS[locale] });
}

// Mutates a copy of the real fixture payload (to exercise malformed/missing-field paths).
function withMenuState(html: string, mutate: (state: any, data: any) => void): string {
  return html.replace(NEXT_DATA_RE, (_m, open, json, close) => {
    const data = JSON.parse(json);
    mutate(data.props.pageProps.initialMenuState, data);
    return `${open}${JSON.stringify(data).replace(/</g, '\\u003c')}${close}`;
  });
}

// categories[0] is the synthetic "Picks for you" section; [1] Thali (1 item); [2] Idli & Wada (8 items).
const section = (state: any, index: number) => state.menuData.categories[index];
const codes = (r: TalabatParseResult) => r.warnings.map(w => w.code);

const EN = parse('en');
const AR = parse('ar');

describe('Talabat adapter — URLs and fetch options', () => {
  test('recognises EN and AR restaurant menu URLs only', () => {
    assert.equal(talabatAdapter.platform, 'talabat');
    assert.ok(isTalabatMenuUrl(URLS.en));
    assert.ok(isTalabatMenuUrl(URLS.ar));
    assert.ok(isTalabatMenuUrl('https://talabat.com/uae/restaurant/773429/kamat-vegetarian-the-palm-jumeirah'));
    for (const bad of [
      'http://www.talabat.com/uae/restaurant/773429/kamat-vegetarian-the-palm-jumeirah',
      'https://www.talabat.com/uae/restaurants/1333/the-palm-jumeirah',
      'https://www.talabat.com/uae/restaurant/773429',
      'https://www.talabat.com/uae/restaurant/abc/kamat',
      'https://www.talabat.com.evil.io/uae/restaurant/773429/kamat',
      'https://deliveroo.ae/en/menu/Dubai/dubai-business-bay/kamat-dt/',
      'not a url',
    ]) {
      assert.equal(isTalabatMenuUrl(bad), false, bad);
    }
  });

  test('locale detection and conversion keep the path and the area query', () => {
    assert.equal(detectTalabatLocale(URLS.en), 'en');
    assert.equal(detectTalabatLocale(URLS.ar), 'ar');
    assert.equal(toTalabatLocaleUrl(URLS.en, 'ar'), URLS.ar);
    assert.equal(toTalabatLocaleUrl(URLS.ar, 'en'), URLS.en);
    assert.equal(toTalabatLocaleUrl(URLS.ar, 'ar'), URLS.ar);
    assert.throws(() => toTalabatLocaleUrl('nope', 'en'), /Invalid Talabat URL/);
  });

  test('fetch options are a plain HTML request (no rendering, no super proxy)', () => {
    const options = getTalabatFetchOptions(URLS.en, 'en');
    assert.deepEqual(options, {});
    assert.notEqual(options, getTalabatFetchOptions(URLS.en, 'en'));
  });

  test('fetchTalabatMenu makes one request for the locale URL and parses it without persisting', async () => {
    const fake = fakeScrapeDo(url => HTML[url.includes('/ar/') ? 'ar' : 'en'], { requestCost: 1, remainingCredits: 888 });
    const logs: string[] = [];
    const out = await fetchTalabatMenu(URLS.en, 'ar', { client: fake.client as any, logger: { log: (m: string) => logs.push(m) } });
    assert.equal(fake.calls.length, 1);
    assert.equal(fake.calls[0].url, URLS.ar);
    assert.deepEqual(fake.calls[0].options, {});
    assert.equal(out.result.items.length, 333);
    assert.deepEqual(out.cost, { requestCost: 1, remainingCredits: 888, attempts: 1, durationMs: 1200 });
    assert.match(logs.join('\n'), /talabat ar status=200 cost=1 remaining=888/);
    assert.doesNotMatch(logs.join('\n'), new RegExp(FAKE_SCRAPE_DO_TOKEN));
    await assert.rejects(fetchTalabatMenu('https://deliveroo.ae/en/menu/a/b/c/', 'en', { client: fake.client as any }), /Not a Talabat menu URL/);
  });

  test('Talabat is registered with its own adapter and mapper; Deliveroo is unchanged', () => {
    const talabat = getDiningPlatformModule('talabat')!;
    assert.equal(talabat.adapter, talabatAdapter);
    assert.equal(talabat.mapper.platform, 'talabat');
    assert.equal(getDiningPlatformModule('deliveroo')!.adapter.platform, 'deliveroo');
    assert.equal(getDiningPlatformModule('careem'), undefined);
  });
});

describe('Talabat parser — English fixture', () => {
  test('reads the menu from __NEXT_DATA__ with no warnings beyond expectations', () => {
    assert.equal(EN.platform, 'talabat');
    assert.equal(EN.dataSource, 'next-data');
    assert.equal(EN.detectedLocale, 'en');
    assert.deepEqual(codes(EN), []);
  });

  test('restaurant: branch identity, brand, cuisines, rating, location, images', () => {
    const r = EN.restaurant!;
    assert.equal(r.platformRestaurantId, '773429');
    assert.equal(r.platformBrandId, '2699');
    assert.equal(r.slug, 'kamat-vegetarian-the-palm-jumeirah');
    assert.equal(r.brandSlug, 'kamat-vegetarian');
    assert.equal(r.name, 'Kamat Vegetarian, The Palm Jumeirah');
    assert.equal(r.brandName, 'Kamat Vegetarian');
    assert.equal(r.url, URLS.en);
    assert.deepEqual(r.alternateUrls, { en: URLS.en, ar: URLS.ar });
    assert.equal(r.currency, 'AED');
    assert.deepEqual(r.cuisines, ['Vegetarian', 'Indian', 'Asian', 'South indian', 'Street food', 'North indian', 'Veg only']);
    assert.deepEqual(r.cuisineIds, ['171', '104', '385', '1130', '1167', '1169', '2013']);
    assert.equal(r.rating, 4.9);
    assert.equal(r.ratingCount, 500);
    assert.deepEqual(r.location, { area: 'The Palm Jumeirah', city: 'Dubai', platformAreaId: 1333, platformCityId: 35, lat: 25.111222348578067, lng: 55.141854912966906 });
    assert.equal(r.imageUrl, 'https://talabat.dhmedia.io/image/talabat/restaurants/KAMAT_1638350200016715497.jpg');
    assert.match(r.logoUrl!, /^https:\/\/talabat\.dhmedia\.io\/image\/talabat\/restaurants\/logo2_\d+\.jpg$/);
    // Address-dependent placeholders are kept raw only.
    assert.equal(r.deliveryFeeRaw, '0');
    assert.equal(r.minimumOrderRaw, 0);
    assert.equal(r.deliveryTimeRaw, '0 mins');
  });

  test('categories: 28 real sections in display order; the synthetic "Picks for you" section is skipped', () => {
    assert.equal(EN.categories.length, 28);
    assert.deepEqual(EN.categories[0], { platformCategoryId: '20581457', name: 'Thali', sortOrder: 0 });
    assert.deepEqual(EN.categories[27], { platformCategoryId: '20581483', name: 'Stimulators', sortOrder: 27 });
    EN.categories.forEach((c, i) => assert.equal(c.sortOrder, i));
    assert.ok(EN.categories.every(c => /^[1-9]\d+$/.test(c.platformCategoryId!)));
    assert.ok(!EN.categories.some(c => /Picks for you/.test(c.name)));
  });

  test('items: 333 distinct Talabat IDs, each in exactly one real category', () => {
    assert.equal(EN.items.length, 333);
    assert.equal(new Set(EN.items.map(i => i.platformItemId)).size, 333);
    assert.ok(EN.items.every(i => i.categoryIndex !== undefined && i.platformCategoryId === EN.categories[i.categoryIndex].platformCategoryId));
    assert.deepEqual(EN.stats, { itemsSeen: 333, itemsParsed: 333, itemsRejected: 0, syntheticSectionEntries: 6, duplicateItemEntries: 0, itemsWithModifiers: 153 });
  });

  test('item fields: price, currency, description, original image without resize query', () => {
    const thali = EN.items.find(i => i.platformItemId === THALI)!;
    assert.equal(thali.name, 'Thali');
    assert.equal(thali.price, 35);
    assert.equal(thali.currency, 'AED');
    assert.equal(thali.originalPrice, undefined);
    assert.match(thali.description!, /^Dry Veg\. South Indian/);
    assert.equal(thali.categoryName, 'Thali');
    assert.equal(thali.positionInCategory, 0);
    assert.equal(thali.imageUrl, 'https://talabat.dhmedia.io/image/talabat/MenuItems/82C81FF00D451C2711F13728E6C8D608');
    assert.equal(thali.hasImage, true);
    assert.ok(EN.items.every(i => i.imageUrl && !i.imageUrl.includes('?') && !i.imageUrl.includes('&amp;')));
    assert.equal(EN.items.filter(i => i.description === undefined).length, 10);
  });

  test('recommended items keep their real category; modifiers are flagged, not invented', () => {
    const roti = EN.items.find(i => i.platformItemId === TANDOORI_ROTI)!;
    assert.equal(roti.platformCategoryId, INDIAN_BREAD);
    assert.equal(roti.isRecommended, true);
    assert.equal(EN.items.filter(i => i.isRecommended).length, 6);
    assert.equal(EN.items.filter(i => i.hasModifiers).length, 153);
    assert.ok(EN.items.every(i => !('modifiers' in i)));
  });
});

describe('Talabat parser — Arabic fixture', () => {
  test('same restaurant, categories, item IDs, prices and images as EN; localized text differs', () => {
    assert.equal(AR.detectedLocale, 'ar');
    assert.deepEqual(codes(AR), []);
    const r = AR.restaurant!;
    assert.equal(r.platformRestaurantId, '773429');
    assert.equal(r.slug, 'kamat-vegetarian-the-palm-jumeirah');
    assert.equal(r.name, 'كامات فيجتريان, نخلة الجميرا');
    assert.equal(r.brandName, 'كامات فيجتريان');
    assert.equal(r.url, URLS.ar);
    assert.equal(r.cuisines[1], 'هندي');
    assert.deepEqual(r.cuisineIds, EN.restaurant!.cuisineIds);
    assert.equal(r.location.area, 'نخلة الجميرا');
    assert.equal(r.location.city, 'دبي');

    assert.deepEqual(AR.categories.map(c => c.platformCategoryId), EN.categories.map(c => c.platformCategoryId));
    assert.equal(AR.categories[0].name, 'ثالي');
    const en = new Map(EN.items.map(i => [i.platformItemId, i]));
    assert.equal(AR.items.length, 333);
    for (const item of AR.items) {
      const twin = en.get(item.platformItemId)!;
      assert.ok(twin, item.platformItemId);
      assert.equal(item.price, twin.price);
      assert.equal(item.imageUrl, twin.imageUrl);
      assert.equal(item.platformCategoryId, twin.platformCategoryId);
      assert.equal(item.hasModifiers, twin.hasModifiers);
      assert.notEqual(item.name, twin.name);
    }
  });

  test('coordinates written with the Arabic decimal separator parse to the same numbers', () => {
    assert.match(HTML.ar, /"latitude":"25٫111222348578067"/);
    assert.equal(AR.restaurant!.location.lat, EN.restaurant!.location.lat);
    assert.equal(AR.restaurant!.location.lng, EN.restaurant!.location.lng);
  });

  test('both locales yield identical identity inputs', () => {
    assert.deepEqual(getTalabatIdentityInputs(AR), getTalabatIdentityInputs(EN));
    assert.deepEqual(getTalabatIdentityInputs(EN).restaurant, { kind: 'id', value: '773429' });
    assert.deepEqual(getTalabatIdentityInputs(EN).unresolvedItemIndexes, []);
  });
});

describe('Talabat parser — missing and malformed fields', () => {
  test('item without a name is rejected; the rest of the menu is kept', () => {
    const r = parse('en', withMenuState(HTML.en, s => { section(s, 1).items[0].name = '  '; }));
    assert.equal(r.items.length, 332);
    assert.equal(r.stats.itemsRejected, 1);
    assert.ok(codes(r).includes('MISSING_NAME'));
  });

  test('malformed prices are rejected; numeric strings (incl. Arabic digits) are accepted', () => {
    const page = withMenuState(HTML.en, s => {
      const idli = section(s, 2).items;
      idli[0].price = 'abc';
      idli[1].price = -4;
      idli[2].price = null;
      idli[3].price = '12.5';
      idli[4].price = '١٢٫٥';
    });
    const r = parse('en', page);
    assert.equal(r.stats.itemsRejected, 3);
    assert.equal(r.warnings.filter(w => w.code === 'INVALID_PRICE').length, 3);
    const idli = r.items.filter(i => i.platformCategoryId === '20581459');
    assert.equal(idli.length, 5);
    assert.equal(idli[0].price, 12.5);
    assert.equal(idli[1].price, 12.5);
    assert.equal(idli[0].positionInCategory, 0);
  });

  test('oldPrice above price becomes originalPrice; -1 and malformed values do not', () => {
    const page = withMenuState(HTML.en, s => {
      section(s, 1).items[0].oldPrice = 40;
      section(s, 2).items[0].oldPrice = 'n/a';
    });
    const r = parse('en', page);
    assert.equal(r.items.find(i => i.platformItemId === THALI)!.originalPrice, 40);
    assert.ok(codes(r).includes('INVALID_ORIGINAL_PRICE'));
    assert.equal(r.items.filter(i => i.originalPrice !== undefined).length, 1);
  });

  test('missing or invalid item IDs fall back to position; duplicates across sections keep the first', () => {
    const page = withMenuState(HTML.en, s => {
      delete section(s, 2).items[0].id;
      section(s, 2).items[1].id = -5;
      section(s, 3).items[0].id = Number(THALI);
    });
    const r = parse('en', page);
    assert.ok(codes(r).includes('INVALID_ITEM_ID'));
    assert.ok(codes(r).includes('DUPLICATE_ITEM_ID'));
    assert.equal(r.stats.duplicateItemEntries, 1);
    assert.equal(r.items.filter(i => i.platformItemId === THALI).length, 1);
    assert.equal(r.items.find(i => i.platformItemId === THALI)!.platformCategoryId, '20581457');
    const inputs = getTalabatIdentityInputs(r);
    const positional = inputs.items.filter(i => i.identity.kind === 'position');
    assert.deepEqual(positional.map(p => p.identity.value), [0, 1]);
  });

  test('images: isWithImage=false and malformed URLs produce no image; resize URLs are normalized', () => {
    const page = withMenuState(HTML.en, s => {
      section(s, 1).items[0].isWithImage = false;
      Object.assign(section(s, 2).items[0], { originalImage: 'not a url', image: 'javascript:alert(1)' });
      Object.assign(section(s, 2).items[1], { originalImage: null, image: 'https://talabat.dhmedia.io/image/talabat/MenuItems/ABC?width=172&amp;height=172' });
    });
    const r = parse('en', page);
    const idli = r.items.filter(i => i.platformCategoryId === '20581459');
    assert.equal(r.items.find(i => i.platformItemId === THALI)!.imageUrl, undefined);
    assert.equal(r.items.find(i => i.platformItemId === THALI)!.hasImage, false);
    assert.equal(idli[0].imageUrl, undefined);
    assert.equal(idli[1].imageUrl, 'https://talabat.dhmedia.io/image/talabat/MenuItems/ABC');
    assert.equal(r.warnings.filter(w => w.code === 'INVALID_IMAGE_URL').length, 1);
  });

  test('category without ID uses position identity; category without name keeps items uncategorized', () => {
    const page = withMenuState(HTML.en, s => {
      delete section(s, 1).id;
      section(s, 2).name = '';
    });
    const r = parse('en', page);
    assert.ok(codes(r).includes('MISSING_CATEGORY_ID'));
    assert.ok(codes(r).includes('INVALID_CATEGORY'));
    assert.equal(r.categories.length, 27);
    assert.equal(r.categories[0].platformCategoryId, undefined);
    assert.deepEqual(getTalabatIdentityInputs(r).categories[0].identity, { kind: 'position', value: 0 });
    const idli = r.items.filter(i => i.categoryIndex === undefined);
    assert.equal(idli.length, 8);
    assert.ok(idli.every(i => i.platformItemId));
  });

  test('missing currency rejects every item instead of guessing one', () => {
    const r = parse('en', withMenuState(HTML.en, s => { s.currentCountry = null; }));
    assert.equal(r.restaurant!.currency, undefined);
    assert.equal(r.items.length, 0);
    assert.equal(r.stats.itemsRejected, 333);
    assert.ok(codes(r).includes('MISSING_CURRENCY'));
  });

  test('restaurant ID: falls back to the page query, then to the slug anchor; mismatches are reported', () => {
    const noBranch = parse('en', withMenuState(HTML.en, s => { delete s.restaurant.branchId; }));
    assert.equal(noBranch.restaurant!.platformRestaurantId, '773429');
    assert.ok(codes(noBranch).includes('MISSING_RESTAURANT_ID'));

    const anchorOnly = parse('en', withMenuState(HTML.en, (s, d) => { delete s.restaurant.branchId; delete d.query.branchId; }));
    assert.equal(anchorOnly.restaurant!.platformRestaurantId, undefined);
    assert.deepEqual(getTalabatIdentityInputs(anchorOnly).restaurant, { kind: 'anchor', value: 'kamat-vegetarian-the-palm-jumeirah' });

    const mismatch = parse('en', withMenuState(HTML.en, s => { s.restaurant.branchId = 111; }));
    assert.ok(codes(mismatch).includes('RESTAURANT_ID_MISMATCH'));
    // The chain-level ID is never promoted to the branch identity.
    assert.equal(anchorOnly.restaurant!.platformBrandId, '2699');
  });

  test('items listed outside every section are reported, not silently dropped', () => {
    const page = withMenuState(HTML.en, s => { s.menuData.items.push({ id: 999999001, name: 'Ghost', price: 1 }); });
    const r = parse('en', page);
    assert.ok(codes(r).includes('ITEMS_OUTSIDE_SECTIONS'));
    assert.equal(r.items.length, 333);
  });

  test('no __NEXT_DATA__ (or malformed JSON): no menu, restaurant from canonical URL + JSON-LD', () => {
    for (const page of [HTML.en.replace(NEXT_DATA_RE, ''), HTML.en.replace(NEXT_DATA_RE, '$1{not json$3')]) {
      const r = parse('en', page);
      assert.equal(r.dataSource, 'none');
      assert.equal(r.items.length, 0);
      assert.equal(r.categories.length, 0);
      assert.ok(codes(r).includes('NEXT_DATA_UNAVAILABLE'));
      assert.ok(codes(r).includes('NO_ITEMS'));
      assert.equal(r.restaurant!.platformRestaurantId, '773429');
      assert.equal(r.restaurant!.slug, 'kamat-vegetarian-the-palm-jumeirah');
      assert.equal(r.restaurant!.name, 'Kamat Vegetarian');
      assert.equal(r.restaurant!.location.lat, 25.111222348578067);
    }
  });

  test('locale mismatch, empty input and unsupported locales', () => {
    assert.ok(codes(parse('ar', HTML.en)).includes('LOCALE_MISMATCH'));
    const empty = parseTalabatMenu(undefined as unknown as string, { locale: 'en', sourceUrl: URLS.en });
    assert.equal(empty.dataSource, 'none');
    assert.ok(codes(empty).includes('MISSING_RESTAURANT_NAME'));
    assert.throws(() => parseTalabatMenu(HTML.en, { locale: 'fr' as DiningLocale, sourceUrl: URLS.en }), /Unsupported locale/);
  });
});

describe('Talabat parser — helpers', () => {
  test('parseTalabatNumber', () => {
    assert.equal(parseTalabatNumber(5), 5);
    assert.equal(parseTalabatNumber('25٫5'), 25.5);
    assert.equal(parseTalabatNumber('٣٥'), 35);
    assert.equal(parseTalabatNumber(' 7.25 '), 7.25);
    for (const bad of ['', 'AED 5', '1,000', NaN, Infinity, null, undefined, {}]) assert.equal(parseTalabatNumber(bad), undefined, String(bad));
  });

  test('normalizeTalabatImageUrl', () => {
    assert.equal(
      normalizeTalabatImageUrl('https://talabat.dhmedia.io/image/talabat/MenuItems/047ABF?width=172&amp;height=172'),
      'https://talabat.dhmedia.io/image/talabat/MenuItems/047ABF'
    );
    for (const bad of ['', 'javascript:alert(1)', 'data:image/png;base64,AA', 'https://cdn.example.com/', 42, null]) {
      assert.equal(normalizeTalabatImageUrl(bad), undefined, String(bad));
    }
  });

  test('readTalabatUrlIdentity', () => {
    assert.deepEqual(readTalabatUrlIdentity(URLS.ar), { branchId: '773429', slug: 'kamat-vegetarian-the-palm-jumeirah' });
    assert.deepEqual(readTalabatUrlIdentity('/uae/restaurant/773429/kamat'), { branchId: '773429', slug: 'kamat' });
    assert.deepEqual(readTalabatUrlIdentity('https://www.talabat.com/uae'), {});
    assert.deepEqual(readTalabatUrlIdentity(undefined), {});
  });
});

describe('Talabat fixtures — sanitization', () => {
  test('saved fixtures contain no visitor, session or tracking data', () => {
    for (const html of Object.values(HTML)) {
      for (const marker of ['userIpAddress', 'initialReduxState', 'initialI18nStore', 'gtmEventData', 'buildId', 'hostName', 'filteredCategories', 'ExperimentData']) {
        assert.ok(!html.includes(marker), marker);
      }
      assert.doesNotMatch(html, /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/);
      assert.doesNotMatch(html, /token|session|cookie|authorization/i);
    }
  });

  test('sanitizer keeps the menu payload and drops sensitive keys', () => {
    const payload = {
      props: {
        userIpAddress: '203.0.113.7',
        initialReduxState: { customer: { email: 'a@b.c' } },
        pageProps: {
          currentURL: '/uae/restaurant/1/x',
          gtmEventData: { x: 1 },
          initialMenuState: {
            restaurant: { branchId: 1, name: 'R', sessionId: 's', availablePaymentMethods: [] },
            currentCountry: { currencyISO: 'AED', dialCode: '+971' },
            menuData: { categories: [{ id: 2, name: 'C', items: [{ id: 3, name: 'I', price: 1, authToken: 't' }] }], items: [], filteredCategories: [] },
            sbExperimentData: { a: 1 },
          },
        },
      },
      buildId: 'abc',
      query: { branchId: '1' },
    };
    const out = sanitizeTalabatHtml(`<html lang="en"><head><title>T</title></head><body><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(payload)}</script></body></html>`);
    const data = JSON.parse(NEXT_DATA_RE.exec(out)![2]);
    const state = data.props.pageProps.initialMenuState;
    assert.equal(data.props.userIpAddress, undefined);
    assert.equal(data.props.initialReduxState, undefined);
    assert.equal(data.buildId, undefined);
    assert.equal(state.restaurant.sessionId, undefined);
    assert.equal(state.restaurant.availablePaymentMethods, undefined);
    assert.deepEqual(state.currentCountry, { currencyISO: 'AED' });
    assert.equal(state.menuData.filteredCategories, undefined);
    assert.deepEqual(state.menuData.categories[0].items[0], { id: 3, name: 'I', price: 1 });
    assert.equal(state.sbExperimentData, undefined);
    assert.throws(() => sanitizeTalabatHtml('<html></html>'), /No __NEXT_DATA__/);
  });
});
