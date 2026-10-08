import dotenv from 'dotenv';
import { closeMongo, getMongoConfig, getMongoDb } from '../../shared/db/mongo';
import { DINING_PLATFORMS, DiningPlatform } from '../dining.types';
import { backfillRestaurantIdentity } from './identity.backfill';
import { ensureDiningIdentityIndexes, getDiningIdentityCollections } from './identity.collections';
import { createDiningIdentityRepositories } from './identity.service';

// Development-only: `npm run dining:identity-backfill` (dry run) / `-- --apply` (writes).
// Reads dining_restaurants; writes only dining_restaurant_groups / dining_restaurant_mappings.

function parseArgs(argv: string[]): { apply: boolean; platform?: DiningPlatform } {
  let apply = false;
  let platform: DiningPlatform | undefined;
  for (const arg of argv) {
    if (arg === '--apply') apply = true;
    else if (arg === '--dry-run') apply = false;
    else if (arg.startsWith('--platform=')) {
      const value = arg.slice('--platform='.length);
      if (!(DINING_PLATFORMS as readonly string[]).includes(value)) throw new Error(`Unsupported platform: ${value}`);
      platform = value as DiningPlatform;
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  return { apply, platform };
}

async function main(): Promise<void> {
  dotenv.config();
  if (process.env.NODE_ENV === 'production') throw new Error('The identity backfill is development-only (NODE_ENV=production)');
  const { apply, platform } = parseArgs(process.argv.slice(2));
  const { dbName } = getMongoConfig();
  console.log(`[dining-identity] ${apply ? 'APPLY' : 'DRY RUN'} on database "${dbName}"${platform ? ` (platform: ${platform})` : ''}`);

  const db = await getMongoDb();
  if (apply) await ensureDiningIdentityIndexes(db);
  const report = await backfillRestaurantIdentity(createDiningIdentityRepositories(getDiningIdentityCollections(db)), {
    dryRun: !apply,
    platform,
  });

  const { entries, ...totals } = report;
  for (const e of entries) {
    const target = report.dryRun && e.outcome === 'GROUP_CREATED' ? ' → new group' : e.groupId ? ` → group ${e.groupId}` : '';
    const extra = e.error ? ` [${e.error.code}] ${e.error.message}` : e.reason ? ` (${e.reason})` : '';
    console.log(`[dining-identity]   ${e.platform}:${e.platformRestaurantId ?? e.restaurantId} "${e.name ?? ''}" ${e.outcome}${e.matchMethod ? `/${e.matchMethod}` : ''}${target}${extra}`);
  }
  console.log(`[dining-identity] ${JSON.stringify(totals)}`);
  if (report.failed > 0) process.exitCode = 1;
}

main()
  .catch(err => {
    console.error(`[dining-identity] Backfill failed: ${(err as Error).message}`);
    process.exitCode = 1;
  })
  .finally(() => closeMongo());
