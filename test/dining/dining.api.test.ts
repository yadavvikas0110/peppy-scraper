/// <reference types="node" />
import { after, afterEach, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'http';
import type { AddressInfo } from 'net';
import { createDiningApp } from '../../src/dining/dining.app';
import type { DiningControllerDeps } from '../../src/dining/dining.controller';
import { DiningScrapeError, DiningScrapeRequest, DiningScrapeResult, runDiningScrape } from '../../src/dining/dining.service';
import { emptyScrapeRunCounts } from '../../src/dining/dining.types';
import { closeTestClient, fakeScrapeDo, FIXTURE_URL, LOCAL_DB_SKIP, openTestDb, pageByLocale, TestDb, THALI } from './helpers';

const API_KEY = 'test-dining-key-0123456789';

async function startServer(deps: DiningControllerDeps): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer(createDiningApp(deps));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise(resolve => server.close(() => resolve())) };
}

async function post(base: string, payload: unknown, headers: Record<string, string> = { 'x-api-key': API_KEY }) {
  const res = await fetch(`${base}/api/dining/scrape`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof payload === 'string' ? payload : JSON.stringify(payload),
  });
  const text = await res.text();
  return { status: res.status, body: JSON.parse(text), text };
}

const validBody = { platform: 'deliveroo', locale: 'en', targetUrl: FIXTURE_URL.en, dryRun: false };

function fakeResult(request: DiningScrapeRequest): DiningScrapeResult {
  return {
    runId: 'run_fake_0001', platform: request.platform, locale: request.locale, targetUrl: request.targetUrl,
    status: 'succeeded', dryRun: request.dryRun, restaurantId: 'abc',
    counts: { ...emptyScrapeRunCounts(), restaurantsCreated: 1, categoriesCreated: 28, itemsSeen: 332, itemsCreated: 332 },
    fetch: { statusCode: 200, requestCost: 5, remainingCredits: 990, attempts: 1 },
    durationMs: 1500,
    completeness: { complete: true, reasons: [], itemsSeen: 332, itemsMapped: 332, itemsRejected: 0 },
    inactive: { applied: true, reasons: [], previousActiveItems: 0, seenItems: 332 },
    warnings: { total: 0, byCode: {} },
    errors: [],
  };
}

describe('POST /api/dining/scrape — HTTP layer (fake service)', () => {
  let server: { url: string; close: () => Promise<void> };
  let calls: DiningScrapeRequest[];
  let behaviour: (r: DiningScrapeRequest) => Promise<DiningScrapeResult>;
  const savedKey = process.env.DINING_API_KEY;

  before(async () => {
    server = await startServer({ runScrape: r => { calls.push(r); return behaviour(r); }, logger: { error: () => {} } });
  });
  beforeEach(() => {
    process.env.DINING_API_KEY = API_KEY;
    calls = [];
    behaviour = async r => fakeResult(r);
  });
  afterEach(() => {
    if (savedKey === undefined) delete process.env.DINING_API_KEY;
    else process.env.DINING_API_KEY = savedKey;
  });
  after(async () => { await server.close(); });

  test('1+17. authentication success → 200 with the success envelope', async () => {
    const res = await post(server.url, validBody);
    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.message, 'Dining scrape completed');
    assert.equal(res.body.data.runId, 'run_fake_0001');
    assert.equal(res.body.data.status, 'succeeded');
    assert.equal(res.body.data.dryRun, false);
    for (const k of ['restaurantsCreated', 'restaurantsUpdated', 'categoriesCreated', 'categoriesUpdated', 'itemsCreated', 'itemsUpdated', 'itemsRejected', 'itemsMarkedInactive']) {
      assert.equal(typeof res.body.data.counts[k], 'number', k);
    }
    assert.deepEqual(res.body.data.fetch, { statusCode: 200, requestCost: 5, remainingCredits: 990, attempts: 1 });
    assert.deepEqual(calls, [{ platform: 'deliveroo', locale: 'en', targetUrl: FIXTURE_URL.en, dryRun: false }]);
  });

  test('dry run message is explicit', async () => {
    const res = await post(server.url, { ...validBody, dryRun: true });
    assert.equal(res.body.data.dryRun, true);
    assert.match(res.body.message, /dry run/i);
  });

  test('2. authentication failure: missing or wrong key → 401; unset server key → 503 (fail closed)', async () => {
    const missing = await post(server.url, validBody, {});
    assert.equal(missing.status, 401);
    assert.equal(missing.body.success, false);
    const wrong = await post(server.url, validBody, { 'x-api-key': 'nope' });
    assert.equal(wrong.status, 401);
    delete process.env.DINING_API_KEY;
    const unset = await post(server.url, validBody);
    assert.equal(unset.status, 503);
    for (const r of [missing, wrong, unset]) assert.doesNotMatch(r.text, new RegExp(API_KEY));
    assert.equal(calls.length, 0);
  });

  test('auth runs before body parsing (malformed JSON without a key is still 401)', async () => {
    assert.equal((await post(server.url, '{oops', {})).status, 401);
    const bad = await post(server.url, '{oops');
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error.code, 'INVALID_JSON');
  });

  test('3. invalid request → 400 with field details; secrets in the body are refused', async () => {
    const res = await post(server.url, { platform: 'deliveroo', locale: 'en', SCRAPE_DO_TOKEN: 'x' });
    assert.equal(res.status, 400);
    assert.equal(res.body.success, false);
    assert.equal(res.body.error.code, 'INVALID_REQUEST');
    assert.deepEqual(res.body.error.details.map((d: { field: string }) => d.field).sort(), ['SCRAPE_DO_TOKEN', 'targetUrl']);
    assert.equal(calls.length, 0);
  });

  test('4. unsupported platform → 400 UNSUPPORTED_PLATFORM', async () => {
    const res = await post(server.url, { ...validBody, platform: 'careem' });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'UNSUPPORTED_PLATFORM');
  });

  test('5. unsupported locale → 400 UNSUPPORTED_LOCALE', async () => {
    const res = await post(server.url, { ...validBody, locale: 'fr' });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'UNSUPPORTED_LOCALE');
  });

  test('17. failure envelope: runId, stage, code, safe message, no stack', async () => {
    behaviour = async () => {
      throw new DiningScrapeError({ stage: 'fetch', code: 'SCRAPE_DO_QUOTA', httpStatus: 502, message: 'failed at https://api.scrape.do/?token=abc', runId: 'run_fake_0002' });
    };
    const res = await post(server.url, validBody);
    assert.equal(res.status, 502);
    assert.deepEqual(res.body, {
      success: false,
      message: 'failed at <scrape.do request>',
      error: { stage: 'fetch', code: 'SCRAPE_DO_QUOTA' },
      data: { runId: 'run_fake_0002' },
    });
  });

  test('unexpected errors → generic 500 without internals', async () => {
    behaviour = async () => { throw new Error('boom at /secret/path with token=abc'); };
    const res = await post(server.url, validBody);
    assert.equal(res.status, 500);
    assert.deepEqual(res.body, { success: false, message: 'Internal error', error: { stage: 'internal', code: 'INTERNAL_ERROR' } });
  });

  test('health stays public; unknown routes 404', async () => {
    delete process.env.DINING_API_KEY;
    const health = await fetch(`${server.url}/health`);
    assert.equal(health.status, 200);
    assert.equal((await fetch(`${server.url}/nope`)).status, 404);
  });
});

describe('POST /api/dining/scrape end-to-end (local MongoDB, fake Scrape.do)', { skip: LOCAL_DB_SKIP }, () => {
  let t: TestDb;
  let server: { url: string; close: () => Promise<void> };
  const savedKey = process.env.DINING_API_KEY;

  before(async () => {
    process.env.DINING_API_KEY = API_KEY;
    t = await openTestDb('api');
    const fake = fakeScrapeDo(pageByLocale);
    const silent = { log: () => {}, warn: () => {}, error: () => {} };
    server = await startServer({ runScrape: r => runDiningScrape(r, { scrapeDo: fake.client, repositories: t.repos, logger: silent }) });
  });
  after(async () => {
    await server?.close();
    await t?.close();
    await closeTestClient();
    if (savedKey === undefined) delete process.env.DINING_API_KEY;
    else process.env.DINING_API_KEY = savedKey;
  });

  test('EN then AR through the endpoint: one restaurant/category/item set with both locales', async () => {
    const en = await post(server.url, validBody);
    assert.equal(en.status, 200);
    assert.equal(en.body.data.counts.itemsCreated, 332);
    const ar = await post(server.url, { ...validBody, locale: 'ar', targetUrl: FIXTURE_URL.ar });
    assert.equal(ar.status, 200);
    assert.equal(ar.body.data.counts.itemsCreated, 0);
    assert.equal(ar.body.data.counts.itemsUpdated, 332);

    assert.equal(await t.collections.restaurants.countDocuments(), 1);
    assert.equal(await t.collections.menuCategories.countDocuments(), 28);
    assert.equal(await t.collections.menuItems.countDocuments(), 332);
    assert.equal(await t.collections.scrapeRuns.countDocuments({ status: 'succeeded' }), 2);
    const thali = (await t.collections.menuItems.findOne({ platformItemId: THALI }))!;
    assert.deepEqual(thali.name, { en: 'Thali', ar: 'ثالي' });
  });
});
