/// <reference types="node" />
import { after, afterEach, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'http';
import type { AddressInfo } from 'net';
import { ObjectId, WithId } from 'mongodb';
import { backfillCanonicalItems } from '../../src/dining/canonical-items/canonical-item.backfill';
import { ensureDiningCanonicalItemIndexes, getDiningCanonicalItemCollections } from '../../src/dining/canonical-items/canonical-item.collections';
import { normalizeItemText } from '../../src/dining/canonical-items/canonical-item.text';
import { createDiningApp } from '../../src/dining/dining.app';
import { persistMappedMenu } from '../../src/dining/dining.persistence';
import { buildMenuItemSourceKey } from '../../src/dining/dining.source-key';
import type { DiningMenuItem, DiningPlatform, DiningRestaurant } from '../../src/dining/dining.types';
import { backfillRestaurantIdentity } from '../../src/dining/identity/identity.backfill';
import { ensureDiningIdentityIndexes, getDiningIdentityCollections } from '../../src/dining/identity/identity.collections';
import { assignRestaurantToGroup, createDiningIdentityRepositories } from '../../src/dining/identity/identity.service';
import { ensureDiningItemMappingIndexes, getDiningItemMappingCollections } from '../../src/dining/item-mappings/item-mapping.collections';
import { importSeedItemMappings } from '../../src/dining/item-mappings/item-mapping.import';
import { createItemMappingService } from '../../src/dining/item-mappings/item-mapping.service';
import type { DiningItemMapping } from '../../src/dining/item-mappings/item-mapping.types';
import { buildOffers, computeCheapestOffer, OfferSources, SearchMappingDoc, SearchMenuItemDoc, SearchRestaurantDoc } from '../../src/dining/search/dining-search.offers';
import { rankCandidates } from '../../src/dining/search/dining-search.ranking';
import {
  createDiningSearchRepository,
  DINING_SEARCH_INDEXES,
  DiningSearchRepository,
  ensureDiningSearchIndexes,
  getDiningSearchCollections,
} from '../../src/dining/search/dining-search.repository';
import { createDiningSearchService, DiningSearchService } from '../../src/dining/search/dining-search.service';
import { DINING_SEARCH_LIMITS, DiningSearchError, DiningSearchResponse } from '../../src/dining/search/dining-search.types';
import { normalizeSearchQuery, searchInputFromQueryString, validateDiningSearchRequest } from '../../src/dining/search/dining-search.validation';
import { closeTestClient, LOCAL_DB_SKIP, mappedMenu, openTestDb, TestDb, THALI } from './helpers';

const API_KEY = 'test-dining-key-0123456789';

const expectSearchError = (code: string, field?: string) => (e: unknown) =>
  e instanceof DiningSearchError && e.code === code && (!field || !!e.details?.some(d => d.field === field));

// ─── 20. Input validation (pure) ─────────────────────────────────────────────

describe('search input validation', () => {
  test('20. empty query and invalid parameters are rejected safely', () => {
    const bad: Array<[unknown, string, string]> = [
      [{}, 'INVALID_REQUEST', 'query'],
      [{ query: '' }, 'INVALID_REQUEST', 'query'],
      [{ query: '   ' }, 'INVALID_REQUEST', 'query'],
      [{ query: '!!! ---' }, 'INVALID_REQUEST', 'query'],
      [{ query: 'x'.repeat(DINING_SEARCH_LIMITS.maxQueryLength + 1) }, 'INVALID_REQUEST', 'query'],
      [{ query: { $ne: '' } }, 'INVALID_REQUEST', 'query'],
      [{ query: 'Thali', locale: 'fr' }, 'UNSUPPORTED_LOCALE', 'locale'],
      [{ query: 'Thali', restaurantGroupId: 'abc' }, 'INVALID_REQUEST', 'restaurantGroupId'],
      [{ query: 'Thali', restaurantGroupId: { $gt: '' } }, 'INVALID_REQUEST', 'restaurantGroupId'],
      [{ query: 'Thali', platforms: [] }, 'INVALID_REQUEST', 'platforms'],
      [{ query: 'Thali', platforms: 'deliveroo' }, 'INVALID_REQUEST', 'platforms'],
      [{ query: 'Thali', platforms: ['ubereats'] }, 'UNSUPPORTED_PLATFORM', 'platforms'],
      [{ query: 'Thali', limit: 0 }, 'INVALID_REQUEST', 'limit'],
      [{ query: 'Thali', limit: DINING_SEARCH_LIMITS.maxLimit + 1 }, 'INVALID_REQUEST', 'limit'],
      [{ query: 'Thali', limit: 2.5 }, 'INVALID_REQUEST', 'limit'],
      [{ query: 'Thali', filter: { price: { $lt: 1 } } }, 'INVALID_REQUEST', 'filter'],
      [null, 'INVALID_REQUEST', 'body'],
      [['Thali'], 'INVALID_REQUEST', 'body'],
    ];
    for (const [input, code, field] of bad) {
      const v = validateDiningSearchRequest(input);
      assert.equal(v.ok, false, JSON.stringify(input));
      if (!v.ok) {
        assert.equal(v.code, code, JSON.stringify(input));
        assert.ok(v.errors.some(e => e.field === field), JSON.stringify(input));
      }
    }
  });

  test('valid input is normalized with defaults', () => {
    const id = new ObjectId();
    const v = validateDiningSearchRequest({ query: ' Thali ', restaurantGroupId: id.toHexString(), platforms: ['talabat', 'deliveroo', 'talabat'] });
    assert.ok(v.ok);
    if (v.ok) {
      assert.equal(v.value.query, 'Thali');
      assert.equal(v.value.locale, 'en');
      assert.equal(v.value.limit, DINING_SEARCH_LIMITS.defaultLimit);
      assert.ok(v.value.restaurantGroupId!.equals(id));
      assert.deepEqual(v.value.platforms, ['deliveroo', 'talabat']);
    }
    assert.deepEqual(normalizeSearchQuery('  MASALA-Dosa (2 Pcs) and '), { normalized: 'masala dosa 2 pcs and', tokens: ['masala', 'dosa', '2', 'pcs'] });
  });

  test('query-string parsing: q/query, comma or repeated platforms, repeated scalars rejected', () => {
    assert.deepEqual(searchInputFromQueryString({ q: 'Thali', locale: 'ar', platforms: 'deliveroo,talabat', limit: '5' }).input, {
      query: 'Thali', locale: 'ar', platforms: ['deliveroo', 'talabat'], limit: 5,
    });
    assert.deepEqual(searchInputFromQueryString({ query: 'Thali', platforms: ['deliveroo', 'careem'] }).input, { query: 'Thali', platforms: ['deliveroo', 'careem'] });
    for (const [qs, field] of [
      [{ q: ['a', 'b'] }, 'q'],
      [{ q: 'a', query: 'b' }, 'q'],
      [{ q: 'a', limit: '-1' }, 'limit'],
      [{ q: 'a', limit: '1e3' }, 'limit'],
      [{ q: 'a', sort: 'price' }, 'sort'],
    ] as Array<[Record<string, unknown>, string]>) {
      const r = searchInputFromQueryString(qs);
      assert.equal(r.input, undefined, JSON.stringify(qs));
      assert.ok(r.errors.some(e => e.field === field), JSON.stringify(qs));
    }
  });
});

// ─── Ranking (pure) ──────────────────────────────────────────────────────────

describe('search ranking', () => {
  const item = (name: string, o: { ar?: string; aliases?: string[]; extra?: string[] } = {}) => {
    const names = [name, o.ar, ...(o.aliases ?? [])].filter((s): s is string => !!s);
    const kw = [...new Set([...names.flatMap(n => normalizeItemText(n)!.split(' ')), ...(o.extra ?? [])])];
    return { _id: new ObjectId(), canonicalName: { en: name, ...(o.ar ? { ar: o.ar } : {}) }, aliases: o.aliases ?? [], searchKeywords: kw };
  };

  test('exact name > exact alias > all keywords > partial; name tokens beat description-only tokens', () => {
    const exact = item('Masala Dosa', { ar: 'مسالا دوسا' });
    const alias = item('Potato Dosa Special', { aliases: ['Masala Dosa Classic'] });
    const aliasExact = item('Aloo Dosa', { aliases: ['masala dosa'] });
    const kwName = item('Mysore Masala Dosa');
    const kwDescOnly = item('Plain Uttapam', { extra: ['masala', 'dosa'] });
    const partial = item('Paper Dosa');
    const unrelated = item('Filter Coffee');
    const q = normalizeSearchQuery('masala dosa');
    const ranked = rankCandidates([unrelated, partial, kwDescOnly, kwName, alias, aliasExact, exact], q, 'en');
    assert.deepEqual(ranked.map(r => r.item.canonicalName.en), ['Masala Dosa', 'Aloo Dosa', 'Mysore Masala Dosa', 'Potato Dosa Special', 'Plain Uttapam', 'Paper Dosa']);
    assert.deepEqual(ranked.map(r => r.match.type), ['EXACT_NAME', 'EXACT_ALIAS', 'KEYWORD', 'KEYWORD', 'KEYWORD', 'PARTIAL']);
    assert.equal(ranked[4].match.nameCoverage, 0);
    assert.equal(rankCandidates([exact], normalizeSearchQuery('مسالا دوسا'), 'ar')[0].match.type, 'EXACT_NAME');
  });

  test('prefix tokens (≥3 chars) are partial matches; shorter names first; deterministic', () => {
    const a = item('Dosa');
    const b = item('Dosa Platter Deluxe');
    const ranked = rankCandidates([b, a], normalizeSearchQuery('dos'), 'en');
    assert.deepEqual(ranked.map(r => [r.item.canonicalName.en, r.match.type, r.match.prefixTokens]), [['Dosa', 'PARTIAL', ['dos']], ['Dosa Platter Deluxe', 'PARTIAL', ['dos']]]);
    assert.equal(rankCandidates([a], normalizeSearchQuery('do'), 'en').length, 0);
    assert.deepEqual(rankCandidates([a, b, a], normalizeSearchQuery('dosa'), 'en').map(r => r.item._id), rankCandidates([b, a], normalizeSearchQuery('dosa'), 'en').map(r => r.item._id));
  });
});

// ─── Offers + cheapest (pure) ────────────────────────────────────────────────

describe('offer assembly and cheapest offer', () => {
  const group = new ObjectId();
  const otherGroup = new ObjectId();
  const canonical = { _id: new ObjectId(), restaurantGroupId: group };
  const now = new Date('2026-10-09T08:00:00Z');

  function fixture(platform: DiningPlatform, price: unknown, o: Partial<SearchMenuItemDoc> = {}, restaurantGroup = group) {
    const restaurant: SearchRestaurantDoc = { _id: new ObjectId(), platform, platformRestaurantId: `${platform}-r`, name: { en: `Kamat on ${platform}` }, url: { en: `https://${platform}.example/kamat` }, isActive: true };
    const item = {
      _id: new ObjectId(), platform, restaurantId: restaurant._id, platformItemId: `${platform}-1`, name: { en: 'Thali', ar: 'ثالي' },
      price, currency: 'AED', imageUrl: `https://${platform}.example/t.jpg`, isActive: true, isAvailable: true, lastSeenAt: now, ...o,
    } as SearchMenuItemDoc;
    const mapping: SearchMappingDoc = {
      _id: new ObjectId(), canonicalItemId: canonical._id, restaurantGroupId: group, menuItemId: item._id, restaurantId: restaurant._id, platform,
      platformItemId: item.platformItemId, matchStatus: 'MATCHED', matchMethod: 'MANUAL', confidence: 1, decidedBy: 'manual', isActive: true, decidedAt: now,
    };
    return { restaurant, item, mapping, restaurantGroup };
  }

  function sourcesOf(fs: Array<ReturnType<typeof fixture>>, conflicting: string[] = []): OfferSources {
    return {
      menuItems: new Map(fs.map(f => [f.item._id.toHexString(), f.item])),
      restaurants: new Map(fs.map(f => [f.restaurant._id.toHexString(), f.restaurant])),
      restaurantGroupOf: new Map(fs.map(f => [f.restaurant._id.toHexString(), f.restaurantGroup.toHexString()])),
      conflictingMenuItems: new Set(conflicting),
    };
  }

  const run = (fs: Array<ReturnType<typeof fixture>>, mappings = fs.map(f => f.mapping), conflicting: string[] = []) => {
    const built = buildOffers(canonical, mappings, sourcesOf(fs, conflicting), 'en');
    return { ...built, ...computeCheapestOffer(built.offers) };
  };

  test('7 + 9. offers are per platform; the lowest eligible price wins; ties are deterministic', () => {
    const d = fixture('deliveroo', 35);
    const t = fixture('talabat', 32);
    const c = fixture('careem', 32);
    const r = run([c, d, t]);
    assert.deepEqual(r.offers.map(o => [o.platform, o.price]), [['talabat', 32], ['careem', 32], ['deliveroo', 35]]);
    assert.deepEqual(r.cheapestOffer, { platform: 'talabat', menuItemId: t.item._id.toHexString(), price: 32, currency: 'AED', tiedOffers: [{ platform: 'careem', menuItemId: c.item._id.toHexString() }] });
    assert.equal(r.cheapestOfferStatus, 'OK');
    const offer = r.offers.find(o => o.platform === 'deliveroo')!;
    assert.equal(offer.itemUrl, null);
    assert.equal(offer.restaurantUrl, 'https://deliveroo.example/kamat');
    assert.equal(offer.lastSeenAt, now.toISOString());
    assert.deepEqual(run([d]).cheapestOffer?.platform, 'deliveroo');
  });

  test('10 + 11. unavailable or inactive offers stay listed but never win', () => {
    const d = fixture('deliveroo', 35);
    const soldOut = fixture('talabat', 20, { isAvailable: false });
    const delisted = fixture('careem', 10, { isActive: false });
    const r = run([d, soldOut, delisted]);
    assert.equal(r.offers.length, 3);
    assert.equal(r.cheapestOffer!.platform, 'deliveroo');
    const so = r.offers.find(o => o.platform === 'talabat')!;
    assert.deepEqual([so.isActive, so.isAvailable, so.eligibleForCheapest, so.ineligibleReasons], [true, false, false, ['ITEM_UNAVAILABLE']]);
    const dl = r.offers.find(o => o.platform === 'careem')!;
    assert.deepEqual([dl.isActive, dl.isAvailable, dl.ineligibleReasons], [false, true, ['ITEM_INACTIVE']]);
    const onlyBad = run([soldOut, delisted]);
    assert.deepEqual([onlyBad.cheapestOffer, onlyBad.cheapestOfferStatus], [null, 'NO_ELIGIBLE_OFFERS']);
  });

  test('unknown availability is listed with its status but never the confirmed cheapest', () => {
    const d = fixture('deliveroo', 35);
    const unknown = fixture('talabat', 20, { isAvailable: undefined, availabilityStatus: 'unknown' });
    const r = run([d, unknown]);
    assert.equal(r.offers.length, 2);
    assert.deepEqual([r.cheapestOffer!.platform, r.cheapestOfferStatus], ['deliveroo', 'OK']);
    const u = r.offers.find(o => o.platform === 'talabat')!;
    assert.deepEqual(
      [u.availabilityStatus, u.isAvailable, u.eligibleForCheapest, u.ineligibleReasons, u.price],
      ['unknown', false, false, ['ITEM_AVAILABILITY_UNKNOWN'], 20]
    );
    assert.deepEqual([r.offers[0].platform, r.offers[0].availabilityStatus], ['deliveroo', 'available']);
    const onlyUnknown = run([unknown]);
    assert.deepEqual([onlyUnknown.cheapestOffer, onlyUnknown.cheapestOfferStatus, onlyUnknown.cheapestByCurrency], [null, 'NO_ELIGIBLE_OFFERS', []]);
  });

  test('legacy and explicit availability: true → available, false → unavailable, missing or contradictory → unknown', () => {
    const cases: Array<[Partial<SearchMenuItemDoc>, string, string[]]> = [
      [{ isAvailable: true }, 'available', []],
      [{ isAvailable: false }, 'unavailable', ['ITEM_UNAVAILABLE']],
      [{ isAvailable: true, availabilityStatus: 'available' }, 'available', []],
      [{ isAvailable: false, availabilityStatus: 'unavailable' }, 'unavailable', ['ITEM_UNAVAILABLE']],
      [{ isAvailable: undefined }, 'unknown', ['ITEM_AVAILABILITY_UNKNOWN']],
      [{ isAvailable: true, availabilityStatus: 'unknown' }, 'unknown', ['ITEM_AVAILABILITY_UNKNOWN']],
      [{ isAvailable: true, availabilityStatus: 'unavailable' }, 'unknown', ['ITEM_AVAILABILITY_UNKNOWN']],
    ];
    for (const [o, status, reasons] of cases) {
      const [offer] = run([fixture('deliveroo', 35, o)]).offers;
      assert.deepEqual([offer.availabilityStatus, offer.isAvailable, offer.ineligibleReasons], [status, status === 'available', reasons], JSON.stringify(o));
    }
  });

  test('12. missing or invalid prices are never treated as zero', () => {
    const missing = fixture('talabat', undefined);
    const negative = fixture('careem', -5);
    const nan = fixture('careem', Number.NaN);
    const text = fixture('careem', '12' as unknown as number);
    const ok = fixture('deliveroo', 35);
    const r = run([missing, negative, nan, text, ok]);
    assert.equal(r.cheapestOffer!.price, 35);
    const byId = (f: ReturnType<typeof fixture>) => r.offers.find(o => o.menuItemId === f.item._id.toHexString())!;
    assert.deepEqual([byId(missing).price, byId(missing).priceStatus, byId(missing).ineligibleReasons], [null, 'MISSING', ['PRICE_MISSING']]);
    for (const f of [negative, nan, text]) assert.deepEqual([byId(f).price, byId(f).priceStatus], [null, 'INVALID']);
    assert.equal(run([fixture('deliveroo', 0)]).cheapestOffer!.price, 0);
  });

  test('13. currencies are never compared with each other', () => {
    const r = run([fixture('deliveroo', 35), fixture('talabat', 9, { currency: 'USD' }), fixture('careem', 30, { currency: 'aed' })]);
    assert.equal(r.cheapestOffer, null);
    assert.equal(r.cheapestOfferStatus, 'MIXED_CURRENCIES');
    assert.deepEqual(r.cheapestByCurrency.map(c => [c.currency, c.platform, c.price]), [['AED', 'careem', 30], ['USD', 'talabat', 9]]);
    const invalid = run([fixture('deliveroo', 35, { currency: 'dirham' })]);
    assert.deepEqual([invalid.cheapestOffer, invalid.offers[0].currency, invalid.offers[0].ineligibleReasons], [null, null, ['CURRENCY_INVALID']]);
  });

  test('14 + 15. REVIEW, UNMATCHED, REJECTED and inactive mappings are never offers', () => {
    const d = fixture('deliveroo', 35);
    const statuses: Array<Partial<SearchMappingDoc>> = [{ matchStatus: 'REVIEW' }, { matchStatus: 'REJECTED', isActive: false }, { matchStatus: 'UNMATCHED' }, { isActive: false }];
    for (const patch of statuses) {
      const r = run([d], [{ ...d.mapping, ...patch } as SearchMappingDoc]);
      assert.equal(r.offers.length, 0, JSON.stringify(patch));
      assert.equal(r.excluded.count, 0);
    }
  });

  test('16. duplicate or conflicting confirmations of one source item never duplicate an offer', () => {
    const d = fixture('deliveroo', 35);
    const dup = { ...d.mapping, _id: new ObjectId(), decidedAt: new Date(now.getTime() - 1000) };
    const r = run([d], [d.mapping, dup]);
    assert.equal(r.offers.length, 1);
    assert.equal(r.offers[0].mapping.mappingId, d.mapping._id.toHexString());
    assert.deepEqual(r.excluded, { count: 1, reasons: { DUPLICATE_SOURCE_ITEM: 1 } });
    const conflicted = run([d], [d.mapping], [d.item._id.toHexString()]);
    assert.deepEqual([conflicted.offers.length, conflicted.excluded.reasons], [0, { CONFLICTING_ACTIVE_MAPPINGS: 1 }]);
  });

  test('17. cross-group and inconsistent mappings are rejected', () => {
    const cases: Array<[string, (f: ReturnType<typeof fixture>) => { mapping?: Partial<SearchMappingDoc>; item?: Partial<SearchMenuItemDoc>; restaurantGroup?: ObjectId; dropItem?: boolean; dropRestaurant?: boolean }]> = [
      ['CROSS_GROUP_MAPPING', () => ({ mapping: { restaurantGroupId: otherGroup } })],
      ['RESTAURANT_NOT_IN_GROUP', () => ({ restaurantGroup: otherGroup })],
      ['PLATFORM_MISMATCH', () => ({ mapping: { platform: 'careem' } })],
      ['PLATFORM_ITEM_MISMATCH', () => ({ mapping: { platformItemId: 'other' } })],
      ['RESTAURANT_MISMATCH', () => ({ mapping: { restaurantId: new ObjectId() } })],
      ['SOURCE_ITEM_NOT_FOUND', () => ({ dropItem: true })],
      ['RESTAURANT_NOT_FOUND', () => ({ dropRestaurant: true })],
    ];
    for (const [reason, mk] of cases) {
      const f = fixture('talabat', 30);
      const spec = mk(f);
      const g = { ...f, item: { ...f.item, ...spec.item }, mapping: { ...f.mapping, ...spec.mapping }, restaurantGroup: spec.restaurantGroup ?? group };
      const sources = sourcesOf([g]);
      if (spec.dropItem) sources.menuItems.clear();
      if (spec.dropRestaurant) sources.restaurants.clear();
      const built = buildOffers(canonical, [g.mapping], sources, 'en');
      assert.equal(built.offers.length, 0, reason);
      assert.deepEqual(built.excluded.reasons, { [reason]: 1 }, reason);
    }
  });

  test('18. offer names fall back across locales without discarding either', () => {
    const t = fixture('talabat', 30, { name: { en: 'Thali Meal' } });
    const built = buildOffers(canonical, [t.mapping], sourcesOf([t]), 'ar');
    assert.deepEqual([built.offers[0].displayName, built.offers[0].name], ['Thali Meal', { en: 'Thali Meal' }]);
  });
});

// ─── Service failure handling + HTTP layer (fake repository) ─────────────────

async function startServer(searchService?: DiningSearchService): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer(createDiningApp({ runScrape: async () => { throw new Error('not used'); }, searchService, logger: { error: () => {} } }));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise(resolve => server.close(() => resolve())) };
}

async function get(base: string, path: string, headers: Record<string, string> = { 'x-api-key': API_KEY }) {
  const res = await fetch(`${base}${path}`, { headers });
  const text = await res.text();
  return { status: res.status, body: JSON.parse(text), text };
}

function failingRepository(message: string): DiningSearchRepository {
  const fail = async () => { throw new Error(message); };
  return {
    findCanonicalCandidates: fail, findConfirmedMappings: fail, findConfirmedMappingsForMenuItems: fail, findMenuItems: fail,
    findRestaurants: fail, findRestaurantGroupIds: fail, findRestaurantGroups: fail,
  };
}

describe('search service errors and GET /api/dining/search (fake repository)', () => {
  const savedKey = process.env.DINING_API_KEY;
  const secret = 'failed mongodb+srv://admin:hunter2@cluster0.example.net/peppy token=abc123';
  let logged: string[];
  let server: { url: string; close: () => Promise<void> };

  before(async () => {
    logged = [];
    server = await startServer(createDiningSearchService(failingRepository(secret), { logger: { error: (m: string) => logged.push(m) } }));
  });
  beforeEach(() => { process.env.DINING_API_KEY = API_KEY; });
  afterEach(() => {
    if (savedKey === undefined) delete process.env.DINING_API_KEY;
    else process.env.DINING_API_KEY = savedKey;
  });
  after(async () => { await server.close(); });

  test('database failures become a safe SEARCH_UNAVAILABLE error (no credentials, no stack)', async () => {
    const svc = createDiningSearchService(failingRepository(secret), { logger: { error: (m: string) => logged.push(m) } });
    await assert.rejects(svc.search({ query: 'Thali' }), expectSearchError('SEARCH_UNAVAILABLE'));
    await assert.rejects(svc.search({ query: '' }), expectSearchError('INVALID_REQUEST', 'query'));
    const res = await get(server.url, '/api/dining/search?q=Thali');
    assert.equal(res.status, 503);
    assert.deepEqual(res.body, { success: false, message: 'Search is temporarily unavailable', error: { stage: 'search', code: 'SEARCH_UNAVAILABLE' } });
    for (const text of [res.text, ...logged]) {
      assert.doesNotMatch(text, /hunter2|abc123|admin:/);
    }
    assert.doesNotMatch(res.text, /at .*\.ts:\d+/);
  });

  test('20 (http). authentication first; invalid parameters → 400 with field details', async () => {
    assert.equal((await get(server.url, '/api/dining/search?q=Thali', {})).status, 401);
    assert.equal((await get(server.url, '/api/dining/search?q=Thali', { 'x-api-key': 'nope' })).status, 401);
    const cases: Array<[string, string, string]> = [
      ['/api/dining/search', 'INVALID_REQUEST', 'query'],
      ['/api/dining/search?q=', 'INVALID_REQUEST', 'query'],
      ['/api/dining/search?q=Thali&locale=fr', 'UNSUPPORTED_LOCALE', 'locale'],
      ['/api/dining/search?q=Thali&restaurantGroupId=123', 'INVALID_REQUEST', 'restaurantGroupId'],
      ['/api/dining/search?q=Thali&platforms=ubereats', 'UNSUPPORTED_PLATFORM', 'platforms'],
      ['/api/dining/search?q=Thali&limit=500', 'INVALID_REQUEST', 'limit'],
      ['/api/dining/search?q=Thali&q=Dosa', 'INVALID_REQUEST', 'q'],
      ['/api/dining/search?q[$ne]=x', 'INVALID_REQUEST', 'q[$ne]'],
    ];
    for (const [path, code, field] of cases) {
      const res = await get(server.url, path);
      assert.equal(res.status, 400, path);
      assert.equal(res.body.success, false);
      assert.equal(res.body.error.code, code, path);
      assert.ok(res.body.error.details.some((d: { field: string }) => d.field === field), `${path} → ${res.text}`);
    }
  });

  test('the search route is not mounted without a search service', async () => {
    const bare = await startServer();
    try {
      assert.equal((await get(bare.url, '/api/dining/search?q=Thali')).status, 404);
    } finally {
      await bare.close();
    }
  });
});

// ─── Local MongoDB: real Kamat data + synthetic multi-platform records ────────

describe('canonical search (local MongoDB)', { skip: LOCAL_DB_SKIP }, () => {
  let t: TestDb;
  let search: DiningSearchService;
  let kamat: WithId<DiningRestaurant>;
  let kamatGroup: ObjectId;
  const now = new Date('2026-10-09T08:00:00Z');
  const savedKey = process.env.DINING_API_KEY;
  const itemCols = () => getDiningItemMappingCollections(t.db);
  const identityRepos = () => createDiningIdentityRepositories(getDiningIdentityCollections(t.db));

  before(async () => {
    t = await openTestDb('search');
    await ensureDiningIdentityIndexes(t.db);
    await ensureDiningCanonicalItemIndexes(t.db);
    await ensureDiningItemMappingIndexes(t.db);
    await ensureDiningSearchIndexes(t.db);
    search = createDiningSearchService(createDiningSearchRepository(getDiningSearchCollections(t.db)), { logger: { error: () => {} } });
  });
  beforeEach(async () => {
    await t.reset();
    const c = itemCols();
    await Promise.all([c.itemMappings, c.canonicalItems, c.restaurantMappings, c.restaurantGroups].map(col => col.deleteMany({})));
    await ensureDiningItemMappingIndexes(t.db);
    for (const locale of ['en', 'ar'] as const) await persistMappedMenu(t.repos, mappedMenu(locale), { locale, runId: `run_search_${locale}`, now });
    kamat = (await t.collections.restaurants.findOne({ platformRestaurantId: '76728' }))!;
    await backfillRestaurantIdentity(identityRepos(), { now });
    await backfillCanonicalItems(getDiningCanonicalItemCollections(t.db), { now });
    await importSeedItemMappings(c, { now });
    kamatGroup = (await c.restaurantMappings.findOne({ restaurantId: kamat._id }))!.canonicalRestaurantGroupId!;
  });
  after(async () => {
    await t?.close();
    await closeTestClient();
    if (savedKey === undefined) delete process.env.DINING_API_KEY;
    else process.env.DINING_API_KEY = savedKey;
  });

  async function addRestaurant(platform: DiningPlatform, id: string, name: string, location: DiningRestaurant['location'], group?: ObjectId) {
    const doc: DiningRestaurant = {
      platform, platformRestaurantId: id, sourceKey: `${platform}:restaurant:id:${id}`, sourceKeyKind: 'id', name: { en: name },
      url: { en: `https://${platform}.example/${id}` }, cuisines: [], tags: [], currency: 'AED', isActive: true, offers: [], location,
      firstSeenAt: now, lastScrapedAtByLocale: { en: now }, lastRunIdByLocale: { en: 'run_x' }, createdAt: new Date(now.getTime() + 1000), updatedAt: now,
    };
    const res = await t.collections.restaurants.insertOne(doc);
    const restaurant = { ...doc, _id: res.insertedId } as WithId<DiningRestaurant>;
    if (group) await assignRestaurantToGroup(identityRepos(), { restaurantId: restaurant._id, groupId: group }, now);
    return restaurant;
  }

  const kamatItem = async (name: string) => (await t.collections.menuItems.findOne({ restaurantId: kamat._id, 'name.en': name }))!;
  const canonicalOf = async (menuItemId: ObjectId) => (await itemCols().canonicalItems.findOne({ seedMenuItemId: menuItemId }))!;

  // Synthetic listing (test data only, never scraped).
  async function cloneItem(templateName: string, into: WithId<DiningRestaurant>, platformItemId: string, overrides: Partial<DiningMenuItem> = {}, omit: Array<keyof DiningMenuItem> = []) {
    const { _id, categoryId, ...rest } = await kamatItem(templateName);
    for (const key of omit) delete (rest as Partial<DiningMenuItem>)[key];
    const doc: DiningMenuItem = {
      ...rest, platform: into.platform, restaurantId: into._id, restaurantSourceKey: into.sourceKey, platformRestaurantId: into.platformRestaurantId,
      platformItemId, sourceKey: buildMenuItemSourceKey(into.sourceKey, { kind: 'id', value: platformItemId }), ...overrides,
    };
    const res = await t.collections.menuItems.insertOne(doc);
    return { ...doc, _id: res.insertedId } as WithId<DiningMenuItem>;
  }

  // Talabat + Careem listings of Kamat's Thali, manually confirmed to the Kamat Thali canonical item.
  async function multiPlatformThali(prices: { talabat: number; careem: number }) {
    const thali = await kamatItem('Thali');
    const canonical = await canonicalOf(thali._id);
    const svc = createItemMappingService(itemCols());
    const tb = await cloneItem('Thali', await addRestaurant('talabat', 't-kamat', 'Kamat Vegetarian Business Bay', { city: 'Dubai' }, kamatGroup), 'tb-thali', { price: prices.talabat });
    const cr = await cloneItem('Thali', await addRestaurant('careem', 'c-kamat', 'Kamat Vegetarian', { city: 'Dubai' }, kamatGroup), 'cr-thali', { price: prices.careem });
    await svc.remapSourceItem(tb._id, canonical._id, { now });
    await svc.remapSourceItem(cr._id, canonical._id, { now });
    return { thali, canonical, tb, cr };
  }

  const thaliResult = (res: DiningSearchResponse) => res.results.find(r => r.canonicalItem.name.en === 'Thali' && r.restaurant.restaurantGroupId === kamatGroup.toHexString())!;

  test('indexes: search indexes exist and none are unique', async () => {
    const indexes = await t.db.collection('dining_canonical_items').indexes();
    for (const spec of DINING_SEARCH_INDEXES) assert.ok(indexes.some(i => i.name === spec.name && !i.unique), spec.name);
  });

  test('1 + 7. exact English name → the canonical item with its one Deliveroo offer', async () => {
    const thali = await kamatItem('Thali');
    for (const q of ['Thali', '  THALI ', 'thali']) {
      const res = await search.search({ query: q, locale: 'en' });
      const top = res.results[0];
      assert.equal(top.match.type, 'EXACT_NAME', q);
      assert.deepEqual(top.canonicalItem.name, { en: 'Thali', ar: 'ثالي' });
      assert.equal(top.canonicalItem.display.name, 'Thali');
      assert.equal(top.restaurant.restaurantGroupId, kamatGroup.toHexString());
      assert.equal(top.offers.length, 1);
      const offer = top.offers[0];
      assert.deepEqual(
        [offer.platform, offer.platformItemId, offer.price, offer.currency, offer.isActive, offer.isAvailable, offer.itemUrl, offer.menuItemId],
        ['deliveroo', THALI, thali.price, 'AED', true, true, null, thali._id.toHexString()]
      );
      assert.equal(offer.restaurantUrl, kamat.url.en);
      assert.equal(offer.mapping.matchMethod, 'IMPORT');
      assert.deepEqual(top.cheapestOffer, { platform: 'deliveroo', menuItemId: thali._id.toHexString(), price: thali.price, currency: 'AED', tiedOffers: [] });
    }
    const res = await search.search({ query: 'Thali' });
    assert.equal(new Set(res.results.map(r => r.canonicalItem.id)).size, res.results.length);
    assert.ok(res.results.slice(1).every(r => r.match.type !== 'EXACT_NAME'));
  });

  test('2 + 18. exact Arabic name with Arabic display, English kept for fallback', async () => {
    const res = await search.search({ query: 'ثالي', locale: 'ar' });
    const top = res.results[0];
    assert.equal(top.match.type, 'EXACT_NAME');
    assert.equal(top.canonicalItem.display.name, 'ثالي');
    assert.equal(top.canonicalItem.name.en, 'Thali');
    assert.deepEqual(top.canonicalItem.display.fallbackFields, []);
    assert.ok(top.canonicalItem.display.category && top.canonicalItem.display.category === top.canonicalItem.category?.ar);

    const canonical = await canonicalOf((await kamatItem('Thali'))._id);
    await itemCols().canonicalItems.updateOne({ _id: canonical._id }, { $unset: { 'canonicalDescription.ar': '' } });
    const fallback = (await search.search({ query: 'ثالي', locale: 'ar' })).results[0].canonicalItem;
    assert.deepEqual(fallback.display.fallbackFields, ['description']);
    assert.equal(fallback.display.description, fallback.description!.en);
    assert.equal(fallback.description!.ar, undefined);
    // locale changes what is displayed, not what matches.
    assert.ok((await search.search({ query: 'Thali', locale: 'ar' })).results[0].canonicalItem.display.name === 'ثالي');
  });

  test('3. alias search', async () => {
    const canonical = await canonicalOf((await kamatItem('Thali'))._id);
    await itemCols().canonicalItems.updateOne(
      { _id: canonical._id },
      { $push: { aliases: 'Veg Meal Platter', 'signals.normalizedNames': 'veg meal platter', searchKeywords: { $each: ['veg', 'meal', 'platter'] } } }
    );
    const res = await search.search({ query: 'veg meal platter' });
    assert.equal(res.results[0].canonicalItem.id, canonical._id.toHexString());
    assert.equal(res.results[0].match.type, 'EXACT_ALIAS');
  });

  test('4. keyword search: name tokens first, ordered by tier, partial prefix matches', async () => {
    const res = await search.search({ query: 'dosa', limit: 50 });
    assert.ok(res.results.length >= 20);
    const tiers = res.results.map(r => ['EXACT_NAME', 'EXACT_ALIAS', 'KEYWORD', 'PARTIAL'].indexOf(r.match.type));
    assert.deepEqual(tiers, [...tiers].sort((a, b) => a - b));
    assert.ok(res.results.every(r => r.match.matchedTokens.includes('dosa')));
    assert.ok(res.results.slice(0, 20).every(r => r.match.nameCoverage === 1));
    assert.equal(res.truncated, res.results.length === 50);

    const masala = await search.search({ query: 'masala dosa' });
    assert.equal(masala.results[0].canonicalItem.name.en?.toLowerCase(), 'masala dosa');
    assert.equal(masala.results[0].match.type, 'EXACT_NAME');
    assert.ok(masala.results.slice(1).every(r => r.match.type !== 'EXACT_NAME'));

    const prefix = await search.search({ query: 'dos' });
    assert.ok(prefix.results.length > 0);
    assert.ok(prefix.results.every(r => r.match.type === 'PARTIAL' && r.match.prefixTokens.includes('dos')));

    const limited = await search.search({ query: 'dosa', limit: 3 });
    assert.deepEqual(limited.results.map(r => r.canonicalItem.id), res.results.slice(0, 3).map(r => r.canonicalItem.id));
    assert.equal(limited.truncated, true);
  });

  test('5. restaurant-group scope; equal names in different groups stay separate', async () => {
    const other = await addRestaurant('deliveroo', '88888', 'Other Place', { city: 'dubai', area: 'Jumeirah Lake Towers', address: 'Cluster D' });
    await backfillRestaurantIdentity(identityRepos(), { now });
    await cloneItem('Thali', other, 'o-thali');
    await backfillCanonicalItems(getDiningCanonicalItemCollections(t.db), { now });
    await importSeedItemMappings(itemCols(), { now });
    const groupB = (await itemCols().restaurantMappings.findOne({ restaurantId: other._id }))!.canonicalRestaurantGroupId!;

    const all = await search.search({ query: 'Thali' });
    const exact = all.results.filter(r => r.match.type === 'EXACT_NAME');
    assert.deepEqual(exact.map(r => r.restaurant.restaurantGroupId).sort(), [kamatGroup.toHexString(), groupB.toHexString()].sort());
    for (const g of [kamatGroup, groupB]) {
      const scoped = await search.search({ query: 'Thali', restaurantGroupId: g.toHexString() });
      assert.ok(scoped.results.length > 0);
      assert.ok(scoped.results.every(r => r.restaurant.restaurantGroupId === g.toHexString() && r.canonicalItem.restaurantGroupId === g.toHexString()));
      assert.equal(scoped.results[0].offers.length, 1);
    }
    assert.equal((await search.search({ query: 'Thali', restaurantGroupId: new ObjectId().toHexString() })).total, 0);
  });

  test('6 + 8 + 9 + H. multi-platform comparison (synthetic Talabat/Careem records) and platform filter', async () => {
    const { thali, tb, cr } = await multiPlatformThali({ talabat: 30, careem: 33 });
    const res = await search.search({ query: 'Thali' });
    const r = thaliResult(res);
    assert.deepEqual(r.offers.map(o => [o.platform, o.price]), [['talabat', 30], ['careem', 33], ['deliveroo', thali.price]]);
    assert.deepEqual(r.cheapestOffer, { platform: 'talabat', menuItemId: tb._id.toHexString(), price: 30, currency: 'AED', tiedOffers: [] });
    assert.equal(r.offers.find(o => o.platform === 'careem')!.menuItemId, cr._id.toHexString());
    assert.ok(r.offers.every(o => o.itemUrl === null && o.restaurantUrl));

    const onlyTalabat = await search.search({ query: 'Thali', platforms: ['talabat'] });
    assert.equal(onlyTalabat.total, 1);
    assert.deepEqual(onlyTalabat.results[0].offers.map(o => o.platform), ['talabat']);
    const two = await search.search({ query: 'Thali', platforms: ['deliveroo', 'careem'] });
    assert.deepEqual(thaliResult(two).offers.map(o => o.platform).sort(), ['careem', 'deliveroo']);
    assert.equal(thaliResult(two).cheapestOffer!.platform, 'careem');
    assert.equal((await search.search({ query: 'Dosa', platforms: ['talabat'] })).total, 0);

    // Canonical documents never receive prices.
    const canonicalDoc = await itemCols().canonicalItems.findOne({ seedMenuItemId: thali._id });
    assert.equal(JSON.stringify(canonicalDoc).includes('"price"'), false);
  });

  test('a cheaper Talabat listing with unknown availability is shown but does not win', async () => {
    const thali = await kamatItem('Thali');
    const canonical = await canonicalOf(thali._id);
    const talabat = await addRestaurant('talabat', 't-kamat', 'Kamat Vegetarian Business Bay', { city: 'Dubai' }, kamatGroup);
    const tb = await cloneItem('Thali', talabat, 'tb-thali', { price: 1, availabilityStatus: 'unknown' }, ['isAvailable']);
    await createItemMappingService(itemCols()).remapSourceItem(tb._id, canonical._id, { now });

    const r = thaliResult(await search.search({ query: 'Thali' }));
    const offer = r.offers.find(o => o.platform === 'talabat')!;
    assert.deepEqual(
      [offer.price, offer.availabilityStatus, offer.isAvailable, offer.eligibleForCheapest, offer.ineligibleReasons],
      [1, 'unknown', false, false, ['ITEM_AVAILABILITY_UNKNOWN']]
    );
    assert.deepEqual([r.cheapestOffer!.platform, r.cheapestOffer!.price], ['deliveroo', thali.price]);
    assert.equal(r.offers.find(o => o.platform === 'deliveroo')!.availabilityStatus, 'available');
  });

  test('9 (ties). equal prices pick a deterministic winner and list the tie', async () => {
    const { tb, cr } = await multiPlatformThali({ talabat: 30, careem: 30 });
    const r = thaliResult(await search.search({ query: 'Thali' }));
    assert.equal(r.cheapestOffer!.menuItemId, tb._id.toHexString());
    assert.deepEqual(r.cheapestOffer!.tiedOffers, [{ platform: 'careem', menuItemId: cr._id.toHexString() }]);
  });

  test('10 + 11. sold-out and delisted listings stay visible but never win; canonical item stays active', async () => {
    const { thali, tb, cr } = await multiPlatformThali({ talabat: 20, careem: 25 });
    await t.collections.menuItems.updateOne({ _id: tb._id }, { $set: { isAvailable: false } });
    await t.collections.menuItems.updateOne({ _id: cr._id }, { $set: { isActive: false } });
    const r = thaliResult(await search.search({ query: 'Thali' }));
    assert.equal(r.offers.length, 3);
    assert.equal(r.cheapestOffer!.platform, 'deliveroo');
    assert.equal(r.cheapestOffer!.price, thali.price);
    const t2 = r.offers.find(o => o.platform === 'talabat')!;
    assert.deepEqual([t2.isActive, t2.isAvailable, t2.ineligibleReasons], [true, false, ['ITEM_UNAVAILABLE']]);
    const c2 = r.offers.find(o => o.platform === 'careem')!;
    assert.deepEqual([c2.isActive, c2.ineligibleReasons], [false, ['ITEM_INACTIVE']]);
    assert.equal((await canonicalOf(thali._id)).status, 'active');
  });

  test('12 + 13. missing price and currency mismatch', async () => {
    const { tb, cr } = await multiPlatformThali({ talabat: 20, careem: 25 });
    await t.collections.menuItems.updateOne({ _id: tb._id }, { $unset: { price: '' } });
    let r = thaliResult(await search.search({ query: 'Thali' }));
    const missing = r.offers.find(o => o.platform === 'talabat')!;
    assert.deepEqual([missing.price, missing.priceStatus, missing.eligibleForCheapest], [null, 'MISSING', false]);
    assert.equal(r.cheapestOffer!.platform, 'careem');

    await t.collections.menuItems.updateOne({ _id: cr._id }, { $set: { currency: 'USD', price: 7 } });
    r = thaliResult(await search.search({ query: 'Thali' }));
    assert.equal(r.cheapestOffer, null);
    assert.equal(r.cheapestOfferStatus, 'MIXED_CURRENCIES');
    assert.deepEqual(r.cheapestByCurrency.map(c => [c.currency, c.platform]), [['AED', 'deliveroo'], ['USD', 'careem']]);
  });

  test('14 + 15. REVIEW and REJECTED mappings are never confirmed offers', async () => {
    const svc = createItemMappingService(itemCols());
    const tk = await addRestaurant('talabat', 't-kamat', 'Kamat Vegetarian Business Bay', { city: 'Dubai' }, kamatGroup);
    const bare = await cloneItem('Thali', tk, 'tb-thali-bare', { categoryName: { en: 'Meals' } }, ['description', 'modifiers']);
    const review = await svc.matchSourceItem(bare._id, { now });
    assert.equal(review.mapping.matchStatus, 'REVIEW');
    let r = thaliResult(await search.search({ query: 'Thali' }));
    assert.deepEqual(r.offers.map(o => o.platform), ['deliveroo']);

    await svc.rejectMapping(bare._id, { now: new Date(now.getTime() + 1000) });
    assert.equal(await itemCols().itemMappings.countDocuments({ menuItemId: bare._id, matchStatus: 'REJECTED' }), 1);
    r = thaliResult(await search.search({ query: 'Thali' }));
    assert.deepEqual(r.offers.map(o => o.platform), ['deliveroo']);
    assert.equal(r.excludedOffers.count, 0);
  });

  test('16. duplicate and conflicting active confirmations (legacy data without the unique index)', async () => {
    const c = itemCols();
    const thali = await kamatItem('Thali');
    const thaliCanonical = await canonicalOf(thali._id);
    const original = (await c.itemMappings.findOne({ menuItemId: thali._id, isActive: true }))!;
    await c.itemMappings.dropIndex('uniq_active_menuItemId');
    const { _id, ...copy } = original;
    await c.itemMappings.insertOne({ ...copy, decidedAt: new Date(now.getTime() - 60_000) } as DiningItemMapping);
    let r = thaliResult(await search.search({ query: 'Thali' }));
    assert.equal(r.offers.length, 1);
    assert.equal(r.offers[0].mapping.mappingId, original._id.toHexString());
    assert.deepEqual(r.excludedOffers, { count: 1, reasons: { DUPLICATE_SOURCE_ITEM: 1 } });

    const other = await canonicalOf((await kamatItem('Fried Idli'))._id);
    await c.itemMappings.insertOne({ ...copy, canonicalItemId: other._id } as DiningItemMapping);
    r = thaliResult(await search.search({ query: 'Thali' }));
    assert.equal(r.offers.length, 0);
    assert.equal(r.cheapestOffer, null);
    assert.equal(r.excludedOffers.reasons.CONFLICTING_ACTIVE_MAPPINGS, 2);
    assert.ok(thaliCanonical);
  });

  test('17. cross-group confirmations are never offers', async () => {
    const other = await addRestaurant('deliveroo', '88888', 'Other Place', { city: 'dubai', area: 'Jumeirah Lake Towers', address: 'Cluster D' });
    await backfillRestaurantIdentity(identityRepos(), { now });
    const groupB = (await itemCols().restaurantMappings.findOne({ restaurantId: other._id }))!.canonicalRestaurantGroupId!;
    const foreign = await cloneItem('Thali', other, 'o-thali');
    const thaliCanonical = await canonicalOf((await kamatItem('Thali'))._id);
    const base = {
      menuItemId: foreign._id, restaurantId: other._id, platform: 'deliveroo' as const, platformItemId: 'o-thali', canonicalItemId: thaliCanonical._id,
      matchStatus: 'MATCHED' as const, matchMethod: 'MANUAL' as const, confidence: 1, evidence: { reasons: ['MANUAL_REMAP'], conflicts: [] },
      decidedBy: 'manual' as const, decidedAt: now, isActive: true, createdAt: now, updatedAt: now,
    };
    // Raw writes simulate corrupted data; the mapping service itself refuses both.
    await itemCols().itemMappings.insertOne({ ...base, restaurantGroupId: groupB });
    let r = thaliResult(await search.search({ query: 'Thali' }));
    assert.deepEqual(r.offers.map(o => o.platform), ['deliveroo']);
    assert.deepEqual(r.excludedOffers.reasons, { CROSS_GROUP_MAPPING: 1 });

    await itemCols().itemMappings.updateOne({ menuItemId: foreign._id }, { $set: { restaurantGroupId: kamatGroup } });
    r = thaliResult(await search.search({ query: 'Thali' }));
    assert.deepEqual(r.offers.map(o => o.menuItemId), [(await kamatItem('Thali'))._id.toHexString()]);
    assert.deepEqual(r.excludedOffers.reasons, { RESTAURANT_NOT_IN_GROUP: 1 });
  });

  test('19. no canonical item found', async () => {
    for (const q of ['Truffle Ramen', 'zzzz', 'سوشي']) {
      const res = await search.search({ query: q });
      assert.deepEqual([res.total, res.results, res.truncated], [0, [], false], q);
    }
  });

  test('GET /api/dining/search end to end', async () => {
    process.env.DINING_API_KEY = API_KEY;
    await multiPlatformThali({ talabat: 30, careem: 33 });
    const server = await startServer(search);
    try {
      const res = await get(server.url, `/api/dining/search?q=Thali&locale=ar&platforms=talabat,careem&restaurantGroupId=${kamatGroup.toHexString()}&limit=5`);
      assert.equal(res.status, 200);
      assert.equal(res.body.success, true);
      assert.equal(res.body.data.query.locale, 'ar');
      assert.deepEqual(res.body.data.query.platforms, ['talabat', 'careem']);
      const top = res.body.data.results[0];
      assert.equal(top.canonicalItem.display.name, 'ثالي');
      assert.deepEqual(top.offers.map((o: { platform: string }) => o.platform), ['talabat', 'careem']);
      assert.equal(top.cheapestOffer.platform, 'talabat');
      assert.doesNotMatch(res.text, /scrape\.do|authorization|x-api-key|mongodb(\+srv)?:\/\//i);
      assert.equal(res.text.includes(API_KEY), false);
    } finally {
      await server.close();
    }
  });
});
