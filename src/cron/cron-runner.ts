import * as fs from 'fs';
import * as path from 'path';
import axios from 'axios';
import { scrapeBulk, closeBrowser, withoutEmbeddings, BundledBulkResult, SiteOutcome } from '../services/playwright.service';
import { pushToDatabase, markStaleOffers, PushResult } from './push-pipeline';
import { QUERIES, queryKey, QueryPlan } from '../../scrape-master';
import { BundledProduct } from '../parsers/types';
import { acquireLock, releaseLock, shouldStop, clearStopSignal } from '../utils/stop-signal';
import { SCRAPER_API_KEY_HEADER } from '../utils/api-key';
import { isResumeStateFresh, resumeMaxAgeMs } from '../services/checkpoint.service';

const PARALLEL_QUERIES = Math.max(1, parseInt(process.env.PARALLEL_QUERIES || '3', 10));

export interface CronState {
  startedAt: string;
  completedQueries: string[];   // queryKey() of each finished query
  allBundles: BundledProduct[];
  totalRawScraped: number;
  totalErrors: number;
  failedQueries: string[];      // labels of queries where no site produced data
  /** "<site>: <status> — <reason>" for every site that did not complete, deduplicated */
  siteIssues: string[];
}

export type RunStatus = 'complete' | 'partial' | 'stopped' | 'failed';

export interface RunSummary {
  status: RunStatus;
  bundles: number;
  push?: PushResult;
  staleMarked?: number;
  failedQueries: string[];
  siteIssues: string[];
}

function freshState(): CronState {
  return { startedAt: new Date().toISOString(), completedQueries: [], allBundles: [], totalRawScraped: 0, totalErrors: 0, failedQueries: [], siteIssues: [] };
}

export interface CronDeps {
  queries: QueryPlan[];
  scrapeBulk: (options: Parameters<typeof scrapeBulk>[0]) => Promise<BundledBulkResult>;
  pushToDatabase: (bundles: BundledProduct[]) => Promise<PushResult>;
  markStaleOffers: () => Promise<number>;
  reportStatus: (success: boolean, productCount: number, errorCount: number, responseTimeMs: number, error?: string) => Promise<void>;
  shouldStop: () => boolean;
  clearStopSignal: () => void;
  acquireLock: () => boolean;
  releaseLock: () => void;
  closeBrowser: () => Promise<void>;
  stateFile: string;
  cooldownMs: number;
}

export function loadCronState(stateFile: string, now: Date = new Date()): CronState {
  if (fs.existsSync(stateFile)) {
    try {
      const state: CronState = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      // A resume state older than the window is from a previous day's run — its prices are stale
      if (isResumeStateFresh(state.startedAt, resumeMaxAgeMs(), now)) {
        return { ...freshState(), ...state, failedQueries: state.failedQueries ?? [], siteIssues: state.siteIssues ?? [] };
      }
      console.warn(`[cron] Discarding resume state from ${state.startedAt} — older than ${resumeMaxAgeMs() / 3600000}h.`);
    } catch {}
  }
  return freshState();
}

function saveCronState(stateFile: string, state: CronState): void {
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  // Embeddings are dropped on disk; pushToDatabase re-embeds bundles that lack one after a resume
  fs.writeFileSync(stateFile, JSON.stringify({ ...state, allBundles: withoutEmbeddings(state.allBundles) }));
}

function describeIssue(o: SiteOutcome): string {
  return `${o.site}: ${o.status}${o.reason ? ` — ${o.reason}` : ''}`;
}

async function reportStatus(success: boolean, productCount: number, errorCount: number, responseTimeMs: number, error?: string): Promise<void> {
  const beUrl = process.env.PEPPY_BE_URL;
  if (!beUrl) return;

  const apiKey = process.env.SCRAPER_API_KEY;
  try {
    await axios.post(`${beUrl}/api/v1/admin/scraper/status`, {
      source: 'cron',
      success,
      responseTime: responseTimeMs,
      productCount,
      ...(error ? { error } : {}),
    }, { timeout: 10000, headers: apiKey ? { [SCRAPER_API_KEY_HEADER]: apiKey } : {} });
    console.log(`[cron] Status reported to peppy-be (success=${success}, products=${productCount})`);
  } catch (e: any) {
    console.warn(`[cron] Failed to report status to peppy-be: ${e.message}`);
  }
}

export const defaultCronDeps: CronDeps = {
  queries: QUERIES,
  // Sites without an authorized source (Noon) are reported per query, not silently skipped
  scrapeBulk: options => scrapeBulk({ ...options, allowUnsupported: true }),
  pushToDatabase: bundles => pushToDatabase(bundles),
  markStaleOffers: () => markStaleOffers(),
  reportStatus,
  shouldStop,
  clearStopSignal,
  acquireLock: () => acquireLock('full'),
  releaseLock,
  closeBrowser: () => closeBrowser(),
  get stateFile() { return path.join(process.cwd(), 'output', 'cron_state.json'); },
  cooldownMs: 15000,
};

export async function runFullPipeline(deps: CronDeps = defaultCronDeps): Promise<RunSummary | undefined> {
  if (!deps.acquireLock()) return undefined;

  const pipelineStart = Date.now();
  const state = loadCronState(deps.stateFile);
  const isResume = state.completedQueries.length > 0;

  console.log(`\n[cron] ══════════════════════════════════════════════════`);
  console.log(`[cron] Pipeline started at ${new Date().toISOString()}`);
  if (isResume) {
    console.log(`[cron] Resuming — ${state.completedQueries.length}/${deps.queries.length} queries done, ${state.allBundles.length} bundles so far.`);
  } else {
    console.log(`[cron] Fresh run — ${deps.queries.length} queries planned.`);
  }
  console.log(`[cron] ══════════════════════════════════════════════════\n`);

  let fatalError: string | undefined;
  let stopped = false;
  let summary: RunSummary | undefined;

  try {
    const pending = deps.queries.filter(q => !state.completedQueries.includes(queryKey(q)));
    console.log(`[cron] ${pending.length} queries to run (${PARALLEL_QUERIES} parallel)\n`);

    for (let i = 0; i < pending.length; i += PARALLEL_QUERIES) {
      if (deps.shouldStop()) {
        stopped = true;
        break;
      }

      const batch = pending.slice(i, i + PARALLEL_QUERIES);
      const batchNum = Math.floor(i / PARALLEL_QUERIES) + 1;
      const totalBatches = Math.ceil(pending.length / PARALLEL_QUERIES);
      console.log(`\n[cron] ── Batch ${batchNum}/${totalBatches}: ${batch.map(q => q.label).join(' | ')} ──`);

      const outcomes = await Promise.allSettled(
        batch.map(query => deps.scrapeBulk({
          sites: query.sites,
          category: query.category,
          categoryKey: query.categoryKey,
          broadCategory: query.broadCategory,
          subCategory: query.subCategory,
          count: query.count,
        }))
      );

      for (let j = 0; j < batch.length; j++) {
        const query = batch[j];
        const outcome = outcomes[j];
        if (outcome.status === 'rejected') {
          console.error(`[cron] "${query.label}" FAILED: ${outcome.reason?.message}`);
          state.totalErrors++;
          if (!state.failedQueries.includes(query.label)) state.failedQueries.push(query.label);
          continue;
        }
        const result = outcome.value;
        for (const o of result.siteResults) {
          if (o.status !== 'complete' && o.status !== 'stopped' && !state.siteIssues.includes(describeIssue(o))) {
            state.siteIssues.push(describeIssue(o));
          }
        }
        if (result.status === 'stopped') {
          // Not completed: the query's checkpoint is kept and it resumes on the next run
          stopped = true;
          console.log(`[cron] "${query.label}" interrupted — will resume.`);
        } else if (result.status === 'failed') {
          console.error(`[cron] "${query.label}" FAILED — no site produced data.`);
          state.totalErrors++;
          if (!state.failedQueries.includes(query.label)) state.failedQueries.push(query.label);
        } else {
          state.allBundles.push(...result.bundles);
          state.totalRawScraped += result.totalScraped;
          state.totalErrors += result.errors.length;
          state.completedQueries.push(queryKey(query));
          console.log(`[cron] "${query.label}" ${result.status} — ${result.bundleCount} bundles.`);
        }
      }
      saveCronState(deps.stateFile, state);

      if (stopped || deps.shouldStop()) {
        stopped = true;
        break;
      }
      if (i + PARALLEL_QUERIES < pending.length && deps.cooldownMs > 0) {
        console.log(`[cron] Cooling down ${deps.cooldownMs / 1000}s before next batch...`);
        await new Promise(r => setTimeout(r, deps.cooldownMs));
      }
    }

    if (stopped) {
      // An interrupted run publishes nothing: the bundles so far stay in the resume state (valid for
      // the resume window), stale-offer expiry does not run, and the run is not reported as a success.
      deps.clearStopSignal();
      saveCronState(deps.stateFile, state);
      console.log(`[cron] ⛔ Stopped — ${state.completedQueries.length}/${deps.queries.length} queries kept for resume. Nothing pushed.`);
      summary = { status: 'stopped', bundles: state.allBundles.length, failedQueries: state.failedQueries, siteIssues: state.siteIssues };
      await deps.reportStatus(false, 0, state.totalErrors, Date.now() - pipelineStart,
        `Stopped before completion (${state.completedQueries.length}/${deps.queries.length} queries); resumable, nothing published`);
      return summary;
    }

    console.log(`\n[cron] All queries attempted. Pushing ${state.allBundles.length} bundles to DB...`);
    const pushResult = await deps.pushToDatabase(state.allBundles);
    console.log(`[cron] Push complete — MongoDB: ${pushResult.mongoInserted} new, ${pushResult.mongoUpdated} updated | ChromaDB: ${pushResult.chromaVectors}`);
    if (pushResult.errors.length > 0) {
      console.warn(`[cron] Push errors: ${pushResult.errors.join('; ')}`);
    }

    // Offers no run has re-observed lose their price claim (stale → unknown, out of the price range)
    const staleCount = await deps.markStaleOffers();
    console.log(`[cron] Marked ${staleCount} stale offer(s).`);

    // The bundles are published — the next run starts fresh
    try { fs.unlinkSync(deps.stateFile); } catch {}

    const status: RunStatus = state.failedQueries.length === 0 && state.siteIssues.length === 0 && pushResult.errors.length === 0
      ? 'complete'
      : 'partial';
    summary = { status, bundles: state.allBundles.length, push: pushResult, staleMarked: staleCount, failedQueries: state.failedQueries, siteIssues: state.siteIssues };

    const elapsed = Date.now() - pipelineStart;
    console.log(`\n[cron] ══════════════════════════════════════════════════`);
    console.log(`[cron] Pipeline ${status} in ${Math.round(elapsed / 1000)}s`);
    console.log(`[cron] Bundles: ${state.allBundles.length} | Raw: ${state.totalRawScraped} | Errors: ${state.totalErrors}`);
    for (const issue of state.siteIssues) console.log(`[cron]   site issue — ${issue}`);
    if (state.failedQueries.length) console.log(`[cron]   failed queries — ${state.failedQueries.join(', ')}`);
    console.log(`[cron] ══════════════════════════════════════════════════\n`);

    const problems = [
      ...state.siteIssues,
      ...(state.failedQueries.length ? [`failed queries: ${state.failedQueries.join(', ')}`] : []),
      ...pushResult.errors,
    ];
    await deps.reportStatus(status === 'complete', pushResult.mongoInserted + pushResult.mongoUpdated, state.totalErrors, elapsed,
      problems.length ? `Partial run: ${problems.join('; ').slice(0, 1000)}` : undefined);
  } catch (e: any) {
    fatalError = e.message;
    console.error(`[cron] Pipeline fatal error: ${e.message}`);
    await deps.reportStatus(false, 0, state.totalErrors, Date.now() - pipelineStart, e.message);
  } finally {
    await deps.closeBrowser().catch(() => {});
    deps.releaseLock();
  }

  if (fatalError) throw new Error(fatalError);
  return summary;
}
