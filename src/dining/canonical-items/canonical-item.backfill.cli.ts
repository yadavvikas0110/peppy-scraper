import dotenv from 'dotenv';
import { ObjectId } from 'mongodb';
import { closeMongo, getMongoConfig, getMongoDb } from '../../shared/db/mongo';
import { DINING_PLATFORMS, DiningPlatform } from '../dining.types';
import { backfillCanonicalItems, CanonicalItemBackfillOptions } from './canonical-item.backfill';
import { ensureDiningCanonicalItemIndexes, getDiningCanonicalItemCollections } from './canonical-item.collections';

// Development-only: `npm run dining:canonical-items-backfill` (dry run) / `-- --apply` (writes).
// Reads dining_menu_items + dining_restaurant_mappings + dining_restaurant_groups; writes only dining_canonical_items.

function objectId(flag: string, value: string): ObjectId {
  if (!/^[0-9a-f]{24}$/i.test(value)) throw new Error(`${flag} must be a 24-character hex ObjectId`);
  return new ObjectId(value);
}

function parseArgs(argv: string[]): { apply: boolean; options: CanonicalItemBackfillOptions } {
  let apply = false;
  const options: CanonicalItemBackfillOptions = {};
  for (const arg of argv) {
    const [flag, value = ''] = arg.split('=', 2);
    if (arg === '--apply') apply = true;
    else if (arg === '--dry-run') apply = false;
    else if (flag === '--platform') {
      if (!(DINING_PLATFORMS as readonly string[]).includes(value)) throw new Error(`Unsupported platform: ${value}`);
      options.platform = value as DiningPlatform;
    } else if (flag === '--group') options.restaurantGroupId = objectId(flag, value);
    else if (flag === '--restaurant') options.restaurantId = objectId(flag, value);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return { apply, options };
}

async function main(): Promise<void> {
  dotenv.config();
  if (process.env.NODE_ENV === 'production') throw new Error('The canonical item backfill is development-only (NODE_ENV=production)');
  const { apply, options } = parseArgs(process.argv.slice(2));
  const { dbName } = getMongoConfig();
  const scope = [
    options.platform && `platform=${options.platform}`,
    options.restaurantGroupId && `group=${options.restaurantGroupId.toHexString()}`,
    options.restaurantId && `restaurant=${options.restaurantId.toHexString()}`,
  ].filter(Boolean);
  console.log(`[dining-canonical] ${apply ? 'APPLY' : 'DRY RUN'} on database "${dbName}"${scope.length ? ` (${scope.join(', ')})` : ''}`);

  const db = await getMongoDb();
  if (apply) await ensureDiningCanonicalItemIndexes(db);
  const report = await backfillCanonicalItems(getDiningCanonicalItemCollections(db), { ...options, dryRun: !apply });

  const { restaurants, issues, ...totals } = report;
  for (const r of restaurants) {
    const where = r.restaurantGroupId ? `group ${r.restaurantGroupId}` : `no group (${r.reason})`;
    console.log(`[dining-canonical]   ${r.platform ?? '?'}:${r.platformRestaurantId ?? r.restaurantId} → ${where}: inspected=${r.itemsInspected} created=${r.created} reused=${r.reused} enriched=${r.enriched} skipped=${r.skipped} invalid=${r.invalid} failures=${r.failures}`);
  }
  for (const i of issues) {
    console.log(`[dining-canonical]   ${i.outcome} ${i.code} restaurant=${i.restaurantId}${i.menuItemId ? ` item=${i.menuItemId}` : ''}${i.itemCount !== undefined ? ` items=${i.itemCount}` : ''}: ${i.message}`);
  }
  console.log(`[dining-canonical] ${JSON.stringify(totals)}`);
  if (report.failures > 0) process.exitCode = 1;
}

main()
  .catch(err => {
    console.error(`[dining-canonical] Backfill failed: ${(err as Error).message}`);
    process.exitCode = 1;
  })
  .finally(() => closeMongo());
