import { test, describe } from 'node:test';
import assert from 'node:assert';
import { withGroceryObs } from '../../src/grocery/grocery-obs';
import { createInMemoryScrapeObsRecorder } from '../../src/observability/scrape-obs.recorder';

describe('withGroceryObs', () => {
  test('records a complete run with totals and site outcome', async () => {
    const recorder = createInMemoryScrapeObsRecorder();
    const result = await withGroceryObs(
      'talabat',
      async () => ({ itemsSeen: 120, productsPushed: 110, errors: [] as string[], stopped: false }),
      r => ({ itemsSeen: r.itemsSeen, productsPushed: r.productsPushed, warnings: [], errors: r.errors, stopped: r.stopped }),
      { recorder },
    );
    assert.ok(result);
    assert.equal(recorder.runs.length, 1);
    assert.equal(recorder.runs[0].status, 'complete');
    assert.equal(recorder.runs[0].totals.productsScraped, 120);
    assert.equal(recorder.runs[0].totals.bundles, 110);
    assert.equal(recorder.siteOutcomes.length, 1);
    assert.equal(recorder.siteOutcomes[0].outcome.site, 'talabat');
  });

  test('a run with errors finishes partial and records each error', async () => {
    const recorder = createInMemoryScrapeObsRecorder();
    await withGroceryObs(
      'deliveroo',
      async () => ({ errors: ['store 12 failed', 'page 3 timeout'] }),
      () => ({ itemsSeen: 10, productsPushed: 0, warnings: ['low stock data'], errors: ['store 12 failed', 'page 3 timeout'], stopped: false }),
      { recorder },
    );
    assert.equal(recorder.runs[0].status, 'partial');
    assert.equal(recorder.errors.filter(e => e.input.severity !== 'warning').length, 2);
    assert.equal(recorder.errors.filter(e => e.input.severity === 'warning').length, 1);
  });

  test('an admin-stopped run finishes with status stopped', async () => {
    const recorder = createInMemoryScrapeObsRecorder();
    await withGroceryObs(
      'noon-minutes',
      async () => ({ ok: true }),
      () => ({ itemsSeen: 5, productsPushed: 0, warnings: [], errors: [], stopped: true }),
      { recorder },
    );
    assert.equal(recorder.runs[0].status, 'stopped');
  });

  test('a job skipped by the lock closes the run instead of leaving it running', async () => {
    const recorder = createInMemoryScrapeObsRecorder();
    const result = await withGroceryObs('talabat', async () => null, () => { throw new Error('must not summarize'); }, { recorder });
    assert.equal(result, null);
    assert.equal(recorder.runs[0].status, 'stopped');
    assert.equal(recorder.errors[0].input.code, 'LOCKED');
  });

  test('a thrown job records a fatal error and finishes failed', async () => {
    const recorder = createInMemoryScrapeObsRecorder();
    await assert.rejects(
      withGroceryObs('deliveroo', async () => { throw new Error('boom'); }, () => { throw new Error('unreachable'); }, { recorder }),
      /boom/,
    );
    assert.equal(recorder.runs[0].status, 'failed');
    assert.equal(recorder.errors[0].input.stage, 'fatal');
  });
});
