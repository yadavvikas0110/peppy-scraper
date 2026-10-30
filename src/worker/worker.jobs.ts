import * as crypto from 'crypto';
import { BundledProduct, ProductData } from '../parsers/types';
import { BulkScrapeDeps, BundledBulkResult, defaultBulkScrapeDeps, scrapeBulk } from '../services/playwright.service';
import { buildOffer } from '../services/bundler.service';
import { PushResult, ProductsCollection } from '../cron/push-pipeline';
import { extractAmazonAsin } from '../services/product-identity';
import { isResumeStateFresh, resumeMaxAgeMs } from '../services/checkpoint.service';
import { ShoppingQuery, WorkerConfig } from './worker.config';
import { JobRecord, JobSummary, RunOutcome, emptySummary } from './worker.store';
import { RequestBudget, isBudgetExhausted } from './worker.budget';
import { WorkerLogger } from './worker.logger';

/** Everything a job needs; the CLI wires real implementations, tests wire fakes. */
export interface JobContext {
  config: WorkerConfig;
  budget: RequestBudget;
  logger: WorkerLogger;
  products: ProductsCollection;
  now(): Date;
  /** stop requested (signal / stop command) or budget exhausted */
  shouldStop(): boolean;
  scrapeBulk(options: Parameters<typeof scrapeBulk>[0], deps: BulkScrapeDeps): Promise<BundledBulkResult>;
  scrapeProduct(url: string): Promise<ProductData>;
  push(bundles: BundledProduct[]): Promise<PushResult>;
  /** Expires offers no run has observed recently (stale → unknown stock, out of the price range) */
  markStale(): Promise<number>;
}

export interface JobResult {
  outcome: RunOutcome;
  summary: JobSummary;
  issues: string[];
  error?: string;
  progress?: JobRecord['progress'];
}

function addPush(summary: JobSummary, push: PushResult): void {
  summary.inserted += push.mongoInserted;
  summary.updated += push.mongoUpdated;
  summary.matched += push.matchedExisting;
  summary.skipped += push.skipped;
  summary.mapped += push.mapping.mapped ?? 0;
}

/** ASINs whose Amazon offer was observed within the freshness window — discovery skips them. */
export async function loadFreshAsins(ctx: JobContext): Promise<Set<string>> {
  const cutoff = new Date(ctx.now().getTime() - ctx.config.freshForMs);
  const docs = await ctx.products.find({
    retailers: { $elemMatch: { retailerId: 'amazon', lastSeenAt: { $gte: cutoff }, isStale: { $ne: true } } },
  }).toArray();
  const fresh = new Set<string>();
  for (const d of docs) {
    for (const r of d.retailers ?? []) {
      if (r.retailerId !== 'amazon' || !r.lastSeenAt || new Date(r.lastSeenAt) < cutoff || r.isStale) continue;
      const asin = r.externalId ?? extractAmazonAsin(r.productUrl);
      if (asin) fresh.add(String(asin).toUpperCase());
    }
  }
  return fresh;
}

// ── Discovery: find new products for one configured query ─────────────────────

export async function runDiscovery(query: ShoppingQuery, ctx: JobContext): Promise<JobResult> {
  const summary = emptySummary();
  const issues: string[] = [];
  const fresh = await loadFreshAsins(ctx);

  const result = await ctx.scrapeBulk({
    sites: ctx.config.sites,
    category: query.category,
    categoryKey: query.categoryKey,
    broadCategory: query.broadCategory,
    subCategory: query.subCategory,
    count: query.count,
  }, {
    ...defaultBulkScrapeDeps,
    shouldStop: ctx.shouldStop,
    // A product observed recently is refreshed by the refresh job, not re-scraped here
    shouldSkipUrl: (site, url) => site === 'amazon' && fresh.has(extractAmazonAsin(url) ?? ''),
  });

  for (const s of result.siteResults) {
    summary.discovered += s.links ?? 0;
    summary.skipped += s.skipped ?? 0;
    if (s.status !== 'complete' && s.status !== 'stopped') issues.push(`${s.site}: ${s.status}${s.reason ? ` — ${s.reason}` : ''}`);
  }
  summary.scraped = result.totalScraped;
  summary.failed = result.errors.length;
  summary.reviewRequired = result.matchReviews.length;

  if (result.status === 'stopped') {
    // Checkpoint kept by scrapeBulk; nothing is published from an interrupted run
    return { outcome: ctx.budget.exhausted ? 'budget_exhausted' : 'interrupted', summary, issues };
  }
  if (result.status === 'failed') {
    return { outcome: 'failed', summary, issues, error: issues.join('; ') || 'no site produced data' };
  }

  const push = await ctx.push(result.bundles);
  addPush(summary, push);
  issues.push(...push.errors);
  const outcome: RunOutcome = result.status === 'complete' && push.errors.length === 0 && summary.failed === 0 ? 'complete' : 'partial';
  if (result.outputFile) ctx.logger.info('discovery.output', { query: query.key, file: result.outputFile, matchReviews: result.matchReviews.length });
  return { outcome, summary, issues };
}

// ── Refresh: re-scrape price and stock of existing Amazon offers ───────────────

const REFRESH_CHUNK = 10;

/** Oldest-first Amazon ASINs whose offer is stale, unobserved or older than the freshness window. */
export async function selectRefreshTargets(ctx: JobContext): Promise<string[]> {
  const cutoff = new Date(ctx.now().getTime() - ctx.config.freshForMs);
  const docs = await ctx.products.find({
    retailers: { $elemMatch: { retailerId: 'amazon', $or: [{ lastSeenAt: { $lt: cutoff } }, { lastSeenAt: { $exists: false } }, { isStale: true }] } },
  }).toArray();
  const candidates: Array<{ asin: string; seen: number }> = [];
  for (const d of docs) {
    for (const r of d.retailers ?? []) {
      if (r.retailerId !== 'amazon') continue;
      const seen = r.lastSeenAt ? new Date(r.lastSeenAt).getTime() : 0;
      if (seen >= cutoff.getTime() && !r.isStale) continue;
      const asin = r.externalId ?? extractAmazonAsin(r.productUrl);
      if (asin) candidates.push({ asin: String(asin).toUpperCase(), seen });
    }
  }
  candidates.sort((a, b) => a.seen - b.seen);
  return [...new Set(candidates.map(c => c.asin))].slice(0, ctx.config.refreshBatchSize);
}

function refreshBundle(data: ProductData, stored: any | undefined): BundledProduct {
  const offer = buildOffer('amazon', data);
  const images = data.imageUrls?.length ? data.imageUrls : data.imageUrl ? [data.imageUrl] : [];
  return {
    name: data.productName ?? stored?.name ?? null,
    description: data.description,
    category: 'refresh',
    // Only used if the stored product vanished; existing documents keep their own taxonomy
    broadCategory: stored?.category ?? 'Electronics',
    subCategory: stored?.subcategory ?? 'General',
    tags: [],
    images: images.length ? images : stored?.images ?? [],
    lowestPrice: null,
    highestPrice: null,
    rating: data.ratings,
    reviewCount: data.reviewCount,
    retailerCount: 1,
    retailers: [offer],
  };
}

export async function runRefresh(
  job: JobRecord,
  ctx: JobContext,
  /** Persists progress after every chunk so a crash or restart resumes where it left off */
  saveProgress: (progress: NonNullable<JobRecord['progress']>) => Promise<void> = async () => {},
): Promise<JobResult> {
  const summary = emptySummary();
  const issues: string[] = [];

  // Resume a run interrupted by a restart, but never one older than the resume window
  let progress = job.progress && isResumeStateFresh(new Date(job.progress.startedAt).toISOString(), resumeMaxAgeMs(), ctx.now())
    ? job.progress
    : null;
  if (!progress) {
    const targets = await selectRefreshTargets(ctx);
    progress = { runId: crypto.randomUUID(), startedAt: ctx.now(), targets, done: [] };
  } else {
    ctx.logger.info('refresh.resume', { runId: progress.runId, done: progress.done.length, targets: progress.targets.length });
  }
  await saveProgress(progress);
  summary.discovered = progress.targets.length;
  const done = new Set(progress.done);
  const remaining = progress.targets.filter(a => !done.has(a));

  for (let i = 0; i < remaining.length; i += REFRESH_CHUNK) {
    if (ctx.shouldStop()) {
      return { outcome: ctx.budget.exhausted ? 'budget_exhausted' : 'interrupted', summary, issues, progress };
    }
    const chunk = remaining.slice(i, i + REFRESH_CHUNK);
    const storedDocs = await ctx.products.find({ retailers: { $elemMatch: { retailerId: 'amazon', externalId: { $in: chunk } } } }).toArray();
    const bundles: BundledProduct[] = [];
    const processed: string[] = [];
    let stopped = false;

    for (const asin of chunk) {
      if (ctx.shouldStop()) { stopped = true; break; }
      try {
        const data = await ctx.scrapeProduct(`https://www.amazon.ae/dp/${asin}`);
        data.scrapedAt = ctx.now().toISOString();
        const stored = storedDocs.find(d => (d.retailers ?? []).some((r: any) => r.retailerId === 'amazon' && r.externalId === asin));
        bundles.push(refreshBundle(data, stored));
        summary.scraped++;
      } catch (e: any) {
        if (isBudgetExhausted(e)) { stopped = true; break; }
        summary.failed++;
        ctx.logger.warn('refresh.product_failed', { asin, error: String(e.message).slice(0, 200) });
      }
      processed.push(asin);
    }

    // Persist what was observed before recording progress, so a crash never skips unpushed data
    if (bundles.length) {
      const push = await ctx.push(bundles);
      addPush(summary, push);
      issues.push(...push.errors);
    }
    progress = { ...progress, done: [...progress.done, ...processed] };
    await saveProgress(progress);
    if (stopped) return { outcome: ctx.budget.exhausted ? 'budget_exhausted' : 'interrupted', summary, issues, progress };
  }

  // Every due offer was attempted: expire the ones that have not been observed for too long
  summary.staleMarked = await ctx.markStale();

  const outcome: RunOutcome = summary.scraped === 0 && summary.failed > 0
    ? 'failed'
    : summary.failed > 0 || issues.length ? 'partial' : 'complete';
  return { outcome, summary, issues, progress: null };
}
