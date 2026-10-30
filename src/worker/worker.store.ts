import * as os from 'os';
import { Db } from 'mongodb';

/**
 * Persistent worker state, kept in the same database the worker writes products to:
 *   shopping_worker_jobs   one record per job (discovery per query, refresh) — schedule, status, progress
 *   shopping_worker_runs   one record per run — summary counts, outcome, errors
 *   shopping_worker_locks  scheduler lock (one active worker; expires if the holder dies)
 *   shopping_worker_budget paid provider requests used per UTC day
 */

export type JobType = 'discovery' | 'refresh';
/** complete = every requested piece succeeded; partial/failed/interrupted are never reported as success */
export type RunOutcome = 'complete' | 'partial' | 'failed' | 'interrupted' | 'budget_exhausted';

export interface JobSummary {
  discovered: number;
  scraped: number;
  inserted: number;
  updated: number;
  matched: number;
  reviewRequired: number;
  failed: number;
  skipped: number;
  requests: number;
  mapped: number;
  /** offers marked stale (not observed within STALE_OFFER_DAYS) after a refresh run */
  staleMarked: number;
}

export function emptySummary(): JobSummary {
  return { discovered: 0, scraped: 0, inserted: 0, updated: 0, matched: 0, reviewRequired: 0, failed: 0, skipped: 0, requests: 0, mapped: 0, staleMarked: 0 };
}

export interface JobRecord {
  _id: string;                 // "discovery:<queryKey>" | "refresh:amazon"
  type: JobType;
  label: string;
  status: 'idle' | 'running' | RunOutcome;
  nextRunAt: Date;
  lastRunAt?: Date;
  lastFinishedAt?: Date;
  lastSuccessAt?: Date;
  /** consecutive failed attempts; reset on success */
  attempts: number;
  lastSummary?: JobSummary;
  lastError?: string;
  issues?: string[];
  /** Resumable progress of a refresh run (ASINs chosen at start, ASINs already pushed) */
  progress?: { runId: string; startedAt: Date; targets: string[]; done: string[] } | null;
}

export interface RunRecord {
  runId: string;
  jobId: string;
  type: JobType;
  startedAt: Date;
  finishedAt: Date;
  outcome: RunOutcome;
  summary: JobSummary;
  issues: string[];
  error?: string;
}

export interface LockRecord {
  _id: string;
  owner: string;
  pid: number;
  host: string;
  acquiredAt: Date;
  heartbeatAt: Date;
  expiresAt: Date;
}

export interface WorkerStore {
  getJob(id: string): Promise<JobRecord | null>;
  listJobs(): Promise<JobRecord[]>;
  saveJob(job: JobRecord): Promise<void>;
  addRun(run: RunRecord): Promise<void>;
  recentRuns(limit: number): Promise<RunRecord[]>;
  /** Acquire or renew the scheduler lock. False when another live worker holds it. */
  acquireLock(owner: string, ttlMs: number, now: Date): Promise<boolean>;
  releaseLock(owner: string): Promise<void>;
  readLock(): Promise<LockRecord | null>;
  /** Atomically reserve `n` requests for `day`; false (and nothing reserved) if it would exceed `limit`. */
  reserveBudget(day: string, n: number, limit: number): Promise<boolean>;
  budgetUsed(day: string): Promise<number>;
}

export const LOCK_ID = 'shopping-scheduler';

export function workerOwnerId(): string {
  return `${os.hostname()}:${process.pid}`;
}

export function utcDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function mongoWorkerStore(db: Db): WorkerStore {
  const jobs = db.collection<JobRecord>('shopping_worker_jobs');
  const runs = db.collection<RunRecord>('shopping_worker_runs');
  const locks = db.collection<LockRecord>('shopping_worker_locks');
  const budget = db.collection<{ _id: string; used: number }>('shopping_worker_budget');

  return {
    getJob: id => jobs.findOne({ _id: id }),
    listJobs: () => jobs.find({}).sort({ _id: 1 }).toArray(),
    async saveJob(job) {
      await jobs.replaceOne({ _id: job._id }, job, { upsert: true });
    },
    async addRun(run) {
      await runs.insertOne(run as any);
    },
    recentRuns: limit => runs.find({}).sort({ finishedAt: -1 }).limit(limit).toArray() as Promise<RunRecord[]>,
    async acquireLock(owner, ttlMs, now) {
      const expiresAt = new Date(now.getTime() + ttlMs);
      try {
        const r = await locks.updateOne(
          { _id: LOCK_ID, $or: [{ owner }, { expiresAt: { $lt: now } }] },
          {
            $set: { owner, pid: process.pid, host: os.hostname(), heartbeatAt: now, expiresAt },
            $setOnInsert: { acquiredAt: now },
          },
          { upsert: true },
        );
        return r.matchedCount > 0 || r.upsertedCount > 0;
      } catch (e: any) {
        // Duplicate key: the lock exists, is unexpired and belongs to someone else
        if (e?.code === 11000) return false;
        throw e;
      }
    },
    async releaseLock(owner) {
      await locks.deleteOne({ _id: LOCK_ID, owner });
    },
    readLock: () => locks.findOne({ _id: LOCK_ID }),
    async reserveBudget(day, n, limit) {
      try {
        const r = await budget.updateOne(
          { _id: day, used: { $lte: limit - n } },
          { $inc: { used: n } },
          { upsert: true },
        );
        return r.matchedCount > 0 || r.upsertedCount > 0;
      } catch (e: any) {
        // Upsert collided with an existing day document that is over the limit
        if (e?.code === 11000) return false;
        throw e;
      }
    },
    async budgetUsed(day) {
      return (await budget.findOne({ _id: day }))?.used ?? 0;
    },
  };
}

/** In-memory store with the same semantics, for tests and dry runs. */
export function memoryWorkerStore(): WorkerStore & { jobs: Map<string, JobRecord>; runs: RunRecord[]; lock: LockRecord | null; budget: Map<string, number> } {
  const state = {
    jobs: new Map<string, JobRecord>(),
    runs: [] as RunRecord[],
    lock: null as LockRecord | null,
    budget: new Map<string, number>(),
  };
  const clone = <T>(v: T): T => structuredClone(v);
  return {
    jobs: state.jobs,
    runs: state.runs,
    budget: state.budget,
    get lock() { return state.lock; },
    async getJob(id) { const j = state.jobs.get(id); return j ? clone(j) : null; },
    async listJobs() { return [...state.jobs.values()].map(clone).sort((a, b) => a._id.localeCompare(b._id)); },
    async saveJob(job) { state.jobs.set(job._id, clone(job)); },
    async addRun(run) { state.runs.push(clone(run)); },
    async recentRuns(limit) { return [...state.runs].reverse().slice(0, limit).map(clone); },
    async acquireLock(owner, ttlMs, now) {
      if (state.lock && state.lock.owner !== owner && state.lock.expiresAt >= now) return false;
      state.lock = { _id: LOCK_ID, owner, pid: process.pid, host: os.hostname(), acquiredAt: state.lock?.owner === owner ? state.lock.acquiredAt : now, heartbeatAt: now, expiresAt: new Date(now.getTime() + ttlMs) };
      return true;
    },
    async releaseLock(owner) { if (state.lock?.owner === owner) state.lock = null; },
    async readLock() { return state.lock ? clone(state.lock) : null; },
    async reserveBudget(day, n, limit) {
      const used = state.budget.get(day) ?? 0;
      if (used + n > limit) return false;
      state.budget.set(day, used + n);
      return true;
    },
    async budgetUsed(day) { return state.budget.get(day) ?? 0; },
  };
}
