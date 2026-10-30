/**
 * Fills retailers[].externalId (ASIN / SKU) and retailers[].canonicalUrl on stored products so the
 * push pipeline can match them by marketplace identity, and reports products that already share a
 * listing (existing duplicates) for manual review. It never merges or deletes products and never
 * sets stock status (legacy offers carry no stock evidence to derive it from).
 *
 * Usage (targets MONGODB_URI / MONGODB_DB — check which database before running live):
 *   npm run ecommerce:identity-backfill -- --dry-run
 *   npm run ecommerce:identity-backfill
 */
import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import { canonicalProductUrl, marketplaceIdFor } from '../services/product-identity';
import { assertSafeWriteTarget, closeMongo, getMongoDb } from '../shared/db/mongo';
import { ProductsCollection } from './push-pipeline';

export interface IdentityBackfillResult {
  scanned: number;
  updated: number;
  conflicts: number;
  duplicateGroups: Array<{ key: string; productIds: string[]; names: string[] }>;
}

/** Retailers with identity fields filled in, or null when nothing changes. */
export function withIdentity(retailers: any[]): any[] | null {
  let changed = false;
  const next = retailers.map(r => {
    const externalId = r.externalId ?? marketplaceIdFor(r.retailerId, r.productUrl) ?? undefined;
    const canonicalUrl = r.canonicalUrl ?? canonicalProductUrl(r.productUrl) ?? undefined;
    if (externalId === r.externalId && canonicalUrl === r.canonicalUrl) return r;
    changed = true;
    return { ...r, ...(externalId ? { externalId } : {}), ...(canonicalUrl ? { canonicalUrl } : {}) };
  });
  return changed ? next : null;
}

export async function backfillRetailerIdentity(col: ProductsCollection, dryRun: boolean): Promise<IdentityBackfillResult> {
  const docs = await col.find({}).toArray();
  const result: IdentityBackfillResult = { scanned: docs.length, updated: 0, conflicts: 0, duplicateGroups: [] };
  const owners = new Map<string, any[]>();

  for (const doc of docs) {
    const retailers = withIdentity(doc.retailers ?? []);
    for (const r of retailers ?? doc.retailers ?? []) {
      if (!r.externalId) continue;
      const key = `${r.retailerId}:${r.externalId}`;
      const list = owners.get(key) ?? [];
      if (!list.includes(doc)) list.push(doc);
      owners.set(key, list);
    }
    if (!retailers) continue;
    if (dryRun) { result.updated++; continue; }
    // Only if nobody edited the product since it was read
    const r = await col.updateOne({ _id: doc._id, updatedAt: doc.updatedAt ?? null }, { $set: { retailers } });
    if (r.matchedCount === 0) result.conflicts++;
    else if (r.modifiedCount > 0) result.updated++;
  }

  for (const [key, list] of owners) {
    if (list.length > 1) {
      result.duplicateGroups.push({ key, productIds: list.map(d => String(d._id)), names: list.map(d => String(d.name)) });
    }
  }
  return result;
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const { dbName } = assertSafeWriteTarget();
  console.log(`[identity-backfill] ${dryRun ? 'DRY RUN' : 'LIVE'} on ${dbName}.products_clean`);
  const col = (await getMongoDb()).collection('products_clean') as unknown as ProductsCollection;
  const result = await backfillRetailerIdentity(col, dryRun);

  const out = path.join(process.cwd(), 'output', `identity-backfill-${dryRun ? 'dry-run-' : ''}${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(result, null, 2));
  console.log(`[identity-backfill] scanned ${result.scanned}, ${dryRun ? 'would update' : 'updated'} ${result.updated}, conflicts ${result.conflicts}`);
  console.log(`[identity-backfill] ${result.duplicateGroups.length} listing(s) shared by more than one product — review ${out}`);
  await closeMongo();
}

if (require.main === module) {
  main().catch(async e => {
    console.error(`[identity-backfill] Failed: ${e.message}`);
    await closeMongo().catch(() => {});
    process.exit(1);
  });
}
