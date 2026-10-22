/// <reference types="node" />
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';
import { ObjectId } from 'mongodb';
import { diffFields } from '../../src/dining/cron/dining-cron.changes';
import { DiningCronCollections, ensureDiningCronIndexes, getDiningCronCollections } from '../../src/dining/cron/dining-cron.collections';
import { DINING_CRON_DEFAULTS, DiningCronConfig, isDiningCronEnabled, loadDiningCronConfig } from '../../src/dining/cron/dining-cron.config';
import { DINING_CRON_LOCK_KEY, emptyCronTotals, STALE_JOB_MS } from '../../src/dining/cron/dining-cron.repository';
import { decideJobStatus, DiningCronRunnerDeps, runDiningCronJob } from '../../src/dining/cron/dining-cron.runner';
import { startDiningCronScheduler } from '../../src/dining/cron/dining-cron.scheduler';
import { estimateScrapeDoCredits, loadDiningCronPlan } from '../../src/dining/cron/dining-cron.targets';
import { matchesExpectedRestaurant, runDiningScrape } from '../../src/dining/dining.service';
import type { DiningLocale } from '../../src/dining/dining.types';
import { ScrapeDoError } from '../../src/shared/scrapedo/scrapedo.errors';
import type { ScrapeDoClient } from '../../src/shared/scrapedo/scrapedo.client';
import { makeRestaurant } from './fixtures';
import {
  closeTestClient,
  FAKE_SCRAPE_DO_TOKEN,
  fakeScrapeDo,
  FIXTURE_URL,
  fixtureHtml,
  goldenMileFixtureHtml,
  LOCAL_DB_SKIP,
  openTestDb,
  pageByLocale,
  TestDb,
  THALI,
  withMenuRoot, fakeUpload } from './helpers';

const silent = { log: () => {}, warn: () => {}, error: () => {} };
const localeOf = (url: string): DiningLocale => (url.includes('/ar/') ? 'ar' : 'en');
const testConfig = (overrides: Partial<DiningCronConfig> = {}): DiningCronConfig =>
  ({ ...DINING_CRON_DEFAULTS, enabled: true, delayMs: 0, retryDelayMs: 0, ...overrides });

// ─── Config, estimates, status (pure) ────────────────────────────────────────

describe('dining cron config', () => {
  test('off unless ENABLE_DINING_CRON is true', () => {
    assert.equal(isDiningCronEnabled({}), false);
    assert.equal(isDiningCronEnabled({ ENABLE_DINING_CRON: 'false' }), false);
    assert.equal(isDiningCronEnabled({ ENABLE_DINING_CRON: 'ture' }), false);
    assert.equal(isDiningCronEnabled({ ENABLE_DINING_CRON: 'true' }), true);
    assert.equal(isDiningCronEnabled({ ENABLE_DINING_CRON: ' TRUE ' }), true);
  });

  test('defaults: daily at 13:00, bounded concurrency and retries', () => {
    const c = loadDiningCronConfig({ ENABLE_DINING_CRON: 'true' });
    assert.equal(c.enabled, true);
    assert.equal(c.schedule, '0 13 * * *');
    assert.equal(c.timezone, 'Asia/Kolkata');
    assert.equal(c.concurrency, 2);
    assert.equal(c.retryAttempts, 1);
  });

  test('invalid values fail loudly', () => {
    assert.throws(() => loadDiningCronConfig({ DINING_CRON_SCHEDULE: 'every day' }), /DINING_CRON_SCHEDULE/);
    assert.throws(() => loadDiningCronConfig({ DINING_CRON_TIMEZONE: 'Mars/Base' }), /DINING_CRON_TIMEZONE/);
    assert.throws(() => loadDiningCronConfig({ DINING_CRON_CONCURRENCY: '20' }), /DINING_CRON_CONCURRENCY/);
    assert.throws(() => loadDiningCronConfig({ DINING_CRON_RUN_ON_START: 'maybe' }), /DINING_CRON_RUN_ON_START/);
    assert.equal(loadDiningCronConfig({ DINING_CRON_TIMEZONE: 'Asia/Dubai', DINING_CRON_SCHEDULE: '30 13 * * *' }).timezone, 'Asia/Dubai');
  });

  test('Scrape.do credit estimate per request', () => {
    assert.equal(estimateScrapeDoCredits({}), 1);
    assert.equal(estimateScrapeDoCredits({ render: true }), 5);
    assert.equal(estimateScrapeDoCredits({ super: true }), 10);
    assert.equal(estimateScrapeDoCredits({ render: true, super: true }), 25);
  });

  test('job status from totals', () => {
    const totals = (o: Partial<ReturnType<typeof emptyCronTotals>>) => ({ ...emptyCronTotals(), ...o });
    assert.equal(decideJobStatus(totals({}), undefined), 'succeeded');
    assert.equal(decideJobStatus(totals({ targetsSucceeded: 3 }), undefined), 'succeeded');
    assert.equal(decideJobStatus(totals({ targetsSucceeded: 2, targetsFailed: 1 }), undefined), 'partial');
    assert.equal(decideJobStatus(totals({ targetsFailed: 2 }), undefined), 'failed');
    assert.equal(decideJobStatus(totals({ targetsSucceeded: 1 }), 'LOW_SCRAPE_DO_CREDITS'), 'partial');
    assert.equal(decideJobStatus(totals({ targetsFailed: 1 }), 'SCRAPE_DO_UNAVAILABLE'), 'failed');
    assert.equal(decideJobStatus(totals({ targetsSucceeded: 1 }), 'SHUTDOWN'), 'aborted');
  });

  test('field diff: prices, images, modifiers; ObjectIds and empties normalized', () => {
    const id = new ObjectId();
    const before = { _id: id, price: 35, imageUrl: 'a.jpg', categoryId: id, description: { en: '' }, modifiers: [{ options: [{ n: 1 }] }] };
    const after = { _id: id, price: 39, imageUrl: 'b.jpg', categoryId: new ObjectId(id.toHexString()), modifiers: [{ options: [{ n: 2 }] }] };
    const changes = diffFields(before, after, ['price', 'imageUrl', 'categoryId', 'description.en', 'modifiers']);
    assert.deepEqual(changes.map(c => c.field), ['price', 'imageUrl', 'modifiers']);
    assert.deepEqual(changes[0], { field: 'price', before: 35, after: 39 });

    const reordered = diffFields(
      { _id: id, modifiers: [{ name: { en: 'Size', ar: 'الحجم' }, options: [] }], location: { lat: 1, lng: 2 } },
      { _id: id, modifiers: [{ options: [], name: { ar: 'الحجم', en: 'Size' } }], location: { lng: 2, lat: 1 } },
      ['modifiers', 'location']
    );
    assert.deepEqual(reordered, []);
  });

  test('identity expectation: platform ID first, source key otherwise', () => {
    const menu = (platformRestaurantId: string | undefined, sourceKey: string) => ({ restaurant: { platformRestaurantId, sourceKey } as any });
    assert.equal(matchesExpectedRestaurant(menu('1', 'a'), { platformRestaurantId: '1', sourceKey: 'b' }), true);
    assert.equal(matchesExpectedRestaurant(menu('2', 'a'), { platformRestaurantId: '1', sourceKey: 'a' }), false);
    assert.equal(matchesExpectedRestaurant(menu(undefined, 'a'), { sourceKey: 'a' }), true);
    assert.equal(matchesExpectedRestaurant(menu(undefined, 'a'), { sourceKey: 'b' }), false);
  });
});

// ─── Scheduler ───────────────────────────────────────────────────────────────

describe('dining cron scheduler', () => {
  const fakeSchedule = () => {
    const calls: Array<{ expression: string; options: { timezone: string } ; fn: () => Promise<void> }> = [];
    let stopped = false;
    return {
      calls,
      get stopped() { return stopped; },
      schedule: (expression: string, fn: () => Promise<void>, options: { timezone: string; name: string; noOverlap: boolean }) => {
        calls.push({ expression, options, fn });
        return { stop: () => { stopped = true; }, getNextRun: () => new Date('2026-10-14T07:30:00.000Z') };
      },
    };
  };

  test('not scheduled when ENABLE_DINING_CRON is not true', () => {
    const s = fakeSchedule();
    const scheduler = startDiningCronScheduler({ env: { ENABLE_DINING_CRON: 'false' }, runJob: async () => assert.fail('must not run'), logger: silent, schedule: s.schedule });
    assert.equal(scheduler, null);
    assert.equal(s.calls.length, 0);
  });

  test('invalid configuration disables the cron instead of crashing', () => {
    const s = fakeSchedule();
    const errors: string[] = [];
    const scheduler = startDiningCronScheduler({
      env: { ENABLE_DINING_CRON: 'true', DINING_CRON_SCHEDULE: 'nope' },
      runJob: async () => assert.fail('must not run'),
      logger: { ...silent, error: (m: string) => errors.push(m) },
      schedule: s.schedule,
    });
    assert.equal(scheduler, null);
    assert.equal(s.calls.length, 0);
    assert.match(errors[0], /DINING_CRON_SCHEDULE/);
  });

  test('daily 13:00 schedule; overlapping triggers are ignored; stop aborts the running job', async () => {
    const s = fakeSchedule();
    let release!: () => void;
    const seen: Array<{ trigger: string; signal?: AbortSignal }> = [];
    const scheduler = startDiningCronScheduler({
      env: { ENABLE_DINING_CRON: 'true' },
      logger: silent,
      schedule: s.schedule,
      runJob: async input => {
        seen.push({ trigger: input.trigger, signal: input.signal });
        await new Promise<void>(resolve => {
          release = resolve;
          input.signal?.addEventListener('abort', () => resolve());
        });
        return { jobId: 'j', status: input.signal?.aborted ? 'aborted' : 'succeeded', totals: emptyCronTotals(), durationMs: 0 };
      },
    })!;
    assert.ok(scheduler);
    assert.equal(s.calls[0].expression, '0 13 * * *');
    assert.equal(s.calls[0].options.timezone, 'Asia/Kolkata');

    const tick = s.calls[0].fn();
    assert.equal(scheduler.isRunning(), true);
    assert.equal(await scheduler.trigger('manual'), null);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].trigger, 'schedule');

    await scheduler.stop();
    await tick;
    assert.equal(s.stopped, true);
    assert.equal(seen[0].signal?.aborted, true);
    assert.equal(scheduler.isRunning(), false);
    void release;
  });
});

// ─── Jobs against a local MongoDB (fake Scrape.do; fixtures only) ────────────

describe('dining cron jobs (local MongoDB, fake Scrape.do)', { skip: LOCAL_DB_SKIP }, () => {
  let t: TestDb;
  let cron: DiningCronCollections;

  before(async () => {
    t = await openTestDb('cron');
    await ensureDiningCronIndexes(t.db);
    cron = getDiningCronCollections(t.db);
  });
  beforeEach(async () => {
    await t.reset();
    await Promise.all([cron.jobs.deleteMany({}), cron.changes.deleteMany({}), cron.itemMappings.deleteMany({})]);
  });
  after(async () => { await t?.close(); await closeTestClient(); });

  // The restaurant as it exists today: scraped once in English and once in Arabic.
  async function seed() {
    const context = { scrapeDo: fakeScrapeDo(pageByLocale).client, repositories: t.repos, logger: silent, uploadImage: fakeUpload };
    for (const locale of ['en', 'ar'] as const) {
      await runDiningScrape({ platform: 'deliveroo', locale, targetUrl: FIXTURE_URL[locale], dryRun: false }, context);
    }
    return (await t.collections.restaurants.findOne({}))!;
  }

  const deps = (scrapeDo: Pick<ScrapeDoClient, 'fetchHtml'>, extra: Partial<DiningRunnerExtras> = {}): DiningCronRunnerDeps => ({
    collections: cron,
    scrapeContext: { scrapeDo, repositories: t.repos, logger: silent, uploadImage: fakeUpload },
    logger: silent,
    sleep: async () => {},
    owner: { host: 'test', pid: 1 },
    ...extra,
  });
  type DiningRunnerExtras = Omit<DiningCronRunnerDeps, 'collections' | 'scrapeContext'>;

  const priceAndImageChange = (page: string) =>
    withMenuRoot(page, root => {
      const thali = root.items.find((i: any) => String(i.id) === THALI);
      thali.price = { ...thali.price, fractional: 3900, formatted: 'AED 39' };
      thali.image = { ...thali.image, url: 'https://rs-menus-api.roocdn.com/images/new-thali/image.jpeg?width={w}&height={h}' };
    });

  test('plan: every active stored restaurant × stored locale URL; nothing invented', async () => {
    const seeded = await seed();
    await t.collections.restaurants.insertMany([
      makeRestaurant({ platformRestaurantId: '111', sourceKey: 'deliveroo:id:111', url: { en: 'https://deliveroo.ae/en/menu/dubai/jumeirah/only-english' } }),
      makeRestaurant({ platformRestaurantId: '222', sourceKey: 'deliveroo:id:222', isActive: false }),
      makeRestaurant({ platform: 'careem' as any, platformRestaurantId: '333', sourceKey: 'careem:id:333' }),
    ]);
    const { plan, restaurants } = await loadDiningCronPlan(cron, { maxTargets: 200 });

    assert.equal(plan.targets, 3);
    // Deliveroo menus are plain requests now: 1 credit each (5 when the rendered fallback is needed)
    assert.equal(plan.estimatedCredits, 3);
    assert.deepEqual(plan.byPlatform, { deliveroo: { restaurants: 2, targets: 3, estimatedCredits: 3 } });
    const kamat = restaurants.find(r => r.restaurantId === seeded._id!.toHexString())!;
    // Same URLs as the previous scrape (with the delivery-location query), not the bare stored page URL.
    assert.deepEqual(kamat.targets.map(x => [x.locale, x.url, x.urlSource]), [['en', FIXTURE_URL.en, 'lastRun'], ['ar', FIXTURE_URL.ar, 'lastRun']]);
    assert.notEqual(seeded.url.en, FIXTURE_URL.en);
    const onlyEnglish = restaurants.find(r => r.restaurantId !== kamat.restaurantId)!;
    assert.deepEqual(onlyEnglish.targets.map(x => [x.locale, x.urlSource]), [['en', 'restaurant']]);
    assert.deepEqual(kamat.targets[0].expected, { platformRestaurantId: '76728', sourceKey: seeded.sourceKey });
    assert.deepEqual(plan.skipped.map(s => [s.platform, s.locale, s.reason]).sort(), [
      ['careem', undefined, 'UNSUPPORTED_PLATFORM'],
      ['deliveroo', 'ar', 'MISSING_LOCALE_URL'],
    ]);

    const capped = await loadDiningCronPlan(cron, { maxTargets: 1 });
    assert.equal(capped.plan.targets, 1);
    assert.ok(capped.plan.skipped.some(s => s.reason === 'MAX_TARGETS_EXCEEDED'));
  });

  test('refresh: price and image changes are written and logged field by field, in both locales', async () => {
    const seeded = await seed();
    const fake = fakeScrapeDo(url => priceAndImageChange(fixtureHtml(localeOf(url))), {
      finalUrl: `https://api.scrape.do/?token=${FAKE_SCRAPE_DO_TOKEN}`,
    });
    const summary = await runDiningCronJob(deps(fake.client), { trigger: 'manual', config: testConfig() });

    assert.equal(summary.status, 'succeeded');
    assert.deepEqual(fake.calls.map(c => c.url), [FIXTURE_URL.en, FIXTURE_URL.ar]);
    assert.equal(summary.totals.targetsSucceeded, 2);
    assert.equal(summary.totals.creditsUsed, 10);
    assert.equal(summary.totals.remainingCredits, 990);
    assert.ok(summary.totals.itemsUpdated >= 1);
    assert.equal(summary.totals.itemsCreated, 0);

    const thali = (await t.collections.menuItems.findOne({ platformItemId: THALI }))!;
    assert.equal(thali.price, 39);
    assert.match(thali.imageUrl!, /new-thali/);

    const thaliChange = (await cron.changes.findOne({ jobId: summary.jobId, entityId: thali._id }))!;
    assert.equal(thaliChange.action, 'updated');
    assert.equal(thaliChange.locale, 'en');
    assert.equal(thaliChange.restaurantId.toHexString(), seeded._id!.toHexString());
    assert.deepEqual(thaliChange.changes.find(c => c.field === 'price'), { field: 'price', before: 35, after: 39 });
    assert.ok(thaliChange.changes.some(c => c.field === 'imageUrl'));
    // The Arabic page carries the same price: no second change for it.
    assert.equal(await cron.changes.countDocuments({ jobId: summary.jobId, entityId: thali._id }), 1);

    const job = (await cron.jobs.findOne({ jobId: summary.jobId }))!;
    assert.equal(job.status, 'succeeded');
    assert.equal(job.trigger, 'manual');
    assert.deepEqual(job.progress, { completed: 2, total: 2 });
    assert.equal(job.targets.length, 2);
    assert.deepEqual(job.targets.map(x => [x.locale, x.status, x.attempts]), [['en', 'succeeded', 1], ['ar', 'succeeded', 1]]);
    assert.equal(job.totals.changesRecorded, job.targets[0].changes!.recorded + job.targets[1].changes!.recorded);
    assert.ok(job.finishedAt && job.durationMs! >= 0);
    assert.doesNotMatch(JSON.stringify(job), new RegExp(`${FAKE_SCRAPE_DO_TOKEN}|api\\.scrape\\.do`));

    const runs = await t.collections.scrapeRuns.find({ trigger: 'cron' }).toArray();
    assert.equal(runs.length, 2);
    assert.deepEqual(runs.map(r => r.runId).sort(), job.targets.flatMap(x => x.runIds).sort());

    // A second job with identical pages records nothing (no noise from per-locale rewrites).
    const again = await runDiningCronJob(deps(fake.client), { trigger: 'schedule', config: testConfig() });
    assert.equal(again.status, 'succeeded');
    assert.equal(await cron.changes.countDocuments({ jobId: again.jobId }), 0);
    assert.equal(again.totals.changesRecorded, 0);
  });

  test('removed dishes are deactivated (never deleted), returning ones reactivated, new ones flagged as unmapped', async () => {
    await seed();
    const withoutThali = (page: string) => withMenuRoot(page, root => { root.items = root.items.filter((i: any) => String(i.id) !== THALI); });
    const removed = await runDiningCronJob(deps(fakeScrapeDo(url => withoutThali(fixtureHtml(localeOf(url)))).client), {
      trigger: 'manual', config: testConfig(), filter: { locales: ['en'] },
    });
    assert.equal(removed.totals.itemsMarkedInactive, 1);
    const thali = (await t.collections.menuItems.findOne({ platformItemId: THALI }))!;
    assert.equal(thali.isActive, false);
    assert.equal((await cron.changes.findOne({ jobId: removed.jobId, entityId: thali._id }))!.action, 'deactivated');

    const withNewDish = (page: string) => withMenuRoot(page, root => {
      const source = root.items.find((i: any) => String(i.id) === THALI);
      root.items.push({ ...source, id: '9990001', name: 'Royal Thali' });
    });
    const back = await runDiningCronJob(deps(fakeScrapeDo(url => withNewDish(fixtureHtml(localeOf(url)))).client), {
      trigger: 'manual', config: testConfig(), filter: { locales: ['en'] },
    });
    assert.equal((await cron.changes.findOne({ jobId: back.jobId, entityId: thali._id }))!.action, 'reactivated');
    const created = (await cron.changes.findOne({ jobId: back.jobId, entity: 'item', action: 'created' }))!;
    assert.equal(created.name, 'Royal Thali');
    assert.equal(back.totals.itemsCreated, 1);
    assert.equal(back.totals.newItemsUnmapped, 1);
    assert.equal(await t.collections.menuItems.countDocuments(), 333);
  });

  test('dry run scrapes but writes no menu data and no change records', async () => {
    await seed();
    const fake = fakeScrapeDo(url => priceAndImageChange(fixtureHtml(localeOf(url))));
    const summary = await runDiningCronJob(deps(fake.client), { trigger: 'manual', config: testConfig(), dryRun: true });
    assert.equal(summary.status, 'succeeded');
    assert.equal(fake.calls.length, 2);
    assert.equal((await t.collections.menuItems.findOne({ platformItemId: THALI }))!.price, 35);
    assert.equal(await cron.changes.countDocuments(), 0);
    assert.equal((await cron.jobs.findOne({ jobId: summary.jobId }))!.options.dryRun, true);
  });

  test('a page that resolves to another restaurant is rejected and changes nothing', async () => {
    await seed();
    const fake = fakeScrapeDo(() => goldenMileFixtureHtml());
    const summary = await runDiningCronJob(deps(fake.client), { trigger: 'manual', config: testConfig({ maxConsecutiveFailures: 10 }) });
    assert.equal(summary.status, 'failed');
    const job = (await cron.jobs.findOne({ jobId: summary.jobId }))!;
    assert.deepEqual(job.targets.map(x => x.error?.code), ['RESTAURANT_IDENTITY_MISMATCH', 'RESTAURANT_IDENTITY_MISMATCH']);
    assert.equal(job.targets[0].attempts, 1);
    assert.equal(await t.collections.restaurants.countDocuments(), 1);
    assert.equal(await cron.changes.countDocuments(), 0);
  });

  test('transient Scrape.do failures are retried', async () => {
    await seed();
    let calls = 0;
    const ok = fakeScrapeDo(pageByLocale).client;
    const flaky: Pick<ScrapeDoClient, 'fetchHtml'> = {
      async fetchHtml(url, options) {
        // the plain request and its one rendered fallback both time out: the first attempt fails, the cron retries
        if (++calls <= 2) throw new ScrapeDoError({ category: 'timeout', message: 'Scrape.do request timed out' });
        return ok.fetchHtml(url, options);
      },
    };
    const sleeps: number[] = [];
    const summary = await runDiningCronJob(deps(flaky, { sleep: async ms => { sleeps.push(ms); } }), {
      trigger: 'manual', config: testConfig({ retryDelayMs: 1234 }),
    });
    assert.equal(summary.status, 'succeeded');
    const job = (await cron.jobs.findOne({ jobId: summary.jobId }))!;
    assert.equal(job.targets[0].attempts, 2);
    assert.equal(job.targets[0].runIds.length, 2);
    assert.ok(sleeps.includes(1234));
    assert.equal(await t.collections.scrapeRuns.countDocuments({ trigger: 'cron', status: 'failed' }), 1);
  });

  test('Scrape.do auth/quota failure stops the job instead of burning through every target', async () => {
    await seed();
    let calls = 0;
    const denied: Pick<ScrapeDoClient, 'fetchHtml'> = {
      async fetchHtml() {
        calls++;
        throw new ScrapeDoError({ category: 'quota', statusCode: 429, message: 'Scrape.do credits exhausted' });
      },
    };
    const summary = await runDiningCronJob(deps(denied), { trigger: 'manual', config: testConfig() });
    assert.equal(summary.status, 'failed');
    assert.equal(summary.abortReason, 'SCRAPE_DO_UNAVAILABLE');
    assert.equal(calls, 1);
    const job = (await cron.jobs.findOne({ jobId: summary.jobId }))!;
    assert.deepEqual(job.targets.map(x => [x.status, x.skipReason ?? x.error?.code]), [
      ['failed', 'SCRAPE_DO_QUOTA'],
      ['skipped', 'SCRAPE_DO_UNAVAILABLE'],
    ]);
  });

  test('low remaining credits stop the job after the current scrape', async () => {
    await seed();
    const fake = fakeScrapeDo(pageByLocale, { remainingCredits: 12 });
    const summary = await runDiningCronJob(deps(fake.client), { trigger: 'manual', config: testConfig({ minRemainingCredits: 50 }) });
    assert.equal(summary.status, 'partial');
    assert.equal(summary.abortReason, 'LOW_SCRAPE_DO_CREDITS');
    assert.equal(fake.calls.length, 1);
    assert.equal(summary.totals.targetsSkipped, 1);
  });

  test('consecutive failures stop the job', async () => {
    await seed();
    const fake = fakeScrapeDo(() => '<html><body>blocked</body></html>');
    const summary = await runDiningCronJob(deps(fake.client), { trigger: 'manual', config: testConfig({ maxConsecutiveFailures: 1 }) });
    assert.equal(summary.abortReason, 'TOO_MANY_CONSECUTIVE_FAILURES');
    assert.equal(summary.status, 'failed');
    // a page with no menu data: the plain request, then exactly one rendered fallback, then the target fails
    assert.equal(fake.calls.length, 2);
    assert.equal(fake.calls[0].options?.render, false);
    assert.equal(fake.calls[1].options?.render, true);
  });

  test('shutdown signal: finishes the current scrape, skips the rest, job ends "aborted"', async () => {
    await seed();
    const controller = new AbortController();
    const ok = fakeScrapeDo(pageByLocale).client;
    let calls = 0;
    const client: Pick<ScrapeDoClient, 'fetchHtml'> = {
      async fetchHtml(url, options) {
        calls++;
        controller.abort();
        return ok.fetchHtml(url, options);
      },
    };
    const summary = await runDiningCronJob(deps(client), { trigger: 'schedule', config: testConfig(), signal: controller.signal });
    assert.equal(summary.status, 'aborted');
    assert.equal(summary.abortReason, 'SHUTDOWN');
    assert.equal(calls, 1);
    assert.deepEqual(
      (await cron.jobs.findOne({ jobId: summary.jobId }))!.targets.map(x => x.status),
      ['succeeded', 'skipped']
    );
  });

  test('one job at a time: a live job blocks, a crashed (stale) job is taken over', async () => {
    await seed();
    const now = new Date();
    const running = {
      jobId: 'cron_other', lockKey: DINING_CRON_LOCK_KEY, trigger: 'schedule' as const, status: 'running' as const,
      options: { dryRun: false, concurrency: 1, delayMs: 0, retryAttempts: 0, maxTargets: 1, minRemainingCredits: 0, maxConsecutiveFailures: 1 },
      progress: { completed: 0, total: 0 }, totals: emptyCronTotals(), targets: [], errors: [], host: 'other', pid: 2,
      startedAt: now, heartbeatAt: now, createdAt: now, updatedAt: now,
    };
    await cron.jobs.insertOne({ ...running });
    const fake = fakeScrapeDo(pageByLocale);
    const blocked = await runDiningCronJob(deps(fake.client), { trigger: 'schedule', config: testConfig() });
    assert.equal(blocked.status, 'skipped');
    assert.equal(blocked.blockedByJobId, 'cron_other');
    assert.equal(fake.calls.length, 0);
    assert.equal((await cron.jobs.findOne({ jobId: blocked.jobId }))!.skipReason, 'ALREADY_RUNNING');

    const stale = new Date(now.getTime() - STALE_JOB_MS - 1000);
    await cron.jobs.updateOne({ jobId: 'cron_other' }, { $set: { heartbeatAt: stale } });
    const taken = await runDiningCronJob(deps(fake.client), { trigger: 'schedule', config: testConfig() });
    assert.equal(taken.status, 'succeeded');
    const old = (await cron.jobs.findOne({ jobId: 'cron_other' }))!;
    assert.equal(old.status, 'failed');
    assert.equal(old.errors[0].code, 'STALE_JOB');
    assert.equal(await cron.jobs.countDocuments({ status: 'running' }), 0);
  });

  test('Talabat: same URLs (with query) re-scraped at 1 credit each; an unchanged menu logs nothing', async () => {
    const html: Record<DiningLocale, string> = {
      en: readFileSync(join(__dirname, 'fixtures', 'talabat-en.html'), 'utf8'),
      ar: readFileSync(join(__dirname, 'fixtures', 'talabat-ar.html'), 'utf8'),
    };
    const urls: Record<DiningLocale, string> = {
      en: 'https://www.talabat.com/uae/restaurant/773429/kamat-vegetarian-the-palm-jumeirah?aid=1333',
      ar: 'https://www.talabat.com/ar/uae/restaurant/773429/kamat-vegetarian-the-palm-jumeirah?aid=1333',
    };
    const talabatPage = (url: string) => html[url.includes('/ar/') ? 'ar' : 'en'];
    const context = { scrapeDo: fakeScrapeDo(talabatPage).client, repositories: t.repos, logger: silent, uploadImage: fakeUpload };
    for (const locale of ['en', 'ar'] as const) {
      await runDiningScrape({ platform: 'talabat', locale, targetUrl: urls[locale], dryRun: false }, context);
    }

    const { plan } = await loadDiningCronPlan(cron, { maxTargets: 200 });
    assert.deepEqual(plan.byPlatform, { talabat: { restaurants: 1, targets: 2, estimatedCredits: 2 } });

    const fake = fakeScrapeDo(talabatPage, { requestCost: 1 });
    const summary = await runDiningCronJob(deps(fake.client), { trigger: 'schedule', config: testConfig() });
    assert.equal(summary.status, 'succeeded');
    assert.deepEqual(fake.calls.map(c => c.url), [urls.en, urls.ar]);
    assert.equal(summary.totals.creditsUsed, 2);
    assert.equal(await cron.changes.countDocuments({ jobId: summary.jobId }), 0);
  });

  test('restaurants added later are picked up by the next job', async () => {
    await seed();
    const first = await loadDiningCronPlan(cron, { maxTargets: 200 });
    assert.equal(first.plan.restaurants, 1);
    await t.collections.restaurants.insertOne(makeRestaurant({ platformRestaurantId: '444', sourceKey: 'deliveroo:id:444' }));
    const next = await loadDiningCronPlan(cron, { maxTargets: 200 });
    assert.equal(next.plan.restaurants, 2);
    assert.equal(next.plan.targets, 4);
  });
});
