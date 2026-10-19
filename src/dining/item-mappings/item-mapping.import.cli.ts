import dotenv from 'dotenv';
import { ObjectId } from 'mongodb';
import { closeMongo, getMongoConfig, getMongoDb } from '../../shared/db/mongo';
import { DINING_PLATFORMS, DiningPlatform } from '../dining.types';
import { ensureDiningItemMappingIndexes, getDiningItemMappingCollections } from './item-mapping.collections';
import { importSeedItemMappings, ItemMappingImportOptions } from './item-mapping.import';

// Development-only: `npm run dining:item-mappings-import` (dry run) / `-- --apply` (writes).
// Reads canonical items, menu items and restaurant mappings/groups; writes only dining_item_mappings.

function parseArgs(argv: string[]): { apply: boolean; options: ItemMappingImportOptions } {
  let apply = false;
  const options: ItemMappingImportOptions = {};
  for (const arg of argv) {
    const [flag, value = ''] = arg.split('=', 2);
    if (arg === '--apply') apply = true;
    else if (arg === '--dry-run') apply = false;
    else if (flag === '--platform') {
      if (!(DINING_PLATFORMS as readonly string[]).includes(value)) throw new Error(`Unsupported platform: ${value}`);
      options.platform = value as DiningPlatform;
    } else if (flag === '--group') {
      if (!/^[0-9a-f]{24}$/i.test(value)) throw new Error('--group must be a 24-character hex ObjectId');
      options.restaurantGroupId = new ObjectId(value);
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  return { apply, options };
}

async function main(): Promise<void> {
  dotenv.config();
  if (process.env.NODE_ENV === 'production') throw new Error('The item mapping import is development-only (NODE_ENV=production)');
  const { apply, options } = parseArgs(process.argv.slice(2));
  const { dbName } = getMongoConfig();
  const scope = [options.platform && `platform=${options.platform}`, options.restaurantGroupId && `group=${options.restaurantGroupId.toHexString()}`].filter(Boolean);
  console.log(`[dining-item-mappings] ${apply ? 'APPLY' : 'DRY RUN'} on database "${dbName}"${scope.length ? ` (${scope.join(', ')})` : ''}`);

  const db = await getMongoDb();
  if (apply) await ensureDiningItemMappingIndexes(db);
  const report = await importSeedItemMappings(getDiningItemMappingCollections(db), { ...options, dryRun: !apply });

  const { issues, ...totals } = report;
  for (const i of issues) console.log(`[dining-item-mappings]   ${i.code} canonical=${i.canonicalItemId}${i.menuItemId ? ` item=${i.menuItemId}` : ''}: ${i.message}`);
  console.log(`[dining-item-mappings] ${JSON.stringify(totals)}`);
  if (report.failures > 0) process.exitCode = 1;
}

main()
  .catch(err => {
    console.error(`[dining-item-mappings] Import failed: ${(err as Error).message}`);
    process.exitCode = 1;
  })
  .finally(() => closeMongo());
