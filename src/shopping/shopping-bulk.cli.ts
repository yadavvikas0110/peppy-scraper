/**
 * Shopping bulk pipeline CLI (see shopping-bulk.ts and docs/SHOPPING_BULK.md).
 *
 *   node --env-file=.env.dev dist/src/shopping/shopping-bulk.cli.js [options]
 *
 *   --categories air-fryers,smartphones   only these catalog keys (default: every enabled category)
 *   --platforms amazon,noon,carrefour     only these platforms
 *   --count 20                            products per platform per category (overrides the catalog)
 *   --category-concurrency 2              category jobs at once
 *   --product-concurrency 3               product pages at once per platform lane
 *   --dry-run                             scrape + bundle only; no S3 upload, no database write
 *   --catalog <file>                      catalog file (default config/shopping-catalog.json)
 *   --include-disabled                    also run categories with "enabled": false
 *   --list                                print the plan (categories × platforms, data source) and exit
 *
 * Stop: Ctrl+C / SIGTERM, or `npm run shopping:bulk:stop` — the current pages finish, checkpoints are
 * kept, nothing from an interrupted category is written; the next run resumes it.
 */
import { SiteKey, SITE_KEYS, SITES } from '../config/sites';
import { partitionSites } from '../config/transport-policy';
import { defaultBulkScrapeDeps, scrapeBulk } from '../services/playwright.service';
import { pushToDatabase } from '../cron/push-pipeline';
import { assertSafeWriteTarget } from '../shared/db/mongo';
import { isOwnS3Url } from '../utils/s3.util';
import { createS3Rehoster } from '../services/shopping-images';
import { scrapeDoImageUsage } from '../services/scrapedo-images';
import { scrapeDoEnabledFor, scrapeDoUsage } from '../services/scrapedo-transport';
import { fetchScrapeDoAccountInfo } from '../dining/bulk/bulk.credits';
import {
  acquireLock, clearStopSignal, releaseLock, shouldStop as stopFileExists,
  SHOPPING_BULK_LOCK_FILE, SHOPPING_BULK_STOP_FILE,
} from '../utils/stop-signal';
import { loadCatalog, runShoppingBulk, selectCategories, DEFAULT_CATALOG_FILE, BulkRunReport } from './shopping-bulk';
import { BULK_DAILY, BULK_RUNS, ensureStatsIndexes, recordBulkRun } from './shopping-bulk.store';
import { closeMongo, getMongoDb } from '../shared/db/mongo';
import { getScrapeObsRecorder } from '../observability/scrape-obs.recorder';

/** Stores the run's statistics (shopping_bulk_runs / shopping_bulk_daily) and shows it in the admin
 *  "Scrape Monitoring" panel (scrape_obs_*). Never fails the run. */
async function storeStats(report: BulkRunReport, trigger: 'cron' | 'manual'): Promise<void> {
  try {
    const db = await getMongoDb();
    await ensureStatsIndexes(db).catch(() => {});
    if (await recordBulkRun({ runs: db.collection(BULK_RUNS), daily: db.collection(BULK_DAILY) }, report)) {
      console.log('[bulk] Run statistics stored (shopping_bulk_runs, shopping_bulk_daily)');
    }
  } catch (e: any) {
    console.warn(`[bulk] run statistics not stored: ${e?.message ?? e}`);
  }
  const obs = getScrapeObsRecorder(process.env, 'ecommerce');
  const runId = await obs.startRun({ trigger, resumed: false, queriesPlanned: report.categories.length });
  const perSite = new Map<string, { status: string; scraped: number; failed: number; links: number; reasons: string[] }>();
  for (const c of report.categories) for (const s of c.siteResults) {
    const x = perSite.get(s.site) ?? { status: 'complete', scraped: 0, failed: 0, links: 0, reasons: [] };
    x.scraped += s.scraped; x.failed += s.failed; x.links += s.links ?? 0;
    if (s.status !== 'complete') { x.status = x.scraped > 0 ? 'partial' : s.status; if (s.reason) x.reasons.push(`${c.key}: ${s.reason}`); }
    perSite.set(s.site, x);
  }
  for (const [site, x] of perSite) {
    await obs.recordSiteOutcome(runId, { site, status: x.status, scraped: x.scraped, failed: x.failed, links: x.links, reason: x.reasons.join(' | ').slice(0, 500) || undefined });
  }
  for (const c of report.categories) {
    if (c.error) await obs.recordError(runId, { stage: c.status === 'error' && c.push === undefined && !c.bundles ? 'scrape' : 'push', message: `${c.key}: ${c.error}` });
    for (const e of c.push?.errors ?? []) await obs.recordError(runId, { stage: 'push', severity: 'warning', message: `${c.key}: ${e}` });
  }
  const t = report.totals;
  await obs.finishRun(runId, report.status === 'stopped' ? 'stopped' : report.status, {
    queriesPlanned: report.categories.length,
    queriesCompleted: report.categories.filter(c => c.status === 'complete' || c.status === 'partial').length,
    queriesFailed: report.categories.filter(c => c.status === 'failed' || c.status === 'error').length,
    productsScraped: t.scraped, productsFailed: t.failedPages, bundles: t.bundles,
    mongoInserted: t.inserted, mongoUpdated: t.updated,
  }, [...perSite.keys()]);
}

export interface CliArgs {
  categories?: string[];
  platforms?: SiteKey[];
  count?: number;
  categoryConcurrency: number;
  productConcurrency: number;
  dryRun: boolean;
  catalog: string;
  includeDisabled: boolean;
  list: boolean;
  /** Skip products scraped within this many hours (0 = scrape everything again) */
  freshHours: number;
  maxPages: number;
}

/**
 * Defaults come from the environment so a server can be tuned without changing its start command;
 * command-line flags still win. Unset / empty variables fall back to the built-in default.
 *
 *   SHOPPING_BULK_FRESH_HOURS            skip products scraped within this many hours (default 24, 0 = rescrape all)
 *   SHOPPING_BULK_COUNT                  products per platform per category (default: the catalog's count)
 *   SHOPPING_BULK_MAX_PAGES              listing pages to look through per platform for new products (default 15)
 *   SHOPPING_BULK_CATEGORY_CONCURRENCY   categories in parallel (default 2)
 *   SHOPPING_BULK_PRODUCT_CONCURRENCY    product pages in parallel per platform (default 3)
 */
export function parseArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): CliArgs {
  const int = (name: string, v: string | undefined, min: number, max: number) => {
    const n = Number(v);
    if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${name} must be an integer ${min}–${max} (got "${v}")`);
    return n;
  };
  const fromEnv = (name: string, fallback: number, min: number, max: number): number => {
    const raw = env[name]?.trim();
    return raw ? int(name, raw, min, max) : fallback;
  };
  const envCount = env.SHOPPING_BULK_COUNT?.trim() ? fromEnv('SHOPPING_BULK_COUNT', 0, 1, 500) : undefined;
  const args: CliArgs = {
    count: envCount,
    categoryConcurrency: fromEnv('SHOPPING_BULK_CATEGORY_CONCURRENCY', 2, 1, 10),
    productConcurrency: fromEnv('SHOPPING_BULK_PRODUCT_CONCURRENCY', 3, 1, 20),
    dryRun: false, catalog: DEFAULT_CATALOG_FILE, includeDisabled: false, list: false,
    freshHours: fromEnv('SHOPPING_BULK_FRESH_HOURS', 24, 0, 24 * 30),
    maxPages: fromEnv('SHOPPING_BULK_MAX_PAGES', 15, 1, 200),
  };
  const list = (v: string | undefined) => (v ?? '').split(',').map(s => s.trim()).filter(Boolean);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => argv[++i];
    switch (a) {
      case '--categories': args.categories = list(val()); break;
      case '--platforms': {
        const p = list(val());
        const bad = p.filter(x => !SITE_KEYS.includes(x as SiteKey));
        if (bad.length) throw new Error(`Unknown platform(s): ${bad.join(', ')} (known: ${SITE_KEYS.join(', ')})`);
        args.platforms = p as SiteKey[];
        break;
      }
      case '--count': args.count = int('--count', val(), 1, 500); break;
      case '--category-concurrency': args.categoryConcurrency = int('--category-concurrency', val(), 1, 10); break;
      case '--product-concurrency': args.productConcurrency = int('--product-concurrency', val(), 1, 20); break;
      case '--dry-run': args.dryRun = true; break;
      case '--catalog': args.catalog = val(); break;
      case '--include-disabled': args.includeDisabled = true; break;
      case '--list': args.list = true; break;
      case '--fresh-hours': args.freshHours = int('--fresh-hours', val(), 0, 24 * 30); break;
      case '--max-pages': args.maxPages = int('--max-pages', val(), 1, 200); break;
      default: throw new Error(`Unknown option ${a}`);
    }
  }
  return args;
}

export function transportOf(site: SiteKey, env: NodeJS.ProcessEnv = process.env): string {
  if (scrapeDoEnabledFor(site, env)) return 'Scrape.do';
  if (SITES[site].shopify) return 'Shopify API';
  return 'Bright Data';
}

function printPlan(categories: ReturnType<typeof selectCategories>, env: NodeJS.ProcessEnv): void {
  for (const c of categories) {
    const { supported, unsupported } = partitionSites(c.platforms, env);
    const how = (p: SiteKey) => (c.categoryKey && SITES[p].categories?.[c.categoryKey] ? 'category page' : `search "${c.category}"`);
    console.log(`${c.key}  [${c.broadCategory} > ${c.subCategory}]  ×${c.count}${c.enabled === false ? '  (disabled)' : ''}`);
    for (const p of supported) console.log(`    ✓ ${p.padEnd(12)} ${transportOf(p, env).padEnd(12)} ${how(p)}`);
    for (const u of unsupported) console.log(`    ✗ ${u.site.padEnd(12)} ${u.reason}`);
  }
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const categories = selectCategories(loadCatalog(args.catalog), { keys: args.categories, platforms: args.platforms, includeDisabled: args.includeDisabled });
  if (!categories.length) throw new Error('Nothing to run: no category matches the filters');
  if (args.list) { printPlan(categories, process.env); return 0; }

  const platforms = [...new Set(categories.flatMap(c => c.platforms))];
  const notScrapeDo = platforms.filter(p => partitionSites([p]).supported.length && transportOf(p) === 'Bright Data');
  if (notScrapeDo.length) {
    console.warn(`[bulk] Not on Scrape.do (add to SCRAPE_DO_SITES to switch): ${notScrapeDo.join(', ')} — these use Bright Data`);
  }

  // Pre-flight: fail in seconds, not after an hour of scraping
  if (process.env.SCRAPE_DO_TOKEN?.trim()) {
    const info = await fetchScrapeDoAccountInfo();
    if (info && (!info.isActive || info.remainingMonthlyRequest <= 0)) {
      throw new Error(`Scrape.do account is not usable (active: ${info.isActive}, remaining credits: ${info.remainingMonthlyRequest}). Renew the plan or fix SCRAPE_DO_TOKEN.`);
    }
    if (info) console.log(`[bulk] Scrape.do: ${info.remainingMonthlyRequest} credits left this month, ${info.concurrentRequest} concurrent requests allowed`);
  }
  let rehoster = null;
  let push = null;
  if (!args.dryRun) {
    const { dbName } = assertSafeWriteTarget();
    console.log(`[bulk] Target database: ${dbName}.products_clean`);
    rehoster = createS3Rehoster();
    push = (bundles: Parameters<typeof pushToDatabase>[0]) => pushToDatabase(bundles, { isOwnImage: isOwnS3Url });
  }

  // Products observed recently are not paid for again; pagination goes deeper for new ones instead
  let isFresh: ((site: SiteKey, url: string) => boolean) | undefined;
  if (args.freshHours > 0) {
    try {
      const { loadFreshIndex } = await import('./shopping-fresh');
      const index = await loadFreshIndex((await getMongoDb()).collection('products_clean'), args.freshHours);
      isFresh = index.isFresh;
      console.log(`[bulk] Skipping products scraped in the last ${args.freshHours} h (${index.size} offer keys); up to ${args.maxPages} listing pages per platform to find new ones`);
    } catch (e: any) {
      console.warn(`[bulk] Freshness check unavailable (${e?.message ?? e}) — every product found will be scraped`);
    }
  } else {
    console.log('[bulk] --fresh-hours 0: every product found is scraped again (price refresh of everything)');
  }

  if (!acquireLock('shopping-bulk', SHOPPING_BULK_LOCK_FILE)) return 2;
  clearStopSignal(SHOPPING_BULK_STOP_FILE);
  let interrupted = 0;
  const onSignal = () => {
    interrupted++;
    if (interrupted > 1) { console.warn('[bulk] Second signal — exiting now (checkpoints were saved after every page).'); process.exit(130); }
    console.warn('[bulk] Stopping after the pages in flight; checkpoints are kept. Press Ctrl+C again to force.');
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  try {
    const report = await runShoppingBulk({
      categories,
      categoryConcurrency: args.categoryConcurrency,
      productConcurrency: args.productConcurrency,
      countPerPlatform: args.count,
      dryRun: args.dryRun,
      isFresh,
      maxListingPages: args.maxPages,
    }, {
      scrapeBulk,
      bulkDeps: defaultBulkScrapeDeps,
      rehoster,
      push,
      shouldStop: () => interrupted > 0 || stopFileExists(SHOPPING_BULK_STOP_FILE),
      now: () => new Date(),
      env: process.env,
      log: console,
      scrapeDoUsage: () => ({ ...scrapeDoUsage(), images: scrapeDoImageUsage }),
    });
    // PM2 (24/7 mode) sets pm_id; a run started by hand is "manual"
    await storeStats(report, process.env.pm_id !== undefined || process.env.SHOPPING_BULK_TRIGGER === 'cron' ? 'cron' : 'manual');
    return report.status === 'complete' || report.status === 'partial' ? 0 : report.status === 'stopped' ? 3 : 1;
  } finally {
    releaseLock(SHOPPING_BULK_LOCK_FILE);
    clearStopSignal(SHOPPING_BULK_STOP_FILE);
    await closeMongo().catch(() => {});
  }
}

if (require.main === module) {
  main().then(code => process.exit(code), e => {
    console.error(`[bulk] ${e?.message ?? e}`);
    process.exit(1);
  });
}
