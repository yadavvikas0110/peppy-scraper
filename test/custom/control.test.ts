/// <reference types="node" />
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ImageRehoster, PRODUCT_IMAGE_FOLDER, replaceStoredImageUrls } from '../../src/custom/core/images-s3';
import { buildCliArgs, effectiveCustomEnv, lastCustomReport } from '../../src/custom/custom.control';
import { parseCustomConfig } from '../../src/custom/custom.config';
import { requestCustomMapping, runCustomScrape } from '../../src/custom/custom.runner';
import { jumboAdapter } from '../../src/custom/adapters/jumbo.adapter';
import type { CustomFetcher, PlatformAdapter } from '../../src/custom/core/types';

const CDN = 'https://cdn.peppy.test';
const isOwn = (u: string) => u.startsWith(`${CDN}/`);

describe('S3 image re-hosting', () => {
  test('uploads each URL once, keeps own URLs, drops failed images (like dining)', async () => {
    const calls: Array<[string, string]> = [];
    const r = new ImageRehoster(async (u, folder) => {
      calls.push([u, folder]);
      if (u.includes('blocked')) throw Object.assign(new Error('403'), { response: { status: 403 } });
      if (u.includes('gone')) throw Object.assign(new Error('404'), { response: { status: 404 } });
      if (u.includes('html')) throw new Error('Not an image (content-type "text/html"): x');
      return `${CDN}/${folder}/${path.basename(u)}`;
    }, isOwn, 2, { warn: () => {} });
    const out = await r.rehostAll(['https://x.com/a.jpg', 'https://x.com/a.jpg', `${CDN}/products/images/old.jpg`, 'https://x.com/blocked.jpg', 'https://x.com/gone.jpg', 'https://x.com/html.jpg']);
    assert.deepEqual(out, [`${CDN}/products/images/a.jpg`, `${CDN}/products/images/old.jpg`]);
    assert.equal(out.some(u => u.startsWith('https://x.com/')), false, 'no retailer URL is ever returned');
    assert.equal(calls[0][1], PRODUCT_IMAGE_FOLDER);
    assert.deepEqual(r.stats, { uploaded: 1, reused: 1, failed: 3, alreadyOwn: 1 });
    assert.deepEqual([...r.mapping], [['https://x.com/a.jpg', `${CDN}/products/images/a.jpg`]]);
    // Only failures that a retry cannot fix are permanent; a 403 block is temporary
    assert.deepEqual([...r.permanentFailures].sort(), ['https://x.com/gone.jpg', 'https://x.com/html.jpg']);
  });

  test('stored documents: dead URLs removed, temporary ones kept, a gallery is never emptied', async () => {
    const docs = [
      { _id: 1, updatedAt: 'u1', images: ['https://x.com/a.jpg', 'https://x.com/dead.jpg', 'https://x.com/slow.jpg'], retailers: [{ retailerId: 'namshi', imageUrl: 'https://x.com/dead.jpg' }] },
      { _id: 2, updatedAt: 'u2', images: ['https://x.com/dead.jpg'], retailers: [] },
    ];
    const updates: any[] = [];
    const col: any = {
      find: () => ({ toArray: async () => docs }),
      updateOne: async (_f: any, update: any) => { updates.push(update.$set); return { matchedCount: 1, modifiedCount: 1 }; },
    };
    const res = await replaceStoredImageUrls(col, new Map([['https://x.com/a.jpg', `${CDN}/a.jpg`]]), new Date(), new Set(['https://x.com/dead.jpg']));
    assert.deepEqual(res, { documents: 1, images: 1, conflicts: 0, dropped: 2, keptLastImage: 1 });
    assert.deepEqual(updates[0].images, [`${CDN}/a.jpg`, 'https://x.com/slow.jpg']);
    assert.equal(updates[0].retailers[0].imageUrl, `${CDN}/a.jpg`);
    assert.equal(updates.length, 1, 'doc 2 keeps its only image');
  });

  test('a run skips a product whose every image failed to upload', async () => {
    const page = (img: string) => `<script type="application/ld+json">{"@type":"Product","name":"Phone ${img}","sku":"${img}","image":["https://cdn.jumbo.test/${img}.jpg"],"offers":{"price":"999","priceCurrency":"AED","availability":"https://schema.org/InStock"}}</script>`;
    const fetcher: CustomFetcher = { get: async url => ({ url, status: 200, body: page(url.includes('p2') ? 'bad' : 'ok') }), render: async () => '' };
    const adapter: PlatformAdapter = { ...jumboAdapter, discover: async () => ({ urls: ['https://www.jumbo.ae/p1.html', 'https://www.jumbo.ae/p2.html'] }) };
    const config = parseCustomConfig({ settings: { userAgent: 'x' }, sites: { jumbo: [{ key: 'phones', label: 'Phones', broadCategory: 'Electronics', subCategory: 'Smartphones', source: '/m.html', limit: 2 }] } });
    const rehoster = new ImageRehoster(async u => { if (u.includes('bad')) throw new Error('timeout'); return `${CDN}/products/images/${path.basename(u)}`; }, isOwn, 2, { warn: () => {} });
    let pushedNames: string[] = [];
    const result = await runCustomScrape(config, {
      sites: ['jumbo'], ai: false, outputDir: fs.mkdtempSync(path.join(os.tmpdir(), 'custom-s3-')), shouldStop: () => false,
      push: { uri: 'mongodb://localhost/dev', dbName: 'dev' }, s3: rehoster,
    }, {
      adapters: { jumbo: adapter } as any, fetcher,
      push: async b => { pushedNames = b.map((x: any) => x.name); return { mongoInserted: 1, mongoUpdated: 0, matchedExisting: 0, skipped: 0, chromaVectors: 0, mapping: { ok: true, message: '' }, errors: [] }; },
      replaceStoredImages: async () => ({ documents: 0, images: 0, conflicts: 0, dropped: 0, keptLastImage: 0 }),
    });
    assert.equal(pushedNames.length, 1);
    assert.match(pushedNames[0], /ok/);
    assert.equal(result.sites[0].valid, 1);
    assert.equal(result.sites[0].rejected, 1);
  });

  test('stored documents: only mapped URLs change, order kept, offers updated, concurrent edits skipped', async () => {
    const docs = [
      { _id: 1, updatedAt: 'u1', images: ['https://x.com/a.jpg', 'https://x.com/keep.jpg'], retailers: [{ retailerId: 'jumbo', imageUrl: 'https://x.com/a.jpg' }] },
      { _id: 2, updatedAt: 'u2', images: ['https://x.com/a.jpg'], retailers: [] },
    ];
    const updates: any[] = [];
    const col: any = {
      find: () => ({ toArray: async () => docs }),
      updateOne: async (filter: any, update: any) => {
        if (filter._id === 2) return { matchedCount: 0, modifiedCount: 0 }; // edited meanwhile
        updates.push(update.$set);
        return { matchedCount: 1, modifiedCount: 1 };
      },
    };
    const res = await replaceStoredImageUrls(col, new Map([['https://x.com/a.jpg', `${CDN}/a.jpg`]]), new Date('2026-11-12T00:00:00Z'));
    assert.deepEqual(res, { documents: 1, images: 2, conflicts: 1, dropped: 0, keptLastImage: 0 });
    assert.deepEqual(updates[0].images, [`${CDN}/a.jpg`, 'https://x.com/keep.jpg']);
    assert.equal(updates[0].retailers[0].imageUrl, `${CDN}/a.jpg`);
  });

  test('a run with S3 pushes CDN URLs and swaps stored ones', async () => {
    const page = `<script type="application/ld+json">{"@type":"Product","name":"Phone One 128GB","sku":"P1","image":["https://cdn.jumbo.test/p1.jpg"],"offers":{"price":"999","priceCurrency":"AED","availability":"https://schema.org/InStock"}}</script>`;
    const fetcher: CustomFetcher = { get: async url => ({ url, status: 200, body: page }), render: async () => '' };
    const adapter: PlatformAdapter = { ...jumboAdapter, discover: async () => ({ urls: ['https://www.jumbo.ae/p1.html'] }) };
    const config = parseCustomConfig({ settings: { userAgent: 'x' }, sites: { jumbo: [{ key: 'phones', label: 'Phones', broadCategory: 'Electronics', subCategory: 'Smartphones', source: '/m.html', limit: 1 }] } });
    const rehoster = new ImageRehoster(async u => `${CDN}/products/images/${path.basename(u)}`, isOwn);
    let pushed: any[] = [];
    let swappedWith: Map<string, string> | null = null;
    const result = await runCustomScrape(config, {
      sites: ['jumbo'], ai: false, outputDir: fs.mkdtempSync(path.join(os.tmpdir(), 'custom-s3-')), shouldStop: () => false,
      push: { uri: 'mongodb://localhost/dev', dbName: 'dev' }, s3: rehoster,
    }, {
      adapters: { jumbo: adapter } as any, fetcher,
      push: async b => { pushed = b; return { mongoInserted: 1, mongoUpdated: 0, matchedExisting: 0, skipped: 0, chromaVectors: 0, mapping: { ok: true, message: '' }, errors: [] }; },
      replaceStoredImages: async m => { swappedWith = m; return { documents: 3, images: 4, conflicts: 0, dropped: 0, keptLastImage: 0 }; },
    });
    assert.deepEqual(pushed[0].images, [`${CDN}/products/images/p1.jpg`]);
    assert.equal(pushed[0].retailers[0].imageUrl, `${CDN}/products/images/p1.jpg`);
    assert.equal(swappedWith!.get('https://cdn.jumbo.test/p1.jpg'), `${CDN}/products/images/p1.jpg`);
    assert.deepEqual(result.s3, { uploaded: 1, reused: 0, failed: 0, alreadyOwn: 0, storedDocumentsUpdated: 3, storedImagesReplaced: 4, storedImagesDropped: 0 });
  });
});

describe('effective environment for runs', () => {
  test('.env.custom fills gaps; the service environment wins; nothing is loaded into process.env', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'custom-env-')), '.env.custom');
    fs.writeFileSync(file, 'CUSTOM_MONGODB_URI=mongodb://u:p@h/dev\nCUSTOM_SCRAPER_ENABLED=true\nS3_BUCKET=from-file\n');
    const env = effectiveCustomEnv(file, { S3_BUCKET: 'from-service' });
    assert.equal(env.CUSTOM_MONGODB_URI, 'mongodb://u:p@h/dev');
    assert.equal(env.S3_BUCKET, 'from-service');
    assert.equal(process.env.CUSTOM_MONGODB_URI, undefined);
  });
});

describe('backend mapping request', () => {
  test('skipped unless CUSTOM_BACKEND_URL is set; never uses the shared PEPPY_BE_URL', async () => {
    const r = await requestCustomMapping({ PEPPY_BE_URL: 'https://prod.example', SCRAPER_API_KEY: 'k' });
    assert.equal(r.ok, true);
    assert.match(r.message, /not requested/);
  });
});

describe('admin control', () => {
  test('trigger requests are validated against the shipped config', () => {
    assert.deepEqual(buildCliArgs({}), { args: ['--push'] });
    assert.deepEqual(buildCliArgs({ sites: ['namshi'], categories: ['men-shoes'], limit: 5, push: false }), { args: ['--site', 'namshi', '--category', 'men-shoes', '--limit', '5'] });
    assert.match((buildCliArgs({ sites: ['amazon'] }) as any).error, /Unknown site/);
    assert.match((buildCliArgs({ sites: ['namshi'], categories: ['perfumes'] }) as any).error, /Unknown category/); // perfumes is a letstango key
    assert.match((buildCliArgs({ limit: 0 }) as any).error, /limit/);
    assert.match((buildCliArgs({ limit: 51 }) as any).error, /limit/);
  });

  test('status summarises the newest report without the product list', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'custom-rep-'));
    fs.writeFileSync(path.join(dir, 'custom_2026-11-11.json'), JSON.stringify({ startedAt: 'old', sites: [] }));
    fs.writeFileSync(path.join(dir, 'custom_2026-11-12.json'), JSON.stringify({
      startedAt: '2026-11-12T12:00:00Z', finishedAt: '2026-11-12T12:05:00Z',
      sites: [{ site: 'namshi', status: 'complete', valid: 18, rejected: 0 }, { site: 'jumbo', status: 'blocked', valid: 0, rejected: 0, reason: 'anti-bot' }],
      requests: { http: 10, browserRenders: 2 }, push: { target: 'h/dev.products_clean', mongoInserted: 3, mongoUpdated: 15, skipped: 0, errors: [] },
      products: [{ huge: true }],
    }));
    const r: any = lastCustomReport(dir);
    assert.equal(r.startedAt, '2026-11-12T12:00:00Z');
    assert.equal(r.productsScraped, 18);
    assert.equal(r.status, 'partial');
    assert.deepEqual(r.push, { target: 'h/dev.products_clean', inserted: 3, updated: 15, skipped: 0, errors: [] });
    assert.equal('products' in r, false);
  });
});
