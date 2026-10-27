import { randomUUID } from 'crypto';
import { Collection, Filter } from 'mongodb';
import {
  DiningLocale,
  DiningPlatform,
  DiningScrapeRun,
  DiningScrapeRunCounts,
  DiningScrapeRunError,
  DiningScrapeRunFetch,
  DiningScrapeRunStatus,
  DiningScrapeRunTrigger,
  DiningScrapeTargetType,
  emptyScrapeRunCounts,
} from '../dining.types';
import { DiningValidationError, validateScrapeRun } from '../dining.validator';
import { applyUpdate, createUpdate, isDuplicateKeyError, setField, toMongoUpdate } from './document-update';

/*
 * Scrape run records. Also the Module 2 concurrent-run lock: the partial unique index
 * uniq_running_platform_locale_targetUrl allows one `running` run per platform + locale + URL.
 * Only non-secret data is stored (no tokens, headers or Scrape.do request URLs).
 */

export const MAX_RUN_ERRORS = 200;
const MAX_ERROR_MESSAGE = 2000;
// A run still `running` after this long is treated as abandoned (e.g. the process crashed).
export const STALE_RUN_MS = 15 * 60 * 1000;

export class DiningRunConflictError extends Error {
  readonly runningRunId?: string;

  constructor(runningRunId?: string) {
    super('A scrape for this platform, locale and URL is already running');
    this.name = 'DiningRunConflictError';
    this.runningRunId = runningRunId;
  }
}

export interface CreateRunInput {
  runId?: string;
  platform: DiningPlatform;
  locale: DiningLocale;
  targetType: DiningScrapeTargetType;
  targetUrl: string;
  trigger: DiningScrapeRunTrigger;
  dryRun: boolean;
}

export interface FinishRunInput {
  status: Exclude<DiningScrapeRunStatus, 'running'>;
  counts?: DiningScrapeRunCounts;
  errors?: DiningScrapeRunError[];
  fetch?: DiningScrapeRunFetch;
}

export function newRunId(): string {
  return `run_${randomUUID()}`;
}

const SECRET_QUERY_RE = /([?&](?:token|api_?key|access_?token|key)=)[^&\s"'#]*/gi;
const SCRAPE_DO_URL_RE = /https?:\/\/[^\s"']*scrape\.do[^\s"']*/gi;

export function sanitizeRunMessage(message: unknown): string {
  const text = String(message ?? '')
    .replace(SCRAPE_DO_URL_RE, '<scrape.do request>')
    .replace(SECRET_QUERY_RE, '$1***')
    .trim();
  return (text || 'Unknown error').slice(0, MAX_ERROR_MESSAGE);
}

export function sanitizeRunError(error: DiningScrapeRunError): DiningScrapeRunError {
  return {
    stage: sanitizeRunMessage(error.stage).slice(0, 100),
    code: sanitizeRunMessage(error.code).slice(0, 100),
    message: sanitizeRunMessage(error.message),
  };
}

function safePlatformUrl(url: unknown): string | undefined {
  if (typeof url !== 'string') return undefined;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return undefined;
    if (parsed.username || parsed.password) return undefined;
    if (parsed.hostname === 'scrape.do' || parsed.hostname.endsWith('.scrape.do')) return undefined;
    if (SECRET_QUERY_RE.test(url)) return undefined;
    return url;
  } catch {
    return undefined;
  } finally {
    SECRET_QUERY_RE.lastIndex = 0;
  }
}

function nonNegative(value: unknown, integer = false): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined;
  return integer ? Math.round(value) : value;
}

// Whitelist of non-secret fetch metadata (mirrors ScrapeDoResponse fields).
export function sanitizeFetchMetadata(meta: Partial<Record<keyof DiningScrapeRunFetch, unknown>>): DiningScrapeRunFetch {
  const status = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) && v >= 100 && v <= 599 ? v : undefined);
  const attempts = nonNegative(meta.attempts, true);
  const out: DiningScrapeRunFetch = {
    statusCode: status(meta.statusCode),
    initialStatusCode: status(meta.initialStatusCode),
    finalUrl: safePlatformUrl(meta.finalUrl),
    requestCost: nonNegative(meta.requestCost),
    remainingCredits: nonNegative(meta.remainingCredits),
    attempts: attempts && attempts >= 1 ? attempts : undefined,
    durationMs: nonNegative(meta.durationMs, true),
  };
  for (const key of Object.keys(out) as Array<keyof DiningScrapeRunFetch>) if (out[key] === undefined) delete out[key];
  return out;
}

export function createScrapeRunRepository(collection: Collection<DiningScrapeRun>) {
  function runningFilter(input: Pick<CreateRunInput, 'platform' | 'locale' | 'targetUrl'>): Filter<DiningScrapeRun> {
    return { platform: input.platform, locale: input.locale, targetUrl: input.targetUrl, status: 'running' };
  }

  async function findByRunId(runId: string): Promise<DiningScrapeRun | null> {
    return collection.findOne({ runId });
  }

  async function findRunning(input: Pick<CreateRunInput, 'platform' | 'locale' | 'targetUrl'>): Promise<DiningScrapeRun | null> {
    return collection.findOne(runningFilter(input));
  }

  async function insertRunning(input: CreateRunInput, now: Date): Promise<DiningScrapeRun> {
    const run: DiningScrapeRun = {
      runId: input.runId ?? newRunId(),
      platform: input.platform,
      locale: input.locale,
      targetType: input.targetType,
      targetUrl: input.targetUrl,
      trigger: input.trigger,
      dryRun: input.dryRun,
      status: 'running',
      startedAt: now,
      counts: emptyScrapeRunCounts(),
      errors: [],
      createdAt: now,
      updatedAt: now,
    };
    const check = validateScrapeRun(run);
    if (!check.valid) throw new DiningValidationError('scrape run', check.issues);
    await collection.insertOne(run);
    return run;
  }

  // Throws DiningRunConflictError while another run for the same target is running.
  // A run left `running` for longer than STALE_RUN_MS is closed as failed and the lock taken over.
  async function createRunning(input: CreateRunInput, now: Date = new Date()): Promise<DiningScrapeRun> {
    try {
      return await insertRunning(input, now);
    } catch (err) {
      if (!isDuplicateKeyError(err)) throw err;
      const running = await findRunning(input);
      if (running && now.getTime() - running.startedAt.getTime() < STALE_RUN_MS) {
        throw new DiningRunConflictError(running.runId);
      }
      if (running) {
        await finishRun(running.runId, {
          status: 'failed',
          errors: [{ stage: 'run', code: 'STALE_RUN', message: 'Run did not finish and was superseded by a new run' }],
        }, now);
      }
      try {
        return await insertRunning(input, now);
      } catch (retryErr) {
        if (!isDuplicateKeyError(retryErr)) throw retryErr;
        throw new DiningRunConflictError((await findRunning(input))?.runId);
      }
    }
  }

  async function recordFetch(runId: string, fetch: Partial<Record<keyof DiningScrapeRunFetch, unknown>>, now: Date = new Date()): Promise<void> {
    await collection.updateOne({ runId, status: 'running' }, { $set: { fetch: sanitizeFetchMetadata(fetch), updatedAt: now } });
  }

  // Closes a running run. Returns null if the run does not exist or is no longer running.
  async function finishRun(runId: string, input: FinishRunInput, now: Date = new Date()): Promise<DiningScrapeRun | null> {
    const existing = await collection.findOne({ runId, status: 'running' });
    if (!existing) return null;

    const finishedAt = now.getTime() < existing.startedAt.getTime() ? existing.startedAt : now;
    const errors = [...existing.errors, ...(input.errors ?? [])].slice(0, MAX_RUN_ERRORS).map(sanitizeRunError);
    if (input.status === 'failed' && errors.length === 0) {
      errors.push({ stage: 'run', code: 'FAILED', message: 'Run failed without a recorded error' });
    }

    const u = createUpdate();
    setField(u, 'status', input.status);
    setField(u, 'finishedAt', finishedAt);
    setField(u, 'durationMs', finishedAt.getTime() - existing.startedAt.getTime());
    setField(u, 'counts', input.counts ?? existing.counts);
    setField(u, 'errors', errors);
    if (input.fetch) setField(u, 'fetch', sanitizeFetchMetadata(input.fetch));
    setField(u, 'updatedAt', finishedAt);

    const merged = applyUpdate<DiningScrapeRun>(existing, u);
    const check = validateScrapeRun(merged);
    if (!check.valid) throw new DiningValidationError('scrape run', check.issues);

    const res = await collection.updateOne({ runId, status: 'running' }, toMongoUpdate<DiningScrapeRun>(u));
    return res.matchedCount ? merged : null;
  }

  async function listRecent(filter: Partial<Pick<DiningScrapeRun, 'platform' | 'targetUrl' | 'locale'>> = {}, limit = 20): Promise<DiningScrapeRun[]> {
    return collection.find(filter as Filter<DiningScrapeRun>).sort({ startedAt: -1 }).limit(Math.min(Math.max(limit, 1), 100)).toArray();
  }

  return { createRunning, recordFetch, finishRun, findByRunId, findRunning, listRecent };
}

export type ScrapeRunRepository = ReturnType<typeof createScrapeRunRepository>;
