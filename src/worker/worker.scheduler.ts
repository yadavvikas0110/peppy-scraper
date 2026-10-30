import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { WorkerConfig, ShoppingQuery } from './worker.config';
import { JobRecord, JobType, RunOutcome, WorkerStore, emptySummary, utcDay } from './worker.store';
import { WorkerLogger } from './worker.logger';
import { JobContext, JobResult, runDiscovery, runRefresh } from './worker.jobs';

export const REFRESH_JOB_ID = 'refresh:amazon';
export const discoveryJobId = (q: ShoppingQuery) => `discovery:${q.key}`;

/** When a job should run next, given how its last run ended. */
export function computeNextRun(type: JobType, outcome: RunOutcome, attempts: number, now: Date, config: WorkerConfig): Date {
  const interval = type === 'discovery' ? config.discoveryIntervalMs : config.refreshIntervalMs;
  switch (outcome) {
    case 'complete':
    case 'partial':
      // A partial run (e.g. a refused host) waits the full interval — blocked sources are not hammered
      return new Date(now.getTime() + interval);
    case 'budget_exhausted': {
      const tomorrow = new Date(`${utcDay(now)}T00:00:00.000Z`);
      tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
      return new Date(tomorrow.getTime() + 60_000);
    }
    case 'interrupted':
      // Resume as soon as the worker runs again; the checkpoint holds the progress
      return now;
    case 'failed': {
      if (attempts >= config.maxAttempts) return new Date(now.getTime() + interval);
      const backoff = Math.min(config.retryBaseMs * 2 ** Math.max(0, attempts - 1), interval);
      return new Date(now.getTime() + backoff);
    }
  }
}

/** Creates records for newly configured jobs; returns the jobs that are currently configured. */
export async function ensureJobs(store: WorkerStore, config: WorkerConfig, now: Date): Promise<JobRecord[]> {
  const wanted: Array<{ id: string; type: JobType; label: string }> = [
    { id: REFRESH_JOB_ID, type: 'refresh', label: 'Refresh Amazon UAE prices & stock' },
    ...config.queries.map(q => ({ id: discoveryJobId(q), type: 'discovery' as const, label: `Discover: ${q.label}` })),
  ];
  const jobs: JobRecord[] = [];
  for (const w of wanted) {
    let job = await store.getJob(w.id);
    if (!job) {
      job = { _id: w.id, type: w.type, label: w.label, status: 'idle', nextRunAt: now, attempts: 0, progress: null };
      await store.saveJob(job);
    }
    jobs.push(job);
  }
  return jobs;
}

/** Jobs left "running" by a crashed process are resumable, not running. */
export async function recoverInterruptedJobs(store: WorkerStore, now: Date): Promise<string[]> {
  const recovered: string[] = [];
  for (const job of await store.listJobs()) {
    if (job.status === 'running') {
      await store.saveJob({ ...job, status: 'interrupted', nextRunAt: now, lastError: 'worker stopped while the job was running' });
      recovered.push(job._id);
    }
  }
  return recovered;
}

/** Next job to run: interrupted jobs first, then the most overdue. */
export function pickDueJob(jobs: JobRecord[], now: Date): JobRecord | null {
  const due = jobs.filter(j => j.status !== 'running' && new Date(j.nextRunAt).getTime() <= now.getTime());
  due.sort((a, b) => {
    const ai = a.status === 'interrupted' ? 0 : 1;
    const bi = b.status === 'interrupted' ? 0 : 1;
    if (ai !== bi) return ai - bi;
    return new Date(a.nextRunAt).getTime() - new Date(b.nextRunAt).getTime();
  });
  return due[0] ?? null;
}

export interface SchedulerDeps {
  store: WorkerStore;
  config: WorkerConfig;
  owner: string;
  logger: WorkerLogger;
  makeContext(shouldStop: () => boolean): JobContext;
  now(): Date;
  sleep(ms: number, isStopped: () => boolean): Promise<void>;
  stopFile: string;
  statusFile: string;
}

/** Runs one job end to end: marks it running, executes, records outcome, schedule and run history. */
export async function executeJob(job: JobRecord, ctx: JobContext, deps: Pick<SchedulerDeps, 'store' | 'config' | 'now'>): Promise<JobResult> {
  const startedAt = deps.now();
  const runId = crypto.randomUUID();
  const requestsBefore = ctx.budget.requestsThisProcess;
  await deps.store.saveJob({ ...job, status: 'running', lastRunAt: startedAt });
  ctx.logger.info('job.start', { job: job._id, runId });

  let result: JobResult;
  try {
    if (job.type === 'refresh') {
      result = await runRefresh(job, ctx, async progress => {
        const current = (await deps.store.getJob(job._id)) ?? job;
        await deps.store.saveJob({ ...current, progress });
      });
    } else {
      const query = deps.config.queries.find(q => discoveryJobId(q) === job._id);
      if (!query) throw new Error(`query for ${job._id} is no longer configured`);
      result = await runDiscovery(query, ctx);
    }
  } catch (e: any) {
    result = { outcome: 'failed', summary: emptySummary(), issues: [], error: String(e?.message ?? e) };
  }
  result.summary.requests = ctx.budget.requestsThisProcess - requestsBefore;

  const finishedAt = deps.now();
  const attempts = result.outcome === 'failed' ? job.attempts + 1 : 0;
  const current = (await deps.store.getJob(job._id)) ?? job;
  const next: JobRecord = {
    ...current,
    status: result.outcome,
    lastFinishedAt: finishedAt,
    attempts,
    nextRunAt: computeNextRun(job.type, result.outcome, attempts, finishedAt, deps.config),
    lastSummary: result.summary,
    lastError: result.error,
    issues: result.issues,
    ...(result.outcome === 'complete' ? { lastSuccessAt: finishedAt } : {}),
    ...(result.progress !== undefined ? { progress: result.progress } : {}),
  };
  await deps.store.saveJob(next);
  await deps.store.addRun({
    runId, jobId: job._id, type: job.type, startedAt, finishedAt, outcome: result.outcome,
    summary: result.summary, issues: result.issues, ...(result.error ? { error: result.error } : {}),
  });

  ctx.logger.summary(`${job.label} — ${result.outcome.toUpperCase()} in ${Math.round((finishedAt.getTime() - startedAt.getTime()) / 1000)}s`, result.summary, {
    issues: result.issues,
    error: result.error,
    nextRunAt: next.nextRunAt.toISOString(),
  });
  return result;
}

export async function writeStatusFile(deps: Pick<SchedulerDeps, 'store' | 'config' | 'now' | 'statusFile'>, extra: Record<string, unknown> = {}): Promise<void> {
  const now = deps.now();
  const jobs = await deps.store.listJobs();
  const status = {
    updatedAt: now,
    budget: { day: utcDay(now), used: await deps.store.budgetUsed(utcDay(now)), limit: deps.config.dailyRequestBudget },
    lock: await deps.store.readLock(),
    jobs: jobs.map(j => ({
      id: j._id, status: j.status, lastSuccessAt: j.lastSuccessAt ?? null, lastFinishedAt: j.lastFinishedAt ?? null,
      nextRunAt: j.nextRunAt, attempts: j.attempts, lastSummary: j.lastSummary ?? null, lastError: j.lastError ?? null,
      progress: j.progress ? { done: j.progress.done.length, targets: j.progress.targets.length } : null,
    })),
    ...extra,
  };
  fs.mkdirSync(path.dirname(deps.statusFile), { recursive: true });
  fs.writeFileSync(deps.statusFile, JSON.stringify(status, null, 2));
}

/**
 * The continuous worker loop. Returns when stopped (signal, stop command, lost lock).
 * One job runs at a time; the lock is renewed while it runs.
 */
export async function runScheduler(deps: SchedulerDeps, signals: { stopRequested: boolean }): Promise<'stopped' | 'lock_unavailable' | 'lock_lost'> {
  const { store, config, owner, logger } = deps;
  if (!(await store.acquireLock(owner, config.lockTtlMs, deps.now()))) {
    const lock = await store.readLock();
    logger.error('worker.lock_unavailable', { heldBy: lock?.owner, heartbeatAt: lock?.heartbeatAt });
    return 'lock_unavailable';
  }
  let lockLost = false;
  const heartbeat = setInterval(() => {
    store.acquireLock(owner, config.lockTtlMs, deps.now())
      .then(ok => { if (!ok) { lockLost = true; logger.error('worker.lock_lost'); } })
      .catch(e => logger.warn('worker.heartbeat_failed', { error: e.message }));
  }, Math.max(1000, Math.floor(config.lockTtlMs / 3)));
  heartbeat.unref();

  const stopped = () => signals.stopRequested || lockLost || fs.existsSync(deps.stopFile);
  try {
    const recovered = await recoverInterruptedJobs(store, deps.now());
    if (recovered.length) logger.warn('worker.recovered_interrupted_jobs', { jobs: recovered });
    logger.info('worker.started', { owner, env: config.env, sites: config.sites, queries: config.queries.length, budget: config.dailyRequestBudget });

    while (!stopped()) {
      const now = deps.now();
      const jobs = await ensureJobs(store, config, now);
      const job = pickDueJob(jobs, now);
      const remaining = config.dailyRequestBudget - (await store.budgetUsed(utcDay(now)));
      if (job && remaining > 0) {
        const ctx = deps.makeContext(stopped);
        await executeJob(job, ctx, deps);
      } else {
        await writeStatusFile(deps, { state: remaining > 0 ? 'idle' : 'budget_exhausted' });
        await deps.sleep(config.tickMs, stopped);
        continue;
      }
      await writeStatusFile(deps, { state: 'running' });
    }
    logger.info('worker.stopping', { reason: lockLost ? 'lock lost' : 'stop requested' });
    return lockLost ? 'lock_lost' : 'stopped';
  } finally {
    clearInterval(heartbeat);
    try { fs.unlinkSync(deps.stopFile); } catch {}
    await store.releaseLock(owner).catch(() => {});
    await writeStatusFile(deps, { state: 'stopped' }).catch(() => {});
  }
}
