/// <reference types="node" />
import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { BulkScrapeDeps, BundledBulkResult, jobStatusOf, scrapeBulk } from '../../src/services/playwright.service';
import { bundleProducts } from '../../src/services/bundler.service';
import { buildJobId, getCheckpointPath, isResumeStateFresh, loadCheckpoint, saveCheckpoint } from '../../src/services/checkpoint.service';
import { partitionSites, siteSupport, UnsupportedSitesError } from '../../src/config/transport-policy';
import { CronDeps, runFullPipeline } from '../../src/cron/cron-runner';
import { QueryPlan } from '../../scrape-master';
import { ProductData } from '../../src/parsers/types';

delete process.env.OPENAI_API_KEY;

let tmp: string;
const T0 = new Date('2026-10-29T08:00:00.000Z');

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'scrape-job-'));
  process.env.SCRAPER_CHECKPOINT_DIR = path.join(tmp, 'checkpoints');
});
afterEach(() => {
  delete process.env.SCRAPER_CHECKPOINT_DIR;
  fs.rmSync(tmp, { recursive: true, force: true });
});

function pdp(url: string, name: string, price: number): ProductData {
  return {
    productName: name, productUrl: url, imageUrl: 'https://img.test/1.jpg', imageUrls: ['https://img.test/1.jpg'], price,
    currency: 'AED', ratings: null, reviewCount: null, description: null, inStock: true, category: null,
  };
}

const AMAZON_LISTING = ['B0AAAAAAA1', 'B0AAAAAAA2', 'B0AAAAAAA3'].map(a => `<a href="/dp/${a}">x</a>`).join('');

function fakeDeps(overrides: Partial<BulkScrapeDeps> = {}): BulkScrapeDeps & { fetched: string[] } {
  const fetched: string[] = [];
  let clock = T0.getTime();
  return {
    fetched,
    scrapeProduct: async url => { fetched.push(url); return pdp(url, `Phone ${url.slice(-2)} 128GB`, 1000 + fetched.length); },
    fetchSearchHtml: async url => {
      if (url.includes('amazon.ae')) return AMAZON_LISTING;
      return '';
    },
    collectShopify: async () => [],
    bundle: bundleProducts,
    shouldStop: () => false,
    ensureTagger: async () => {},
    now: () => new Date((clock += 1000)),
    outputDir: path.join(tmp, 'output'),
    env: {},
    ...overrides,
  };
}

const job = (sites: any[], extra: object = {}) => ({ sites, category: 'test phone', count: 3, broadCategory: 'Electronics', subCategory: 'Smartphones', ...extra });

describe('transport policy', () => {
  test('Noon has no authorized source unless Bright Data approval is configured', () => {
    assert.equal(siteSupport('noon', {}).supported, false);
    assert.equal(siteSupport('noon', { BRIGHT_DATA_APPROVED_SITES: 'noon' }).supported, true);
    assert.deepEqual(partitionSites(['amazon', 'noon'], {}).supported, ['amazon']);
  });
});

describe('scrapeBulk job status', () => {
  test('an Amazon + Noon job is refused up front instead of silently returning Amazon only', async () => {
    const deps = fakeDeps();
    await assert.rejects(scrapeBulk(job(['amazon', 'noon']), deps), (e: unknown) => e instanceof UnsupportedSitesError && /noon/.test((e as Error).message));
    assert.equal(deps.fetched.length, 0, 'nothing may be scraped (or paid for) before the refusal');
  });

  test('with allowUnsupported the job is partial and Noon is reported unsupported', async () => {
    const result = await scrapeBulk(job(['amazon', 'noon'], { allowUnsupported: true }), fakeDeps());
    assert.equal(result.status, 'partial');
    assert.deepEqual(result.siteResults.map(r => [r.site, r.status]), [['amazon', 'complete'], ['noon', 'unsupported']]);
    assert.ok(result.bundles.length > 0);
    // Unsupported sites cannot be fixed by rerunning — the checkpoint is cleared
    assert.equal(fs.existsSync(getCheckpointPath(result.jobId)), false);
  });

  test('a host the provider refuses mid-run is unsupported, and the job is not complete', async () => {
    // sharafdg links come from search pages (no custom collector), so the fake transport covers it
    const result = await scrapeBulk(job(['amazon', 'sharafdg']), fakeDeps({
      fetchSearchHtml: async url => {
        if (url.includes('amazon')) return AMAZON_LISTING;
        throw new Error('Host blocked by Bright Data (uae.sharafdg.com): robots.txt/KYC restriction');
      },
    }));
    const sharaf = result.siteResults.find(r => r.site === 'sharafdg')!;
    assert.equal(sharaf.status, 'unsupported');
    assert.match(sharaf.reason!, /Host blocked/);
    assert.equal(result.status, 'partial');
  });

  test('every page failing makes the site failed, the job failed, and keeps the checkpoint for retry', async () => {
    const result = await scrapeBulk(job(['amazon']), fakeDeps({ scrapeProduct: async () => { throw new Error('timeout'); } }));
    assert.equal(result.status, 'failed');
    assert.equal(result.siteResults[0].status, 'failed');
    assert.equal(fs.existsSync(getCheckpointPath(result.jobId)), true);
  });

  test('stamps each product with its own scrape time', async () => {
    const result = await scrapeBulk(job(['amazon']), fakeDeps());
    const observed = result.bundles.flatMap(b => b.retailers.map(r => r.observedAt));
    assert.equal(observed.length, 3);
    assert.ok(observed.every(t => t && Date.parse(t) > T0.getTime()));
  });
});

describe('cancellation and resume', () => {
  test('a stopped job publishes nothing, keeps its checkpoint, and resumes without refetching', async () => {
    let calls = 0;
    const stopping = fakeDeps({ shouldStop: () => calls >= 1 });
    const inner = stopping.scrapeProduct;
    stopping.scrapeProduct = async url => { calls++; return inner(url); };

    const stopped = await scrapeBulk(job(['amazon']), stopping);
    assert.equal(stopped.status, 'stopped');
    assert.equal(stopped.bundles.length, 0);
    assert.equal(stopped.outputFile, null);
    const cp = loadCheckpoint(stopped.jobId, { now: new Date(T0.getTime() + 60_000) })!;
    assert.equal(cp.scraped.length, 1);
    const firstObserved = cp.scraped[0].data.scrapedAt;

    const resumedDeps = fakeDeps({ now: () => new Date(T0.getTime() + 120_000) });
    const resumed = await scrapeBulk(job(['amazon']), resumedDeps);
    assert.equal(resumed.status, 'complete');
    assert.equal(resumed.resumed, true);
    assert.equal(resumedDeps.fetched.length, 2, 'only the remaining products are fetched');
    // The product scraped before the stop keeps its original observation time
    assert.ok(resumed.bundles.some(b => b.retailers.some(r => r.observedAt === firstObserved)));
    assert.equal(fs.existsSync(getCheckpointPath(resumed.jobId)), false);
  });

  test('an expired checkpoint is discarded, so its prices are never reused', async () => {
    const jobId = buildJobId(['amazon'], 'test phone', 3);
    saveCheckpoint({
      jobId, sites: ['amazon'], category: 'test phone', broadCategory: 'Electronics', subCategory: 'Smartphones', countPerSite: 3,
      startedAt: '2026-10-27T08:00:00.000Z', updatedAt: '2026-10-27T09:00:00.000Z',
      links: { amazon: ['https://www.amazon.ae/dp/B0OLD00001'] },
      scraped: [{ site: 'amazon', url: 'https://www.amazon.ae/dp/B0OLD00001', data: pdp('https://www.amazon.ae/dp/B0OLD00001', 'Old Phone 128GB', 1) }],
      failed: [],
    });
    const deps = fakeDeps();
    const result = await scrapeBulk(job(['amazon']), deps);
    assert.equal(result.resumed, false);
    assert.equal(deps.fetched.length, 3);
    assert.ok(!result.bundles.some(b => b.name === 'Old Phone 128GB'));
  });

  test('resume window rejects old, future-dated and invalid timestamps', () => {
    const now = new Date('2026-10-29T08:00:00.000Z');
    const day = 20 * 3600 * 1000;
    assert.equal(isResumeStateFresh('2026-10-29T07:00:00.000Z', day, now), true);
    assert.equal(isResumeStateFresh('2026-10-28T07:00:00.000Z', day, now), false);
    assert.equal(isResumeStateFresh('2026-10-30T07:00:00.000Z', day, now), false);
    assert.equal(isResumeStateFresh('garbage', day, now), false);
    assert.equal(isResumeStateFresh(undefined, day, now), false);
  });

  test('job status: complete only when every site completed', () => {
    const o = (status: any) => ({ site: 'amazon' as const, status, scraped: 0, failed: 0 });
    assert.equal(jobStatusOf([o('complete'), o('complete')]), 'complete');
    assert.equal(jobStatusOf([o('complete'), o('unsupported')]), 'partial');
    assert.equal(jobStatusOf([o('complete'), o('stopped')]), 'stopped');
    assert.equal(jobStatusOf([o('failed'), o('unsupported')]), 'failed');
  });
});

describe('cron run', () => {
  const queries: QueryPlan[] = [
    { label: 'Q1', category: 'q1', broadCategory: 'Electronics', subCategory: 'Smartphones', sites: ['amazon', 'noon'], count: 1 },
    { label: 'Q2', category: 'q2', broadCategory: 'Electronics', subCategory: 'Smartphones', sites: ['amazon'], count: 1 },
  ];

  function result(status: BundledBulkResult['status'], extra: Partial<BundledBulkResult> = {}): BundledBulkResult {
    return {
      jobId: 'j', status, sites: ['amazon'], category: 'q', broadCategory: 'E', subCategory: 'S', requestedCountPerSite: 1,
      totalScraped: 1, bundleCount: 1, outputFile: null, bundles: [{ name: 'P' } as any], matchReviews: [], errors: [], resumed: false,
      siteResults: [{ site: 'amazon', status: status === 'stopped' ? 'stopped' : 'complete', scraped: 1, failed: 0 }],
      ...extra,
    };
  }

  function cronDeps(scrape: (q: any) => BundledBulkResult): CronDeps & { pushed: number; reports: any[]; staleRuns: number } {
    const d: any = {
      queries,
      pushed: 0, reports: [], staleRuns: 0,
      scrapeBulk: async (o: any) => scrape(o),
      pushToDatabase: async () => { d.pushed++; return { mongoInserted: 1, mongoUpdated: 0, matchedExisting: 0, skipped: 0, chromaVectors: 0, mapping: { ok: true, message: 'mapped' }, errors: [] }; },
      markStaleOffers: async () => { d.staleRuns++; return 0; },
      reportStatus: async (...args: any[]) => { d.reports.push(args); },
      shouldStop: () => false,
      clearStopSignal: () => {},
      acquireLock: () => true,
      releaseLock: () => {},
      closeBrowser: async () => {},
      stateFile: path.join(tmp, 'cron_state.json'),
      cooldownMs: 0,
    };
    return d;
  }

  test('a run where Noon is unsupported is partial and is not reported as a success', async () => {
    const deps = cronDeps(o => o.category === 'q1'
      ? result('partial', { siteResults: [{ site: 'amazon', status: 'complete', scraped: 1, failed: 0 }, { site: 'noon', status: 'unsupported', scraped: 0, failed: 0, reason: 'no authorized source' }] })
      : result('complete'));
    const summary = (await runFullPipeline(deps))!;
    assert.equal(summary.status, 'partial');
    assert.deepEqual(summary.siteIssues, ['noon: unsupported — no authorized source']);
    assert.equal(deps.pushed, 1);
    assert.equal(deps.reports[0][0], false, 'success flag');
    assert.match(deps.reports[0][4], /noon: unsupported/);
  });

  test('a stopped run publishes nothing, skips stale expiry, and keeps resume state', async () => {
    const deps = cronDeps(o => (o.category === 'q1' ? result('complete') : result('stopped')));
    const summary = (await runFullPipeline(deps))!;
    assert.equal(summary.status, 'stopped');
    assert.equal(deps.pushed, 0);
    assert.equal(deps.staleRuns, 0);
    assert.equal(deps.reports[0][0], false);
    const state = JSON.parse(fs.readFileSync(deps.stateFile, 'utf8'));
    assert.equal(state.completedQueries.length, 1, 'only the finished query counts as completed');

    // The next run resumes only the interrupted query
    const seen: string[] = [];
    const resumeDeps = cronDeps(o => { seen.push(o.category); return result('complete'); });
    resumeDeps.stateFile = deps.stateFile;
    const resumed = (await runFullPipeline(resumeDeps))!;
    assert.deepEqual(seen, ['q2']);
    assert.equal(resumed.status, 'complete');
    assert.equal(resumeDeps.reports[0][0], true);
    assert.equal(fs.existsSync(deps.stateFile), false);
  });

  test('a query where no site produced data is not marked completed', async () => {
    const deps = cronDeps(o => (o.category === 'q1' ? result('failed', { bundles: [], siteResults: [{ site: 'amazon', status: 'failed', scraped: 0, failed: 1, reason: 'timeout' }] }) : result('complete')));
    const summary = (await runFullPipeline(deps))!;
    assert.equal(summary.status, 'partial');
    assert.deepEqual(summary.failedQueries, ['Q1']);
    assert.equal(deps.reports[0][0], false);
  });

  test('an expired resume state is discarded', async () => {
    const stateFile = path.join(tmp, 'cron_state.json');
    fs.writeFileSync(stateFile, JSON.stringify({ startedAt: '2026-01-01T00:00:00.000Z', completedQueries: ['q1|amazon,noon|', 'q2|amazon|'], allBundles: [{ name: 'Old' }], totalRawScraped: 1, totalErrors: 0 }));
    const seen: string[] = [];
    const deps = cronDeps(o => { seen.push(o.category); return result('complete'); });
    deps.stateFile = stateFile;
    await runFullPipeline(deps);
    assert.deepEqual(seen.sort(), ['q1', 'q2']);
  });
});
