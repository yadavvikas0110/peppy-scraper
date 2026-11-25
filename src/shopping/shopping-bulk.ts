/**
 * Shopping bulk pipeline — scrape many categories across many platforms in parallel, merge the same
 * product across platforms, re-host images on S3, and write to products_clean.
 *
 *   catalog (config/shopping-catalog.json)            one entry per category, with the platforms that sell it
 *        │
 *        ├─ category job ×N in parallel (categoryConcurrency)
 *        │     └─ scrapeBulk: one lane per platform, in parallel; productConcurrency pages at once per lane
 *        │           → in-memory cross-platform bundling (bundler: barcode, then guarded title match)
 *        │
 *        ├─ S3 image re-hosting (shared cache: an image is uploaded once per run; failed images are dropped)
 *        │
 *        └─ ONE writer at a time (pushes are serialised): pushToDatabase merges each product into the stored
 *           document of the same listing, the same barcode, the same name, or — guarded — the same product
 *           on another platform (services/cross-match.ts); then asks the backend to map categories.
 *
 * Every network/DB effect is injected (BulkRunDeps), so the orchestration is tested offline.
 * Checkpoints and stop/resume come from scrapeBulk: a stopped or credit-exhausted job publishes nothing
 * and resumes from its checkpoint on the next run.
 */
import * as fs from 'fs';
import * as path from 'path';
import { SiteKey, SITE_KEYS, SITES } from '../config/sites';
import { partitionSites } from '../config/transport-policy';
import { getBroadCategoryBaseTags } from '../config/taxonomy';
import type { BundledProduct } from '../parsers/types';
import type { BulkScrapeDeps, BundledBulkResult, JobStatus, SiteOutcome, scrapeBulk } from '../services/playwright.service';
import type { PushResult } from '../cron/push-pipeline';
import type { ImageRehoster } from '../custom/core/images-s3';
import { BundleImageStats, rehostBundleImages } from '../services/shopping-images';

// ── Catalog ───────────────────────────────────────────────────────────────────

export interface CatalogCategory {
  /** Permanent id: names checkpoints and report rows */
  key: string;
  label: string;
  /** Search text, used on platforms without a category page for `categoryKey` */
  category: string;
  /** Key into each platform's SITES[...].categories (category browse pages) */
  categoryKey?: string;
  broadCategory: string;
  subCategory: string;
  /** Products per platform per run */
  count: number;
  platforms: SiteKey[];
  enabled?: boolean;
}

const KEY_RE = /^[a-z0-9][a-z0-9-]*$/;

/** Validates the catalog file. Throws with every problem listed, so a bad edit never half-runs. */
export function parseCatalog(raw: unknown, source = 'catalog'): CatalogCategory[] {
  const list: any[] = Array.isArray(raw) ? raw : (raw as any)?.categories;
  if (!Array.isArray(list)) throw new Error(`${source}: expected { "categories": [...] }`);
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const c of list) {
    const id = JSON.stringify(c?.key ?? c?.label ?? '?');
    for (const f of ['key', 'label', 'category', 'broadCategory', 'subCategory'] as const) {
      if (typeof c?.[f] !== 'string' || !c[f].trim()) problems.push(`${id}: missing "${f}"`);
    }
    if (typeof c?.key === 'string') {
      if (!KEY_RE.test(c.key)) problems.push(`${id}: key must be lowercase letters, digits and dashes`);
      if (seen.has(c.key)) problems.push(`${id}: duplicate key`);
      seen.add(c.key);
    }
    if (!Number.isInteger(c?.count) || c.count < 1 || c.count > 500) problems.push(`${id}: count must be an integer 1–500`);
    if (!Array.isArray(c?.platforms) || c.platforms.length === 0) problems.push(`${id}: platforms must list at least one site`);
    for (const p of c?.platforms ?? []) {
      if (!SITE_KEYS.includes(p)) problems.push(`${id}: unknown platform "${p}"`);
    }
    if (typeof c?.broadCategory === 'string' && typeof c?.subCategory === 'string'
      && getBroadCategoryBaseTags(c.broadCategory, c.subCategory).length === 0) {
      problems.push(`${id}: unknown taxonomy "${c.broadCategory} > ${c.subCategory}" (src/config/taxonomy.ts)`);
    }
    // A platform without a category page for this key falls back to search — that must be intended
    if (c?.categoryKey) {
      const browsable = (c.platforms ?? []).filter((p: SiteKey) => SITES[p]?.categories?.[c.categoryKey]);
      if (browsable.length === 0) problems.push(`${id}: categoryKey "${c.categoryKey}" exists on none of its platforms`);
    }
  }
  if (problems.length) throw new Error(`${source} has ${problems.length} problem(s):\n  - ${problems.join('\n  - ')}`);
  return list as CatalogCategory[];
}

// src/shopping → ../../config ; dist/src/shopping → ../../../config
export const DEFAULT_CATALOG_FILE = [
  path.join(__dirname, '..', '..', 'config', 'shopping-catalog.json'),
  path.join(__dirname, '..', '..', '..', 'config', 'shopping-catalog.json'),
].find(p => fs.existsSync(p)) ?? path.join(process.cwd(), 'config', 'shopping-catalog.json');

export function loadCatalog(file = DEFAULT_CATALOG_FILE): CatalogCategory[] {
  return parseCatalog(JSON.parse(fs.readFileSync(file, 'utf8')), file);
}

/** Categories to run: enabled ones, optionally narrowed by key and by platform. */
export function selectCategories(
  catalog: CatalogCategory[],
  filter: { keys?: string[]; platforms?: SiteKey[]; includeDisabled?: boolean } = {},
): CatalogCategory[] {
  const unknown = (filter.keys ?? []).filter(k => !catalog.some(c => c.key === k));
  if (unknown.length) throw new Error(`Unknown category key(s): ${unknown.join(', ')}`);
  return catalog
    .filter(c => (filter.keys?.length ? filter.keys.includes(c.key) : filter.includeDisabled || c.enabled !== false))
    .map(c => ({ ...c, platforms: filter.platforms?.length ? c.platforms.filter(p => filter.platforms!.includes(p)) : c.platforms }))
    .filter(c => c.platforms.length > 0);
}

// ── Run ───────────────────────────────────────────────────────────────────────

export interface BulkRunOptions {
  categories: CatalogCategory[];
  /** Category jobs at once (default 2) */
  categoryConcurrency?: number;
  /** Product pages at once per platform lane (default 3) */
  productConcurrency?: number;
  /** Override every category's count (pilots) */
  countPerPlatform?: number;
  /** Scrape and bundle only: no S3 upload, no database write */
  dryRun?: boolean;
}

export interface BulkRunDeps {
  scrapeBulk: typeof scrapeBulk;
  /** Base deps for scrapeBulk (fetchers, bundler, checkpoints dir…); shouldStop/productConcurrency are set per run */
  bulkDeps: BulkScrapeDeps;
  /** Required unless dryRun */
  rehoster: ImageRehoster | null;
  /** Required unless dryRun */
  push: ((bundles: BundledProduct[]) => Promise<PushResult>) | null;
  shouldStop(): boolean;
  now(): Date;
  env: NodeJS.ProcessEnv;
  log: Pick<Console, 'log' | 'warn' | 'error'>;
  /** Credits/pages used by Scrape.do so far (for the report) */
  scrapeDoUsage?: () => unknown;
}

export type CategoryStatus = JobStatus | 'skipped' | 'error';

export interface CategoryRunResult {
  key: string;
  status: CategoryStatus;
  platforms: SiteKey[];
  siteResults: SiteOutcome[];
  scraped: number;
  /** Product pages that failed (listed in the scrape output file) */
  failedPages: number;
  bundles: number;
  /** Bundles offered by two or more platforms — the price comparisons this run produced */
  comparisons: number;
  matchReviews: number;
  images?: BundleImageStats;
  push?: Pick<PushResult, 'mongoInserted' | 'mongoUpdated' | 'matchedExisting' | 'skipped' | 'errors'> & { mapped: boolean };
  outputFile: string | null;
  error?: string;
  durationMs: number;
}

export interface BulkRunReport {
  startedAt: string;
  finishedAt: string;
  dryRun: boolean;
  /** complete: every category complete; partial: some data written; failed: nothing; stopped: interrupted */
  status: 'complete' | 'partial' | 'failed' | 'stopped';
  categories: CategoryRunResult[];
  totals: { scraped: number; failedPages: number; bundles: number; comparisons: number; inserted: number; updated: number; matchedExisting: number; imagesUploaded: number; imagesFailed: number };
  scrapeDo?: unknown;
  reportFile?: string;
}

/** Runs `fn` over items with at most `limit` in flight; results keep the input order. */
export async function mapPool<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    for (let i = next++; i < items.length; i = next++) out[i] = await fn(items[i], i);
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return out;
}

/** Serialises async calls: each waits for the previous to settle (a failure does not block the queue). */
export function createSerialQueue() {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(fn: () => Promise<T>): Promise<T> => {
    const run = tail.then(fn, fn);
    tail = run.catch(() => {});
    return run;
  };
}

export function overallStatus(results: CategoryRunResult[], dryRun: boolean): BulkRunReport['status'] {
  if (results.some(r => r.status === 'stopped')) return 'stopped';
  const ran = results.filter(r => r.status !== 'skipped');
  if (ran.length && ran.every(r => r.status === 'complete')) return 'complete';
  const produced = ran.some(r => (r.status === 'complete' || r.status === 'partial') && (dryRun || (r.push && r.push.mongoInserted + r.push.mongoUpdated > 0)));
  return produced ? 'partial' : 'failed';
}

export async function runShoppingBulk(options: BulkRunOptions, deps: BulkRunDeps): Promise<BulkRunReport> {
  const dryRun = !!options.dryRun;
  if (!dryRun && (!deps.rehoster || !deps.push)) throw new Error('A write run needs an S3 rehoster and a push function (or use dryRun)');
  const startedAt = deps.now();
  const productConcurrency = Math.max(1, options.productConcurrency ?? 3);
  const serialWrite = createSerialQueue();
  const log = deps.log;

  log.log(`[bulk] ${options.categories.length} categor${options.categories.length === 1 ? 'y' : 'ies'}, ` +
    `${options.categoryConcurrency ?? 2} at a time, ${productConcurrency} pages at once per platform${dryRun ? ' — DRY RUN (no S3, no DB)' : ''}`);

  const runOne = async (c: CatalogCategory): Promise<CategoryRunResult> => {
    const t0 = deps.now().getTime();
    const base = { key: c.key, platforms: c.platforms, siteResults: [] as SiteOutcome[], scraped: 0, failedPages: 0, bundles: 0, comparisons: 0, matchReviews: 0, outputFile: null as string | null };
    const done = (r: Partial<CategoryRunResult> & { status: CategoryStatus }): CategoryRunResult =>
      ({ ...base, ...r, durationMs: deps.now().getTime() - t0 });

    if (deps.shouldStop()) return done({ status: 'stopped', error: 'stop signal before start' });
    const { supported, unsupported } = partitionSites(c.platforms, deps.env);
    if (!supported.length) {
      const reason = unsupported.map(u => `${u.site}: ${u.reason}`).join('; ');
      log.warn(`[bulk:${c.key}] skipped — no platform has a data source (${reason})`);
      return done({ status: 'skipped', error: reason, siteResults: unsupported.map(u => ({ site: u.site, status: 'unsupported', scraped: 0, failed: 0, reason: u.reason })) });
    }

    let result: BundledBulkResult;
    try {
      result = await deps.scrapeBulk({
        sites: c.platforms,
        category: c.category,
        categoryKey: c.categoryKey,
        broadCategory: c.broadCategory,
        subCategory: c.subCategory,
        count: options.countPerPlatform ?? c.count,
        allowUnsupported: true,
      }, { ...deps.bulkDeps, shouldStop: deps.shouldStop, productConcurrency });
    } catch (e: any) {
      log.error(`[bulk:${c.key}] scrape failed: ${e?.message ?? e}`);
      return done({ status: 'error', error: String(e?.message ?? e) });
    }

    const scraped = {
      siteResults: result.siteResults,
      scraped: result.totalScraped,
      failedPages: result.errors.length,
      bundles: result.bundles.length,
      comparisons: result.bundles.filter(b => new Set(b.retailers.map(r => r.retailerId)).size >= 2).length,
      matchReviews: result.matchReviews.length,
      outputFile: result.outputFile,
    };
    if (result.status === 'stopped' || result.status === 'failed') {
      log.warn(`[bulk:${c.key}] ${result.status} — nothing written${result.status === 'stopped' ? ' (checkpoint kept for resume)' : ''}`);
      return done({ status: result.status, ...scraped });
    }
    // Failed product pages make a category partial (same rule as the shopping worker)
    const scrapeStatus: CategoryStatus = result.status === 'complete' && result.errors.length > 0 ? 'partial' : result.status;
    if (dryRun) {
      log.log(`[bulk:${c.key}] ${result.status}: ${scraped.scraped} scraped → ${scraped.bundles} products (${scraped.comparisons} on 2+ platforms) — dry run, not written`);
      return done({ status: scrapeStatus, ...scraped });
    }

    try {
      const images = await rehostBundleImages(result.bundles, deps.rehoster!);
      const pushed = await serialWrite(() => deps.push!(result.bundles));
      log.log(`[bulk:${c.key}] ${result.status}: ${scraped.bundles} products (${scraped.comparisons} compared) → ` +
        `${pushed.mongoInserted} new, ${pushed.mongoUpdated} updated, ${pushed.matchedExisting} merged into existing; ` +
        `images ${images.uploaded} uploaded / ${images.failed} failed`);
      const status: CategoryStatus = scrapeStatus === 'complete' && pushed.errors.length === 0 ? 'complete' : 'partial';
      return done({
        status, ...scraped, images,
        push: { mongoInserted: pushed.mongoInserted, mongoUpdated: pushed.mongoUpdated, matchedExisting: pushed.matchedExisting, skipped: pushed.skipped, errors: pushed.errors, mapped: pushed.mapping.ok },
      });
    } catch (e: any) {
      log.error(`[bulk:${c.key}] write failed: ${e?.message ?? e} (scraped data kept in ${result.outputFile ?? 'no file'})`);
      return done({ status: 'error', ...scraped, error: String(e?.message ?? e) });
    }
  };

  const categories = await mapPool(options.categories, Math.max(1, options.categoryConcurrency ?? 2), runOne);

  const sum = (f: (r: CategoryRunResult) => number) => categories.reduce((n, r) => n + f(r), 0);
  const report: BulkRunReport = {
    startedAt: startedAt.toISOString(),
    finishedAt: deps.now().toISOString(),
    dryRun,
    status: overallStatus(categories, dryRun),
    categories,
    totals: {
      scraped: sum(r => r.scraped),
      failedPages: sum(r => r.failedPages),
      bundles: sum(r => r.bundles),
      comparisons: sum(r => r.comparisons),
      inserted: sum(r => r.push?.mongoInserted ?? 0),
      updated: sum(r => r.push?.mongoUpdated ?? 0),
      matchedExisting: sum(r => r.push?.matchedExisting ?? 0),
      imagesUploaded: deps.rehoster?.stats.uploaded ?? 0,
      imagesFailed: deps.rehoster?.stats.failed ?? 0,
    },
    scrapeDo: deps.scrapeDoUsage?.(),
  };

  try {
    fs.mkdirSync(deps.bulkDeps.outputDir, { recursive: true });
    const file = path.join(deps.bulkDeps.outputDir, `shopping-bulk_${startedAt.toISOString().replace(/[:.]/g, '-')}.json`);
    fs.writeFileSync(file, JSON.stringify(report, null, 2));
    report.reportFile = file;
  } catch (e: any) {
    log.warn(`[bulk] report not written: ${e?.message ?? e}`);
  }
  log.log(`[bulk] ${report.status.toUpperCase()} — ${report.totals.scraped} scraped, ${report.totals.bundles} products, ` +
    `${report.totals.comparisons} compared across platforms; ${report.totals.inserted} new, ${report.totals.updated} updated` +
    (report.reportFile ? ` — report ${report.reportFile}` : ''));
  return report;
}
