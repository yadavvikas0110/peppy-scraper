import { Collection, ObjectId } from 'mongodb';
import { DINING_LOCALES, DiningLocale } from '../dining.types';
import { DiningScrapeContext, isDiningScrapeError, runDiningScrape } from '../dining.service';
import { getDiningPlatformModule } from '../platforms/platform.registry';
import { estimateScrapeDoCredits } from '../cron/dining-cron.targets';
import type { ImportLocaleResult, ImportQueueItem } from './bulk.types';
import { stripUndefined } from '../dining.object';

/*
 * Imports the queued restaurants of one batch through the normal scrape pipeline (the same runDiningScrape the cron and the
 * API use), English then Arabic per restaurant: restaurant, categories, items, images and the offers on the page.
 * Cross-platform linking is NOT done here (it is a separate batch step), so a slow link never holds up the scraping.
 *
 *   - hard credit budget (maxCredits) and a floor of credits that is never spent (reserveCredits)
 *   - stops on Scrape.do quota/auth/config errors (continuing would only fail again) and after repeated failures
 *   - resumable: an entry keeps what each locale achieved, a rerun only does what is missing
 */

export interface BulkRunOptions {
  batchId: string;
  concurrency: number;
  maxCredits: number;
  reserveCredits: number;
  // Stop after this many restaurants (handy for a first small run).
  limit?: number;
  maxConsecutiveFailures?: number;
  // An entry "running" for longer than this was abandoned by a crashed run and is queued again.
  staleRunningMs?: number;
}

export interface BulkRunSummary {
  attempted: number;
  imported: number;
  partial: number;
  failed: number;
  creditsUsed: number;
  remainingCredits?: number;
  stoppedReason?: string;
  durationMs: number;
}

export interface BulkRunDeps {
  queue: Collection<ImportQueueItem>;
  scrapeContext: DiningScrapeContext;
  logger?: Pick<Console, 'log' | 'warn'>;
  now?: () => Date;
}

const HARD_STOP_CODES = new Set(['SCRAPE_DO_QUOTA', 'SCRAPE_DO_AUTH', 'SCRAPE_DO_CONFIG']);

export async function runBulkImport(deps: BulkRunDeps, options: BulkRunOptions): Promise<BulkRunSummary> {
  const { queue } = deps;
  const logger = deps.logger ?? console;
  const now = deps.now ?? (() => new Date());
  const started = Date.now();
  const summary: BulkRunSummary = { attempted: 0, imported: 0, partial: 0, failed: 0, creditsUsed: 0, durationMs: 0 };
  const maxConsecutiveFailures = options.maxConsecutiveFailures ?? 5;
  let consecutiveFailures = 0;
  let inFlightEstimate = 0;
  let stopped: string | undefined;

  // Entries abandoned by a crashed earlier run go back to the queue.
  await queue.updateMany(
    { batchId: options.batchId, status: 'running', updatedAt: { $lt: new Date(now().getTime() - (options.staleRunningMs ?? 20 * 60_000)) } },
    { $set: { status: 'queued', updatedAt: now() } }
  );

  const total = await queue.countDocuments({ batchId: options.batchId, status: 'queued' });
  const target = options.limit ? Math.min(options.limit, total) : total;
  logger.log(`[bulk] batch ${options.batchId}: ${total} queued, importing ${target} (budget ${options.maxCredits} credits, reserve ${options.reserveCredits}, concurrency ${options.concurrency})`);

  const estimateFor = (platform: ImportQueueItem['platform']): number => {
    const adapter = getDiningPlatformModule(platform)?.adapter;
    return adapter ? DINING_LOCALES.length * estimateScrapeDoCredits(adapter.getFetchOptions('', 'en')) : 2;
  };

  async function claimNext(): Promise<ImportQueueItem | null> {
    if (stopped) return null;
    if (options.limit && summary.attempted >= options.limit) return null;
    const next = await queue.findOne({ batchId: options.batchId, status: 'queued' }, { sort: { priority: 1, ratingCount: -1, _id: 1 } });
    if (!next) return null;
    const estimate = estimateFor(next.platform);
    if (summary.creditsUsed + inFlightEstimate + estimate > options.maxCredits) {
      stopped = `BUDGET_REACHED (${summary.creditsUsed} of ${options.maxCredits} credits)`;
      return null;
    }
    if (summary.remainingCredits !== undefined && summary.remainingCredits - inFlightEstimate - estimate < options.reserveCredits) {
      stopped = `CREDIT_RESERVE (${summary.remainingCredits} left, reserve ${options.reserveCredits})`;
      return null;
    }
    const claimed = await queue.findOneAndUpdate(
      { _id: next._id, status: 'queued' },
      { $set: { status: 'running', updatedAt: now() }, $inc: { attempts: 1 } },
      { returnDocument: 'after' }
    );
    if (!claimed) return claimNext();
    inFlightEstimate += estimate;
    summary.attempted++;
    return claimed;
  }

  async function importEntry(entry: ImportQueueItem): Promise<void> {
    const module = getDiningPlatformModule(entry.platform);
    const estimate = estimateFor(entry.platform);
    const locales: ImportQueueItem['locales'] = { ...entry.locales };
    let credits = 0;
    let restaurantId = entry.restaurantId;
    let platformIdSeen: string | undefined;
    let lastError: string | undefined;
    const t0 = Date.now();

    if (!module) {
      lastError = 'UNSUPPORTED_PLATFORM';
    } else {
      for (const locale of DINING_LOCALES as readonly DiningLocale[]) {
        if (locales[locale]?.status === 'succeeded' || locales[locale]?.status === 'partial') continue;
        // The Arabic page must be the same restaurant the English page was.
        const expected = platformIdSeen ? { platformRestaurantId: platformIdSeen, sourceKey: '' } : undefined;
        try {
          const result = await runDiningScrape(
            { platform: entry.platform, locale, targetUrl: module.adapter.toLocaleUrl(entry.url, locale), dryRun: false },
            { ...deps.scrapeContext, expectedRestaurant: expected }
          );
          const cost = result.fetch.requestCost ?? 0;
          credits += cost;
          summary.creditsUsed += cost;
          if (result.fetch.remainingCredits !== undefined) summary.remainingCredits = result.fetch.remainingCredits;
          platformIdSeen ??= result.source.platformRestaurantId;
          locales[locale] = { status: result.status, runId: result.runId, itemsSeen: result.counts.itemsSeen, credits: cost } as ImportLocaleResult;
          if (result.restaurantId) restaurantId = toObjectId(result.restaurantId);
        } catch (err) {
          const code = isDiningScrapeError(err) ? err.code : 'UNEXPECTED';
          lastError = `${locale}: ${code}${isDiningScrapeError(err) ? ` (${err.stage})` : ''} ${String((err as Error)?.message ?? err).slice(0, 160)}`;
          locales[locale] = { status: 'failed', error: lastError };
          if (isDiningScrapeError(err) && HARD_STOP_CODES.has(code)) stopped = `${code}: ${err.message}`;
          break; // no point fetching the Arabic page of a restaurant whose English page failed
        }
      }
    }

    const en = locales.en?.status;
    const ar = locales.ar?.status;
    const status: ImportQueueItem['status'] = en && en !== 'failed' && ar && ar !== 'failed' ? (en === 'partial' || ar === 'partial' ? 'partial' : 'imported') : en && en !== 'failed' ? 'partial' : 'failed';
    const idMismatch = platformIdSeen && platformIdSeen !== entry.platformRestaurantId ? `the page reports id ${platformIdSeen}, not ${entry.platformRestaurantId}` : undefined;
    await queue.updateOne(
      { _id: entry._id },
      {
        $set: stripUndefined({ status, locales, restaurantId, lastError: lastError ?? idMismatch, updatedAt: now() }),
        $inc: { creditsUsed: credits },
        ...(lastError || idMismatch ? {} : { $unset: { lastError: '' as const } }),
      }
    );
    inFlightEstimate -= estimate;

    if (status === 'imported') {
      summary.imported++;
      consecutiveFailures = 0;
    } else if (status === 'partial') {
      summary.partial++;
      consecutiveFailures = 0;
    } else {
      summary.failed++;
      if (++consecutiveFailures >= maxConsecutiveFailures) stopped = `TOO_MANY_CONSECUTIVE_FAILURES (${consecutiveFailures})`;
    }
    logger.log(
      `[bulk] ${String(summary.attempted).padStart(3)}/${target} ${entry.platform} ${entry.platformRestaurantId} "${entry.name.slice(0, 40)}" -> ${status}` +
        ` | en ${locales.en?.status ?? '-'} ${locales.en?.itemsSeen ?? ''} | ar ${locales.ar?.status ?? '-'} ${locales.ar?.itemsSeen ?? ''}` +
        ` | ${credits} credits, ${((Date.now() - t0) / 1000).toFixed(0)}s${lastError ? ` | ${lastError}` : ''}${idMismatch ? ` | ${idMismatch}` : ''}`
    );
  }

  const workers = Array.from({ length: Math.max(1, options.concurrency) }, async () => {
    for (let entry = await claimNext(); entry; entry = await claimNext()) await importEntry(entry);
  });
  await Promise.all(workers);

  summary.stoppedReason = stopped;
  summary.durationMs = Date.now() - started;
  return summary;
}

function toObjectId(id: string): ObjectId | undefined {
  return ObjectId.isValid(id) ? new ObjectId(id) : undefined;
}
