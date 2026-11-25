/// <reference types="node" />
/**
 * Shopping bulk pipeline: parallel platform lanes, stop/pause/resume on Scrape.do account and
 * circuit-breaker errors, parallel category jobs with serialised writes, S3 image re-hosting before
 * the write, dry runs, and failure isolation between categories. All offline (fakes for every effect).
 */
import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { BulkScrapeDeps, BundledBulkResult, scrapeBulk, jobStatusOf } from '../../src/services/playwright.service';
import { bundleProducts } from '../../src/services/bundler.service';
import { loadCheckpoint, buildJobId } from '../../src/services/checkpoint.service';
import { ProductData, BundledProduct } from '../../src/parsers/types';
import { ScrapeDoAccountError, ScrapeDoCircuitOpenError } from '../../src/shared/scrapedo/scrapedo.fetcher';
import { ImageRehoster } from '../../src/custom/core/images-s3';
import { rehostBundleImages } from '../../src/services/shopping-images';
import { CatalogCategory, createSerialQueue, mapPool, overallStatus, runShoppingBulk, selectCategories, BulkRunDeps } from '../../src/shopping/shopping-bulk';
import { parseArgs } from '../../src/shopping/shopping-bulk.cli';
import type { PushResult } from '../../src/cron/push-pipeline';

delete process.env.OPENAI_API_KEY;

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shopping-bulk-'));
  process.env.SCRAPER_CHECKPOINT_DIR = path.join(tmp, 'checkpoints');
});
afterEach(() => {
  delete process.env.SCRAPER_CHECKPOINT_DIR;
  fs.rmSync(tmp, { recursive: true, force: true });
});

const quiet = { log() {}, warn() {}, error() {} };
const tick = () => new Promise(r => setImmediate(r));

function pdp(url: string, name: string, price: number): ProductData {
  return {
    productName: name, productUrl: url, imageUrl: `https://img.shop/${encodeURIComponent(url)}.jpg`, imageUrls: [`https://img.shop/${encodeURIComponent(url)}.jpg`],
    price, currency: 'AED', ratings: null, reviewCount: null, description: null, inStock: true, category: null,
  };
}

const ASINS = Array.from({ length: 8 }, (_, i) => `B0AAAAAA${String(i).padStart(2, '0')}`);
const AMAZON_LISTING = ASINS.map(a => `<a href="/dp/${a}">x</a>`).join('');

function laneDeps(overrides: Partial<BulkScrapeDeps> = {}): BulkScrapeDeps {
  let clock = Date.parse('2026-11-25T08:00:00.000Z');
  return {
    scrapeProduct: async url => pdp(url, `Phone ${url.slice(-2)} 128GB`, 1000),
    fetchSearchHtml: async url => (url.includes('amazon.ae') && /page=1$/.test(url) ? AMAZON_LISTING : '<html><title>empty</title></html>'),
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

const job = { sites: ['amazon'] as any[], category: 'test phone', count: 8, broadCategory: 'Electronics', subCategory: 'Smartphones' };

describe('platform lane: parallel product pages', () => {
  test('productConcurrency pages are in flight at once and every link is scraped once', async () => {
    let inFlight = 0;
    let peak = 0;
    const seen: string[] = [];
    const r = await scrapeBulk(job, laneDeps({
      productConcurrency: 3,
      scrapeProduct: async url => {
        inFlight++; peak = Math.max(peak, inFlight); seen.push(url);
        await tick(); await tick();
        inFlight--;
        return pdp(url, `Phone ${url.slice(-2)} 128GB`, 1000);
      },
    }));
    assert.equal(peak, 3);
    assert.equal(new Set(seen).size, 8);
    assert.equal(seen.length, 8);
    assert.equal(r.status, 'complete');
    assert.equal(r.totalScraped, 8);
  });

  test('the listing fetch is told the page number (page 2+ may be empty)', async () => {
    const pages: Array<number | undefined> = [];
    await scrapeBulk({ ...job, count: 20 }, laneDeps({ fetchSearchHtml: async (url, ctx) => { pages.push(ctx?.page); return /page=1$/.test(url) ? AMAZON_LISTING : '<html><title>x</title></html>'; } }));
    assert.deepEqual(pages, [1, 2]);
  });
});

describe('platform lane: Scrape.do account and circuit-breaker errors', () => {
  test('credits used up: the site stops, unscraped links are NOT marked failed, and a resume finishes them', async () => {
    let calls = 0;
    let clock = Date.parse('2026-11-25T08:00:00.000Z');
    const now = () => new Date((clock += 1000)); // one clock for both runs: a resume happens later, never earlier
    const out = await scrapeBulk(job, laneDeps({
      now,
      scrapeProduct: async url => {
        if (++calls > 3) throw new ScrapeDoAccountError('Scrape.do account problem: quota 401');
        return pdp(url, `Phone ${url.slice(-2)} 128GB`, 1000);
      },
    }));
    assert.equal(out.status, 'stopped');
    assert.equal(out.siteResults[0].status, 'stopped');
    assert.equal(out.siteResults[0].pending, 5);
    assert.equal(out.errors.length, 0, 'nothing may land in checkpoint.failed — a resume would skip it forever');
    assert.equal(out.bundles.length, 0, 'an interrupted job publishes nothing');

    const cp = loadCheckpoint(buildJobId(['amazon'], 'test phone', 8));
    assert.equal(cp?.scraped.length, 3);

    const resumed: string[] = [];
    const again = await scrapeBulk(job, laneDeps({ now, scrapeProduct: async url => { resumed.push(url); return pdp(url, `Phone ${url.slice(-2)} 128GB`, 1000); } }));
    assert.equal(again.resumed, true);
    assert.equal(resumed.length, 5, 'only the remaining links are fetched');
    assert.equal(again.status, 'complete');
    assert.equal(again.totalScraped, 8);
  });

  test('circuit open on one platform: it pauses (links pending), the other platform completes, data is published', async () => {
    let amazonCalls = 0;
    const deps = laneDeps({
      fetchSearchHtml: async url => {
        if (url.includes('amazon.ae')) return AMAZON_LISTING;
        if (url.includes('noon.com')) return ['N1AAAAAA01', 'N1AAAAAA02'].map(s => `<a href="https://www.noon.com/uae-en/x/${s}/p/">x</a>`).join('');
        return '';
      },
      scrapeProduct: async url => {
        if (url.includes('amazon.ae') && ++amazonCalls > 2) throw new ScrapeDoCircuitOpenError('Amazon paused after 5 failed pages in a row (resumes in 300 s)');
        return pdp(url, url.includes('noon') ? `Noon Gadget ${url.slice(-6, -3)}` : `Phone ${url.slice(-2)} 128GB`, 1000);
      },
      env: { SCRAPE_DO_TOKEN: 't', SCRAPE_DO_SITES: 'noon' },
    });
    const r = await scrapeBulk({ ...job, sites: ['amazon', 'noon'] }, deps);
    const amazon = r.siteResults.find(s => s.site === 'amazon')!;
    assert.equal(amazon.status, 'complete');
    assert.equal(amazon.pending, 6);
    assert.match(amazon.reason ?? '', /^paused:/);
    assert.equal(r.siteResults.find(s => s.site === 'noon')!.status, 'complete');
    assert.equal(r.status, 'partial', 'pending links mean the job is not complete');
    assert.equal(r.errors.length, 0);
    assert.ok(r.bundles.length >= 4, 'scraped products are still published');
    assert.ok(loadCheckpoint(r.jobId), 'checkpoint kept so the next run scrapes only what is left');
  });

  test('jobStatusOf: pending makes a complete site partial', () => {
    assert.equal(jobStatusOf([{ site: 'amazon', status: 'complete', scraped: 2, failed: 0, pending: 3 }]), 'partial');
    assert.equal(jobStatusOf([{ site: 'amazon', status: 'complete', scraped: 2, failed: 0 }]), 'complete');
  });
});

// ── Orchestrator ──────────────────────────────────────────────────────────────

const CDN = 'https://cdn.peppy.test';
const cat = (key: string, platforms: any[] = ['amazon', 'carrefour'], extra: Partial<CatalogCategory> = {}): CatalogCategory =>
  ({ key, label: key, category: key, broadCategory: 'Electronics', subCategory: 'Smartphones', count: 2, platforms, ...extra });

function fakeBundle(name: string, retailerIds: string[]): BundledProduct {
  return {
    name, description: null, category: 'c', broadCategory: 'Electronics', subCategory: 'Smartphones', tags: [],
    images: [`https://img.shop/${name}.jpg`, `https://img.shop/broken.jpg`], lowestPrice: 10, highestPrice: 12, rating: null, reviewCount: null,
    retailerCount: retailerIds.length,
    retailers: retailerIds.map(r => ({ retailerId: r, retailerName: r, price: 10, currency: 'AED', inStock: true, productUrl: `https://${r}.test/${name}`, imageUrl: `https://img.shop/${r}-${name}.jpg`, ratings: null, reviewCount: null })),
  };
}

function fakeResult(key: string, status: BundledBulkResult['status'], bundles: BundledProduct[], sites: any[] = ['amazon', 'carrefour']): BundledBulkResult {
  return {
    jobId: key, status, siteResults: sites.map(s => ({ site: s, status: status === 'stopped' ? 'stopped' : 'complete', scraped: 1, failed: 0 })), sites, category: key,
    broadCategory: 'Electronics', subCategory: 'Smartphones', requestedCountPerSite: 2, totalScraped: bundles.length, bundleCount: bundles.length,
    outputFile: `/tmp/${key}.json`, bundles, matchReviews: [], errors: [], resumed: false,
  };
}

function pushResult(n: number, errors: string[] = []): PushResult {
  return { mongoInserted: n, mongoUpdated: 0, matchedExisting: 0, skipped: 0, chromaVectors: 0, mapping: { ok: true, message: 'ok' }, errors };
}

function orchestratorDeps(over: Partial<BulkRunDeps> & { results?: Record<string, () => Promise<BundledBulkResult>> } = {}) {
  const pushes: BundledProduct[][] = [];
  const uploads: string[] = [];
  const rehoster = new ImageRehoster(async (src) => {
    uploads.push(src);
    await tick();
    if (src.includes('broken')) throw Object.assign(new Error('404'), { response: { status: 404 } });
    return `${CDN}/${Buffer.from(src).toString('hex').slice(-16)}.jpg`;
  }, u => u.startsWith(CDN), 4, quiet);
  const deps: BulkRunDeps = {
    scrapeBulk: (async (opts: any) => (over.results?.[opts.category] ?? (async () => fakeResult(opts.category, 'complete', [fakeBundle(`${opts.category}-p1`, ['amazon', 'carrefour'])])))()) as any,
    bulkDeps: laneDeps(),
    rehoster,
    push: async b => { pushes.push(structuredClone(b)); return pushResult(b.length); },
    shouldStop: () => false,
    now: () => new Date('2026-11-25T09:00:00.000Z'),
    env: { SCRAPE_DO_TOKEN: 't', SCRAPE_DO_SITES: 'all' },
    log: quiet,
    ...over,
  };
  return { deps, pushes, uploads, rehoster };
}

describe('bulk orchestrator', () => {
  test('categories run in parallel, writes never overlap, images are on S3 before the write', async () => {
    let scraping = 0, peakScrape = 0, writing = 0, peakWrite = 0;
    const { deps, pushes } = orchestratorDeps();
    deps.scrapeBulk = (async (opts: any) => {
      scraping++; peakScrape = Math.max(peakScrape, scraping);
      await tick(); await tick();
      scraping--;
      return fakeResult(opts.category, 'complete', [fakeBundle(`${opts.category}-p1`, ['amazon', 'carrefour'])]);
    }) as any;
    const inner = deps.push!;
    deps.push = async b => { writing++; peakWrite = Math.max(peakWrite, writing); await tick(); await tick(); writing--; return inner(b); };

    const report = await runShoppingBulk({ categories: [cat('a'), cat('b'), cat('c')], categoryConcurrency: 3 }, deps);
    assert.equal(peakScrape, 3, 'category jobs overlap');
    assert.equal(peakWrite, 1, 'database writes are serialised');
    assert.equal(report.status, 'complete');
    assert.equal(pushes.length, 3);
    for (const b of pushes.flat()) {
      assert.ok(b.images.length === 1 && b.images.every(u => u.startsWith(CDN)), 'gallery is ours; the broken image was dropped');
      assert.ok(b.retailers.every(r => r.imageUrl!.startsWith(CDN)));
    }
    assert.equal(report.totals.comparisons, 3);
    assert.ok(report.reportFile && fs.existsSync(report.reportFile));
  });

  test('dry run: no upload, no write', async () => {
    const { deps, pushes, uploads } = orchestratorDeps({ rehoster: null, push: null });
    const report = await runShoppingBulk({ categories: [cat('a')], dryRun: true }, deps);
    assert.equal(pushes.length + uploads.length, 0);
    assert.equal(report.status, 'complete');
    assert.equal(report.categories[0].bundles, 1);
  });

  test('a write run refuses to start without S3 and a push function', async () => {
    const { deps } = orchestratorDeps({ rehoster: null });
    await assert.rejects(runShoppingBulk({ categories: [cat('a')] }, deps), /S3 rehoster/);
  });

  test('a stopped category writes nothing; a failing category does not stop the others', async () => {
    const { deps, pushes } = orchestratorDeps({
      results: {
        stopped: async () => fakeResult('stopped', 'stopped', []),
        boom: async () => { throw new Error('listing parser crashed'); },
      },
    });
    const report = await runShoppingBulk({ categories: [cat('ok'), cat('stopped'), cat('boom')], categoryConcurrency: 2 }, deps);
    const by = Object.fromEntries(report.categories.map(c => [c.key, c]));
    assert.equal(by.ok.status, 'complete');
    assert.equal(by.stopped.status, 'stopped');
    assert.equal(by.boom.status, 'error');
    assert.match(by.boom.error!, /listing parser crashed/);
    assert.equal(pushes.length, 1);
    assert.equal(report.status, 'stopped');
  });

  test('a write failure is reported on that category; a partial scrape stays partial', async () => {
    const { deps } = orchestratorDeps({ results: { part: async () => fakeResult('part', 'partial', [fakeBundle('x', ['amazon'])]) } });
    let n = 0;
    deps.push = async b => { if (++n === 1) throw new Error('Mongo timeout'); return pushResult(b.length); };
    const report = await runShoppingBulk({ categories: [cat('first'), cat('part')], categoryConcurrency: 1 }, deps);
    assert.equal(report.categories[0].status, 'error');
    assert.match(report.categories[0].error!, /Mongo timeout/);
    assert.equal(report.categories[1].status, 'partial');
    assert.equal(report.status, 'partial');
  });

  test('a category whose platforms all lack a data source is skipped without scraping', async () => {
    let called = 0;
    const { deps } = orchestratorDeps({ env: {} });
    deps.scrapeBulk = (async () => { called++; return fakeResult('x', 'complete', []); }) as any;
    const report = await runShoppingBulk({ categories: [cat('lux', ['ounass'])] }, deps);
    assert.equal(called, 0);
    assert.equal(report.categories[0].status, 'skipped');
    assert.match(report.categories[0].error!, /Scrape\.do only/);
  });

  test('a stop before a category starts skips its scrape', async () => {
    let called = 0;
    const { deps } = orchestratorDeps({ shouldStop: () => true });
    deps.scrapeBulk = (async () => { called++; return fakeResult('x', 'complete', []); }) as any;
    const report = await runShoppingBulk({ categories: [cat('a'), cat('b')] }, deps);
    assert.equal(called, 0);
    assert.equal(report.status, 'stopped');
  });

  test('count override and per-lane concurrency reach scrapeBulk', async () => {
    const seen: any[] = [];
    const { deps } = orchestratorDeps();
    deps.scrapeBulk = (async (opts: any, d: any) => { seen.push({ count: opts.count, pc: d.productConcurrency, allow: opts.allowUnsupported }); return fakeResult('a', 'complete', []); }) as any;
    await runShoppingBulk({ categories: [cat('a')], countPerPlatform: 5, productConcurrency: 4 }, deps);
    assert.deepEqual(seen, [{ count: 5, pc: 4, allow: true }]);
  });
});

describe('image re-hosting for bundles', () => {
  test('each source URL is uploaded once; an empty gallery is filled from an uploaded offer image', async () => {
    const uploads: string[] = [];
    const rh = new ImageRehoster(async src => { uploads.push(src); if (src.includes('gallery')) throw new Error('timeout'); return `${CDN}/${uploads.length}.jpg`; }, u => u.startsWith(CDN), 2, quiet);
    const a = fakeBundle('a', ['amazon']);
    a.images = ['https://img.shop/gallery.jpg'];
    a.retailers[0].imageUrl = 'https://img.shop/offer.jpg';
    const b = fakeBundle('b', ['noon']);
    b.images = ['https://img.shop/offer.jpg', `${CDN}/already.jpg`];
    b.retailers[0].imageUrl = null;
    const stats = await rehostBundleImages([a, b], rh);
    assert.deepEqual(a.images, [a.retailers[0].imageUrl]);
    assert.ok(a.images[0].startsWith(CDN));
    assert.equal(uploads.filter(u => u === 'https://img.shop/offer.jpg').length, 1, 'same image uploaded once');
    assert.ok(b.images.every(u => u.startsWith(CDN)));
    assert.equal(stats.bundlesWithoutImages, 0);
    assert.equal(stats.alreadyOwn, 1);
  });

  test('a product whose every image fails has no images (so it is not inserted)', async () => {
    const rh = new ImageRehoster(async () => { throw new Error('403'); }, u => u.startsWith(CDN), 2, quiet);
    const a = fakeBundle('a', ['amazon']);
    const stats = await rehostBundleImages([a], rh);
    assert.deepEqual(a.images, []);
    assert.equal(a.retailers[0].imageUrl, null);
    assert.equal(stats.bundlesWithoutImages, 1);
  });
});

describe('helpers', () => {
  test('mapPool keeps order and limits concurrency', async () => {
    let live = 0, peak = 0;
    const out = await mapPool([1, 2, 3, 4, 5], 2, async n => { live++; peak = Math.max(peak, live); await tick(); live--; return n * 10; });
    assert.deepEqual(out, [10, 20, 30, 40, 50]);
    assert.equal(peak, 2);
  });

  test('serial queue keeps going after a failure', async () => {
    const q = createSerialQueue();
    const order: number[] = [];
    const a = q(async () => { await tick(); order.push(1); throw new Error('x'); });
    const b = q(async () => { order.push(2); return 2; });
    await assert.rejects(a);
    assert.equal(await b, 2);
    assert.deepEqual(order, [1, 2]);
  });

  test('overall status', () => {
    const r = (status: any, inserted = 0): any => ({ status, push: { mongoInserted: inserted, mongoUpdated: 0 } });
    assert.equal(overallStatus([r('complete', 1), r('skipped')], false), 'complete');
    assert.equal(overallStatus([r('complete', 1), r('failed')], false), 'partial');
    assert.equal(overallStatus([r('failed'), r('error')], false), 'failed');
    assert.equal(overallStatus([r('partial', 0)], false), 'failed', 'nothing written is a failure');
    assert.equal(overallStatus([r('partial')], true), 'partial');
  });

  test('selectCategories filters by key and platform; unknown keys are an error', () => {
    const catalog = [cat('a', ['amazon', 'noon']), cat('b', ['ounass'], { enabled: false }), cat('c', ['homecentre'])];
    assert.deepEqual(selectCategories(catalog).map(c => c.key), ['a', 'c']);
    assert.deepEqual(selectCategories(catalog, { keys: ['b'] }).map(c => c.key), ['b'], 'explicit keys run disabled categories');
    assert.deepEqual(selectCategories(catalog, { platforms: ['noon'] }).map(c => [c.key, c.platforms]), [['a', ['noon']]]);
    assert.throws(() => selectCategories(catalog, { keys: ['zzz'] }), /Unknown category/);
  });

  test('CLI arguments are validated', () => {
    const a = parseArgs(['--categories', 'air-fryers,tvs', '--platforms', 'amazon,homecentre', '--count', '5', '--product-concurrency', '4', '--dry-run']);
    assert.deepEqual(a.categories, ['air-fryers', 'tvs']);
    assert.deepEqual(a.platforms, ['amazon', 'homecentre']);
    assert.equal(a.count, 5);
    assert.equal(a.productConcurrency, 4);
    assert.equal(a.dryRun, true);
    assert.throws(() => parseArgs(['--platforms', 'ebay']), /Unknown platform/);
    assert.throws(() => parseArgs(['--count', '0']), /--count/);
    assert.throws(() => parseArgs(['--bogus']), /Unknown option/);
  });
});
