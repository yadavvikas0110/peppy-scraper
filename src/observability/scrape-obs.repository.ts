import { randomUUID } from 'crypto';
import { Collection } from 'mongodb';
import {
  ScrapeObsCollections,
  ScrapeObsError,
  ScrapeObsErrorStage,
  ScrapeObsRun,
  ScrapeObsRunStatus,
  ScrapeObsRunTotals,
  ScrapeObsSeverity,
  ScrapeObsSiteRun,
  ScrapeObsSubsystem,
  ScrapeObsTrigger,
  emptyRunTotals,
} from './scrape-obs.collections';

/*
 * Low-level persistence for scrape observability records. Only non-secret data is
 * stored — Bright Data / Scrape.do request URLs and credentialed query params are
 * stripped before anything is written (mirrors the dining scrape-run repository).
 */

const MAX_ERROR_MESSAGE = 2000;
const MAX_REASON = 500;
// A run still `running` after this long is treated as abandoned (process crashed).
export const STALE_RUN_MS = 6 * 60 * 60 * 1000; // 6h — the full pipeline is long-running.

const SECRET_QUERY_RE = /([?&](?:token|api_?key|access_?token|key|auth|password|secret)=)[^&\s"'#]*/gi;
const SCRAPE_DO_URL_RE = /https?:\/\/[^\s"']*scrape\.do[^\s"']*/gi;
const BRIGHTDATA_URL_RE = /https?:\/\/[^\s"']*(?:brightdata|brd\.superproxy|luminati)[^\s"']*/gi;
const MONGO_URI_RE = /mongodb(?:\+srv)?:\/\/[^\s"']+/gi;

export function sanitizeMessage(message: unknown): string {
  const text = String(message ?? '')
    .replace(MONGO_URI_RE, '<mongodb_uri>')
    .replace(SCRAPE_DO_URL_RE, '<scrape.do request>')
    .replace(BRIGHTDATA_URL_RE, '<brightdata request>')
    .replace(SECRET_QUERY_RE, '$1***')
    .trim();
  return (text || 'Unknown error').slice(0, MAX_ERROR_MESSAGE);
}

/** Returns a public product URL only if it carries no embedded credentials/secrets. */
export function safeUrl(url: unknown): string | undefined {
  if (typeof url !== 'string' || !url) return undefined;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return undefined;
    if (parsed.username || parsed.password) return undefined;
    const host = parsed.hostname;
    if (host === 'scrape.do' || host.endsWith('.scrape.do')) return undefined;
    if (/brightdata|superproxy|luminati/i.test(host)) return undefined;
    if (SECRET_QUERY_RE.test(url)) return undefined;
    return url.slice(0, 1000);
  } catch {
    return undefined;
  } finally {
    SECRET_QUERY_RE.lastIndex = 0;
  }
}

export function newRunId(): string {
  return `erun_${randomUUID()}`;
}

export interface CreateRunInput {
  runId?: string;
  subsystem?: ScrapeObsSubsystem;
  trigger: ScrapeObsTrigger;
  resumed: boolean;
  queriesPlanned: number;
  host?: string;
  pid?: number;
}

export interface SiteOutcomeInput {
  site: string;
  status: string;
  scraped?: number;
  failed?: number;
  skipped?: number;
  links?: number;
  reason?: string;
}

export interface RecordErrorInput {
  errorKey?: string;
  site?: string;
  stage: ScrapeObsErrorStage;
  code?: string;
  message: unknown;
  url?: string;
  severity?: ScrapeObsSeverity;
  context?: Record<string, unknown>;
}

export interface FinishRunInput {
  status: Exclude<ScrapeObsRunStatus, 'running'>;
  totals?: Partial<ScrapeObsRunTotals>;
  sites?: string[];
}

function nonNeg(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value) : 0;
}

export function createScrapeObsRepository(collections: ScrapeObsCollections, subsystem: ScrapeObsSubsystem = 'ecommerce') {
  const { runs, siteRuns, errors } = collections;

  /** Closes runs left `running` past STALE_RUN_MS from an earlier crashed process. */
  async function reapStaleRuns(now: Date): Promise<void> {
    const cutoff = new Date(now.getTime() - STALE_RUN_MS);
    await runs.updateMany(
      { subsystem, status: 'running', startedAt: { $lt: cutoff } },
      { $set: { status: 'failed', finishedAt: now, updatedAt: now } },
    );
  }

  async function createRun(input: CreateRunInput, now: Date = new Date()): Promise<string> {
    await reapStaleRuns(now);
    const runId = input.runId ?? newRunId();
    const totals = emptyRunTotals();
    totals.queriesPlanned = nonNeg(input.queriesPlanned);
    const doc: ScrapeObsRun = {
      runId,
      subsystem: input.subsystem ?? subsystem,
      trigger: input.trigger,
      status: 'running',
      startedAt: now,
      resumed: input.resumed,
      totals,
      sites: [],
      host: input.host,
      pid: input.pid,
      createdAt: now,
      updatedAt: now,
    };
    await runs.insertOne(doc);
    return runId;
  }

  async function updateRunProgress(
    runId: string,
    totals: Partial<ScrapeObsRunTotals>,
    sites: string[] | undefined,
    now: Date = new Date(),
  ): Promise<void> {
    const set: Record<string, unknown> = { updatedAt: now };
    for (const [k, v] of Object.entries(totals)) {
      if (typeof v === 'number' && Number.isFinite(v)) set[`totals.${k}`] = Math.round(v);
    }
    const update: Record<string, unknown> = { $set: set };
    if (sites && sites.length) update.$addToSet = { sites: { $each: sites } };
    await runs.updateOne({ runId, status: 'running' }, update);
  }

  async function finishRun(runId: string, input: FinishRunInput, now: Date = new Date()): Promise<void> {
    const existing = await runs.findOne({ runId });
    if (!existing) return;
    const finishedAt = now.getTime() < existing.startedAt.getTime() ? existing.startedAt : now;
    const set: Record<string, unknown> = {
      status: input.status,
      finishedAt,
      durationMs: finishedAt.getTime() - existing.startedAt.getTime(),
      updatedAt: finishedAt,
    };
    for (const [k, v] of Object.entries(input.totals ?? {})) {
      if (typeof v === 'number' && Number.isFinite(v)) set[`totals.${k}`] = Math.round(v);
    }
    const update: Record<string, unknown> = { $set: set };
    if (input.sites && input.sites.length) update.$addToSet = { sites: { $each: input.sites } };
    await runs.updateOne({ runId }, update);
  }

  async function upsertSiteRun(runId: string, outcome: SiteOutcomeInput, now: Date = new Date()): Promise<void> {
    await siteRuns.updateOne(
      { runId, site: outcome.site },
      {
        $setOnInsert: { runId, site: outcome.site, subsystem, startedAt: now },
        $set: {
          status: String(outcome.status).slice(0, 40),
          lastReason: outcome.reason ? sanitizeMessage(outcome.reason).slice(0, MAX_REASON) : undefined,
          updatedAt: now,
        },
        $inc: {
          scraped: nonNeg(outcome.scraped),
          failed: nonNeg(outcome.failed),
          skipped: nonNeg(outcome.skipped),
          links: nonNeg(outcome.links),
          queriesCovered: 1,
        },
      } as any,
      { upsert: true },
    );
  }

  async function recordError(runId: string | undefined, input: RecordErrorInput, now: Date = new Date()): Promise<void> {
    const doc: ScrapeObsError = {
      errorKey: input.errorKey,
      runId,
      subsystem,
      site: input.site,
      stage: input.stage,
      code: (input.code ?? 'ERROR').slice(0, 100),
      message: sanitizeMessage(input.message),
      url: safeUrl(input.url),
      severity: input.severity ?? 'error',
      context: input.context,
      createdAt: now,
    };
    if (doc.errorKey) {
      // Upsert so a resumed run re-reporting the same per-URL failure does not duplicate it.
      const { errorKey, ...rest } = doc;
      await errors.updateOne(
        { errorKey },
        { $set: { ...rest, updatedAt: now }, $setOnInsert: { errorKey, createdAt: now } },
        { upsert: true },
      );
    } else {
      await errors.insertOne(doc);
    }
  }

  return { createRun, updateRunProgress, finishRun, upsertSiteRun, recordError, reapStaleRuns };
}

export type ScrapeObsRepository = ReturnType<typeof createScrapeObsRepository>;

export type { Collection };
