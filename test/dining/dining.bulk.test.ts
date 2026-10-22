/// <reference types="node" />
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';
import { ObjectId } from 'mongodb';
import { candidatesFromDeliverooListing, candidatesFromTalabatListing, isLikelyRestaurantName, storeCandidates } from '../../src/dining/bulk/bulk.discover';
import { ensureImportQueueIndexes, getImportQueueCollection } from '../../src/dining/bulk/bulk.collections';
import { runBulkImport } from '../../src/dining/bulk/bulk.run';
import { areaTokens, brandKey, selectForBatch } from '../../src/dining/bulk/bulk.select';
import type { ImportQueueItem } from '../../src/dining/bulk/bulk.types';
import type { DiningScrapeContext } from '../../src/dining/dining.service';
import { parseTalabatListing, talabatMenuUrl } from '../../src/dining/platforms/talabat/talabat.listing';
import { ScrapeDoError } from '../../src/shared/scrapedo/scrapedo.errors';
import { closeTestClient, fakeScrapeDo, fakeUpload, FIXTURE_URL, goldenMileFixtureHtml, GOLDEN_MILE_URL, LOCAL_DB_SKIP, openTestDb, pageByLocale, TestDb } from './helpers';

const FIXTURES = join(__dirname, 'fixtures');
const read = (...p: string[]) => readFileSync(join(FIXTURES, ...p), 'utf8');
const silent = { log: () => {}, warn: () => {}, error: () => {} };

describe('Talabat listing page', () => {
  const html = read('bulk', 'talabat-listing.html');
  const page = parseTalabatListing(html)!;

  test('vendors, de-duplicated by branch id, with ids and coordinates from the platform', () => {
    assert.equal(page.vendors.length, 6, 'the duplicate vendor is dropped');
    assert.equal(page.totalVendors, 7940);
    assert.deepEqual(page.area, { id: 1252, name: 'Business Bay', slug: 'business-bay' });
    const kababji = page.vendors.find(v => v.branchSlug === 'kababji-difc')!;
    assert.equal(kababji.branchId, '33598');
    assert.equal(kababji.menuPath, '/uae/restaurant/33598/kababji-difc');
    assert.equal(typeof kababji.lat, 'number');
    assert.equal(typeof kababji.lng, 'number');
    assert.deepEqual(kababji.cuisines.slice(0, 2), ['Lebanese', 'Grills']);
  });

  test('only food vendors are restaurants: pharmacies, minimarts and shops are not', () => {
    const restaurants = page.vendors.filter(v => v.isRestaurant).map(v => v.name).sort();
    assert.deepEqual(restaurants, ['Biryani Joy', 'Kababji, DIFC', 'Starbucks, Bay Square']);
    for (const name of ['Apotec Pharmacy', 'Freshville Minimart', 'Falcon Pack']) assert.equal(page.vendors.find(v => v.name === name)!.isRestaurant, false, name);
  });

  test('the menu URL the scraper takes carries the delivery area', () => {
    assert.equal(talabatMenuUrl(page.vendors[0], 1252), `https://www.talabat.com${page.vendors[0].menuPath}?aid=1252`);
  });

  test('pages without vendor data give null', () => {
    assert.equal(parseTalabatListing('<html></html>'), null);
    assert.equal(parseTalabatListing('<script id="__NEXT_DATA__">{broken</script>'), null);
    assert.equal(parseTalabatListing('<script id="__NEXT_DATA__">{"props":{"pageProps":{"data":{}}}}</script>'), null);
  });
});

describe('discovery candidates', () => {
  test('Talabat: restaurants only, the rest reported as excluded', () => {
    const found = candidatesFromTalabatListing(read('bulk', 'talabat-listing.html'), 'https://www.talabat.com/uae/restaurants/1252/business-bay')!;
    assert.equal(found.candidates.length, 3);
    assert.equal(found.excluded.length, 3);
    const starbucks = found.candidates.find(c => c.name.startsWith('Starbucks'))!;
    assert.equal(starbucks.platform, 'talabat');
    assert.match(starbucks.url, /^https:\/\/www\.talabat\.com\/uae\/restaurant\/\d+\/starbucks-bay-square\?aid=1252$/);
    assert.equal(found.totalVendors, 7940);
  });

  test('Deliveroo: ids and menu URLs keep the delivery location of the listing', () => {
    const url = 'https://deliveroo.ae/en/restaurants/dubai/dubai-business-bay?geohash=thrr3squys8d&collection=restaurants';
    const found = candidatesFromDeliverooListing(read('offers', 'deliveroo-offers-listing.html'), url);
    const subway = found.candidates.find(c => c.platformRestaurantId === '71256')!;
    assert.equal(subway.url, 'https://deliveroo.ae/en/menu/Dubai/knowledge-village/subway-knowledge-village/?day=today&geohash=thrr3squys8d&time=ASAP');
    assert.equal(subway.slug, 'subway-knowledge-village');
    assert.deepEqual(subway.offerLabels, ['Spend AED 50, Get free delivery']);
  });

  test('groceries and shops are recognised by name; restaurants are not', () => {
    for (const name of ['Deliveroo HOP: 24/7 Groceries', 'Choithrams', 'Carrefour Market', 'Viva Supermarket - Deliveroo Pickers', 'Grandiose Hypermarket', 'Life Pharmacy']) {
      assert.equal(isLikelyRestaurantName(name), false, name);
    }
    for (const name of ['KFC', 'Subway', "Hardee's", 'Pizza Hut', 'Joe & The Juice', 'Five Guys', 'Kamat Vegetarian - Business Bay']) assert.equal(isLikelyRestaurantName(name), true, name);
  });
});

describe('batch selection', () => {
  const c = (platform: 'deliveroo' | 'talabat', id: string, name: string, slug: string, ratingCount = 0, rating = 4): ImportQueueItem =>
    ({ platform, platformRestaurantId: id, name, url: 'u', slug, ratingCount, rating, sourceUrl: 's', status: 'discovered', locales: {}, attempts: 0, creditsUsed: 0, discoveredAt: new Date(), updatedAt: new Date() });

  test('brand: the first significant word of the brand part', () => {
    assert.equal(brandKey("McDonald's, Al Wasl"), 'mcdonalds');
    assert.equal(brandKey('Hardee`s, ,Business Bay'), 'hardees');
    assert.equal(brandKey('Kababji Grill - كبابجي جريل'), 'kababji');
    assert.equal(brandKey('Al Safadi'), 'safadi');
    assert.equal(brandKey('The Good Food Co'), 'good');
  });

  test('area words ignore the brand, filler and generic place words ("Square" is not a place)', () => {
    assert.deepEqual([...areaTokens(c('talabat', '1', 'Starbucks, Bay Square', 'starbucks-bay-square'))], ['bay']);
    assert.deepEqual([...areaTokens(c('deliveroo', '2', 'Starbucks', 'starbucks-emaar-square'))], ['emaar']);
    assert.deepEqual([...areaTokens(c('deliveroo', '3', 'Kababji Grill', 'kababji-grill-difc-2'))], ['difc']);
    // the later words of a multi-word brand are the brand, not the place
    assert.deepEqual([...areaTokens(c('deliveroo', '4', 'Pizza Hut', 'pizza-hut-al-diyafa'))], ['diyafa']);
    assert.deepEqual([...areaTokens(c('talabat', '5', 'Pizza Hut', 'pizza-hut-business-bay'))].sort(), ['bay', 'business']);
    assert.deepEqual([...areaTokens(c('deliveroo', '6', 'Five Guys', 'five-guys-city-walk'))], ['city', 'walk']);
  });

  const pool = [
    c('deliveroo', 'd1', 'Kababji Grill', 'kababji-grill-difc-2', 500),
    c('talabat', 't1', 'Kababji, DIFC', 'kababji-difc', 1000),
    c('deliveroo', 'd2', 'Starbucks', 'starbucks-emaar-square', 900),
    c('talabat', 't2', 'Starbucks, Bay Square', 'starbucks-bay-square', 1000),
    c('deliveroo', 'd3', 'Operation Falafel', 'operation-falafel-downtown', 300),
    c('talabat', 't3', 'Operation Falafel, Downtown Burj Khalifa', 'operation-falafel-downtown-burj-khalifa', 1000),
    c('deliveroo', 'd4', 'Solo Deliveroo Diner', 'solo-deliveroo-diner', 800),
    c('deliveroo', 'd5', 'Quiet Deliveroo Cafe', 'quiet-deliveroo-cafe', 10),
    c('talabat', 't4', 'Solo Talabat Place', 'solo-talabat-place', 700),
  ];

  test('tiers: same brand and area are PAIRs, same brand elsewhere is a CONTROL, then the most reviewed', () => {
    const picks = selectForBatch(pool, { quota: { deliveroo: 4, talabat: 4 }, controls: 1 });
    const tier = (id: string) => picks.find(p => p.platformRestaurantId === id)?.tier;
    assert.deepEqual(['d1', 't1', 'd3', 't3'].map(tier), ['PAIR', 'PAIR', 'PAIR', 'PAIR']);
    assert.deepEqual(['d2', 't2'].map(tier), ['CONTROL', 'CONTROL']);
    assert.equal(picks.find(p => p.platformRestaurantId === 'd1')!.pairKey, picks.find(p => p.platformRestaurantId === 't1')!.pairKey);
    assert.equal(picks.find(p => p.platformRestaurantId === 'd2')!.pairKey, 'control:starbucks');
  });

  test('the same multi-word brand in two areas is a CONTROL, never a PAIR (Pizza Hut Al Diyafa vs Pizza Hut Business Bay)', () => {
    const picks = selectForBatch(
      [c('deliveroo', 'p1', 'Pizza Hut', 'pizza-hut-al-diyafa', 900), c('talabat', 'p2', 'Pizza Hut', 'pizza-hut-business-bay', 900)],
      { quota: { deliveroo: 1, talabat: 1 }, controls: 1 }
    );
    assert.deepEqual(picks.map(p => p.tier), ['CONTROL', 'CONTROL']);
    assert.equal(picks[0].pairKey, 'control:pizza');
  });

  test('the quotas are respected per platform, nobody is picked twice, and the rest is filled by popularity', () => {
    const picks = selectForBatch(pool, { quota: { deliveroo: 5, talabat: 4 }, controls: 1 });
    assert.equal(picks.filter(p => p.platform === 'deliveroo').length, 5);
    assert.equal(picks.filter(p => p.platform === 'talabat').length, 4);
    assert.equal(new Set(picks.map(p => `${p.platform}:${p.platformRestaurantId}`)).size, picks.length);
    const fill = picks.filter(p => p.tier === 'FILL').map(p => p.platformRestaurantId);
    assert.ok(fill.includes('d4') && fill.includes('d5') && fill.includes('t4'));
  });

  test('a small quota keeps pairs together or not at all', () => {
    const picks = selectForBatch(pool, { quota: { deliveroo: 1, talabat: 1 }, controls: 0 });
    assert.equal(picks.length, 2);
    assert.deepEqual(new Set(picks.map(p => p.pairKey)).size, 1);
  });

  test('a per-brand cap keeps one chain from filling the batch', () => {
    const chain = Array.from({ length: 6 }, (_, i) => c('deliveroo', `m${i}`, `McDonald's Branch ${i}`, `mcdonalds-branch-${i}`, 1000 - i));
    const picks = selectForBatch(chain, { quota: { deliveroo: 5 }, perBrandCap: 2 });
    assert.equal(picks.length, 2);
  });
});

describe('bulk import against a local MongoDB (fake Scrape.do)', { skip: LOCAL_DB_SKIP }, () => {
  let t: TestDb;
  const queue = () => getImportQueueCollection(t.db);
  const TALABAT_URL = { en: 'https://www.talabat.com/uae/restaurant/773429/kamat-vegetarian-the-palm-jumeirah?aid=1333', ar: 'https://www.talabat.com/ar/uae/restaurant/773429/kamat-vegetarian-the-palm-jumeirah?aid=1333' };

  before(async () => {
    t = await openTestDb('bulk');
    await ensureImportQueueIndexes(t.db);
  });
  beforeEach(async () => {
    await t.reset();
    await queue().deleteMany({});
  });
  after(async () => { await t?.close(); await closeTestClient(); });

  const entry = (over: Partial<ImportQueueItem>): ImportQueueItem => ({
    platform: 'deliveroo', platformRestaurantId: '76728', name: 'Kamat Vegetarian - Business Bay', url: FIXTURE_URL.en, sourceUrl: 'listing',
    status: 'queued', batchId: 'b1', priority: 0, locales: {}, attempts: 0, creditsUsed: 0, discoveredAt: new Date(), updatedAt: new Date(), ...over,
  });
  const kamatBB = () => entry({});
  const goldenMile = () => entry({ platformRestaurantId: '735078', name: 'Kamat Golden Mile', url: GOLDEN_MILE_URL });
  const talabat = () => entry({ platform: 'talabat', platformRestaurantId: '773429', name: 'Kamat Palm', url: TALABAT_URL.en });
  const pages = (url: string): string =>
    url.includes('talabat') ? read(url.includes('/ar/') ? 'talabat-ar.html' : 'talabat-en.html') : url.includes('golden-mile') ? goldenMileFixtureHtml() : pageByLocale(url);
  const ctx = (scrapeDo: DiningScrapeContext['scrapeDo']): DiningScrapeContext => ({ scrapeDo, repositories: t.repos, logger: silent, uploadImage: fakeUpload });
  const options = (over = {}) => ({ batchId: 'b1', concurrency: 1, maxCredits: 100, reserveCredits: 10, ...over });
  const cheap = () => fakeScrapeDo(pages, { requestCost: 1, remainingCredits: 500 });

  test('a queued restaurant is imported in English and Arabic and recorded with what each locale achieved', async () => {
    await queue().insertOne(kamatBB());
    const fake = cheap();
    const summary = await runBulkImport({ queue: queue(), scrapeContext: ctx(fake.client), logger: silent }, options());

    assert.equal(summary.imported, 1);
    assert.equal(summary.creditsUsed, 2);
    assert.equal(fake.calls.length, 2);
    assert.deepEqual(fake.calls.map(c => c.options?.render), [false, false], 'plain requests');
    assert.deepEqual(fake.calls.map(c => c.url.includes('/ar/')), [false, true]);

    const doc = (await queue().findOne({}))!;
    assert.equal(doc.status, 'imported');
    assert.equal(doc.locales.en?.status, 'succeeded');
    assert.equal(doc.locales.ar?.status, 'succeeded');
    assert.ok(doc.locales.en!.itemsSeen! > 100);
    assert.equal(doc.creditsUsed, 2);
    assert.equal(doc.attempts, 1);
    const restaurant = (await t.collections.restaurants.findOne({ platformRestaurantId: '76728' }))!;
    assert.equal(doc.restaurantId?.toHexString(), restaurant._id!.toHexString());
    assert.ok(restaurant.lastRunIdByLocale.en && restaurant.lastRunIdByLocale.ar);
    assert.equal(await t.collections.menuItems.countDocuments({ restaurantId: restaurant._id, isActive: true }) > 100, true);
  });

  test('Talabat and Deliveroo restaurants import through the same path', async () => {
    await queue().insertMany([kamatBB(), talabat()]);
    const summary = await runBulkImport({ queue: queue(), scrapeContext: ctx(cheap().client), logger: silent }, options());
    assert.equal(summary.imported, 2);
    assert.deepEqual((await t.collections.restaurants.find({}).toArray()).map(r => r.platform).sort(), ['deliveroo', 'talabat']);
  });

  test('the credit budget is a hard limit: the next restaurant is not started when it would not fit', async () => {
    await queue().insertMany([kamatBB(), goldenMile(), talabat()]);
    const summary = await runBulkImport({ queue: queue(), scrapeContext: ctx(cheap().client), logger: silent }, options({ maxCredits: 4 }));
    assert.equal(summary.attempted, 2);
    assert.match(summary.stoppedReason ?? '', /^BUDGET_REACHED/);
    assert.equal(await queue().countDocuments({ status: 'queued' }), 1);
    assert.ok(summary.creditsUsed <= 4);
  });

  test('the reserve of credits is never spent', async () => {
    await queue().insertMany([kamatBB(), goldenMile()]);
    const low = fakeScrapeDo(pages, { requestCost: 1, remainingCredits: 11 });
    const summary = await runBulkImport({ queue: queue(), scrapeContext: ctx(low.client), logger: silent }, options({ reserveCredits: 10 }));
    assert.equal(summary.attempted, 1);
    assert.match(summary.stoppedReason ?? '', /^CREDIT_RESERVE/);
  });

  test('a quota/auth failure stops the whole run and leaves the rest queued', async () => {
    await queue().insertMany([kamatBB(), goldenMile(), talabat()]);
    const denied: DiningScrapeContext['scrapeDo'] = { async fetchHtml() { throw new ScrapeDoError({ category: 'quota', message: 'credits exhausted' }); } };
    const summary = await runBulkImport({ queue: queue(), scrapeContext: ctx(denied), logger: silent }, options());
    assert.equal(summary.failed, 1);
    assert.match(summary.stoppedReason ?? '', /SCRAPE_DO_QUOTA/);
    assert.equal(await queue().countDocuments({ status: 'queued' }), 2);
  });

  test('repeated failures stop the run', async () => {
    await queue().insertMany([kamatBB(), goldenMile(), talabat()]);
    const blocked = fakeScrapeDo(() => '<html><body>blocked</body></html>');
    const summary = await runBulkImport({ queue: queue(), scrapeContext: ctx(blocked.client), logger: silent }, options({ maxConsecutiveFailures: 2 }));
    assert.equal(summary.failed, 2);
    assert.match(summary.stoppedReason ?? '', /TOO_MANY_CONSECUTIVE_FAILURES/);
    assert.equal(await queue().countDocuments({ status: 'queued' }), 1);
    const failed = (await queue().findOne({ status: 'failed' }))!;
    assert.equal(failed.locales.en?.status, 'failed');
    assert.equal(failed.locales.ar, undefined, 'the Arabic page of a restaurant whose English page failed is not fetched');
  });

  test('English done but Arabic failed is "partial"; a rerun fetches only the Arabic page', async () => {
    await queue().insertOne(kamatBB());
    let arabicWorks = false;
    const calls: string[] = [];
    const flakyArabic: DiningScrapeContext['scrapeDo'] = {
      async fetchHtml(url, opts) {
        calls.push(url);
        if (url.includes('/ar/') && !arabicWorks) throw new ScrapeDoError({ category: 'timeout', message: 'timeout' });
        return cheap().client.fetchHtml(url, opts);
      },
    };
    const first = await runBulkImport({ queue: queue(), scrapeContext: ctx(flakyArabic), logger: silent }, options());
    assert.equal(first.partial, 1);
    let doc = (await queue().findOne({}))!;
    assert.equal(doc.status, 'partial');
    assert.equal(doc.locales.en?.status, 'succeeded');
    assert.equal(doc.locales.ar?.status, 'failed');
    assert.ok(doc.restaurantId, 'the English import is kept');

    arabicWorks = true;
    calls.length = 0;
    await queue().updateOne({}, { $set: { status: 'queued' } });
    const second = await runBulkImport({ queue: queue(), scrapeContext: ctx(flakyArabic), logger: silent }, options());
    assert.equal(second.imported, 1);
    assert.deepEqual(calls.map(u => u.includes('/ar/')), [true], 'only the Arabic page is fetched again');
    doc = (await queue().findOne({}))!;
    assert.equal(doc.status, 'imported');
    assert.equal(doc.attempts, 2);
  });

  test('an Arabic page that belongs to another restaurant is rejected, never merged into the English one', async () => {
    await queue().insertOne(kamatBB());
    const wrongBranch = fakeScrapeDo(url => (url.includes('/ar/') ? goldenMileFixtureHtml() : pageByLocale(url)), { requestCost: 1, remainingCredits: 500 });
    const summary = await runBulkImport({ queue: queue(), scrapeContext: ctx(wrongBranch.client), logger: silent }, options());
    assert.equal(summary.partial, 1);
    const doc = (await queue().findOne({}))!;
    assert.equal(doc.locales.ar?.status, 'failed');
    assert.match(doc.locales.ar?.error ?? '', /RESTAURANT_IDENTITY_MISMATCH/);
    assert.equal(await t.collections.restaurants.countDocuments({}), 1);
  });

  test('a queue id that differs from the id the page reports is flagged', async () => {
    await queue().insertOne(entry({ platformRestaurantId: '999' }));
    await runBulkImport({ queue: queue(), scrapeContext: ctx(cheap().client), logger: silent }, options());
    const doc = (await queue().findOne({}))!;
    assert.match(doc.lastError ?? '', /reports id 76728, not 999/);
  });

  test('entries abandoned as "running" by a crashed run are queued again; fresh ones are left alone', async () => {
    const old = new Date(Date.now() - 60 * 60_000);
    await queue().insertMany([entry({ status: 'running', updatedAt: old }), entry({ status: 'running', platformRestaurantId: '735078', url: GOLDEN_MILE_URL, name: 'GM' })]);
    const summary = await runBulkImport({ queue: queue(), scrapeContext: ctx(cheap().client), logger: silent }, options());
    assert.equal(summary.attempted, 1);
    assert.equal(await queue().countDocuments({ status: 'running' }), 1);
  });

  test('the same listing found twice is queued once, and a known one keeps its status', async () => {
    const candidate = { platform: 'talabat' as const, platformRestaurantId: '5', name: 'X', url: 'u', sourceUrl: 's' };
    assert.deepEqual(await storeCandidates(queue(), [candidate]), { added: 1, alreadyKnown: 0 });
    await queue().updateOne({ platformRestaurantId: '5' }, { $set: { status: 'imported' } });
    assert.deepEqual(await storeCandidates(queue(), [{ ...candidate, name: 'X renamed' }]), { added: 0, alreadyKnown: 1 });
    const doc = (await queue().findOne({}))!;
    assert.equal(doc.status, 'imported');
    assert.equal(doc.name, 'X renamed');
    assert.equal(await queue().countDocuments({}), 1);
  });
});

describe('same-restaurant duplicates across platforms (local MongoDB)', { skip: LOCAL_DB_SKIP }, () => {
  let t: TestDb;
  before(async () => { t = await openTestDb('duplicates'); });
  beforeEach(async () => { await t.reset(); });
  after(async () => { await t?.close(); await closeTestClient(); });

  const DISHES = ['Classic Cookie', 'Double Chocolate', 'Red Velvet', 'Lotus Cookie', 'Brownie Box'];
  async function restaurant(platform: 'deliveroo' | 'talabat', id: string, name: string, lat: number, lng: number, dishes = DISHES) {
    const now = new Date();
    const res = await t.db.collection('dining_restaurants').insertOne({
      platform, platformRestaurantId: id, sourceKey: `${platform}:restaurant:id:${id}`, sourceKeyKind: 'id', name: { en: name },
      url: { en: `https://example.com/${platform}/${id}` }, cuisines: [], tags: [], currency: 'AED', isActive: true, offers: [],
      location: { city: 'Dubai', area: 'Business Bay', lat, lng }, firstSeenAt: now, lastScrapedAtByLocale: { en: now }, lastRunIdByLocale: { en: 'run_x' },
      createdAt: new Date(now.getTime() + Number(id)), updatedAt: now,
    });
    await t.db.collection('dining_menu_items').insertMany(dishes.map((d, i) => ({ restaurantId: res.insertedId, platform, sourceKey: `${platform}:item:${id}:${i}`, name: { en: d }, isActive: true })));
    return res.insertedId;
  }

  test('merges the nearby listing with the same menu; a far branch of the chain and a different menu stay apart', async () => {
    const { mergeDuplicatePairs } = await import('../../src/dining/bulk/bulk.duplicates');
    const { backfillRestaurantIdentity } = await import('../../src/dining/identity/identity.backfill');
    const { createDiningIdentityRepositories } = await import('../../src/dining/identity/identity.service');
    const { ensureDiningIdentityIndexes, getDiningIdentityCollections } = await import('../../src/dining/identity/identity.collections');
    await ensureDiningIdentityIndexes(t.db);
    const talabat = await restaurant('talabat', '1', 'Bake My Day, Business Bay', 25.1860, 55.2650);
    // ~100 m away (0.0009° of latitude): beyond the 75 m pin rule, within the 150 m same-menu rule.
    const deliveroo = await restaurant('deliveroo', '2', 'Bake My Day - Cookies - Business Bay', 25.1869, 55.2650);
    await restaurant('deliveroo', '3', 'Bake My Day - Al Diyafa', 25.2300, 55.2700);
    // ~110 m the other way, a different menu: the menu cannot widen the location check.
    await restaurant('deliveroo', '4', 'Bake My Day - Bay Square', 25.1850, 55.2650, ['Pizza', 'Pasta', 'Salad', 'Soup', 'Tea']);
    const identity = getDiningIdentityCollections(t.db);
    await backfillRestaurantIdentity(createDiningIdentityRepositories(identity), {});

    const plan = await mergeDuplicatePairs(t.db, false, silent);
    assert.deepEqual(plan.map(p => [p.deliveroo.name, p.outcome]), [['Bake My Day - Cookies - Business Bay', 'planned']]);

    const done = await mergeDuplicatePairs(t.db, true, silent);
    assert.equal(done[0].outcome, 'merged');
    const a = await identity.restaurantMappings.findOne({ restaurantId: talabat, isActive: true });
    const b = await identity.restaurantMappings.findOne({ restaurantId: deliveroo, isActive: true });
    assert.ok(a!.canonicalRestaurantGroupId!.equals(b!.canonicalRestaurantGroupId!));
    assert.match(b!.evidence.note!, /^DUPLICATE_MERGE/);
    assert.equal((await identity.restaurantGroups.findOne({ _id: a!.canonicalRestaurantGroupId }))!.identityStatus, 'verified');
    assert.equal((await mergeDuplicatePairs(t.db, false, silent)).length, 0, 'nothing left to merge');
  });
});
