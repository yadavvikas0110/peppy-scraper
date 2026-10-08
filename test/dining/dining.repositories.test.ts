/// <reference types="node" />
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';
import { decideInactiveMarking, persistMappedMenu, PersistOptions } from '../../src/dining/dining.persistence';
import type { DiningLocale } from '../../src/dining/dining.types';
import { validateMenuCategory, validateMenuItem, validateRestaurant } from '../../src/dining/dining.validator';
import type { DiningMappedMenu } from '../../src/dining/platforms/platform.mapper';
import { applyUpdate, createUpdate, setLocalized, unsetLocalized } from '../../src/dining/repositories/document-update';
import { mergeModifierGroups } from '../../src/dining/repositories/menu-item.repository';
import { DiningIdentityDowngradeError } from '../../src/dining/repositories/repository.types';
import {
  DiningRunConflictError,
  sanitizeFetchMetadata,
  sanitizeRunMessage,
  STALE_RUN_MS,
} from '../../src/dining/repositories/scrape-run.repository';
import {
  closeTestClient,
  fixtureHtml,
  LOCAL_DB_SKIP,
  mappedMenu,
  openTestDb,
  STUFFED_NAN,
  TestDb,
  THALI,
  withoutNextData,
} from './helpers';

const EN = mappedMenu('en');
const AR = mappedMenu('ar');
const THALI_KEY = `deliveroo:restaurant:id:76728:item:id:${THALI}`;
let runCounter = 0;

function opts(locale: DiningLocale, extra: Partial<PersistOptions> = {}): PersistOptions {
  runCounter++;
  return { locale, runId: `run_test_${String(runCounter).padStart(4, '0')}`, now: new Date(Date.UTC(2026, 9, 8, 10, 0, runCounter)), ...extra };
}

function clone(menu: DiningMappedMenu): DiningMappedMenu {
  return JSON.parse(JSON.stringify(menu));
}

// ─── Pure helpers (no database) ──────────────────────────────────────────────

describe('field-level update helpers', () => {
  test('setLocalized writes one locale path; replay keeps the other locale', () => {
    const u = createUpdate();
    setLocalized(u, 'name', 'ar', { ar: 'ثالي' });
    assert.deepEqual(u.set, { 'name.ar': 'ثالي' });
    assert.deepEqual(applyUpdate({ name: { en: 'Thali' } }, u), { name: { en: 'Thali', ar: 'ثالي' } });
  });

  test('unsetLocalized removes one locale, or the whole field when it was the only one', () => {
    const both = createUpdate();
    unsetLocalized(both, { description: { en: 'a', ar: 'b' } }, 'description', 'en');
    assert.deepEqual(both.unset, ['description.en']);
    const only = createUpdate();
    unsetLocalized(only, { description: { en: 'a' } }, 'description', 'en');
    assert.deepEqual(only.unset, ['description']);
  });

  test('modifier merge: latest structure, other-locale names preserved by group/option ID', () => {
    const existing = [{
      groupId: 'g1', name: { en: 'Size' }, required: true, minSelections: 1, maxSelections: 1,
      options: [{ optionId: 'o1', name: { en: 'Small' }, priceDelta: 0 }, { optionId: 'o2', name: { en: 'Large' }, priceDelta: 5 }],
    }];
    const incoming = [{
      groupId: 'g1', name: { ar: 'الحجم' }, required: true, minSelections: 1, maxSelections: 1,
      options: [{ optionId: 'o2', name: { ar: 'كبير' }, priceDelta: 6 }, { optionId: 'o3', name: { ar: 'وسط' }, priceDelta: 3 }],
    }];
    assert.deepEqual(mergeModifierGroups(existing, incoming, 'ar'), [{
      groupId: 'g1', name: { en: 'Size', ar: 'الحجم' }, required: true, minSelections: 1, maxSelections: 1,
      options: [{ optionId: 'o2', name: { en: 'Large', ar: 'كبير' }, priceDelta: 6 }, { optionId: 'o3', name: { ar: 'وسط' }, priceDelta: 3 }],
    }]);
  });

  test('inactive guard decisions', () => {
    const base = { menu: EN, previousActiveItems: 332, itemsRejected: 0, identityDowngrade: false, allowDeactivation: true };
    assert.equal(decideInactiveMarking(base).applied, true);
    assert.deepEqual(decideInactiveMarking({ ...base, previousActiveItems: 1000 }).reasons, ['SUSPICIOUS_ITEM_DROP']);
    assert.deepEqual(decideInactiveMarking({ ...base, itemsRejected: 100 }).reasons, ['TOO_MANY_REJECTED_ITEMS']);
    assert.deepEqual(decideInactiveMarking({ ...base, allowDeactivation: false }).reasons, ['DISABLED_BY_CALLER']);
    const partial = { ...EN, completeness: { ...EN.completeness, complete: false, reasons: ['DOM_FALLBACK'] } };
    assert.deepEqual(decideInactiveMarking({ ...base, menu: partial }).reasons, ['INCOMPLETE_DOM_FALLBACK']);
    const empty = { ...EN, items: [], completeness: { ...EN.completeness, complete: false, reasons: ['NO_ITEMS'] } };
    assert.ok(decideInactiveMarking({ ...base, menu: empty }).reasons.includes('NO_ITEMS'));
  });

  test('run message and fetch sanitization never keep secrets', () => {
    assert.equal(
      sanitizeRunMessage('GET https://api.scrape.do/?token=abc123&url=x failed; retry ?token=zzz'),
      'GET <scrape.do request> failed; retry ?token=***'
    );
    assert.deepEqual(
      sanitizeFetchMetadata({ statusCode: 200, finalUrl: 'https://api.scrape.do/?token=abc', requestCost: 5, attempts: 1, token: 'abc' } as never),
      { statusCode: 200, requestCost: 5, attempts: 1 }
    );
  });
});

// ─── Repository integration (local MongoDB) ──────────────────────────────────

describe('dining repositories against a local MongoDB', { skip: LOCAL_DB_SKIP }, () => {
  let t: TestDb;

  before(async () => { t = await openTestDb('repos'); });
  beforeEach(async () => { await t.reset(); });
  after(async () => { await t?.close(); await closeTestClient(); });

  const persist = (menu: DiningMappedMenu, o: PersistOptions) => persistMappedMenu(t.repos, menu, o);

  test('1+15. EN insert: one restaurant, 28 categories, 332 items, exact statistics', async () => {
    const res = await persist(EN, opts('en'));
    assert.deepEqual(res.counts, {
      restaurantsCreated: 1, restaurantsUpdated: 0, restaurantsUnchanged: 0,
      categoriesCreated: 28, categoriesUpdated: 0, categoriesUnchanged: 0, categoriesRejected: 0, categoriesMarkedInactive: 0,
      itemsSeen: 332, itemsCreated: 332, itemsUpdated: 0, itemsUnchanged: 0, itemsRejected: 0, itemsMarkedInactive: 0,
    });
    const restaurants = await t.collections.restaurants.find().toArray();
    assert.equal(restaurants.length, 1);
    const r = restaurants[0];
    assert.equal(r.platformRestaurantId, '76728');
    assert.deepEqual(r.name, { en: 'Kamat Vegetarian - Business Bay' });
    assert.deepEqual(r.cuisines, ['Vegetarian', 'Indian', 'South Indian']);
    assert.equal(r.ratingCountText, '500+');
    assert.equal(r.isActive, true);
    assert.ok(r.lastScrapedAtByLocale.en && !r.lastScrapedAtByLocale.ar);
    assert.equal(validateRestaurant(r).valid, true);
    assert.equal(res.restaurantId, r._id.toHexString());
  });

  test('2. AR merges into the same restaurant field-by-field', async () => {
    await persist(EN, opts('en'));
    const res = await persist(AR, opts('ar'));
    assert.equal(res.counts.restaurantsUpdated, 1);
    const restaurants = await t.collections.restaurants.find().toArray();
    assert.equal(restaurants.length, 1);
    const r = restaurants[0];
    assert.deepEqual(r.name, { en: 'Kamat Vegetarian - Business Bay', ar: 'Kamat Vegetarian - Business Bay' });
    assert.deepEqual(Object.keys(r.url).sort(), ['ar', 'en']);
    assert.deepEqual(r.cuisines, ['Vegetarian', 'Indian', 'South Indian']);
    assert.ok(r.lastScrapedAtByLocale.en && r.lastScrapedAtByLocale.ar);
  });

  test('3. EN item insert: canonical document with category reference and modifiers', async () => {
    await persist(EN, opts('en'));
    const thali = (await t.collections.menuItems.findOne({ sourceKey: THALI_KEY }))!;
    assert.equal(thali.platformItemId, THALI);
    assert.deepEqual(thali.name, { en: 'Thali' });
    assert.equal(thali.price, 35);
    assert.equal(thali.currency, 'AED');
    assert.equal(thali.isAvailable, true);
    assert.equal(thali.isActive, true);
    assert.deepEqual(thali.dietaryTags, []);
    assert.equal(thali.originalPrice, undefined);
    assert.equal(thali.modifiers![0].name.en, 'Your Choice Of');
    assert.equal(validateMenuItem(thali).valid, true);
  });

  test('4. AR item merge: one document, EN and AR text, numeric fields unchanged', async () => {
    await persist(EN, opts('en'));
    const res = await persist(AR, opts('ar'));
    assert.equal(res.counts.itemsCreated, 0);
    assert.equal(res.counts.itemsUpdated, 332);
    assert.equal(await t.collections.menuItems.countDocuments(), 332);

    const thali = (await t.collections.menuItems.findOne({ sourceKey: THALI_KEY }))!;
    assert.deepEqual(thali.name, { en: 'Thali', ar: 'ثالي' });
    assert.deepEqual(Object.keys(thali.description!).sort(), ['ar', 'en']);
    assert.deepEqual(Object.keys(thali.sourceUrl).sort(), ['ar', 'en']);
    assert.deepEqual(thali.categoryName, { en: 'Thali', ar: 'ثالي' });
    assert.equal(thali.price, 35);
    assert.match(thali.imageUrl!, /7f753dc1/);

    const nan = (await t.collections.menuItems.findOne({ platformItemId: STUFFED_NAN }))!;
    assert.deepEqual(nan.modifiers![0].name, { en: 'Your Choice Of', ar: 'إختيارك من' });
    assert.deepEqual(nan.modifiers![0].options.map(o => o.name), [{ en: 'Potato', ar: 'بطاطا' }, { en: 'Cauliflower', ar: 'قرنبيط' }]);
  });

  test('5. category upsert: one document per Deliveroo category, names merged', async () => {
    await persist(EN, opts('en'));
    await persist(AR, opts('ar'));
    const categories = await t.collections.menuCategories.find().sort({ sortOrder: 1 }).toArray();
    assert.equal(categories.length, 28);
    assert.deepEqual(categories[0].name, { en: 'Thali', ar: 'ثالي' });
    assert.equal(categories[0].platformCategoryId, '967617571');
    const restaurant = (await t.collections.restaurants.findOne())!;
    assert.ok(categories.every(c => c.restaurantId.equals(restaurant._id) && validateMenuCategory(c).valid));
  });

  test('6. item upsert: categoryId points at the canonical category', async () => {
    await persist(EN, opts('en'));
    const thali = (await t.collections.menuItems.findOne({ sourceKey: THALI_KEY }))!;
    const category = (await t.collections.menuCategories.findOne({ _id: thali.categoryId }))!;
    assert.equal(category.platformCategoryId, '967617571');
    assert.equal(await t.collections.menuItems.countDocuments({ categoryId: { $exists: false } }), 0);
  });

  test('7. repeated identical scrape is idempotent', async () => {
    await persist(EN, opts('en'));
    const before = await t.collections.menuItems.find().sort({ sourceKey: 1 }).toArray();
    const res = await persist(EN, opts('en'));
    assert.equal(res.counts.restaurantsUnchanged, 1);
    assert.equal(res.counts.categoriesUnchanged, 28);
    assert.equal(res.counts.itemsUnchanged, 332);
    assert.equal(res.counts.itemsCreated + res.counts.itemsUpdated, 0);
    const after = await t.collections.menuItems.find().sort({ sourceKey: 1 }).toArray();
    assert.equal(after.length, 332);
    const strip = (d: any) => { const { updatedAt, lastSeenAt, lastSeenAtByLocale, lastRunIdByLocale, ...rest } = d; return rest; };
    assert.deepEqual(after.map(strip), before.map(strip));
  });

  test('8–10. price, availability and modifier updates come from the latest scrape', async () => {
    await persist(EN, opts('en'));
    await persist(AR, opts('ar'));
    const next = clone(EN);
    const thali = next.items.find(i => i.platformItemId === THALI)!;
    thali.price = 38;
    thali.originalPrice = 40;
    thali.clear = thali.clear.filter(f => f !== 'originalPrice');
    thali.isAvailable = false;
    const nan = next.items.find(i => i.platformItemId === STUFFED_NAN)!;
    nan.modifiers![0].options = [{ ...nan.modifiers![0].options[1], priceDelta: 2 }];

    const res = await persist(next, opts('en'));
    assert.equal(res.counts.itemsUpdated, 2);
    assert.equal(res.counts.itemsUnchanged, 330);

    const storedThali = (await t.collections.menuItems.findOne({ platformItemId: THALI }))!;
    assert.equal(storedThali.price, 38);
    assert.equal(storedThali.originalPrice, 40);
    assert.equal(storedThali.isAvailable, false);
    assert.deepEqual(storedThali.name, { en: 'Thali', ar: 'ثالي' });

    const storedNan = (await t.collections.menuItems.findOne({ platformItemId: STUFFED_NAN }))!;
    assert.deepEqual(storedNan.modifiers![0].options, [
      { optionId: '1560783829', name: { en: 'Cauliflower', ar: 'قرنبيط' }, priceDelta: 2, currency: 'AED', isAvailable: true },
    ]);

    // Discount ended → originalPrice removed.
    await persist(EN, opts('en'));
    assert.equal((await t.collections.menuItems.findOne({ platformItemId: THALI }))!.originalPrice, undefined);
  });

  test('11. missing item → isActive=false (never deleted); seen again → active', async () => {
    await persist(EN, opts('en'));
    const without = clone(EN);
    without.items = without.items.filter(i => i.platformItemId !== THALI);
    const res = await persist(without, opts('en'));
    assert.equal(res.inactive.applied, true);
    assert.equal(res.counts.itemsMarkedInactive, 1);
    const thali = (await t.collections.menuItems.findOne({ sourceKey: THALI_KEY }))!;
    assert.equal(thali.isActive, false);
    assert.equal(await t.collections.menuItems.countDocuments(), 332);

    const back = await persist(EN, opts('en'));
    assert.equal(back.counts.itemsUpdated, 1);
    assert.equal((await t.collections.menuItems.findOne({ sourceKey: THALI_KEY }))!.isActive, true);
  });

  test('12. partial, empty-ish or suspicious scrapes never mark items inactive', async () => {
    await persist(EN, opts('en'));

    const partial = clone(EN);
    partial.items = partial.items.slice(0, 300);
    partial.completeness = { ...partial.completeness, complete: false, reasons: ['DOM_FALLBACK'] };
    const r1 = await persist(partial, opts('en'));
    assert.equal(r1.counts.itemsMarkedInactive, 0);
    assert.deepEqual(r1.inactive.reasons, ['INCOMPLETE_DOM_FALLBACK']);

    const dropped = clone(EN);
    dropped.items = dropped.items.slice(0, 50);
    const r2 = await persist(dropped, opts('en'));
    assert.equal(r2.counts.itemsMarkedInactive, 0);
    assert.deepEqual(r2.inactive.reasons, ['SUSPICIOUS_ITEM_DROP']);

    const disabled = await persist(clone(EN), opts('en', { allowDeactivation: false }));
    assert.equal(disabled.inactive.applied, false);
    assert.equal(await t.collections.menuItems.countDocuments({ isActive: true }), 332);
  });

  test('13. duplicate sourceKey protection: the colliding item is rejected, the rest persist', async () => {
    const restaurant = await t.repos.restaurants.upsert(EN.restaurant, opts('en'));
    await t.collections.menuItems.insertOne({
      ...(await t.collections.menuItems.findOne({})),
      platform: 'deliveroo', restaurantId: restaurant.restaurant._id, sourceKey: THALI_KEY, platformItemId: 'other-id',
    } as never);

    const res = await persist(EN, opts('en'));
    assert.equal(res.counts.itemsCreated, 331);
    assert.equal(res.counts.itemsRejected, 1);
    assert.deepEqual(res.rejected.map(r => [r.entity, r.sourceKey, r.code]), [['item', THALI_KEY, 'DUPLICATE_KEY']]);
    assert.equal(res.inactive.applied, true);
    assert.equal(await t.collections.menuItems.countDocuments({ sourceKey: THALI_KEY }), 1);
  });

  test('14. fallback sourceKey persistence (slug anchor + positions), EN/AR merged', async () => {
    const domEn = mappedMenu('en', withoutNextData(fixtureHtml('en')));
    const domAr = mappedMenu('ar', withoutNextData(fixtureHtml('ar')));
    const first = await persist(domEn, opts('en'));
    assert.equal(first.counts.itemsCreated, 332);
    assert.equal(first.inactive.applied, false);
    await persist(domAr, opts('ar'));

    const r = (await t.collections.restaurants.findOne())!;
    assert.equal(r.sourceKey, 'deliveroo:restaurant:anchor:kamat-dt');
    assert.equal(r.sourceKeyKind, 'anchor');
    const first0 = (await t.collections.menuItems.findOne({ sourceKey: 'deliveroo:restaurant:anchor:kamat-dt:category:id:967617571:item:pos:0' }))!;
    assert.deepEqual(first0.name, { en: 'Thali', ar: 'ثالي' });
    assert.ok(first0.categoryId instanceof ObjectId);
    assert.equal(await t.collections.menuItems.countDocuments(), 332);
  });

  test('14b. a slug-only page never duplicates an ID-keyed restaurant', async () => {
    await persist(EN, opts('en'));
    const domEn = mappedMenu('en', withoutNextData(fixtureHtml('en')));
    await assert.rejects(persist(domEn, opts('en')), DiningIdentityDowngradeError);
    assert.equal(await t.collections.restaurants.countDocuments(), 1);
    assert.equal(await t.collections.menuItems.countDocuments(), 332);
  });

  test('dry run computes counts and writes nothing', async () => {
    const res = await persist(EN, opts('en', { dryRun: true }));
    assert.equal(res.dryRun, true);
    assert.equal(res.counts.itemsCreated, 332);
    assert.equal(await t.collections.restaurants.countDocuments(), 0);
    assert.equal(await t.collections.menuItems.countDocuments(), 0);

    await persist(EN, opts('en'));
    const again = await persist(AR, opts('ar', { dryRun: true }));
    assert.equal(again.counts.itemsUpdated, 332);
    assert.equal((await t.collections.menuItems.findOne({ sourceKey: THALI_KEY }))!.name.ar, undefined);
  });

  test('16. scrape run lifecycle and concurrent-run lock', async () => {
    const runs = t.repos.runs;
    const target = { platform: 'deliveroo' as const, locale: 'en' as const, targetType: 'restaurant' as const, targetUrl: 'https://deliveroo.ae/en/menu/Dubai/x/y/', trigger: 'manual' as const, dryRun: false };
    const start = new Date('2026-10-08T10:00:00Z');
    const run = await runs.createRunning(target, start);
    assert.equal(run.status, 'running');
    assert.match(run.runId, /^run_[0-9a-f-]{36}$/);

    await assert.rejects(runs.createRunning(target, new Date(start.getTime() + 1000)), DiningRunConflictError);
    const arRun = await runs.createRunning({ ...target, locale: 'ar' }, start);

    await runs.recordFetch(run.runId, { statusCode: 200, requestCost: 5, remainingCredits: 990, attempts: 1, finalUrl: 'https://api.scrape.do/?token=secret' });
    const finished = await runs.finishRun(run.runId, {
      status: 'partial',
      counts: { ...run.counts, itemsCreated: 3, itemsRejected: 1 },
      errors: [{ stage: 'persist', code: 'DUPLICATE_KEY', message: 'failed at https://api.scrape.do/?token=secret' }],
    }, new Date(start.getTime() + 4200));
    assert.equal(finished!.status, 'partial');
    assert.equal(finished!.durationMs, 4200);
    const stored = (await runs.findByRunId(run.runId))!;
    assert.deepEqual(stored.fetch, { statusCode: 200, requestCost: 5, remainingCredits: 990, attempts: 1 });
    assert.doesNotMatch(JSON.stringify(stored), /secret/);
    assert.equal(await runs.finishRun(run.runId, { status: 'succeeded' }), null);

    // Lock released after finish; an abandoned run is taken over after STALE_RUN_MS.
    const next = await runs.createRunning(target, new Date(start.getTime() + 5000));
    const takeover = await runs.createRunning({ ...target, locale: 'ar' }, new Date(start.getTime() + STALE_RUN_MS + 1));
    assert.notEqual(takeover.runId, arRun.runId);
    assert.equal((await runs.findByRunId(arRun.runId))!.status, 'failed');
    assert.equal((await runs.findByRunId(next.runId))!.status, 'running');
  });
});
