import { getScrapeObsRecorder, ScrapeObsRecorder } from '../observability/scrape-obs.recorder';
import type { ScrapeObsTrigger } from '../observability/scrape-obs.collections';

/*
 * Observability wrapper for the three grocery jobs (Talabat Mart, Deliveroo Hop, noon Minutes).
 * Each job becomes one `scrape_obs_runs` document with subsystem 'grocery' and a single site
 * (the platform), so the admin "Scrape Monitoring" section can show grocery runs alongside
 * e-commerce / shopping / dining. Best-effort like the recorder itself: a failure here never
 * blocks or fails the grocery job.
 */

export type GroceryPlatform = 'talabat' | 'deliveroo' | 'noon-minutes';

export interface GroceryObsSummary {
  /** Items seen on the platform during the crawl. */
  itemsSeen: number;
  /** Products written to grocery_products (0 on dry runs). */
  productsPushed: number;
  /** Non-fatal problems; recorded as warnings. */
  warnings: string[];
  /** Hard per-run errors; recorded as errors. */
  errors: string[];
  /** True when an admin stop signal ended the run early. */
  stopped: boolean;
}

export interface GroceryObsOptions {
  trigger?: ScrapeObsTrigger;
  recorder?: ScrapeObsRecorder; // injectable for tests
}

/**
 * Runs `job` and records it as a grocery observability run. A `null` job result means the job
 * never started (another run holds the platform lock) — recorded as a skipped/failed start so
 * phantom "running" rows never appear.
 */
export async function withGroceryObs<T>(
  platform: GroceryPlatform,
  job: () => Promise<T | null>,
  summarize: (result: T) => GroceryObsSummary,
  options: GroceryObsOptions = {},
): Promise<T | null> {
  const recorder = options.recorder ?? getScrapeObsRecorder(process.env, 'grocery');
  const trigger = options.trigger ?? 'manual';

  let runId: string | null = null;
  try {
    runId = await recorder.startRun({ trigger, resumed: false, queriesPlanned: 1 });
    await recorder.updateProgress(runId, {}, [platform]);
  } catch {
    runId = null;
  }

  let result: T | null = null;
  try {
    result = await job();
  } catch (err: any) {
    await recorder.recordError(runId, {
      site: platform,
      stage: 'fatal',
      message: err?.message ?? err,
      severity: 'error',
    });
    await recorder.finishRun(runId, 'failed', { queriesFailed: 1, errorCount: 1 }, [platform]);
    throw err;
  }

  if (result === null) {
    // The job declined to run (lock already held). Close the obs run instead of leaving it 'running'.
    await recorder.recordError(runId, {
      site: platform,
      stage: 'site',
      code: 'LOCKED',
      message: 'Run skipped: another run of this platform is already in progress',
      severity: 'warning',
    });
    await recorder.finishRun(runId, 'stopped', { errorCount: 0 }, [platform]);
    return result;
  }

  const summary = summarize(result);
  for (const message of summary.errors) {
    await recorder.recordError(runId, { site: platform, stage: 'site', message, severity: 'error' });
  }
  for (const message of summary.warnings) {
    await recorder.recordError(runId, { site: platform, stage: 'site', message, severity: 'warning' });
  }

  const status = summary.stopped
    ? 'stopped'
    : summary.errors.length > 0
      ? 'partial'
      : 'complete';

  await recorder.recordSiteOutcome(runId, {
    site: platform,
    status: status === 'complete' ? 'complete' : status,
    scraped: summary.itemsSeen,
    failed: summary.errors.length,
  });
  await recorder.finishRun(
    runId,
    status,
    {
      queriesCompleted: status === 'complete' ? 1 : 0,
      queriesFailed: 0,
      productsScraped: summary.itemsSeen,
      bundles: summary.productsPushed,
      errorCount: summary.errors.length,
    },
    [platform],
  );

  return result;
}
