import { Collection, MongoClient } from 'mongodb';
import { BundledProduct } from '../../parsers/types';
import { getMongoConfig, redactMongoUri } from '../../shared/db/mongo';
import {
  mergeDuplicateBundles,
  toMongoProduct,
  writeProducts,
  type ProductsCollection,
  type MongoProduct,
} from '../../cron/push-pipeline';
import { GROCERY_COLLECTIONS, ensureGroceryIndexes } from './grocery.collections';
import { isS3Configured, uploadImageFromUrl } from '../../utils/s3.util';
import { uploadGroceryImages } from '../grocery.images';

export interface GroceryPushResult {
  mongoInserted: number;
  mongoUpdated: number;
  matchedExisting: number;
  skipped: number;
  /** Kept for call-site compatibility with pushToDatabase(); grocery does not run shopping mapping. */
  chromaVectors: number;
  mapping: { ok: boolean; message: string };
  errors: string[];
}

let indexesEnsured = false;

/**
 * Grocery counterpart of pushToDatabase(): writes BundledProducts to the dedicated
 * `grocery_products` collection (never `products_clean`). Reuses the exact same dedupe + document
 * mapping + upsert logic as the shopping pipeline, but:
 *   • targets the grocery collection,
 *   • skips ChromaDB (grocery search is a later phase),
 *   • skips the shopping ingest-mapping call (variant grouping / shopping taxonomy don't apply).
 *
 * Dedupe and upsert are idempotent, so re-runs refresh prices without creating duplicates.
 */
export async function pushGroceryToDatabase(
  rawBundles: BundledProduct[],
  opts: { collection?: ProductsCollection; now?: Date } = {},
): Promise<GroceryPushResult> {
  const errors: string[] = [];
  const now = opts.now ?? new Date();

  const bundles = mergeDuplicateBundles(rawBundles);

  // Re-host every scraped platform image on our own S3/CDN before persisting (mirrors dining).
  // Gated on S3 config so local/dev runs without S3 creds still work (they keep platform URLs).
  if (isS3Configured()) {
    const imgStats = await uploadGroceryImages(bundles, (url, folder) => uploadImageFromUrl(url, { folder }));
    console.log(
      `[grocery-push] images → S3: ${imgStats.uploaded} uploaded, ${imgStats.skipped} already-ours, ${imgStats.failed} failed`,
    );
  } else {
    console.warn('[grocery-push] S3 not configured — keeping platform image URLs (set S3_* env to re-host on our bucket)');
  }

  const products = bundles.map(toMongoProduct).filter((p): p is MongoProduct => p !== null);
  console.log(`[grocery-push] ${rawBundles.length} bundles → ${bundles.length} deduped → ${products.length} valid`);

  const run = async (col: ProductsCollection) => {
    return products.length
      ? writeProducts(col, products, now)
      : { inserted: 0, updated: 0, matched: 0, conflicts: 0, skipped: 0 };
  };

  let written;
  if (opts.collection) {
    written = await run(opts.collection);
  } else {
    written = await withGroceryCollection(col => run(col as unknown as ProductsCollection));
  }

  console.log(
    `[grocery-push] ${written.inserted} new, ${written.updated} updated, ${written.skipped} skipped, ${written.conflicts} conflict(s) → ${GROCERY_COLLECTIONS.products}`,
  );
  if (written.conflicts) errors.push(`${written.conflicts} write conflict(s) with concurrent edits`);

  return {
    mongoInserted: written.inserted,
    mongoUpdated: written.updated,
    matchedExisting: written.matched,
    skipped: written.skipped + (bundles.length - products.length),
    chromaVectors: 0,
    mapping: { ok: true, message: 'grocery collection — shopping ingest-mapping not applicable' },
    errors,
  };
}

async function withGroceryCollection<T>(fn: (col: Collection) => Promise<T>): Promise<T> {
  const { uri, dbName } = getMongoConfig();
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 15000 });
  try {
    await client.connect();
    const db = client.db(dbName);
    if (!indexesEnsured) {
      await ensureGroceryIndexes(db).catch((e: any) =>
        console.warn(`[grocery-push] ensure indexes failed (non-fatal): ${e?.message ?? e}`),
      );
      indexesEnsured = true;
    }
    console.log(`[grocery-push] Target: ${dbName}.${GROCERY_COLLECTIONS.products}`);
    return await fn(db.collection(GROCERY_COLLECTIONS.products));
  } catch (e: any) {
    throw new Error(redactMongoUri(String(e?.message ?? e), uri));
  } finally {
    await client.close().catch(() => {});
  }
}
