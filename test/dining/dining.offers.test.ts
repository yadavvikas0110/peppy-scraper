/// <reference types="node" />
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';
import { runDiningScrape, DiningScrapeContext } from '../../src/dining/dining.service';
import { ensureDiningOfferIndexes, getDiningOfferCollection } from '../../src/dining/offers/offer.collections';
import { syncRestaurantOffers } from '../../src/dining/offers/offer.repository';
import type { NormalizedOffer } from '../../src/dining/offers/offer.types';
import { closeTestClient, fakeScrapeDo, fakeUpload, FIXTURE_URL, LOCAL_DB_SKIP, openTestDb, pageByLocale, TestDb } from './helpers';

const silent = { log: () => {}, warn: () => {}, error: () => {} };
const PERCENT: NormalizedOffer = { type: 'PERCENT_OFF_ITEMS', platformTypeName: 'ItemSpecificPercentOffOffer', percentage: 30, platformItemIds: ['1', '2'] };
const DELIVERY: NormalizedOffer = { type: 'FREE_DELIVERY', platformTypeName: 'FreeDeliveryOffer', minimumOrderValue: 50, currency: 'AED', title: 'Spend AED 50 to get free delivery' };

describe('restaurant offers against a local MongoDB', { skip: LOCAL_DB_SKIP }, () => {
  let t: TestDb;
  const offers = () => getDiningOfferCollection(t.db);
  const base = { platform: 'deliveroo' as const, platformRestaurantId: '288186', source: 'menu' as const, locale: 'en' as const };
  const at = (minutes: number) => new Date(Date.UTC(2026, 0, 1, 0, minutes));

  before(async () => {
    t = await openTestDb('offers');
    await ensureDiningOfferIndexes(t.db);
  });
  beforeEach(async () => { await offers().deleteMany({}); });
  after(async () => { await t?.close(); await closeTestClient(); });

  test('stores each offer once; syncing again changes nothing but the last-seen time', async () => {
    const restaurantId = new ObjectId();
    const first = await syncRestaurantOffers(offers(), { ...base, restaurantId, offers: [PERCENT, DELIVERY], now: at(0) });
    assert.deepEqual(first, { active: 2, ended: 0 });
    await syncRestaurantOffers(offers(), { ...base, restaurantId, offers: [PERCENT, DELIVERY], now: at(60) });

    const docs = await offers().find({}).sort({ type: 1 }).toArray();
    assert.equal(docs.length, 2);
    assert.ok(docs.every(d => d.isActive && d.endedAt === undefined && d.restaurantId?.equals(restaurantId)));
    assert.deepEqual(docs.map(d => d.firstSeenAt.getTime()), [at(0).getTime(), at(0).getTime()]);
    assert.deepEqual(docs.map(d => d.lastSeenAt.getTime()), [at(60).getTime(), at(60).getTime()]);
    assert.deepEqual(docs.find(d => d.type === 'PERCENT_OFF_ITEMS')?.platformItemIds, ['1', '2']);
    assert.equal(docs.find(d => d.type === 'FREE_DELIVERY')?.minimumOrderValue, 50);
  });

  test('an offer that is no longer shown is ended, kept as history, and re-activated if it returns', async () => {
    await syncRestaurantOffers(offers(), { ...base, offers: [PERCENT, DELIVERY], now: at(0) });
    const ended = await syncRestaurantOffers(offers(), { ...base, offers: [DELIVERY], now: at(60) });
    assert.deepEqual(ended, { active: 1, ended: 1 });
    const gone = await offers().findOne({ type: 'PERCENT_OFF_ITEMS' });
    assert.equal(gone?.isActive, false);
    assert.equal(gone?.endedAt?.getTime(), at(60).getTime());

    await syncRestaurantOffers(offers(), { ...base, offers: [PERCENT, DELIVERY], now: at(120) });
    const back = await offers().findOne({ type: 'PERCENT_OFF_ITEMS' });
    assert.equal(back?.isActive, true);
    assert.equal(back?.endedAt, undefined);
    assert.equal(back?.firstSeenAt.getTime(), at(0).getTime(), 'the original first-seen time is kept');
    assert.equal(await offers().countDocuments(), 2);
  });

  test('no offers shown ends everything of that restaurant and source, and nothing else', async () => {
    await syncRestaurantOffers(offers(), { ...base, offers: [PERCENT], now: at(0) });
    await syncRestaurantOffers(offers(), { ...base, platformRestaurantId: '999', offers: [PERCENT], now: at(0) });
    await syncRestaurantOffers(offers(), { ...base, source: 'listing', offers: [DELIVERY], now: at(0) });

    assert.deepEqual(await syncRestaurantOffers(offers(), { ...base, offers: [], now: at(30) }), { active: 0, ended: 1 });
    const active = await offers().find({ isActive: true }).toArray();
    assert.deepEqual(active.map(d => `${d.platformRestaurantId}/${d.source}`).sort(), ['288186/listing', '999/menu']);
  });

  test('titles are kept per page language', async () => {
    await syncRestaurantOffers(offers(), { ...base, locale: 'en', offers: [DELIVERY], now: at(0) });
    await syncRestaurantOffers(offers(), { ...base, locale: 'ar', offers: [{ ...DELIVERY, title: 'أنفق 50 درهم' }], now: at(1) });
    assert.equal(await offers().countDocuments(), 1);
    assert.deepEqual((await offers().findOne({}))?.title, { en: 'Spend AED 50 to get free delivery', ar: 'أنفق 50 درهم' });
  });
});

describe('offers during a scrape', { skip: LOCAL_DB_SKIP }, () => {
  let t: TestDb;
  before(async () => { t = await openTestDb('offers_scrape'); });
  beforeEach(async () => { await t.reset(); });
  after(async () => { await t?.close(); await closeTestClient(); });

  const body = (dryRun = false) => ({ platform: 'deliveroo', locale: 'en', targetUrl: FIXTURE_URL.en, dryRun });
  const context = (extra: Partial<DiningScrapeContext>): DiningScrapeContext =>
    ({ scrapeDo: fakeScrapeDo(pageByLocale).client, repositories: t.repos, logger: silent, uploadImage: fakeUpload, ...extra });

  test('the offers on the page reach the offer sink for a real scrape only', async () => {
    const seen: Array<{ platform: string; locale: string; restaurantId: string; offers: NormalizedOffer[]; platformRestaurantId: string }> = [];
    const offerSink: DiningScrapeContext['offerSink'] = async info => {
      seen.push({ platform: info.platform, locale: info.locale, restaurantId: info.restaurantId, offers: info.offers.offers, platformRestaurantId: info.offers.platformRestaurantId });
    };
    const result = await runDiningScrape(body(), context({ offerSink }));
    assert.equal(seen.length, 1);
    assert.equal(seen[0].restaurantId, result.restaurantId);
    assert.equal(seen[0].platform, 'deliveroo');
    assert.equal(seen[0].platformRestaurantId, '76728');
    assert.deepEqual(seen[0].offers.map(o => o.type), ['FREE_DELIVERY']);

    await runDiningScrape(body(true), context({ offerSink }));
    assert.equal(seen.length, 1, 'a dry run stores nothing');
  });

  test('a failing offer sink never fails the scrape', async () => {
    const result = await runDiningScrape(body(), context({ offerSink: async () => { throw new Error('offers db down'); } }));
    assert.equal(result.status, 'succeeded');
  });
});
