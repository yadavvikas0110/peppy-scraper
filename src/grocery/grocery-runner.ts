import * as fs from 'fs';
import * as path from 'path';
import { pushGroceryToDatabase } from './db/grocery-push';
import { collectTalabatGrocery } from './talabat-grocery.collector';
import { GROCERY_DEFAULT_MAX, TALABAT_PILOT } from './talabat-grocery.config';

export interface GroceryRunOptions {
  /** When false, products are written to grocery_products. Defaults to true (read-only). */
  dryRun?: boolean;
  max?: number;
  logger?: Pick<Console, 'log' | 'warn' | 'error'>;
}

const OUTPUT_DIR = path.resolve(process.cwd(), 'output');

function writeBackup(bundles: unknown[], logger: Pick<Console, 'log'>): string {
  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const file = path.join(OUTPUT_DIR, `grocery-talabat-${Date.now()}.json`);
  fs.writeFileSync(file, JSON.stringify({ generatedAt: new Date().toISOString(), count: bundles.length, bundles }, null, 2));
  logger.log(`[grocery] backup written: ${file}`);
  return file;
}

/**
 * Talabat Mart grocery pilot: scrape → bundle → (optionally) push to grocery_products.
 * Dry-run by default: it only writes a local JSON backup and pushes nothing.
 */
export async function runTalabatGroceryPilot(opts: GroceryRunOptions = {}): Promise<void> {
  const dryRun = opts.dryRun ?? true;
  const max = opts.max ?? GROCERY_DEFAULT_MAX;
  const logger = opts.logger ?? console;

  logger.log(`[grocery] Talabat Mart pilot — ${TALABAT_PILOT.categories.length} category pages, max ${max} products, dryRun=${dryRun}`);

  const { bundles, pagesFetched, itemsSeen, warnings } = await collectTalabatGrocery(TALABAT_PILOT, { max, logger });
  logger.log(`[grocery] fetched ${pagesFetched} pages, saw ${itemsSeen} items → ${bundles.length} bundles`);
  for (const w of warnings) logger.warn(`[grocery] warn: ${w}`);

  if (bundles.length === 0) {
    logger.error('[grocery] no products collected — nothing to push.');
    return;
  }

  writeBackup(bundles, logger);

  if (dryRun) {
    logger.log(`[grocery] DRY RUN — ${bundles.length} products NOT pushed. Re-run with --push to write to grocery_products.`);
    for (const b of bundles.slice(0, 10)) {
      logger.log(`   • ${b.name} — ${b.retailers[0]?.currency} ${b.retailers[0]?.price} [${b.subCategory}]`);
    }
    return;
  }

  logger.log(`[grocery] pushing ${bundles.length} products to grocery_products…`);
  const res: any = await pushGroceryToDatabase(bundles);
  logger.log(`[grocery] Mongo: ${res.mongoInserted ?? 0} new, ${res.mongoUpdated ?? 0} updated`);
  if (res.chromaVectors !== undefined) logger.log(`[grocery] Chroma: ${res.chromaVectors} vectors`);
  if (res.mapping) logger.log(`[grocery] backend mapping: ${res.mapping.ok ? 'applied' : `NOT applied — ${res.mapping.message}`}`);
  for (const e of res.errors ?? []) logger.warn(`[grocery] push warn: ${e}`);
}
