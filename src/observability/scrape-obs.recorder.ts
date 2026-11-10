import * as os from 'os';
import { getMongoDb } from '../shared/db/mongo';
import {
  ensureScrapeObsIndexes,
  getScrapeObsCollections,
  ScrapeObsRunStatus,
  ScrapeObsRunTotals,
  ScrapeObsSubsystem,
  ScrapeObsTrigger,
} from './scrape-obs.collections';
import {
  createScrapeObsRepository,
  RecordErrorInput,
  ScrapeObsRepository,
  SiteOutcomeInput,
} from './scrape-obs.repository';

/*
 * Pipeline-facing facade. Every method is best-effort: observability must NEVER
 * break or slow a scrape run, so all DB access is wrapped and failures are logged
 * and swallowed. A null runId (recording disabled, or startRun failed) makes every
 * later call a no-op.
 */

export interface StartRunInput {
  trigger: ScrapeObsTrigger;
  resumed: boolean;
  queriesPlanned: number;
}

export interface ScrapeObsRecorder {
  readonly enabled: boolean;
  startRun(input: StartRunInput): Promise<string | null>;
  recordSiteOutcome(runId: string | null, outcome: SiteOutcomeInput): Promise<void>;
  recordError(runId: string | null, input: RecordErrorInput): Promise<void>;
  updateProgress(
    runId: string | null,
    totals: Partial<ScrapeObsRunTotals>,
    sites?: string[],
  ): Promise<void>;
  finishRun(
    runId: string | null,
    status: Exclude<ScrapeObsRunStatus, 'running'>,
    totals?: Partial<ScrapeObsRunTotals>,
    sites?: string[],
  ): Promise<void>;
}

export const noopScrapeObsRecorder: ScrapeObsRecorder = {
  enabled: false,
  async startRun() {
    return null;
  },
  async recordSiteOutcome() {},
  async recordError() {},
  async updateProgress() {},
  async finishRun() {},
};

export interface InMemoryScrapeObsRecorder extends ScrapeObsRecorder {
  readonly runs: Array<{ runId: string; status: string; totals: Partial<ScrapeObsRunTotals> }>;
  readonly siteOutcomes: Array<{ runId: string | null; outcome: SiteOutcomeInput }>;
  readonly errors: Array<{ runId: string | null; input: RecordErrorInput }>;
}

/** For tests: records everything in memory, never touches a database. */
export function createInMemoryScrapeObsRecorder(): InMemoryScrapeObsRecorder {
  const runs: InMemoryScrapeObsRecorder['runs'] = [];
  const siteOutcomes: InMemoryScrapeObsRecorder['siteOutcomes'] = [];
  const errors: InMemoryScrapeObsRecorder['errors'] = [];
  let counter = 0;
  return {
    enabled: true,
    runs,
    siteOutcomes,
    errors,
    async startRun() {
      const runId = `mem_run_${++counter}`;
      runs.push({ runId, status: 'running', totals: {} });
      return runId;
    },
    async recordSiteOutcome(runId, outcome) {
      siteOutcomes.push({ runId, outcome });
    },
    async recordError(runId, input) {
      errors.push({ runId, input });
    },
    async updateProgress(runId, totals) {
      const run = runs.find((r) => r.runId === runId);
      if (run) run.totals = { ...run.totals, ...totals };
    },
    async finishRun(runId, status, totals) {
      const run = runs.find((r) => r.runId === runId);
      if (run) {
        run.status = status;
        run.totals = { ...run.totals, ...(totals ?? {}) };
      }
    },
  };
}

interface MongoRecorderDeps {
  subsystem?: ScrapeObsSubsystem;
  getRepository?: () => Promise<ScrapeObsRepository>;
  logger?: Pick<Console, 'warn'>;
}

function warnOnce(logger: Pick<Console, 'warn'>, message: string): void {
  logger.warn(`[scrape-obs] ${message}`);
}

export function createMongoScrapeObsRecorder(deps: MongoRecorderDeps = {}): ScrapeObsRecorder {
  const subsystem = deps.subsystem ?? 'ecommerce';
  const logger = deps.logger ?? console;
  let repoPromise: Promise<ScrapeObsRepository> | null = null;

  const defaultGetRepository = async (): Promise<ScrapeObsRepository> => {
    const db = await getMongoDb();
    // Idempotent; only runs once per process because repoPromise is memoized below.
    await ensureScrapeObsIndexes(db).catch(() => {});
    return createScrapeObsRepository(getScrapeObsCollections(db), subsystem);
  };

  async function repository(): Promise<ScrapeObsRepository | null> {
    if (!repoPromise) {
      repoPromise = (deps.getRepository ?? defaultGetRepository)().catch((err) => {
        // Reset so a transient failure can be retried on the next call.
        repoPromise = null;
        throw err;
      });
    }
    try {
      return await repoPromise;
    } catch (err: any) {
      warnOnce(logger, `disabled for now — ${err?.message ?? err}`);
      return null;
    }
  }

  return {
    enabled: true,

    async startRun(input) {
      try {
        const repo = await repository();
        if (!repo) return null;
        return await repo.createRun({
          trigger: input.trigger,
          resumed: input.resumed,
          queriesPlanned: input.queriesPlanned,
          host: os.hostname(),
          pid: process.pid,
        });
      } catch (err: any) {
        warnOnce(logger, `startRun failed — ${err?.message ?? err}`);
        return null;
      }
    },

    async recordSiteOutcome(runId, outcome) {
      if (!runId) return;
      try {
        const repo = await repository();
        await repo?.upsertSiteRun(runId, outcome);
      } catch (err: any) {
        warnOnce(logger, `recordSiteOutcome failed — ${err?.message ?? err}`);
      }
    },

    async recordError(runId, input) {
      try {
        const repo = await repository();
        await repo?.recordError(runId ?? undefined, input);
      } catch (err: any) {
        warnOnce(logger, `recordError failed — ${err?.message ?? err}`);
      }
    },

    async updateProgress(runId, totals, sites) {
      if (!runId) return;
      try {
        const repo = await repository();
        await repo?.updateRunProgress(runId, totals, sites);
      } catch (err: any) {
        warnOnce(logger, `updateProgress failed — ${err?.message ?? err}`);
      }
    },

    async finishRun(runId, status, totals, sites) {
      if (!runId) return;
      try {
        const repo = await repository();
        await repo?.finishRun(runId, { status, totals, sites });
      } catch (err: any) {
        warnOnce(logger, `finishRun failed — ${err?.message ?? err}`);
      }
    },
  };
}

/**
 * Observability is ON by default. Set ENABLE_SCRAPE_OBS=false to fully disable
 * (fast rollback). It also no-ops safely if MONGODB_URI is unset or the DB is
 * unreachable — recording never blocks a scrape run.
 */
export function getScrapeObsRecorder(
  env: NodeJS.ProcessEnv = process.env,
  subsystem: ScrapeObsSubsystem = 'ecommerce',
): ScrapeObsRecorder {
  if (env.ENABLE_SCRAPE_OBS === 'false') return noopScrapeObsRecorder;
  return createMongoScrapeObsRecorder({ subsystem });
}
