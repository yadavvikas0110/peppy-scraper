import { runGroceryCrawlJob, GroceryCrawlProgress } from './grocery-crawl';
import { runNoonMinutesJob, NoonRunResult } from './noon-minutes.collector';
import { runDeliverooGroceryJob, DeliverooRunResult } from './deliveroo-grocery.collector';
import { resolveDeliverooStores } from './deliveroo-grocery.config';
import { resolveNoonCategories } from './noon-minutes.config';
import { resolveDubaiAreas } from './talabat-grocery.config';

export interface AllGroceryOptions {
  /** When false, products are written to grocery_products. Defaults to true (read-only). */
  dryRun?: boolean;
  logger?: Pick<Console, 'log' | 'warn' | 'error'>;
}

export interface AllGrocerySummary {
  talabat: GroceryCrawlProgress | null;
  noon: NoonRunResult | null;
  deliveroo: DeliverooRunResult | null;
  totalPushed: number;
}

/**
 * Run the full Dubai grocery crawl for ALL three platforms — Talabat Mart, noon Minutes and
 * Deliveroo Hop — CONCURRENTLY, with no per-platform budget cap (client approved full spend).
 *
 * Safe to run in parallel: each platform takes its own process lock (Talabat = global pipeline lock,
 * noon = NOON_LOCK_FILE, Deliveroo = DELIVEROO_LOCK_FILE), so they never clobber each other and a
 * second run of the same platform is still excluded. Politeness delays stay on to avoid rate-limit
 * bans. Each job is independently fault-isolated (Promise.allSettled): one platform failing never
 * aborts the others. Dry-run by default; pass dryRun:false (CLI --push) to write to grocery_products.
 */
export async function runAllGroceryJobs(opts: AllGroceryOptions = {}): Promise<AllGrocerySummary> {
  const dryRun = opts.dryRun ?? true;
  const logger = opts.logger ?? console;

  const areas = resolveDubaiAreas();
  const noonCats = resolveNoonCategories();
  const deliverooStores = resolveDeliverooStores();

  logger.log(
    `[grocery-all] launching Talabat + noon + Deliveroo in PARALLEL — dryRun=${dryRun}, NO budget cap\n` +
      `  • Talabat   : ${areas.length} Dubai area(s) → auto-discover all stores\n` +
      `  • noon      : ${noonCats.length} categories (single resolved Dubai dark store)\n` +
      `  • Deliveroo : ${deliverooStores.length} store URL(s)`,
  );

  const settled = await Promise.allSettled([
    runGroceryCrawlJob({ dryRun, logger }),
    runNoonMinutesJob({ dryRun, logger }),
    runDeliverooGroceryJob({ dryRun, storeUrls: deliverooStores, logger }),
  ]);

  const pick = <T>(i: number, name: string): T | null => {
    const r = settled[i];
    if (r.status === 'fulfilled') return (r.value as T) ?? null;
    logger.error(`[grocery-all] ${name} job threw: ${(r.reason as any)?.stack ?? r.reason}`);
    return null;
  };

  const talabat = pick<GroceryCrawlProgress>(0, 'talabat');
  const noon = pick<NoonRunResult>(1, 'noon');
  const deliveroo = pick<DeliverooRunResult>(2, 'deliveroo');

  const totalPushed =
    (talabat?.productsPushed ?? 0) + (noon?.productsPushed ?? 0) + (deliveroo?.productsPushed ?? 0);

  logger.log(
    `[grocery-all] DONE — pushed=${totalPushed} (talabat=${talabat?.productsPushed ?? 'skipped/0'}, ` +
      `noon=${noon?.productsPushed ?? 'skipped/0'}, deliveroo=${deliveroo?.productsPushed ?? 'skipped/0'})` +
      (talabat === null ? ' [talabat lock held — skipped]' : ''),
  );

  return { talabat, noon, deliveroo, totalPushed };
}
