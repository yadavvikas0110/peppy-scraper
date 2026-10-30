/// <reference types="node" />
import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadQueries, loadWorkerConfig, WorkerConfig, DEFAULT_QUERIES_FILE } from '../../src/worker/worker.config';
import { memoryWorkerStore, emptySummary } from '../../src/worker/worker.store';
import { RequestBudget, BudgetExhaustedError } from '../../src/worker/worker.budget';
import { createWorkerLogger } from '../../src/worker/worker.logger';
import {
  computeNextRun, discoveryJobId, ensureJobs, executeJob, pickDueJob, recoverInterruptedJobs, REFRESH_JOB_ID, runScheduler,
} from '../../src/worker/worker.scheduler';
import { JobContext, loadFreshAsins, runRefresh, selectRefreshTargets } from '../../src/worker/worker.jobs';
import { BundledBulkResult } from '../../src/services/playwright.service';
import { ProductData } from '../../src/parsers/types';
import { PushResult } from '../../src/cron/push-pipeline';
import { checkStoredProduct } from '../../src/worker/ingest-report';

const NOW = new Date('2026-10-30T10:00:00.000Z');
const HOUR = 3600_000;
let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-')); });
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

function config(extra: Partial<WorkerConfig> = {}): WorkerConfig {
  return {
    env: 'development', sites: ['amazon'],
    queries: [{ key: 'iphone-16', label: 'iPhone 16', category: 'apple iphone 16', broadCategory: 'Electronics', subCategory: 'Smartphones', count: 3 }],
    discoveryIntervalMs: 24 * HOUR, refreshIntervalMs: 12 * HOUR, freshForMs: 12 * HOUR, refreshBatchSize: 50,
    dailyRequestBudget: 100, minRequestIntervalMs: 0, maxConcurrency: 1, tickMs: 5, retryBaseMs: 15 * 60_000,
    maxAttempts: 3, lockTtlMs: 60_000, outputDir: tmp, ...extra,
  };
}

/** Minimal products collection: find() returns every document; the jobs filter in JS anyway. */
function productsOf(docs: any[]) {
  return {
    docs,
    find: () => ({ toArray: async () => structuredClone(docs) }),
    insertMany: async () => ({ insertedCount: 0 }),
    updateOne: async () => ({ matchedCount: 0, modifiedCount: 0 }),
  };
}

const pushOk = (): PushResult => ({ mongoInserted: 1, mongoUpdated: 2, matchedExisting: 2, skipped: 0, chromaVectors: 0, mapping: { ok: true, message: 'mapped', mapped: 3 }, errors: [] });

function bulkResult(status: BundledBulkResult['status'], extra: Partial<BundledBulkResult> = {}): BundledBulkResult {
  return {
    jobId: 'j', status, sites: ['amazon'], category: 'q', broadCategory: 'Electronics', subCategory: 'Smartphones', requestedCountPerSite: 3,
    totalScraped: 3, bundleCount: 3, outputFile: null, bundles: [], matchReviews: [], errors: [], resumed: false,
    siteResults: [{ site: 'amazon', status: status === 'stopped' ? 'stopped' : status === 'failed' ? 'failed' : 'complete', scraped: 3, failed: 0, links: 5, skipped: 2 }],
    ...extra,
  };
}

function context(store = memoryWorkerStore(), over: Partial<JobContext> = {}): JobContext {
  const budget = new RequestBudget(store, 100, 0, () => NOW);
  return {
    config: config(),
    budget,
    logger: createWorkerLogger({ echo: false }),
    products: productsOf([]),
    now: () => NOW,
    shouldStop: () => false,
    scrapeBulk: async () => bulkResult('complete'),
    scrapeProduct: async () => { throw new Error('not used'); },
    push: async () => pushOk(),
    markStale: async () => 0,
    ...over,
  };
}

describe('worker configuration', () => {
  test('Amazon UAE only; Noon is refused without Bright Data approval', () => {
    assert.deepEqual(loadWorkerConfig({}).sites, ['amazon']);
    assert.throws(() => loadWorkerConfig({ SHOPPING_SITES: 'amazon,noon' }), /noon/);
    assert.throws(() => loadWorkerConfig({ SHOPPING_SITES: 'carrefour' }), /only "amazon"/);
  });

  test('safe defaults: 24h discovery, 12h refresh, bounded budget and concurrency', () => {
    const c = loadWorkerConfig({});
    assert.equal(c.env, 'development');
    assert.equal(c.discoveryIntervalMs, 24 * HOUR);
    assert.equal(c.refreshIntervalMs, 12 * HOUR);
    assert.equal(c.dailyRequestBudget, 800);
    assert.equal(c.maxConcurrency, 2);
    assert.throws(() => loadWorkerConfig({ SHOPPING_DAILY_REQUEST_BUDGET: '-5' }), /SHOPPING_DAILY_REQUEST_BUDGET/);
    assert.throws(() => loadWorkerConfig({ SHOPPING_WORKER_ENV: 'staging' }), /SHOPPING_WORKER_ENV/);
  });

  test('the shipped query file is valid; bad files are rejected', () => {
    assert.ok(loadQueries(DEFAULT_QUERIES_FILE).some(q => q.key === 'iphone-16'));
    const bad = path.join(tmp, 'q.json');
    fs.writeFileSync(bad, JSON.stringify([{ key: 'x', label: 'x', category: 'x', broadCategory: 'Nope', subCategory: 'Nope', count: 5 }]));
    assert.throws(() => loadQueries(bad), /unknown taxonomy/);
    fs.writeFileSync(bad, JSON.stringify([
      { key: 'a', label: 'a', category: 'a', broadCategory: 'Electronics', subCategory: 'Laptops', count: 5 },
      { key: 'a', label: 'b', category: 'b', broadCategory: 'Electronics', subCategory: 'Laptops', count: 5 },
    ]));
    assert.throws(() => loadQueries(bad), /duplicate query key/);
  });
});

describe('scheduling', () => {
  const c = config();
  test('complete and partial runs wait the full interval', () => {
    assert.equal(computeNextRun('discovery', 'complete', 0, NOW, c).getTime(), NOW.getTime() + 24 * HOUR);
    assert.equal(computeNextRun('refresh', 'partial', 0, NOW, c).getTime(), NOW.getTime() + 12 * HOUR);
  });
  test('failures back off exponentially, capped, then wait the interval', () => {
    assert.equal(computeNextRun('refresh', 'failed', 1, NOW, c).getTime() - NOW.getTime(), 15 * 60_000);
    assert.equal(computeNextRun('refresh', 'failed', 2, NOW, c).getTime() - NOW.getTime(), 30 * 60_000);
    assert.equal(computeNextRun('refresh', 'failed', 3, NOW, c).getTime() - NOW.getTime(), 12 * HOUR);
  });
  test('budget exhaustion waits for the next UTC day; interruptions resume immediately', () => {
    assert.equal(computeNextRun('discovery', 'budget_exhausted', 0, NOW, c).toISOString(), '2026-10-31T00:01:00.000Z');
    assert.equal(computeNextRun('discovery', 'interrupted', 0, NOW, c).getTime(), NOW.getTime());
  });
  test('interrupted jobs run first, then the most overdue', async () => {
    const store = memoryWorkerStore();
    const jobs = await ensureJobs(store, c, NOW);
    assert.deepEqual(jobs.map(j => j._id).sort(), [discoveryJobId(c.queries[0]), REFRESH_JOB_ID].sort());
    const later = new Date(NOW.getTime() + 1000);
    jobs[0].nextRunAt = new Date(NOW.getTime() - 5000);
    jobs[1].nextRunAt = NOW;
    jobs[1].status = 'interrupted';
    assert.equal(pickDueJob(jobs, later)!._id, jobs[1]._id);
    jobs[1].status = 'complete';
    assert.equal(pickDueJob(jobs, later)!._id, jobs[0]._id);
    assert.equal(pickDueJob(jobs.map(j => ({ ...j, nextRunAt: new Date(NOW.getTime() + HOUR) })), later), null);
  });
});

describe('scheduler lock', () => {
  test('a second worker cannot start while the first holds the lock; an expired lock is taken over', async () => {
    const store = memoryWorkerStore();
    assert.equal(await store.acquireLock('host:1', 60_000, NOW), true);
    assert.equal(await store.acquireLock('host:2', 60_000, NOW), false);
    assert.equal(await store.acquireLock('host:1', 60_000, NOW), true, 'the holder renews');
    assert.equal(await store.acquireLock('host:2', 60_000, new Date(NOW.getTime() + 61_000)), true, 'dead holder expires');
  });

  test('runScheduler refuses to start when another worker is running', async () => {
    const store = memoryWorkerStore();
    await store.acquireLock('other:9', 60_000, new Date());
    const result = await runScheduler({
      store, config: config(), owner: 'me:1', logger: createWorkerLogger({ echo: false }),
      makeContext: () => context(store), now: () => new Date(), sleep: async () => {},
      stopFile: path.join(tmp, 'stop'), statusFile: path.join(tmp, 'status.json'),
    }, { stopRequested: false });
    assert.equal(result, 'lock_unavailable');
  });
});

describe('request budget', () => {
  test('stops at the daily limit shared across processes', async () => {
    const store = memoryWorkerStore();
    const a = new RequestBudget(store, 3, 0, () => NOW);
    const b = new RequestBudget(store, 3, 0, () => NOW);
    await a.gate(); await a.gate(); await b.gate();
    await assert.rejects(b.gate(), BudgetExhaustedError);
    assert.equal(b.exhausted, true);
    assert.equal(await store.budgetUsed('2026-10-30'), 3);
  });

  test('a per-run cap stops a one-off run before the daily limit', async () => {
    const store = memoryWorkerStore();
    const run = new RequestBudget(store, 100, 0, () => NOW, undefined, 2);
    await run.gate(); await run.gate();
    await assert.rejects(run.gate(), BudgetExhaustedError);
    assert.equal(await store.budgetUsed('2026-10-30'), 2);
  });

  test('spaces requests by the minimum interval', async () => {
    let clock = NOW.getTime();
    const waits: number[] = [];
    const budget = new RequestBudget(memoryWorkerStore(), 10, 2000, () => new Date(clock), async ms => { waits.push(ms); clock += ms; });
    await budget.gate(); await budget.gate(); await budget.gate();
    assert.deepEqual(waits, [2000, 2000]);
  });
});

describe('discovery job', () => {
  test('summary counts and a complete run', async () => {
    const store = memoryWorkerStore();
    const c = config();
    const [job] = (await ensureJobs(store, c, NOW)).filter(j => j.type === 'discovery');
    const result = await executeJob(job, context(store, { config: c, scrapeBulk: async () => bulkResult('complete', { matchReviews: [{} as any] }) }), { store, config: c, now: () => NOW });
    assert.equal(result.outcome, 'complete');
    assert.deepEqual(
      { discovered: result.summary.discovered, scraped: result.summary.scraped, inserted: result.summary.inserted, updated: result.summary.updated, matched: result.summary.matched, reviewRequired: result.summary.reviewRequired, skipped: result.summary.skipped, mapped: result.summary.mapped },
      { discovered: 5, scraped: 3, inserted: 1, updated: 2, matched: 2, reviewRequired: 1, skipped: 2, mapped: 3 },
    );
    const saved = (await store.getJob(job._id))!;
    assert.equal(saved.status, 'complete');
    assert.ok(saved.lastSuccessAt);
    assert.equal(store.runs.length, 1);
  });

  test('a failed mapping or failed products make the run partial, never complete', async () => {
    const store = memoryWorkerStore();
    const c = config();
    const [job] = (await ensureJobs(store, c, NOW)).filter(j => j.type === 'discovery');
    const r1 = await executeJob(job, context(store, { config: c, push: async () => ({ ...pushOk(), mapping: { ok: false, message: 'down' }, errors: ['Backend mapping not applied: down'] }) }), { store, config: c, now: () => NOW });
    assert.equal(r1.outcome, 'partial');
    const r2 = await executeJob(job, context(store, { config: c, scrapeBulk: async () => bulkResult('complete', { errors: [{ url: 'u', message: 'timeout' }] }) }), { store, config: c, now: () => NOW });
    assert.equal(r2.outcome, 'partial');
    assert.equal((await store.getJob(job._id))!.lastSuccessAt, undefined);
  });

  test('a stopped scrape publishes nothing and is resumable', async () => {
    const store = memoryWorkerStore();
    const c = config();
    const [job] = (await ensureJobs(store, c, NOW)).filter(j => j.type === 'discovery');
    let pushed = 0;
    const r = await executeJob(job, context(store, { config: c, scrapeBulk: async () => bulkResult('stopped'), push: async () => { pushed++; return pushOk(); } }), { store, config: c, now: () => NOW });
    assert.equal(r.outcome, 'interrupted');
    assert.equal(pushed, 0);
    assert.equal((await store.getJob(job._id))!.nextRunAt.getTime(), NOW.getTime());
  });

  test('fresh products are skipped; stale ones are not', async () => {
    const ctx = context(memoryWorkerStore(), {
      products: productsOf([
        { retailers: [{ retailerId: 'amazon', externalId: 'B0FRESH001', lastSeenAt: new Date(NOW.getTime() - HOUR) }] },
        { retailers: [{ retailerId: 'amazon', externalId: 'B0OLD00001', lastSeenAt: new Date(NOW.getTime() - 30 * HOUR) }] },
        { retailers: [{ retailerId: 'amazon', externalId: 'B0STALE001', lastSeenAt: new Date(NOW.getTime() - HOUR), isStale: true }] },
      ]),
    });
    assert.deepEqual([...await loadFreshAsins(ctx)], ['B0FRESH001']);
  });
});

describe('refresh job and restart/resume', () => {
  const docs = ['B0AAAAAAA1', 'B0AAAAAAA2', 'B0AAAAAAA3', 'B0AAAAAAA4'].map((asin, i) => ({
    name: `Phone ${i}`, category: 'Electronics', subcategory: 'Smartphones', images: ['https://img/1.jpg'],
    retailers: [{ retailerId: 'amazon', externalId: asin, productUrl: `https://www.amazon.ae/dp/${asin}`, lastSeenAt: new Date(NOW.getTime() - (40 - i) * HOUR) }],
  }));
  const fresh = { name: 'Fresh', retailers: [{ retailerId: 'amazon', externalId: 'B0FRESH001', lastSeenAt: new Date(NOW.getTime() - HOUR) }] };
  const pdp = (url: string): ProductData => ({
    productName: `P ${url.slice(-10)}`, productUrl: url, imageUrl: 'https://img/1.jpg', imageUrls: ['https://img/1.jpg'],
    price: 100, currency: 'AED', ratings: null, reviewCount: null, description: null, inStock: true, category: null,
  });

  test('selects only offers older than the freshness window, oldest first', async () => {
    const ctx = context(memoryWorkerStore(), { products: productsOf([fresh, ...docs]) });
    assert.deepEqual(await selectRefreshTargets(ctx), ['B0AAAAAAA1', 'B0AAAAAAA2', 'B0AAAAAAA3', 'B0AAAAAAA4']);
  });

  test('every refreshed offer carries its own scrape time', async () => {
    const pushed: any[] = [];
    const ctx = context(memoryWorkerStore(), {
      products: productsOf(docs), scrapeProduct: async u => pdp(u),
      push: async b => { pushed.push(...b); return pushOk(); },
    });
    const job = (await ensureJobs(memoryWorkerStore(), config(), NOW)).find(j => j._id === REFRESH_JOB_ID)!;
    const r = await runRefresh(job, ctx);
    assert.equal(r.outcome, 'complete');
    assert.equal(pushed.length, 4);
    assert.ok(pushed.every(b => b.retailers[0].observedAt === NOW.toISOString() && b.retailers[0].externalId));
  });

  test('a crash mid-refresh resumes without re-scraping finished ASINs', async () => {
    const store = memoryWorkerStore();
    const c = config();
    const [job] = (await ensureJobs(store, c, NOW)).filter(j => j._id === REFRESH_JOB_ID);
    let calls = 0;
    // First process: dies (throws a non-product error out of push) after the first chunk would start
    const crashing = context(store, {
      config: c, products: productsOf(docs),
      scrapeProduct: async u => { calls++; return pdp(u); },
      shouldStop: () => calls >= 2, // simulates a stop signal after two products
    });
    const first = await executeJob(job, crashing, { store, config: c, now: () => NOW });
    assert.equal(first.outcome, 'interrupted');
    const saved = (await store.getJob(REFRESH_JOB_ID))!;
    assert.equal(saved.progress!.done.length, 2);

    // Simulate the process dying while marked running, then a restart
    await store.saveJob({ ...saved, status: 'running' });
    assert.deepEqual(await recoverInterruptedJobs(store, NOW), [REFRESH_JOB_ID]);
    const seen: string[] = [];
    const resumed = context(store, { config: c, products: productsOf(docs), scrapeProduct: async u => { seen.push(u.slice(-10)); return pdp(u); } });
    const second = await executeJob((await store.getJob(REFRESH_JOB_ID))!, resumed, { store, config: c, now: () => NOW });
    assert.equal(second.outcome, 'complete');
    assert.deepEqual(seen, ['B0AAAAAAA3', 'B0AAAAAAA4']);
    assert.equal((await store.getJob(REFRESH_JOB_ID))!.progress, null);
  });

  test('budget exhaustion mid-refresh keeps progress and waits for tomorrow', async () => {
    const store = memoryWorkerStore();
    const c = config();
    const [job] = (await ensureJobs(store, c, NOW)).filter(j => j._id === REFRESH_JOB_ID);
    const ctx = context(store, { config: c, products: productsOf(docs) });
    let n = 0;
    ctx.scrapeProduct = async u => {
      if (++n === 3) { ctx.budget.exhausted = true; throw new BudgetExhaustedError('2026-10-30', 2); }
      return pdp(u);
    };
    const r = await executeJob(job, ctx, { store, config: c, now: () => NOW });
    assert.equal(r.outcome, 'budget_exhausted');
    const saved = (await store.getJob(REFRESH_JOB_ID))!;
    assert.equal(saved.progress!.done.length, 2, 'the product hit by the budget stop is not marked done');
    assert.equal(saved.nextRunAt.toISOString(), '2026-10-31T00:01:00.000Z');
  });

  test('an expired refresh progress is discarded instead of resumed', async () => {
    const store = memoryWorkerStore();
    const job = { ...(await ensureJobs(store, config(), NOW)).find(j => j._id === REFRESH_JOB_ID)!, progress: { runId: 'old', startedAt: new Date(NOW.getTime() - 48 * HOUR), targets: ['B0GONE0001'], done: [] } };
    const seen: string[] = [];
    await runRefresh(job, context(store, { products: productsOf(docs), scrapeProduct: async u => { seen.push(u.slice(-10)); return pdp(u); } }));
    assert.ok(!seen.includes('B0GONE0001'));
    assert.equal(seen.length, 4);
  });
});

describe('scheduler loop', () => {
  test('runs due jobs, stops gracefully on request, and releases the lock', async () => {
    const store = memoryWorkerStore();
    let ran = 0;
    const signals = { stopRequested: false };
    const result = await runScheduler({
      store, config: config(), owner: 'me:1', logger: createWorkerLogger({ echo: false }),
      makeContext: stop => context(store, { shouldStop: stop, products: productsOf([]), scrapeBulk: async () => { ran++; return bulkResult('complete'); } }),
      now: () => NOW,
      sleep: async () => { signals.stopRequested = true; },
      stopFile: path.join(tmp, 'stop'), statusFile: path.join(tmp, 'status.json'),
    }, signals);
    assert.equal(result, 'stopped');
    assert.equal(ran, 1, 'the discovery job ran once; refresh had nothing to do');
    assert.equal(store.lock, null);
    const status = JSON.parse(fs.readFileSync(path.join(tmp, 'status.json'), 'utf8'));
    assert.equal(status.state, 'stopped');
    assert.equal(status.jobs.length, 2);
  });

  test('a stop file written by the stop command ends the loop', async () => {
    const store = memoryWorkerStore();
    const stopFile = path.join(tmp, 'stop');
    fs.writeFileSync(stopFile, '{}');
    const result = await runScheduler({
      store, config: config(), owner: 'me:1', logger: createWorkerLogger({ echo: false }),
      makeContext: () => context(store), now: () => NOW, sleep: async () => {},
      stopFile, statusFile: path.join(tmp, 'status.json'),
    }, { stopRequested: false });
    assert.equal(result, 'stopped');
    assert.equal(fs.existsSync(stopFile), false);
  });
});

describe('ingest quality report', () => {
  const asin = 'B0DGHYDZR9';
  const good = {
    name: 'Apple iPhone 16 128GB Black', images: ['i'], categories: ['Gadgets'], discoveryCategories: [], productRole: 'main_product',
    ingestMappingStatus: 'mapped', variantMappingStatus: 'needs_review', bestConfirmedPrice: 3399,
    retailers: [{ retailerId: 'amazon', externalId: asin, productUrl: `https://www.amazon.ae/dp/${asin}`, canonicalUrl: `https://amazon.ae/dp/${asin}`, price: 3399, currency: 'AED', stockStatus: 'available', inStock: true, lastSeenAt: new Date('2026-10-30T09:00:00.000Z') }],
  };
  test('a correct product passes', () => {
    assert.deepEqual(checkStoredProduct(asin, '2026-10-30T09:00:00.000Z', [good]).problems, []);
  });
  test('flags duplicates, wrong currency, missing mapping and a wrong best confirmed price', () => {
    const bad = { ...good, ingestMappingStatus: 'pending', bestConfirmedPrice: 100, retailers: [{ ...good.retailers[0], currency: 'USD' }] };
    const problems = checkStoredProduct(asin, '2026-10-30T09:00:00.000Z', [bad, good]).problems.join('|');
    for (const p of ['duplicate', 'currency USD', 'mapping pending', 'bestConfirmedPrice']) assert.match(problems, new RegExp(p));
  });
});

void emptySummary;
