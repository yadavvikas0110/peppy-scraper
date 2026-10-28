import * as fs from 'fs';
import * as path from 'path';
import axios from 'axios';
import { scrapeBulk, closeBrowser, withoutEmbeddings } from '../services/playwright.service';
import { pushToDatabase, markStaleOffers } from './push-pipeline';
import { QUERIES, queryKey } from '../../scrape-master';
import { BundledProduct } from '../parsers/types';
import { acquireLock, releaseLock, shouldStop, clearStopSignal } from '../utils/stop-signal';
import { SCRAPER_API_KEY_HEADER } from '../utils/api-key';

const STATE_FILE = path.join(process.cwd(), 'output', 'cron_state.json');

const PARALLEL_QUERIES = Math.max(1, parseInt(process.env.PARALLEL_QUERIES || '3', 10));

// A resume state older than this is from a previous day's crashed run — its prices are stale
const STATE_MAX_AGE_MS = Math.max(1, parseFloat(process.env.CRON_STATE_MAX_AGE_HOURS || '20')) * 3600 * 1000;

interface CronState {
  startedAt: string;
  completedQueries: string[];   // queryKey() of each finished query
  allBundles: BundledProduct[];
  totalRawScraped: number;
  totalErrors: number;
}

function freshState(): CronState {
  return { startedAt: new Date().toISOString(), completedQueries: [], allBundles: [], totalRawScraped: 0, totalErrors: 0 };
}

function loadCronState(): CronState {
  if (fs.existsSync(STATE_FILE)) {
    try {
      const state: CronState = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      const age = Date.now() - new Date(state.startedAt).getTime();
      if (age >= 0 && age < STATE_MAX_AGE_MS) return state;
      console.warn(`[cron] Discarding resume state from ${state.startedAt} — older than ${STATE_MAX_AGE_MS / 3600000}h.`);
    } catch {}
  }
  return freshState();
}

function saveCronState(state: CronState): void {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  // Embeddings are dropped on disk; pushToDatabase re-embeds bundles that lack one after a resume
  fs.writeFileSync(STATE_FILE, JSON.stringify({ ...state, allBundles: withoutEmbeddings(state.allBundles) }));
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

export async function runFullPipeline(): Promise<void> {
  if (!acquireLock('full')) return;

  const pipelineStart = Date.now();
  const state = loadCronState();
  const isResume = state.completedQueries.length > 0;

  console.log(`\n[cron] ══════════════════════════════════════════════════`);
  console.log(`[cron] Pipeline started at ${new Date().toISOString()}`);
  if (isResume) {
    console.log(`[cron] Resuming — ${state.completedQueries.length}/${QUERIES.length} queries done, ${state.allBundles.length} bundles so far.`);
  } else {
    console.log(`[cron] Fresh run — ${QUERIES.length} queries planned.`);
  }
  console.log(`[cron] ══════════════════════════════════════════════════\n`);

  let fatalError: string | undefined;
  let stopped = false;

  try {
    const pending = QUERIES.filter(q => !state.completedQueries.includes(queryKey(q)));
    console.log(`[cron] ${pending.length} queries to run (${PARALLEL_QUERIES} parallel)\n`);

    for (let i = 0; i < pending.length; i += PARALLEL_QUERIES) {
      if (shouldStop()) {
        clearStopSignal();
        stopped = true;
        console.log('[cron] ⛔ Stop signal received — aborting pipeline.');
        break;
      }

      const batch = pending.slice(i, i + PARALLEL_QUERIES);
      const batchNum = Math.floor(i / PARALLEL_QUERIES) + 1;
      const totalBatches = Math.ceil(pending.length / PARALLEL_QUERIES);
      console.log(`\n[cron] ── Batch ${batchNum}/${totalBatches}: ${batch.map(q => q.label).join(' | ')} ──`);

      const outcomes = await Promise.allSettled(
        batch.map(query => scrapeBulk({
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
        if (outcome.status === 'fulfilled') {
          const result = outcome.value;
          state.allBundles.push(...result.bundles);
          state.totalRawScraped += result.totalScraped;
          state.totalErrors += result.errors.length;
          state.completedQueries.push(queryKey(query));
          console.log(`[cron] "${query.label}" done — ${result.bundleCount} bundles.`);
        } else {
          console.error(`[cron] "${query.label}" FAILED: ${outcome.reason?.message}`);
          state.totalErrors++;
        }
      }
      saveCronState(state);

      if (i + PARALLEL_QUERIES < pending.length && !shouldStop()) {
        const cooldown = 15000;
        console.log(`[cron] Cooling down ${cooldown / 1000}s before next batch...`);
        await new Promise(r => setTimeout(r, cooldown));
      }
    }

    console.log(`\n[cron] All queries done. Pushing ${state.allBundles.length} bundles to DB...`);
    const pushResult = await pushToDatabase(state.allBundles);
    console.log(`[cron] Push complete — MongoDB: ${pushResult.mongoInserted} new, ${pushResult.mongoUpdated} updated | ChromaDB: ${pushResult.chromaVectors}`);
    if (pushResult.errors.length > 0) {
      console.warn(`[cron] Push errors: ${pushResult.errors.join('; ')}`);
    }

    // Only a complete run has seen every offer it would refresh — a stopped run must not expire offers
    if (!stopped) {
      const staleCount = await markStaleOffers();
      console.log(`[cron] Marked ${staleCount} stale offer(s) out of stock.`);
    }

    // Clear cron state on success so next run is fresh
    try { fs.unlinkSync(STATE_FILE); } catch {}

    const elapsed = Date.now() - pipelineStart;
    console.log(`\n[cron] ══════════════════════════════════════════════════`);
    console.log(`[cron] Pipeline complete in ${Math.round(elapsed / 1000)}s`);
    console.log(`[cron] Bundles: ${state.allBundles.length} | Raw: ${state.totalRawScraped} | Errors: ${state.totalErrors}`);
    console.log(`[cron] ══════════════════════════════════════════════════\n`);

    await reportStatus(true, pushResult.mongoInserted + pushResult.mongoUpdated, state.totalErrors, elapsed);
  } catch (e: any) {
    fatalError = e.message;
    console.error(`[cron] Pipeline fatal error: ${e.message}`);
    await reportStatus(false, 0, state.totalErrors, Date.now() - pipelineStart, e.message);
  } finally {
    await closeBrowser().catch(() => {});
    releaseLock();
  }

  if (fatalError) throw new Error(fatalError);
}
