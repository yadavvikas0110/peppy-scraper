import { ObjectId } from 'mongodb';
import { redactMongoUri } from '../../shared/db/mongo';
import {
  DiningScrapeContext,
  DiningScrapeError,
  DiningScrapeResult,
  isDiningScrapeError,
  runDiningScrape,
} from '../dining.service';
import type { DiningPlatformRegistry } from '../platforms/platform.registry';
import { sanitizeRunMessage } from '../repositories/scrape-run.repository';
import type { DiningCronCollections } from './dining-cron.collections';
import type { DiningCronConfig } from './dining-cron.config';
import { countUnmappedItems, diffSnapshots, RestaurantSnapshot, snapshotRestaurant, summarizeChanges } from './dining-cron.changes';
import {
  addTargetToTotals,
  createDiningCronJobRepository,
  DiningCronLockedError,
  emptyCronTotals,
} from './dining-cron.repository';
import { DiningCronPlanFilter, DiningCronRestaurantPlan, loadDiningCronPlan } from './dining-cron.targets';
import type {
  DiningCronAbortReason,
  DiningCronJobOptions,
  DiningCronJobStatus,
  DiningCronJobTrigger,
  DiningCronPlan,
  DiningCronTarget,
  DiningCronTargetResult,
  DiningCronTotals,
} from './dining-cron.types';

/*
 * One daily refresh: lock → plan (stored restaurants × locales) → scrape each target through the
 * normal ingestion pipeline (runDiningScrape, trigger "cron") → record field-level changes →
 * finish the job log. One restaurant's locales run in order; restaurants run in parallel.
 *
 * Failure handling:
 *   transient (timeouts, network, 5xx, blocked, DB hiccup) → retried after retryDelayMs
 *   page-level (parse/map/validation/identity mismatch)    → that target fails, the job continues
 *   Scrape.do auth/quota/config                            → stop: every further request would fail
 *   N consecutive failures or low remaining credits        → stop before wasting more credits
 *   shutdown signal                                        → finish the current scrape, skip the rest
 */

const RETRYABLE_CODES = new Set([
  'SCRAPE_DO_TIMEOUT', 'SCRAPE_DO_NETWORK', 'SCRAPE_DO_TARGET_5XX', 'SCRAPE_DO_BLOCKED', 'SCRAPE_DO_RESPONSE',
  'FETCH_FAILED', 'DATABASE_UNAVAILABLE', 'RUN_CREATE_FAILED', 'PERSISTENCE_FAILED',
]);
const JOB_FATAL_CODES = new Set(['SCRAPE_DO_AUTH', 'SCRAPE_DO_QUOTA', 'SCRAPE_DO_CONFIG']);

export interface DiningCronRunnerDeps {
  collections: DiningCronCollections | (() => Promise<DiningCronCollections>);
  // Scrape.do client + repositories for runDiningScrape (trigger/expectations are set per target).
  scrapeContext: DiningScrapeContext;
  scrape?: (input: unknown, context: DiningScrapeContext) => Promise<DiningScrapeResult>;
  registry?: DiningPlatformRegistry;
  now?: () => Date;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  logger?: Pick<Console, 'log' | 'warn' | 'error'>;
  heartbeatMs?: number;
  owner?: { host: string; pid: number };
}

export interface DiningCronRunInput {
  trigger: DiningCronJobTrigger;
  config: DiningCronConfig;
  dryRun?: boolean;
  filter?: DiningCronPlanFilter;
  signal?: AbortSignal;
}

export interface DiningCronRunSummary {
  jobId: string;
  status: DiningCronJobStatus;
  abortReason?: DiningCronAbortReason;
  blockedByJobId?: string;
  plan?: DiningCronPlan;
  totals: DiningCronTotals;
  durationMs: number;
}

export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0 || signal?.aborted) return Promise.resolve();
  return new Promise(resolve => {
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });
}

function targetError(err: unknown): { stage: string; code: string; message: string; runId?: string } {
  if (isDiningScrapeError(err)) {
    const e = err as DiningScrapeError;
    return { stage: e.stage, code: e.code, message: e.message, runId: e.runId };
  }
  return { stage: 'internal', code: 'UNEXPECTED_ERROR', message: sanitizeRunMessage(redactMongoUri(String((err as Error)?.message ?? err))) };
}

export function decideJobStatus(totals: DiningCronTotals, abortReason: DiningCronAbortReason | undefined): Exclude<DiningCronJobStatus, 'running' | 'skipped'> {
  if (abortReason === 'SHUTDOWN') return 'aborted';
  const worked = totals.targetsSucceeded + totals.targetsPartial;
  if (abortReason) return worked > 0 ? 'partial' : 'failed';
  if (totals.targetsFailed > 0 && worked === 0) return 'failed';
  if (totals.targetsFailed > 0 || totals.targetsPartial > 0 || totals.targetsSkipped > 0) return 'partial';
  return 'succeeded';
}

export async function runDiningCronJob(deps: DiningCronRunnerDeps, input: DiningCronRunInput): Promise<DiningCronRunSummary> {
  const now = deps.now ?? (() => new Date());
  const sleep = deps.sleep ?? abortableSleep;
  const logger = deps.logger ?? console;
  const scrape = deps.scrape ?? runDiningScrape;
  const { config, signal } = input;
  const dryRun = input.dryRun === true;

  const collections = typeof deps.collections === 'function' ? await deps.collections() : deps.collections;
  const jobs = createDiningCronJobRepository(collections.jobs, deps.owner);
  const options: DiningCronJobOptions = {
    dryRun,
    platforms: input.filter?.platforms,
    restaurantIds: input.filter?.restaurantIds,
    locales: input.filter?.locales,
    concurrency: config.concurrency,
    delayMs: config.delayMs,
    retryAttempts: config.retryAttempts,
    maxTargets: config.maxTargets,
    minRemainingCredits: config.minRemainingCredits,
    maxConsecutiveFailures: config.maxConsecutiveFailures,
  };
  for (const key of ['platforms', 'restaurantIds', 'locales'] as const) if (!options[key]?.length) delete options[key];

  // 1. Lock
  let job;
  try {
    job = await jobs.start({ trigger: input.trigger, options }, now());
  } catch (err) {
    if (!(err instanceof DiningCronLockedError)) throw err;
    const skipped = await jobs.recordSkipped({ trigger: input.trigger, options }, err.runningJobId, now());
    logger.warn(`[dining-cron] Skipped (${input.trigger}): job ${err.runningJobId ?? 'unknown'} is still running`);
    return { jobId: skipped.jobId, status: 'skipped', blockedByJobId: err.runningJobId, totals: skipped.totals, durationMs: 0 };
  }
  const jobId = job.jobId;
  const startedAt = job.startedAt;
  logger.log(`[dining-cron] Job ${jobId} started (${input.trigger}${dryRun ? ', dry run' : ''})`);

  const heartbeat = setInterval(() => {
    jobs.heartbeat(jobId, now()).catch(err => logger.warn(`[dining-cron] Heartbeat failed: ${sanitizeRunMessage(redactMongoUri(String(err?.message)))}`));
  }, deps.heartbeatMs ?? 60_000);
  heartbeat.unref?.();

  let totals = emptyCronTotals();
  let abortReason: DiningCronAbortReason | undefined;
  const jobErrors: Array<{ code: string; message: string }> = [];
  let plan: DiningCronPlan | undefined;

  try {
    // 2. Plan
    const planned = await loadDiningCronPlan(collections, { filter: input.filter, maxTargets: config.maxTargets, registry: deps.registry });
    const jobPlan = planned.plan;
    plan = jobPlan;
    totals.targetsPlanned = jobPlan.targets;
    await jobs.savePlan(jobId, jobPlan, now());
    const byPlatform = Object.entries(jobPlan.byPlatform).map(([p, entry]) => `${p}=${entry?.targets ?? 0}`).join(' ');
    logger.log(
      `[dining-cron] Job ${jobId}: ${jobPlan.restaurants} restaurants, ${jobPlan.targets} scrapes (${byPlatform || 'none'}), ` +
      `~${jobPlan.estimatedCredits} Scrape.do credits, ${jobPlan.skipped.length} skipped`
    );
    for (const s of jobPlan.skipped) logger.warn(`[dining-cron] Not scraped: ${s.platform} ${s.restaurantName ?? s.restaurantId} ${s.locale ?? ''} (${s.reason})`);

    // 3. Scrape
    let consecutiveFailures = 0;
    let completed = 0;
    let writes = Promise.resolve();
    const stopReason = (): DiningCronAbortReason | undefined => (signal?.aborted ? 'SHUTDOWN' : abortReason);

    const record = (result: DiningCronTargetResult) => {
      totals = addTargetToTotals(totals, result);
      completed++;
      const snapshot = totals;
      const done = completed;
      writes = writes
        .then(() => jobs.recordTarget(jobId, result, snapshot, done, now()))
        .catch(err => logger.error(`[dining-cron] Could not record target: ${sanitizeRunMessage(redactMongoUri(String(err?.message)))}`));
      return writes;
    };

    const processTarget = async (target: DiningCronTarget): Promise<DiningCronTargetResult> => {
      const restaurantObjectId = new ObjectId(target.restaurantId);
      const result: DiningCronTargetResult = {
        restaurantId: target.restaurantId,
        restaurantName: target.restaurantName,
        platform: target.platform,
        locale: target.locale,
        url: target.url,
        status: 'failed',
        runIds: [],
        attempts: 0,
        startedAt: now(),
      };

      let before: RestaurantSnapshot | null = null;
      if (!dryRun) {
        before = await snapshotRestaurant(collections, restaurantObjectId).catch(err => {
          jobErrors.push({ code: 'CHANGE_SNAPSHOT_FAILED', message: `${target.restaurantId}: ${redactMongoUri(String(err?.message))}` });
          return null;
        });
      }

      for (let attempt = 1; attempt <= config.retryAttempts + 1; attempt++) {
        result.attempts = attempt;
        try {
          const scraped = await scrape(
            { platform: target.platform, locale: target.locale, targetUrl: target.url, dryRun },
            { ...deps.scrapeContext, trigger: 'cron', expectedRestaurant: target.expected, logger }
          );
          result.runIds.push(scraped.runId);
          result.status = scraped.status === 'partial' ? 'partial' : 'succeeded';
          result.counts = scraped.counts;
          result.inactive = { applied: scraped.inactive.applied, reasons: scraped.inactive.reasons };
          result.fetch = { statusCode: scraped.fetch.statusCode, requestCost: scraped.fetch.requestCost, remainingCredits: scraped.fetch.remainingCredits };
          if (scraped.errors.length) {
            const first = scraped.errors[0];
            result.error = { stage: first.stage, code: first.code, message: `${scraped.errors.length} record(s) rejected; first: ${first.message}` };
          } else {
            delete result.error;
          }

          if (before) {
            try {
              const after = await snapshotRestaurant(collections, restaurantObjectId);
              const changes = diffSnapshots(before, after, {
                jobId, runId: scraped.runId, restaurantId: restaurantObjectId, platform: target.platform, locale: target.locale, now: now(),
              });
              const stored = changes.slice(0, config.maxChangesPerTarget);
              if (stored.length) await collections.changes.insertMany(stored, { ordered: false });
              result.changes = summarizeChanges(changes, stored.length);
              const createdItems = changes.filter(c => c.entity === 'item' && c.action === 'created').map(c => c.entityId);
              result.newItemsUnmapped = await countUnmappedItems(collections, createdItems);
            } catch (err) {
              jobErrors.push({ code: 'CHANGE_LOG_FAILED', message: `${target.restaurantId} ${target.locale}: ${redactMongoUri(String((err as Error)?.message))}` });
            }
          }
          break;
        } catch (err) {
          const e = targetError(err);
          if (e.runId) result.runIds.push(e.runId);
          result.error = { stage: e.stage, code: e.code, message: e.message };
          if (e.code === 'RUN_IN_PROGRESS') {
            result.status = 'skipped';
            result.skipReason = 'RUN_IN_PROGRESS';
            break;
          }
          result.status = 'failed';
          if (JOB_FATAL_CODES.has(e.code)) {
            abortReason = abortReason ?? 'SCRAPE_DO_UNAVAILABLE';
            jobErrors.push({ code: e.code, message: e.message });
            break;
          }
          if (!RETRYABLE_CODES.has(e.code) || attempt > config.retryAttempts || signal?.aborted) break;
          logger.warn(`[dining-cron] ${target.platform} ${target.locale} ${target.restaurantName ?? target.restaurantId}: ${e.code}, retrying in ${config.retryDelayMs}ms`);
          await sleep(config.retryDelayMs, signal);
        }
      }

      result.finishedAt = now();
      result.durationMs = Math.max(0, result.finishedAt.getTime() - (result.startedAt as Date).getTime());
      return result;
    };

    const queue: DiningCronRestaurantPlan[] = [...planned.restaurants];
    const remainingTargets = () => queue.reduce((n, r) => n + r.targets.length, 0);

    const worker = async () => {
      while (queue.length) {
        const restaurant = queue.shift() as DiningCronRestaurantPlan;
        for (let i = 0; i < restaurant.targets.length; i++) {
          const target = restaurant.targets[i];
          const stop = stopReason();
          if (stop) {
            await record({
              restaurantId: target.restaurantId, restaurantName: target.restaurantName, platform: target.platform,
              locale: target.locale, url: target.url, status: 'skipped', skipReason: stop, runIds: [], attempts: 0,
            });
            continue;
          }

          const result = await processTarget(target);
          if (result.status === 'failed') consecutiveFailures++;
          else if (result.status !== 'skipped') consecutiveFailures = 0;
          if (consecutiveFailures >= config.maxConsecutiveFailures) abortReason = abortReason ?? 'TOO_MANY_CONSECUTIVE_FAILURES';
          const remaining = result.fetch?.remainingCredits;
          if (typeof remaining === 'number' && remaining < config.minRemainingCredits) abortReason = abortReason ?? 'LOW_SCRAPE_DO_CREDITS';

          const c = result.counts;
          logger.log(
            `[dining-cron] ${result.status.toUpperCase()} ${target.platform} ${target.locale} ${target.restaurantName ?? target.restaurantId}` +
            (c ? ` items +${c.itemsCreated} ~${c.itemsUpdated} =${c.itemsUnchanged} -${c.itemsMarkedInactive}` : '') +
            (result.changes ? ` changes=${result.changes.recorded + result.changes.truncated}` : '') +
            (result.fetch?.requestCost !== undefined ? ` cost=${result.fetch.requestCost}` : '') +
            (result.error ? ` [${result.error.code}] ${result.error.message}` : '')
          );
          await record(result);

          const moreWork = i < restaurant.targets.length - 1 || remainingTargets() > 0;
          if (moreWork && !stopReason()) await sleep(config.delayMs, signal);
        }
      }
    };

    await Promise.all(Array.from({ length: Math.max(1, Math.min(config.concurrency, planned.restaurants.length || 1)) }, worker));
    await writes;
  } catch (err) {
    jobErrors.push({ code: 'JOB_FAILED', message: redactMongoUri(String((err as Error)?.message ?? err)) });
    logger.error(`[dining-cron] Job ${jobId} crashed: ${sanitizeRunMessage(redactMongoUri(String((err as Error)?.message)))}`);
  } finally {
    clearInterval(heartbeat);
  }

  if (signal?.aborted) abortReason = 'SHUTDOWN';
  const crashed = jobErrors.some(e => e.code === 'JOB_FAILED');
  const status = crashed ? 'failed' : decideJobStatus(totals, abortReason);
  const finished = await jobs.finish(jobId, { status, totals, abortReason, errors: jobErrors }, now()).catch(err => {
    logger.error(`[dining-cron] Could not close job ${jobId}: ${sanitizeRunMessage(redactMongoUri(String(err?.message)))}`);
    return null;
  });
  const durationMs = finished?.durationMs ?? Math.max(0, now().getTime() - startedAt.getTime());

  logger.log(
    `[dining-cron] Job ${jobId} ${status}${abortReason ? ` (${abortReason})` : ''} in ${Math.round(durationMs / 1000)}s: ` +
    `targets ok=${totals.targetsSucceeded} partial=${totals.targetsPartial} failed=${totals.targetsFailed} skipped=${totals.targetsSkipped}; ` +
    `items created=${totals.itemsCreated} updated=${totals.itemsUpdated} inactive=${totals.itemsMarkedInactive}; ` +
    `changes=${totals.changesRecorded} newUnmapped=${totals.newItemsUnmapped} credits=${totals.creditsUsed}` +
    (totals.remainingCredits !== undefined ? ` remaining=${totals.remainingCredits}` : '')
  );

  return { jobId, status, abortReason, plan, totals, durationMs };
}
