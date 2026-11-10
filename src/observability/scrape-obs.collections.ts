import { Collection, Db, IndexDescription } from 'mongodb';
import { getMongoDb } from '../shared/db/mongo';

/*
 * Scrape observability collections — the central source of truth for the admin
 * "Scrape Monitoring" panel. These are NEW, isolated collections (prefixed
 * `scrape_obs_`). They never touch the ecommerce (`products_clean`), dining
 * (`dining_*`) or shopping-worker (`shopping_worker_*`) collections — the admin
 * backend reads those directly and normalizes them alongside these records.
 */

export const SCRAPE_OBS_COLLECTIONS = {
  runs: 'scrape_obs_runs',
  siteRuns: 'scrape_obs_site_runs',
  errors: 'scrape_obs_errors',
} as const;

export type ScrapeObsCollectionName =
  (typeof SCRAPE_OBS_COLLECTIONS)[keyof typeof SCRAPE_OBS_COLLECTIONS];

/** Which scraper subsystem produced the record. `ecommerce` is the 8-retailer pipeline. */
export type ScrapeObsSubsystem = 'ecommerce' | 'shopping' | 'dining' | 'grocery';

export type ScrapeObsRunStatus = 'running' | 'complete' | 'partial' | 'failed' | 'stopped';
export type ScrapeObsTrigger = 'cron' | 'manual' | 'demo';

/** Lifecycle stage an error occurred in (useful for debugging/filtering). */
export type ScrapeObsErrorStage =
  | 'collect_links'
  | 'fetch'
  | 'parse'
  | 'scrape'
  | 'save'
  | 'push'
  | 'query'
  | 'site'
  | 'run'
  | 'fatal';

export type ScrapeObsSeverity = 'error' | 'warning';

export interface ScrapeObsRunTotals {
  queriesPlanned: number;
  queriesCompleted: number;
  queriesFailed: number;
  productsScraped: number;
  productsFailed: number;
  bundles: number;
  mongoInserted: number;
  mongoUpdated: number;
  staleMarked: number;
  errorCount: number;
}

export function emptyRunTotals(): ScrapeObsRunTotals {
  return {
    queriesPlanned: 0,
    queriesCompleted: 0,
    queriesFailed: 0,
    productsScraped: 0,
    productsFailed: 0,
    bundles: 0,
    mongoInserted: 0,
    mongoUpdated: 0,
    staleMarked: 0,
    errorCount: 0,
  };
}

export interface ScrapeObsRun {
  runId: string;
  subsystem: ScrapeObsSubsystem;
  trigger: ScrapeObsTrigger;
  status: ScrapeObsRunStatus;
  startedAt: Date;
  finishedAt?: Date;
  durationMs?: number;
  resumed: boolean;
  totals: ScrapeObsRunTotals;
  sites: string[];
  host?: string;
  pid?: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface ScrapeObsSiteRun {
  runId: string;
  subsystem: ScrapeObsSubsystem;
  site: string;
  status: string;
  scraped: number;
  failed: number;
  skipped: number;
  links: number;
  queriesCovered: number;
  lastReason?: string;
  startedAt: Date;
  updatedAt: Date;
}

export interface ScrapeObsError {
  /** Stable key used to upsert per-URL errors so resumed runs do not duplicate them. */
  errorKey?: string;
  runId?: string;
  subsystem: ScrapeObsSubsystem;
  site?: string;
  stage: ScrapeObsErrorStage;
  code: string;
  message: string;
  url?: string;
  severity: ScrapeObsSeverity;
  context?: Record<string, unknown>;
  createdAt: Date;
  updatedAt?: Date;
}

export interface ScrapeObsCollections {
  runs: Collection<ScrapeObsRun>;
  siteRuns: Collection<ScrapeObsSiteRun>;
  errors: Collection<ScrapeObsError>;
}

export function getScrapeObsCollections(db: Db): ScrapeObsCollections {
  return {
    runs: db.collection<ScrapeObsRun>(SCRAPE_OBS_COLLECTIONS.runs),
    siteRuns: db.collection<ScrapeObsSiteRun>(SCRAPE_OBS_COLLECTIONS.siteRuns),
    errors: db.collection<ScrapeObsError>(SCRAPE_OBS_COLLECTIONS.errors),
  };
}

export async function getScrapeObsCollectionsFromEnv(): Promise<ScrapeObsCollections> {
  return getScrapeObsCollections(await getMongoDb());
}

// ─── Indexes ─────────────────────────────────────────────────────────────────

const HAS_STRING = { $type: 'string' };

export const SCRAPE_OBS_INDEXES: Record<ScrapeObsCollectionName, IndexDescription[]> = {
  scrape_obs_runs: [
    { name: 'uniq_runId', key: { runId: 1 }, unique: true },
    { name: 'subsystem_startedAt', key: { subsystem: 1, startedAt: -1 } },
    { name: 'status_startedAt', key: { status: 1, startedAt: -1 } },
    { name: 'trigger_startedAt', key: { trigger: 1, startedAt: -1 } },
    { name: 'startedAt', key: { startedAt: -1 } },
  ],
  scrape_obs_site_runs: [
    { name: 'uniq_runId_site', key: { runId: 1, site: 1 }, unique: true },
    { name: 'subsystem_site_updatedAt', key: { subsystem: 1, site: 1, updatedAt: -1 } },
    { name: 'runId', key: { runId: 1 } },
  ],
  scrape_obs_errors: [
    // Per-URL errors upsert on this stable key so a resumed run does not duplicate them.
    { name: 'uniq_errorKey', key: { errorKey: 1 }, unique: true, partialFilterExpression: { errorKey: HAS_STRING } },
    { name: 'runId_createdAt', key: { runId: 1, createdAt: -1 } },
    { name: 'subsystem_createdAt', key: { subsystem: 1, createdAt: -1 } },
    { name: 'site_createdAt', key: { site: 1, createdAt: -1 } },
    { name: 'stage_createdAt', key: { stage: 1, createdAt: -1 } },
    { name: 'severity_createdAt', key: { severity: 1, createdAt: -1 } },
    { name: 'createdAt', key: { createdAt: -1 } },
  ],
};

export interface EnsureScrapeObsIndexesResult {
  collection: ScrapeObsCollectionName;
  indexes: string[];
}

/**
 * Idempotent. Re-running with unchanged definitions is a no-op; a changed definition
 * under an existing name fails loudly (IndexOptionsConflict) rather than silently replacing.
 */
export async function ensureScrapeObsIndexes(db: Db): Promise<EnsureScrapeObsIndexesResult[]> {
  const results: EnsureScrapeObsIndexesResult[] = [];
  for (const [collection, specs] of Object.entries(SCRAPE_OBS_INDEXES) as Array<
    [ScrapeObsCollectionName, IndexDescription[]]
  >) {
    const indexes = await db.collection(collection).createIndexes(specs);
    results.push({ collection, indexes });
  }
  return results;
}
