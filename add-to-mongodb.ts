/**
 * add-to-mongodb.ts
 *
 * Upserts products from a JSON file into products_clean WITHOUT flushing.
 * Existing products are preserved; new ones are added; matched ones get their
 * retailer offers merged (see pushToDatabase).
 *
 * Usage: npx ts-node add-to-mongodb.ts <path-to-json>
 */

import dotenv from 'dotenv';
dotenv.config();

import * as path from 'path';
import { loadBundlesFromJson, pushToDatabase } from './src/cron/push-pipeline';
import { assertSafeWriteTarget } from './src/shared/db/mongo';

async function main() {
  const jsonPath = process.argv[2];
  if (!jsonPath) {
    console.error('Usage: npx ts-node add-to-mongodb.ts <path-to-json>');
    process.exit(1);
  }

  // Refuses a production database unless CONFIRM_PRODUCTION_DB=yes
  const { dbName } = assertSafeWriteTarget();
  console.log(`[add] Target database: ${dbName}`);

  const bundles = loadBundlesFromJson(path.resolve(jsonPath));
  console.log(`[add] ${bundles.length} bundles loaded from ${path.basename(jsonPath)}`);

  const result = await pushToDatabase(bundles);
  console.log(`[add] Done — ${result.mongoInserted} new, ${result.mongoUpdated} updated, ${result.chromaVectors} vectors`);
  console.log(`[add] Backend mapping: ${result.mapping.ok ? `applied to ${result.mapping.mapped} product(s)` : `NOT applied — ${result.mapping.message}`}`);
  if (result.errors.length > 0) console.warn(`[add] Errors: ${result.errors.join('; ')}`);
}

main().catch(e => { console.error('[add] Fatal:', e.message); process.exit(1); });
