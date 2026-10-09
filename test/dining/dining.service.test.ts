/// <reference types="node" />
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DiningScrapeContext,
  DiningScrapeError,
  runDiningScrape,
  validateDiningScrapeRequest,
} from '../../src/dining/dining.service';
import { getDiningPlatformModule } from '../../src/dining/platforms/platform.registry';
import { ScrapeDoError } from '../../src/shared/scrapedo/scrapedo.errors';
import {
  closeTestClient,
  FAKE_SCRAPE_DO_TOKEN,
  fakeScrapeDo,
  FIXTURE_URL,
  fixtureHtml,
  LOCAL_DB_SKIP,
  openTestDb,
  pageByLocale,
  TestDb,
  THALI,
  withMenuRoot,
} from './helpers';

const silent = { log: () => {}, warn: () => {}, error: () => {} };
const body = (overrides: Record<string, unknown> = {}) => ({ platform: 'deliveroo', locale: 'en', targetUrl: FIXTURE_URL.en, dryRun: false, ...overrides });

async function expectScrapeError(promise: Promise<unknown>, expected: Partial<Pick<DiningScrapeError, 'stage' | 'code' | 'httpStatus'>>): Promise<DiningScrapeError> {
  try {
    await promise;
  } catch (err) {
    assert.ok(err instanceof DiningScrapeError, `expected DiningScrapeError, got ${err}`);
    for (const [k, v] of Object.entries(expected)) assert.equal((err as any)[k], v, k);
    return err;
  }
  assert.fail('expected the scrape to fail');
}

describe('scrape request validation', () => {
  test('valid request is normalized (locale segment kept, query preserved)', () => {
    const v = validateDiningScrapeRequest(body());
    assert.ok(v.ok);
    assert.deepEqual(v.value, { platform: 'deliveroo', locale: 'en', targetUrl: FIXTURE_URL.en, dryRun: false });
    const noLocale = validateDiningScrapeRequest(body({ targetUrl: 'https://deliveroo.ae/menu/Dubai/dubai-business-bay/kamat-dt', dryRun: undefined }));
    assert.ok(noLocale.ok);
    assert.equal(noLocale.value.targetUrl, 'https://deliveroo.ae/en/menu/Dubai/dubai-business-bay/kamat-dt/');
    assert.equal(noLocale.value.dryRun, false);
  });

  test('missing/invalid fields, unknown fields (e.g. a token) and wrong types', () => {
    const v = validateDiningScrapeRequest({ platform: 'deliveroo', locale: 'en', dryRun: 'yes', scrapeDoToken: 'x' });
    assert.ok(!v.ok);
    assert.equal(v.code, 'INVALID_REQUEST');
    assert.deepEqual(v.errors.map(e => e.field).sort(), ['dryRun', 'scrapeDoToken', 'targetUrl']);
    assert.ok(!validateDiningScrapeRequest(null).ok);
    assert.ok(!validateDiningScrapeRequest([]).ok);
  });

  test('unsupported platform and locale have their own codes', () => {
    const p = validateDiningScrapeRequest(body({ platform: 'careem' }));
    assert.ok(!p.ok && p.code === 'UNSUPPORTED_PLATFORM');
    const l = validateDiningScrapeRequest(body({ locale: 'fr' }));
    assert.ok(!l.ok && l.code === 'UNSUPPORTED_LOCALE');
  });

  test('target URL must be a menu page of the platform, in the requested locale', () => {
    for (const targetUrl of ['https://example.com/', 'https://deliveroo.ae/en/restaurants/dubai', 'javascript:alert(1)', 'x'.repeat(3000)]) {
      assert.ok(!validateDiningScrapeRequest(body({ targetUrl })).ok, targetUrl.slice(0, 40));
    }
    const mismatch = validateDiningScrapeRequest(body({ locale: 'en', targetUrl: FIXTURE_URL.ar }));
    assert.ok(!mismatch.ok);
    assert.match(mismatch.errors[0].message, /"ar" page but locale is "en"/);
  });

  test('invalid request fails before any run, fetch or database access', async () => {
    let touched = false;
    const ctx: DiningScrapeContext = {
      scrapeDo: { fetchHtml: async () => { touched = true; throw new Error('no'); } },
      repositories: async () => { touched = true; throw new Error('no'); },
      logger: silent,
    };
    await expectScrapeError(runDiningScrape(body({ locale: 'de' }), ctx), { stage: 'validation', code: 'UNSUPPORTED_LOCALE', httpStatus: 400 });
    assert.equal(touched, false);
  });
});

describe('runDiningScrape against a local MongoDB (fake Scrape.do)', { skip: LOCAL_DB_SKIP }, () => {
  let t: TestDb;
  before(async () => { t = await openTestDb('service'); });
  beforeEach(async () => { await t.reset(); });
  after(async () => { await t?.close(); await closeTestClient(); });

  const context = (scrapeDo = fakeScrapeDo(pageByLocale).client, extra: Partial<DiningScrapeContext> = {}): DiningScrapeContext =>
    ({ scrapeDo, repositories: t.repos, logger: silent, ...extra });

  test('7+12. real scrape: full pipeline, persisted data and a complete run record', async () => {
    const fake = fakeScrapeDo(pageByLocale, { finalUrl: `https://api.scrape.do/?token=${FAKE_SCRAPE_DO_TOKEN}` });
    const result = await runDiningScrape(body(), context(fake.client));

    assert.equal(fake.calls.length, 1);
    assert.equal(fake.calls[0].url, FIXTURE_URL.en);
    assert.deepEqual(fake.calls[0].options, getDiningPlatformModule('deliveroo')!.adapter.getFetchOptions(FIXTURE_URL.en, 'en'));
    assert.equal(fake.calls[0].options!.super, undefined);
    assert.equal(fake.calls[0].options!.playWithBrowser, undefined);

    assert.equal(result.status, 'succeeded');
    assert.equal(result.dryRun, false);
    assert.equal(result.counts.restaurantsCreated, 1);
    assert.equal(result.counts.categoriesCreated, 28);
    assert.equal(result.counts.itemsCreated, 332);
    assert.deepEqual(result.fetch, { statusCode: 200, initialStatusCode: 200, requestCost: 5, remainingCredits: 990, attempts: 1, durationMs: 1200 });
    assert.ok(result.restaurantId);

    const run = (await t.collections.scrapeRuns.findOne({ runId: result.runId }))!;
    assert.equal(run.status, 'succeeded');
    assert.equal(run.trigger, 'manual');
    assert.equal(run.targetType, 'restaurant');
    assert.equal(run.targetUrl, FIXTURE_URL.en);
    assert.equal(run.dryRun, false);
    assert.ok(run.finishedAt && run.durationMs! >= 0);
    assert.deepEqual(run.counts, result.counts);
    assert.equal(run.fetch!.requestCost, 5);
    assert.equal(run.fetch!.finalUrl, undefined);
    assert.doesNotMatch(JSON.stringify(run), new RegExp(`${FAKE_SCRAPE_DO_TOKEN}|scrape\\.do`));
    assert.equal(await t.collections.menuItems.countDocuments(), 332);
  });

  test('6. dry run: fetch, parse, map, validate and count, but no menu writes', async () => {
    const result = await runDiningScrape(body({ dryRun: true }), context());
    assert.equal(result.dryRun, true);
    assert.equal(result.counts.itemsCreated, 332);
    assert.equal(result.restaurantId, undefined);
    for (const c of [t.collections.restaurants, t.collections.menuCategories, t.collections.menuItems]) {
      assert.equal(await c.countDocuments(), 0);
    }
    const run = (await t.collections.scrapeRuns.findOne({ runId: result.runId }))!;
    assert.equal(run.dryRun, true);
    assert.equal(run.status, 'succeeded');
  });

  test('13+14. EN then AR merge into the same documents; repeats create nothing', async () => {
    await runDiningScrape(body(), context());
    const ar = await runDiningScrape(body({ locale: 'ar', targetUrl: FIXTURE_URL.ar }), context());
    assert.equal(ar.counts.restaurantsCreated + ar.counts.categoriesCreated + ar.counts.itemsCreated, 0);
    assert.equal(ar.counts.itemsUpdated, 332);

    assert.equal(await t.collections.restaurants.countDocuments(), 1);
    assert.equal(await t.collections.menuCategories.countDocuments(), 28);
    assert.equal(await t.collections.menuItems.countDocuments(), 332);
    const thali = (await t.collections.menuItems.findOne({ platformItemId: THALI }))!;
    assert.deepEqual(thali.name, { en: 'Thali', ar: 'ثالي' });
    assert.equal(thali.price, 35);

    const again = await runDiningScrape(body({ locale: 'ar', targetUrl: FIXTURE_URL.ar }), context());
    assert.equal(again.counts.itemsUnchanged, 332);
    assert.equal(await t.collections.menuItems.countDocuments(), 332);
    assert.equal(await t.collections.scrapeRuns.countDocuments(), 3);
  });

  test('16. missing-item safety: a suspicious drop marks nothing inactive; a small removal does', async () => {
    await runDiningScrape(body(), context());
    const fewItems = withMenuRoot(fixtureHtml('en'), root => {
      root.items = root.items.slice(0, 100);
    });
    const dropped = await runDiningScrape(body(), context(fakeScrapeDo(() => fewItems).client));
    assert.equal(dropped.counts.itemsMarkedInactive, 0);
    assert.ok(dropped.inactive.reasons.includes('SUSPICIOUS_ITEM_DROP'));
    assert.equal(await t.collections.menuItems.countDocuments({ isActive: true }), 332);

    const oneLess = withMenuRoot(fixtureHtml('en'), root => { root.items = root.items.filter((i: any) => String(i.id) !== THALI); });
    const removed = await runDiningScrape(body(), context(fakeScrapeDo(() => oneLess).client));
    assert.equal(removed.counts.itemsMarkedInactive, 1);
    assert.equal((await t.collections.menuItems.findOne({ platformItemId: THALI }))!.isActive, false);
    assert.equal(await t.collections.menuItems.countDocuments(), 332);
  });

  test('15. concurrent-run prevention (in-process and via the scrape-run lock)', async () => {
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const slow = fakeScrapeDo(async url => { await gate; return pageByLocale(url); });
    const first = runDiningScrape(body(), context(slow.client));
    await new Promise(r => setTimeout(r, 20));
    await expectScrapeError(runDiningScrape(body(), context()), { stage: 'lock', code: 'RUN_IN_PROGRESS', httpStatus: 409 });
    const otherLocale = await runDiningScrape(body({ locale: 'ar', targetUrl: FIXTURE_URL.ar }), context());
    assert.equal(otherLocale.status, 'succeeded');
    release();
    assert.equal((await first).status, 'succeeded');

    // Another process holds the lock (a running run record for the same target).
    const held = await t.repos.runs.createRunning({ platform: 'deliveroo', locale: 'en', targetType: 'restaurant', targetUrl: FIXTURE_URL.en, trigger: 'cron', dryRun: false });
    const err = await expectScrapeError(runDiningScrape(body(), context()), { code: 'RUN_IN_PROGRESS', httpStatus: 409 });
    assert.equal(err.runId, held.runId);
  });

  test('fetch failure: run failed at fetch with a safe message', async () => {
    const ctx = context({
      fetchHtml: async () => { throw new ScrapeDoError({ category: 'quota', statusCode: 401, message: 'Scrape.do credits exhausted', attempts: 1 }); },
    });
    const err = await expectScrapeError(runDiningScrape(body(), ctx), { stage: 'fetch', code: 'SCRAPE_DO_QUOTA', httpStatus: 502 });
    const run = (await t.collections.scrapeRuns.findOne({ runId: err.runId }))!;
    assert.equal(run.status, 'failed');
    assert.deepEqual(run.errors.map(e => [e.stage, e.code]), [['fetch', 'SCRAPE_DO_QUOTA']]);
    assert.equal(run.fetch!.statusCode, 401);
  });

  test('8. parser failure: run failed at parse, nothing persisted', async () => {
    const deliveroo = getDiningPlatformModule('deliveroo')!;
    const registry = (p: string) => p === 'deliveroo'
      ? { ...deliveroo, adapter: { ...deliveroo.adapter, parse: () => { throw new Error('unexpected markup'); } } }
      : undefined;
    const err = await expectScrapeError(runDiningScrape(body(), context(undefined, { registry })), { stage: 'parse', code: 'PARSE_FAILED', httpStatus: 422 });
    assert.equal((await t.collections.scrapeRuns.findOne({ runId: err.runId }))!.status, 'failed');
    assert.equal(await t.collections.restaurants.countDocuments(), 0);
  });

  test('9. mapper failure (blocked/empty page): run failed at map, nothing persisted', async () => {
    const err = await expectScrapeError(
      runDiningScrape(body(), context(fakeScrapeDo(() => '<html lang="en"><body>Access denied</body></html>').client)),
      { stage: 'map', code: 'MISSING_RESTAURANT_NAME', httpStatus: 422 }
    );
    assert.equal((await t.collections.scrapeRuns.findOne({ runId: err.runId }))!.errors[0].code, 'MISSING_RESTAURANT_NAME');
    assert.equal(await t.collections.restaurants.countDocuments(), 0);
  });

  test('10. canonical validation failure: run failed at validate, nothing persisted', async () => {
    const deliveroo = getDiningPlatformModule('deliveroo')!;
    const registry = (p: string) => p === 'deliveroo'
      ? { ...deliveroo, mapper: { ...deliveroo.mapper, map: (r: unknown) => {
        const menu = deliveroo.mapper.map(r);
        return { ...menu, restaurant: { ...menu.restaurant, currency: 'dirham' } };
      } } }
      : undefined;
    await expectScrapeError(runDiningScrape(body(), context(undefined, { registry })), { stage: 'validate', code: 'INVALID_RESTAURANT', httpStatus: 422 });
    assert.equal(await t.collections.restaurants.countDocuments(), 0);
    assert.equal(await t.collections.menuItems.countDocuments(), 0);
  });

  test('11. persistence failure: run failed at persist, message has no secrets', async () => {
    const repos = {
      ...t.repos,
      items: { ...t.repos.items, upsertMany: async () => { throw new Error('connection lost to mongodb://admin:hunter2@db.internal:27017'); } },
    };
    const err = await expectScrapeError(runDiningScrape(body(), context(undefined, { repositories: repos })), { stage: 'persist', code: 'PERSISTENCE_FAILED', httpStatus: 500 });
    assert.doesNotMatch(err.message, /hunter2/);
    const run = (await t.collections.scrapeRuns.findOne({ runId: err.runId }))!;
    assert.equal(run.status, 'failed');
    assert.doesNotMatch(JSON.stringify(run), /hunter2/);
  });

  test('partial status when individual records are rejected', async () => {
    const page = withMenuRoot(fixtureHtml('en'), root => { root.items.find((i: any) => String(i.id) === THALI).price = null; });
    const result = await runDiningScrape(body(), context(fakeScrapeDo(() => page).client));
    assert.equal(result.status, 'partial');
    assert.equal(result.counts.itemsCreated, 331);
    assert.equal(result.counts.itemsRejected, 1);
    assert.deepEqual(result.errors.map(e => e.code), ['INVALID_PRICE']);
    assert.equal((await t.collections.scrapeRuns.findOne({ runId: result.runId }))!.status, 'partial');
  });
});
