/**
 * Fills `matchKeys` ("brand|model") and `gtins` on products stored before cross-platform matching
 * existed, so a new run on another platform can find them (services/cross-match.ts). Without this,
 * an Amazon product scraped last month and the same product scraped from Carrefour today become two
 * documents and no price comparison is shown.
 *
 * Only adds these two scraper-owned fields; never merges, deletes or renames products, never touches
 * prices, offers or updatedAt. Groceries are skipped (they use groceryMatchKey).
 *
 *   npm run ecommerce:match-keys-backfill            # dry run: counts only
 *   npm run ecommerce:match-keys-backfill -- --execute
 */
import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import { crossMatchKeys } from '../services/cross-match';
import { normalizeGtin } from '../parsers/types';
import { assertSafeWriteTarget, closeMongo, getMongoDb } from '../shared/db/mongo';

export interface MatchKeyBackfillResult { scanned: number; updated: number; withKeys: number; withGtins: number; skippedGroceries: number }

/** Fields to $set on a stored product, or null when it already has them / has nothing to add. */
export function matchFieldsFor(doc: any): { matchKeys?: string[]; gtins?: string[] } | null {
  if (doc?.category === 'Groceries') return null;
  const keys = crossMatchKeys(doc?.name, doc?.brand);
  const gtins = [...new Set((doc?.retailers ?? []).map((r: any) => normalizeGtin(r?.gtin)).filter(Boolean) as string[])];
  const out: { matchKeys?: string[]; gtins?: string[] } = {};
  const merged = [...new Set([...(doc?.matchKeys ?? []), ...keys])];
  if (merged.length > (doc?.matchKeys?.length ?? 0)) out.matchKeys = merged;
  const mergedG = [...new Set([...(doc?.gtins ?? []), ...gtins])];
  if (mergedG.length > (doc?.gtins?.length ?? 0)) out.gtins = mergedG;
  return out.matchKeys || out.gtins ? out : null;
}

export interface BackfillCollection {
  find(filter: object, options?: object): { toArray(): Promise<any[]> };
  updateOne(filter: object, update: object): Promise<{ matchedCount: number; modifiedCount: number }>;
}

export async function backfillMatchKeys(col: BackfillCollection, execute: boolean): Promise<MatchKeyBackfillResult> {
  const docs = await col.find({}, { projection: { name: 1, brand: 1, category: 1, matchKeys: 1, gtins: 1, 'retailers.gtin': 1 } }).toArray();
  const result: MatchKeyBackfillResult = { scanned: docs.length, updated: 0, withKeys: 0, withGtins: 0, skippedGroceries: 0 };
  for (const doc of docs) {
    if (doc.category === 'Groceries') { result.skippedGroceries++; continue; }
    const set = matchFieldsFor(doc);
    if (!set) continue;
    if (set.matchKeys) result.withKeys++;
    if (set.gtins) result.withGtins++;
    if (!execute) { result.updated++; continue; }
    const r = await col.updateOne({ _id: doc._id }, { $set: set });
    if (r.modifiedCount > 0) result.updated++;
  }
  return result;
}

async function main() {
  const execute = process.argv.includes('--execute');
  const { dbName } = assertSafeWriteTarget();
  console.log(`[match-keys] ${execute ? 'LIVE' : 'DRY RUN'} on ${dbName}.products_clean`);
  const col = (await getMongoDb()).collection('products_clean');
  if (execute) {
    for (const field of ['matchKeys', 'gtins']) await col.createIndex({ [field]: 1 }, { background: true });
  }
  const result = await backfillMatchKeys(col as unknown as BackfillCollection, execute);
  const out = path.join(process.cwd(), 'output', `match-keys-backfill-${execute ? '' : 'dry-run-'}${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(result, null, 2));
  console.log(`[match-keys] scanned ${result.scanned}, ${execute ? 'updated' : 'would update'} ${result.updated} ` +
    `(${result.withKeys} with match keys, ${result.withGtins} with barcodes; ${result.skippedGroceries} groceries skipped) — ${out}`);
  await closeMongo();
}

if (require.main === module) {
  main().catch(async e => {
    console.error(`[match-keys] Failed: ${e.message}`);
    await closeMongo().catch(() => {});
    process.exit(1);
  });
}
