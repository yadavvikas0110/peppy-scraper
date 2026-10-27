import { randomUUID } from 'crypto';
import { hostname } from 'os';
import type { Collection } from 'mongodb';
import { emptyScrapeRunCounts, SCRAPE_RUN_COUNT_FIELDS } from '../dining.types';
import { isDuplicateKeyError } from '../repositories/document-update';
import { sanitizeRunMessage } from '../repositories/scrape-run.repository';
import type {
  DiningCronAbortReason,
  DiningCronJob,
  DiningCronJobOptions,
  DiningCronJobStatus,
  DiningCronJobTrigger,
  DiningCronPlan,
  DiningCronTargetResult,
  DiningCronTotals,
} from './dining-cron.types';

/*
 * Cron job records: the job log (plan, per-target results, totals) and the cross-process lock.
 * A job whose heartbeat is older than STALE_JOB_MS is treated as crashed and taken over.
 */

export const DINING_CRON_LOCK_KEY = 'dining-cron';
export const STALE_JOB_MS = 30 * 60 * 1000;
const MAX_JOB_ERRORS = 50;

export class DiningCronLockedError extends Error {
  readonly runningJobId?: string;

  constructor(runningJobId?: string) {
    super('Another dining cron job is already running');
    this.name = 'DiningCronLockedError';
    this.runningJobId = runningJobId;
  }
}

export function newJobId(): string {
  return `cron_${randomUUID()}`;
}

export function emptyCronTotals(): DiningCronTotals {
  return {
    ...emptyScrapeRunCounts(),
    targetsPlanned: 0,
    targetsSucceeded: 0,
    targetsPartial: 0,
    targetsFailed: 0,
    targetsSkipped: 0,
    changesRecorded: 0,
    newItemsUnmapped: 0,
    creditsUsed: 0,
  };
}

// Folds one target result into the job totals (pure; the caller persists the result).
export function addTargetToTotals(totals: DiningCronTotals, result: DiningCronTargetResult): DiningCronTotals {
  const next: DiningCronTotals = { ...totals };
  if (result.status === 'succeeded') next.targetsSucceeded++;
  else if (result.status === 'partial') next.targetsPartial++;
  else if (result.status === 'failed') next.targetsFailed++;
  else next.targetsSkipped++;
  if (result.counts) for (const field of SCRAPE_RUN_COUNT_FIELDS) next[field] += result.counts[field];
  next.changesRecorded += result.changes?.recorded ?? 0;
  next.newItemsUnmapped += result.newItemsUnmapped ?? 0;
  next.creditsUsed += result.fetch?.requestCost ?? 0;
  if (typeof result.fetch?.remainingCredits === 'number') next.remainingCredits = result.fetch.remainingCredits;
  return next;
}

export interface StartJobInput {
  trigger: DiningCronJobTrigger;
  options: DiningCronJobOptions;
}

export function createDiningCronJobRepository(collection: Collection<DiningCronJob>, owner: { host: string; pid: number } = { host: hostname(), pid: process.pid }) {
  function newJob(input: StartJobInput, status: DiningCronJobStatus, now: Date): DiningCronJob {
    return {
      jobId: newJobId(),
      lockKey: DINING_CRON_LOCK_KEY,
      trigger: input.trigger,
      status,
      options: input.options,
      progress: { completed: 0, total: 0 },
      totals: emptyCronTotals(),
      targets: [],
      errors: [],
      host: owner.host,
      pid: owner.pid,
      startedAt: now,
      heartbeatAt: now,
      createdAt: now,
      updatedAt: now,
    };
  }

  async function findRunning(): Promise<DiningCronJob | null> {
    return collection.findOne({ lockKey: DINING_CRON_LOCK_KEY, status: 'running' });
  }

  async function markStale(job: DiningCronJob, now: Date): Promise<void> {
    await collection.updateOne(
      { jobId: job.jobId, status: 'running' },
      {
        $set: { status: 'failed', finishedAt: now, durationMs: Math.max(0, now.getTime() - job.startedAt.getTime()), updatedAt: now },
        $push: { errors: { code: 'STALE_JOB', message: 'Job stopped sending heartbeats (process crashed or was killed) and was superseded' } },
      }
    );
  }

  // Takes the lock or throws DiningCronLockedError. A crashed job's lock is released first.
  async function start(input: StartJobInput, now: Date = new Date()): Promise<DiningCronJob> {
    const job = newJob(input, 'running', now);
    try {
      await collection.insertOne(job);
      return job;
    } catch (err) {
      if (!isDuplicateKeyError(err)) throw err;
    }
    const running = await findRunning();
    if (running && now.getTime() - running.heartbeatAt.getTime() < STALE_JOB_MS) throw new DiningCronLockedError(running.jobId);
    if (running) await markStale(running, now);
    try {
      await collection.insertOne(job);
      return job;
    } catch (err) {
      if (!isDuplicateKeyError(err)) throw err;
      throw new DiningCronLockedError((await findRunning())?.jobId);
    }
  }

  // Audit record for a trigger that found another job running (never holds the lock).
  async function recordSkipped(input: StartJobInput, blockedByJobId: string | undefined, now: Date = new Date()): Promise<DiningCronJob> {
    const job: DiningCronJob = {
      ...newJob(input, 'skipped', now),
      skipReason: 'ALREADY_RUNNING',
      blockedByJobId,
      finishedAt: now,
      durationMs: 0,
    };
    await collection.insertOne(job);
    return job;
  }

  async function savePlan(jobId: string, plan: DiningCronPlan, now: Date = new Date()): Promise<void> {
    await collection.updateOne(
      { jobId, status: 'running' },
      { $set: { plan, progress: { completed: 0, total: plan.targets }, 'totals.targetsPlanned': plan.targets, heartbeatAt: now, updatedAt: now } }
    );
  }

  async function recordTarget(jobId: string, result: DiningCronTargetResult, totals: DiningCronTotals, completed: number, now: Date = new Date()): Promise<void> {
    await collection.updateOne(
      { jobId, status: 'running' },
      { $push: { targets: result }, $set: { totals, 'progress.completed': completed, heartbeatAt: now, updatedAt: now } }
    );
  }

  async function heartbeat(jobId: string, now: Date = new Date()): Promise<void> {
    await collection.updateOne({ jobId, status: 'running' }, { $set: { heartbeatAt: now, updatedAt: now } });
  }

  async function finish(
    jobId: string,
    input: { status: Exclude<DiningCronJobStatus, 'running' | 'skipped'>; totals: DiningCronTotals; abortReason?: DiningCronAbortReason; errors?: Array<{ code: string; message: string }> },
    now: Date = new Date()
  ): Promise<DiningCronJob | null> {
    const existing = await collection.findOne({ jobId, status: 'running' });
    if (!existing) return null;
    const errors = [...existing.errors, ...(input.errors ?? [])]
      .slice(0, MAX_JOB_ERRORS)
      .map(e => ({ code: sanitizeRunMessage(e.code).slice(0, 100), message: sanitizeRunMessage(e.message) }));
    const set: Partial<DiningCronJob> = {
      status: input.status,
      totals: input.totals,
      errors,
      finishedAt: now,
      durationMs: Math.max(0, now.getTime() - existing.startedAt.getTime()),
      heartbeatAt: now,
      updatedAt: now,
    };
    if (input.abortReason) set.abortReason = input.abortReason;
    await collection.updateOne({ jobId, status: 'running' }, { $set: set });
    return collection.findOne({ jobId });
  }

  async function findByJobId(jobId: string): Promise<DiningCronJob | null> {
    return collection.findOne({ jobId });
  }

  async function listRecent(limit = 10): Promise<DiningCronJob[]> {
    return collection.find({}, { projection: { targets: 0 } }).sort({ startedAt: -1 }).limit(Math.min(Math.max(limit, 1), 100)).toArray();
  }

  return { start, recordSkipped, savePlan, recordTarget, heartbeat, finish, findByJobId, findRunning, listRecent };
}

export type DiningCronJobRepository = ReturnType<typeof createDiningCronJobRepository>;
