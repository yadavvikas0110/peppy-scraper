import dotenv from 'dotenv';
import { closeMongo, getMongoConfig, getMongoDb } from '../../shared/db/mongo';
import { ensureDiningIndexes } from './dining.collections';

// One-off: creates the dining_* collections/indexes in the configured database.
// Touches only dining_* collections. Run explicitly: `npm run dining:indexes`.

async function main(): Promise<void> {
  dotenv.config();
  const { dbName } = getMongoConfig();
  console.log(`[dining] Ensuring dining indexes in database "${dbName}"...`);
  const results = await ensureDiningIndexes(await getMongoDb());
  for (const r of results) console.log(`[dining]   ${r.collection}: ${r.indexes.join(', ')}`);
  console.log('[dining] Done.');
}

main()
  .catch(err => {
    console.error(`[dining] Failed to ensure indexes: ${(err as Error).message}`);
    process.exitCode = 1;
  })
  .finally(() => closeMongo());
