/**
 * push-to-mongodb.ts
 *
 * Merges products from master JSON into products_clean (no flush — see pushToDatabase).
 * Also generates OpenAI embeddings and pushes to ChromaDB.
 *
 * Usage: npx ts-node push-to-mongodb.ts [path-to-master-json]
 *        Defaults to latest master_*.json in output/
 */

import dotenv from 'dotenv';
dotenv.config();

import * as fs from 'fs';
import * as path from 'path';
import { pushToDatabase, loadBundlesFromJson } from './src/cron/push-pipeline';
import { assertSafeWriteTarget } from './src/shared/db/mongo';

function findMasterJson(arg?: string): string {
  if (arg && fs.existsSync(arg)) return arg;
  const outputDir = path.join(process.cwd(), 'output');
  const files = fs.readdirSync(outputDir)
    .filter(f => f.startsWith('master_') && f.endsWith('.json'))
    .map(f => ({ name: f, mtime: fs.statSync(path.join(outputDir, f)).mtime }))
    .sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
  if (files.length === 0) throw new Error('No master_*.json found in output/');
  return path.join(outputDir, files[0].name);
}

async function main() {
  const jsonPath = findMasterJson(process.argv[2]);
  console.log(`\n[push] Reading ${path.basename(jsonPath)}...`);

  // Refuses a production database unless CONFIRM_PRODUCTION_DB=yes
  console.log(`[push] Target database: ${assertSafeWriteTarget().dbName}`);
  const bundles = loadBundlesFromJson(jsonPath);
  console.log(`[push] ${bundles.length} bundles found`);

  const result = await pushToDatabase(bundles);

  console.log(`\n[push] Done!`);
  console.log(`  MongoDB products_clean : ${result.mongoInserted} new, ${result.mongoUpdated} updated`);
  console.log(`  ChromaDB peppy_products: ${result.chromaVectors} vectors`);
  if (result.errors.length > 0) {
    console.warn(`  Errors: ${result.errors.join('; ')}`);
  }
}

main().catch(e => {
  console.error('[push] Fatal:', e.message);
  process.exit(1);
});
