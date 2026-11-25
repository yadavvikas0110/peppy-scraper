/// <reference types="node" />
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { dailyIncrements, dubaiDay, recordBulkRun } from '../../src/shopping/shopping-bulk.store';

const report: any = {
  startedAt: '2026-11-25T21:30:00.000Z', finishedAt: '2026-11-25T22:40:00.000Z', dryRun: false, status: 'partial',
  totals: { scraped: 9, failedPages: 1, bundles: 8, comparisons: 1, inserted: 5, updated: 2, matchedExisting: 2, imagesUploaded: 40, imagesFailed: 3 },
  scrapeDo: { pages: 20, credits: 150, byPlatform: { amazon: { pages: 6, credits: 6 }, carrefour: { pages: 14, credits: 144 } }, images: { images: 10, failed: 0, credits: 10 } },
  categories: [
    { key: 'air-fryers', status: 'complete', siteResults: [{ site: 'amazon', status: 'complete', links: 5, scraped: 5, failed: 0 }, { site: 'carrefour', status: 'complete', links: 5, scraped: 4, failed: 1 }] },
  ],
};

describe('daily statistics', () => {
  test('a run counts on the UAE calendar day it started (UTC+4)', () => {
    assert.equal(dubaiDay(new Date('2026-11-25T21:30:00.000Z')), '2026-11-26');
    assert.equal(dubaiDay(new Date('2026-11-25T19:59:00.000Z')), '2026-11-25');
  });

  test('per platform: links, scraped, failed, credits (Scrape.do images on Carrefour); day totals', () => {
    const inc = dailyIncrements(report);
    assert.equal(inc.day, '2026-11-26');
    assert.deepEqual(inc.byPlatform.amazon, { links: 5, scraped: 5, failed: 0, pending: 0, credits: 6, pages: 6, categories: 1 });
    assert.equal(inc.byPlatform.carrefour.credits, 154);
    assert.equal(inc.byPlatform.carrefour.failed, 1);
    assert.equal(inc.all.credits, 160);
    assert.equal(inc.all.inserted, 5);
    assert.equal(inc.all.runs, 1);
  });

  test('stored with upserts per (day, platform) and a run document; a DB failure never throws', async () => {
    const ops: any[] = [];
    const ok = await recordBulkRun({
      runs: { insertOne: async d => { ops.push(['run', d.day, d.categories[0].sites.length]); }, updateOne: async () => {} },
      daily: { insertOne: async () => {}, updateOne: async (f: any, u: any, o: any) => { ops.push(['daily', f.platform, u.$inc.scraped ?? u.$inc.runs, o.upsert]); } },
    }, report);
    assert.equal(ok, true);
    assert.deepEqual(ops, [['run', '2026-11-26', 2], ['daily', 'amazon', 5, true], ['daily', 'carrefour', 4, true], ['daily', '_all', 9, true]]);

    const quiet = { warn() {} };
    const failed = await recordBulkRun({ runs: { insertOne: async () => { throw new Error('db down'); }, updateOne: async () => {} }, daily: { insertOne: async () => {}, updateOne: async () => {} } }, report, quiet);
    assert.equal(failed, false);
  });
});
