/**
 * Full Dubai grocery crawl — ALL platforms (Talabat Mart + noon Minutes + Deliveroo Hop) in PARALLEL.
 *
 *   node dist/src/grocery/grocery-all.cli.js            # dry run (default, writes nothing to DB)
 *   node dist/src/grocery/grocery-all.cli.js --push     # push products to products_clean
 *
 * No per-platform budget cap (client approved full Bright Data spend). Re-impose caps per platform
 * with GROCERY_MAX_REQUESTS / NOON_MAX_REQUESTS / DELIVEROO_MAX_REQUESTS. Widen coverage with
 * GROCERY_DUBAI_AREAS (Talabat) and DELIVEROO_STORE_URLS (Deliveroo).
 *
 * Read-only by default on purpose: a DB write requires the explicit --push flag.
 */
import { runAllGroceryJobs } from './grocery-all';

async function main(): Promise<void> {
  const push = process.argv.slice(2).includes('--push');
  await runAllGroceryJobs({ dryRun: !push });
}

main()
  .then(() => process.exit(0))
  .catch(err => {
    console.error('[grocery-all] fatal:', err?.stack ?? err);
    process.exit(1);
  });
