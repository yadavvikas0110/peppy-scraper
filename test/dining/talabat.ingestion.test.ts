/// <reference types="node" />
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';
import { ObjectId } from 'mongodb';
import { DiningScrapeContext, runDiningScrape, validateDiningScrapeRequest } from '../../src/dining/dining.service';
import type { DiningLocale, DiningMenuCategory, DiningMenuItem, DiningRestaurant } from '../../src/dining/dining.types';
import { validateMenuCategory, validateMenuItem, validateRestaurant } from '../../src/dining/dining.validator';
import type { DiningMappedMenu } from '../../src/dining/platforms/platform.mapper';
import { mapTalabatMenu } from '../../src/dining/platforms/talabat/talabat.mapper';
import { parseTalabatMenu } from '../../src/dining/platforms/talabat/talabat.parser';
import { applyUpdate } from '../../src/dining/repositories/document-update';
import { buildCategoryUpdate } from '../../src/dining/repositories/menu-category.repository';
import { buildItemUpdate } from '../../src/dining/repositories/menu-item.repository';
import type { DiningWriteContext, RestaurantRef } from '../../src/dining/repositories/repository.types';
import { buildRestaurantUpdate } from '../../src/dining/repositories/restaurant.repository';
import { closeTestClient, fakeScrapeDo, LOCAL_DB_SKIP, openTestDb, TestDb } from './helpers';

// Talabat through the shared ingestion contract. No network; the DB section needs a local MongoDB.

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
const THALI_CATEGORY = '20581457';
const NOW = new Date('2026-10-09T12:00:00.000Z');

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

const request = (locale: DiningLocale, overrides: Record<string, unknown> = {}) => ({ platform: 'talabat', locale, targetUrl: URLS[locale], dryRun: true, ...overrides });

describe('Talabat scrape requests', () => {
  test('the exact EN and AR Talabat URLs are accepted unchanged', () => {
    for (const locale of ['en', 'ar'] as const) {
      const v = validateDiningScrapeRequest(request(locale));
      assert.ok(v.ok);
      assert.deepEqual(v.value, { platform: 'talabat', locale, targetUrl: URLS[locale], dryRun: true });
    }
  });

  test('locale/URL mismatches and cross-platform URLs are rejected', () => {
    const mismatch = validateDiningScrapeRequest(request('en', { targetUrl: URLS.ar }));
    assert.ok(!mismatch.ok);
    assert.match(mismatch.errors[0].message, /"ar" page but locale is "en"/);
    assert.ok(!validateDiningScrapeRequest(request('en', { targetUrl: 'https://deliveroo.ae/en/menu/Dubai/dubai-business-bay/kamat-dt/' })).ok);
    assert.ok(!validateDiningScrapeRequest({ platform: 'deliveroo', locale: 'en', targetUrl: URLS.en }).ok);
  });
});

// The same update builders + applyUpdate the repositories use to compute the stored document.
describe('Talabat EN + AR through the shared upsert builders (in memory, no database)', () => {
  const ctx = (locale: DiningLocale): DiningWriteContext => ({ locale, runId: `run_${locale}_test`, now: NOW });

  function upsertAll(order: DiningLocale[], menus: Record<DiningLocale, DiningMappedMenu>) {
    let restaurant: DiningRestaurant | null = null;
    const categories = new Map<string, DiningMenuCategory>();
    const items = new Map<string, DiningMenuItem>();
    const ref: RestaurantRef = { _id: new ObjectId(), platform: 'talabat', sourceKey: menus.en.restaurant.sourceKey, platformRestaurantId: '773429', persisted: true };
    const categoryIds = new Map<string, ObjectId>();
    for (const locale of order) {
      const menu = menus[locale];
      restaurant = applyUpdate<DiningRestaurant>(restaurant, buildRestaurantUpdate(menu.restaurant, ctx(locale)));
      for (const dto of menu.categories) {
        categories.set(dto.sourceKey, applyUpdate<DiningMenuCategory>(categories.get(dto.sourceKey) ?? null, buildCategoryUpdate(ref, dto, ctx(locale))));
        if (!categoryIds.has(dto.sourceKey)) categoryIds.set(dto.sourceKey, new ObjectId());
      }
      for (const dto of menu.items) {
        const existing = items.get(dto.platformItemId!) ?? null;
        const categoryId = dto.categorySourceKey ? categoryIds.get(dto.categorySourceKey) : undefined;
        items.set(dto.platformItemId!, applyUpdate<DiningMenuItem>(existing, buildItemUpdate(ref, dto, categoryId, existing, ctx(locale))));
      }
    }
    return { restaurant: restaurant!, categories, items, categoryIds };
  }

  const menus = { en: mapped('en'), ar: mapped('ar') };

  test('both orders produce one restaurant, 28 categories and 333 items with both languages', () => {
    for (const order of [['en', 'ar'], ['ar', 'en']] as DiningLocale[][]) {
      const out = upsertAll(order, menus);
      assert.ok(validateRestaurant(out.restaurant).valid);
      assert.equal(out.restaurant.platformRestaurantId, '773429');
      assert.deepEqual(out.restaurant.name, { en: 'Kamat Vegetarian, The Palm Jumeirah', ar: 'كامات فيجتريان, نخلة الجميرا' });
      assert.deepEqual(out.restaurant.brandName, { en: 'Kamat Vegetarian', ar: 'كامات فيجتريان' });
      assert.deepEqual(out.restaurant.url, URLS);
      assert.equal(out.restaurant.cuisines.length, 7);
      assert.equal(out.restaurant.location.area, 'The Palm Jumeirah');

      assert.equal(out.categories.size, 28);
      for (const c of out.categories.values()) {
        assert.ok(validateMenuCategory({ ...c, restaurantId: new ObjectId() }).valid);
        assert.ok(c.name.en && c.name.ar);
      }

      assert.equal(out.items.size, 333);
      for (const item of out.items.values()) {
        assert.ok(validateMenuItem(item).valid, item.platformItemId);
        assert.ok(item.name.en && item.name.ar && item.name.en !== item.name.ar);
        assert.ok(item.categoryName?.en && item.categoryName?.ar);
        assert.equal(item.currency, 'AED');
        assert.ok(item.price > 0);
        assert.match(item.imageUrl!, /^https:\/\/talabat\.dhmedia\.io\/image\/talabat\/MenuItems\/[0-9A-F]+$/);
        assert.equal(item.modifiers, undefined);
      }
      const thali = out.items.get(THALI)!;
      assert.deepEqual(thali.name, { en: 'Thali', ar: 'ثالي' });
      assert.equal(thali.categoryId, out.categoryIds.get(`talabat:restaurant:id:773429:category:id:${THALI_CATEGORY}`));
      assert.equal([...out.items.values()].filter(i => !i.description).length, 10);
      assert.equal([...out.items.values()].filter(i => i.description?.en && i.description?.ar).length, 323);
    }
  });

  test('an AR page without a description clears only description.ar', () => {
    const arNoDescription = mapped('ar', withMenuState(HTML.ar, s => { s.menuData.categories[1].items[0].description = null; }));
    const out = upsertAll(['en', 'ar'], { en: menus.en, ar: arNoDescription });
    const thali = out.items.get(THALI)!;
    assert.ok(thali.description?.en);
    assert.equal(thali.description?.ar, undefined);
  });

  test('discounts are carried as originalPrice when the page shows one', () => {
    const discounted = (locale: DiningLocale) => mapped(locale, withMenuState(HTML[locale], s => { s.menuData.categories[1].items[0].oldPrice = 42; }));
    const out = upsertAll(['en', 'ar'], { en: discounted('en'), ar: discounted('ar') });
    const thali = out.items.get(THALI)!;
    assert.equal(thali.price, 35);
    assert.equal(thali.originalPrice, 42);
    assert.ok(validateMenuItem(thali).valid);
  });

  test('unknown availability is never stored as available or unavailable, in either locale order', () => {
    for (const order of [['en'], ['ar'], ['en', 'ar'], ['ar', 'en']] as DiningLocale[][]) {
      const items = [...upsertAll(order, menus).items.values()];
      assert.equal(items.length, 333);
      for (const item of items) {
        assert.equal(item.availabilityStatus, 'unknown');
        assert.equal('isAvailable' in item, false);
        assert.ok(validateMenuItem(item).valid);
      }
      assert.equal(items.filter(i => i.hasModifiers === true).length, 153);
      assert.ok(items.every(i => i.modifiers === undefined));
    }
  });

  test('a Talabat item previously stored as available is corrected to unknown, not left available', () => {
    const ref: RestaurantRef = { _id: new ObjectId(), platform: 'talabat', sourceKey: menus.en.restaurant.sourceKey, platformRestaurantId: '773429', persisted: true };
    const dto = menus.en.items.find(i => i.platformItemId === THALI)!;
    const legacy = { ...applyUpdate<DiningMenuItem>(null, buildItemUpdate(ref, { ...dto, availabilityStatus: undefined }, undefined, null, ctx('en'))) };
    assert.equal(legacy.isAvailable, true);
    const update = buildItemUpdate(ref, dto, undefined, legacy, ctx('en'));
    assert.ok(update.unset.includes('isAvailable'));
    const corrected = applyUpdate<DiningMenuItem>(legacy, update);
    assert.deepEqual([corrected.availabilityStatus, 'isAvailable' in corrected], ['unknown', false]);
    assert.ok(validateMenuItem(corrected).valid);
  });
});

describe('Talabat through runDiningScrape against a local MongoDB (fake Scrape.do)', { skip: LOCAL_DB_SKIP }, () => {
  let t: TestDb;
  const silent = { log: () => {}, warn: () => {}, error: () => {} };
  const page = (url: string) => HTML[url.includes('/ar/') ? 'ar' : 'en'];

  before(async () => { t = await openTestDb('talabat'); });
  beforeEach(async () => { await t.reset(); });
  after(async () => { await t.close(); await closeTestClient(); });

  const context = (): DiningScrapeContext => ({
    scrapeDo: fakeScrapeDo(page, { requestCost: 1, remainingCredits: 888 }).client,
    repositories: t.repos,
    logger: silent,
    now: () => NOW,
  });

  test('EN and AR dry runs: full counts, no menu writes, one audit run each', async () => {
    for (const locale of ['en', 'ar'] as const) {
      const result = await runDiningScrape(request(locale), context());
      assert.equal(result.status, 'succeeded');
      assert.equal(result.dryRun, true);
      assert.equal(result.restaurantId, undefined);
      assert.deepEqual(
        { r: result.counts.restaurantsCreated, c: result.counts.categoriesCreated, seen: result.counts.itemsSeen, i: result.counts.itemsCreated, rejected: result.counts.itemsRejected + result.counts.categoriesRejected },
        { r: 1, c: 28, seen: 333, i: 333, rejected: 0 }
      );
      assert.deepEqual(result.completeness, { complete: true, reasons: [], itemsSeen: 333, itemsMapped: 333, itemsRejected: 0 });
      assert.deepEqual(result.warnings.byCode, { MODIFIERS_NOT_EMBEDDED: 1 });
      assert.deepEqual(result.errors, []);
      assert.deepEqual(result.fetch, { statusCode: 200, initialStatusCode: 200, finalUrl: URLS[locale], requestCost: 1, remainingCredits: 888, attempts: 1, durationMs: 1200 });
    }
    for (const c of [t.collections.restaurants, t.collections.menuCategories, t.collections.menuItems]) {
      assert.equal(await c.countDocuments(), 0);
    }
    const runs = await t.collections.scrapeRuns.find().toArray();
    assert.equal(runs.length, 2);
    assert.ok(runs.every(r => r.dryRun && r.platform === 'talabat' && r.status === 'succeeded'));
  });

  test('EN then AR imports into the test database merge into the same documents', async () => {
    await runDiningScrape(request('en', { dryRun: false }), context());
    const ar = await runDiningScrape(request('ar', { dryRun: false }), context());
    assert.equal(ar.counts.restaurantsCreated + ar.counts.categoriesCreated + ar.counts.itemsCreated, 0);
    assert.equal(ar.counts.itemsUpdated, 333);
    assert.equal(ar.counts.itemsMarkedInactive, 0);

    const restaurants = await t.collections.restaurants.find().toArray();
    assert.equal(restaurants.length, 1);
    assert.equal(restaurants[0].platform, 'talabat');
    assert.equal(restaurants[0].platformRestaurantId, '773429');
    assert.equal(await t.collections.menuCategories.countDocuments({ platformRestaurantId: '773429' }), 28);
    const items = await t.collections.menuItems.find().toArray();
    assert.equal(items.length, 333);
    assert.equal(new Set(items.map(i => i.platformItemId)).size, 333);
    assert.ok(items.every(i => i.platform === 'talabat' && i.name.en && i.name.ar && i.categoryId && i.modifiers === undefined));
    assert.ok(items.every(i => i.availabilityStatus === 'unknown' && !('isAvailable' in i)));
    assert.equal(await t.collections.menuItems.countDocuments({ isAvailable: true }), 0);
    assert.equal(await t.collections.menuItems.countDocuments({ hasModifiers: true }), 153);
    const thali = items.find(i => i.platformItemId === THALI)!;
    assert.deepEqual(thali.name, { en: 'Thali', ar: 'ثالي' });
    assert.deepEqual(thali.sourceUrl, URLS);

    const again = await runDiningScrape(request('en', { dryRun: false }), context());
    assert.equal(again.counts.itemsUnchanged, 333);
    assert.equal(await t.collections.menuItems.countDocuments(), 333);
  });
});
