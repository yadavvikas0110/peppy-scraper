/**
 * Persistent statistics for the shopping bulk pipeline (same database as products_clean).
 *
 *   shopping_bulk_runs   one document per run: status, times, per-category × platform results, credits
 *   shopping_bulk_daily  one document per (day, platform) + one per day with platform "_all":
 *                        counters added by every run that STARTED that day (Asia/Dubai calendar day)
 *
 * Daily per platform: links found, products scraped, pages failed, Scrape.do credits (pages + images).
 * Daily "_all": runs, categories, products written (new / updated / merged), cross-platform comparisons,
 * images uploaded / failed, credits. Products are written once per category for all platforms together,
 * so new/updated counts exist per day and per category, not per platform.
 */
import type { BulkRunReport } from './shopping-bulk';

export const BULK_RUNS = 'shopping_bulk_runs';
export const BULK_DAILY = 'shopping_bulk_daily';

/** Calendar day in the UAE (UTC+4, no DST) — what the client means by "today". */
export function dubaiDay(d: Date): string {
  return new Date(d.getTime() + 4 * 3600 * 1000).toISOString().slice(0, 10);
}

export interface DailyIncrements {
  day: string;
  byPlatform: Record<string, Record<string, number>>;
  all: Record<string, number>;
}

/** What one run adds to the daily counters. Pure, so it is tested without a database. */
export function dailyIncrements(report: BulkRunReport): DailyIncrements {
  const day = dubaiDay(new Date(report.startedAt));
  const byPlatform: Record<string, Record<string, number>> = {};
  const p = (site: string) => (byPlatform[site] ??= { links: 0, scraped: 0, failed: 0, pending: 0, credits: 0, pages: 0, categories: 0 });
  for (const c of report.categories) {
    for (const s of c.siteResults ?? []) {
      const x = p(s.site);
      x.links += s.links ?? 0;
      x.scraped += s.scraped ?? 0;
      x.failed += s.failed ?? 0;
      x.pending += s.pending ?? 0;
      x.categories += 1;
    }
  }
  const sd: any = report.scrapeDo ?? {};
  for (const [site, u] of Object.entries<any>(sd.byPlatform ?? {})) {
    const x = p(site);
    x.credits += Number(u?.credits) || 0;
    x.pages += Number(u?.pages) || 0;
  }
  const imageCredits = Number(sd.images?.credits) || 0;
  // Images fetched through Scrape.do are Carrefour's CDN today; count them on Carrefour
  if (imageCredits) p('carrefour').credits += imageCredits;

  const t = report.totals;
  const all = {
    runs: 1,
    dryRuns: report.dryRun ? 1 : 0,
    categories: report.categories.length,
    categoriesComplete: report.categories.filter(c => c.status === 'complete').length,
    scraped: t.scraped,
    failed: t.failedPages ?? 0,
    products: t.bundles,
    comparisons: t.comparisons,
    inserted: t.inserted,
    updated: t.updated,
    merged: t.matchedExisting,
    imagesUploaded: t.imagesUploaded,
    imagesFailed: t.imagesFailed,
    imagesViaScrapeDo: Number(sd.images?.images) || 0,
    credits: (Number(sd.credits) || 0) + imageCredits,
  };
  return { day, byPlatform, all };
}

export interface StatsCollection {
  insertOne(doc: any): Promise<unknown>;
  updateOne(filter: object, update: object, options?: object): Promise<unknown>;
}

/** Stores the run and adds it to the daily counters. Never throws: stats must not fail a scrape. */
export async function recordBulkRun(
  cols: { runs: StatsCollection; daily: StatsCollection },
  report: BulkRunReport,
  log: Pick<Console, 'warn'> = console,
): Promise<boolean> {
  try {
    const inc = dailyIncrements(report);
    await cols.runs.insertOne({
      startedAt: new Date(report.startedAt), finishedAt: new Date(report.finishedAt), day: inc.day,
      status: report.status, dryRun: report.dryRun, totals: report.totals, scrapeDo: report.scrapeDo,
      categories: report.categories.map(c => ({
        key: c.key, status: c.status, scraped: c.scraped, failedPages: c.failedPages, products: c.bundles, comparisons: c.comparisons,
        push: c.push, images: c.images, error: c.error, durationMs: c.durationMs,
        sites: c.siteResults.map(s => ({ site: s.site, status: s.status, links: s.links ?? 0, scraped: s.scraped, failed: s.failed, pending: s.pending ?? 0, reason: s.reason })),
      })),
    });
    const now = new Date();
    for (const [platform, values] of Object.entries(inc.byPlatform)) {
      await cols.daily.updateOne({ day: inc.day, platform }, { $inc: values, $set: { updatedAt: now } }, { upsert: true });
    }
    await cols.daily.updateOne({ day: inc.day, platform: '_all' }, { $inc: inc.all, $set: { updatedAt: now } }, { upsert: true });
    return true;
  } catch (e: any) {
    log.warn(`[bulk] run statistics not stored: ${e?.message ?? e}`);
    return false;
  }
}

/** Daily rows for the last `days` days (newest first), for the stats CLI and the HTTP endpoint. */
export async function readDailyStats(db: { collection(name: string): any }, days = 30): Promise<any[]> {
  const since = dubaiDay(new Date(Date.now() - (days - 1) * 24 * 3600 * 1000));
  return db.collection(BULK_DAILY).find({ day: { $gte: since } }, { projection: { _id: 0 } }).sort({ day: -1, platform: 1 }).toArray();
}

export async function ensureStatsIndexes(db: { collection(name: string): any }): Promise<void> {
  await db.collection(BULK_DAILY).createIndex({ day: 1, platform: 1 }, { unique: true });
  await db.collection(BULK_RUNS).createIndex({ startedAt: -1 });
}
