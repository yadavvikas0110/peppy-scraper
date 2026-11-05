/**
 * Backfill: re-host EXISTING grocery_products images on our own S3/CDN.
 *
 * New scrapes already re-host images at push time (see grocery-push.ts + grocery.images.ts), but
 * the ~60k products scraped before that change still carry the platform's own image URLs. The push
 * merge keeps existing images on re-scrape, so those never migrate on their own — this one-off
 * backfill fixes them.
 *
 * SAFE + IDEMPOTENT:
 *   • Only docs that still have at least one non-ours image URL are touched.
 *   • Already-ours URLs (isOwnS3Url) are left as-is, so re-running is a cheap no-op.
 *   • A failed upload drops that URL (mirrors the scrape-time rule); the doc keeps whatever uploaded.
 *   • Uploads are content-hashed, so the same image is stored once.
 *
 * USAGE (from peppy-scraper/, needs S3_* + MONGODB_URI in env):
 *   npm run grocery:images:backfill:dry-run    # count docs/images needing migration, NO writes
 *   npm run grocery:images:backfill            # LIVE: upload + update docs
 */
import 'dotenv/config';
import { Collection, MongoClient } from 'mongodb';
import { getMongoConfig, redactMongoUri } from '../shared/db/mongo';
import { isS3Configured, isOwnS3Url, uploadImageFromUrl } from '../utils/s3.util';
import { GROCERY_COLLECTIONS } from './db/grocery.collections';

const FOLDER = 'grocery/products';
const BATCH = 200;

const dryRun = process.argv.includes('--dry-run');

interface GroceryDoc {
  _id: any;
  images?: string[];
  retailers?: Array<{ imageUrl?: string | null }>;
}

const needsMigration = (url?: string | null): url is string => !!url && !isOwnS3Url(url);

async function main(): Promise<void> {
  if (!dryRun && !isS3Configured()) {
    throw new Error('S3 not configured (set S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY, S3_BUCKET) — required for a live backfill.');
  }

  const { uri, dbName } = getMongoConfig();
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 20000 });
  await client.connect();
  const col: Collection<GroceryDoc> = client.db(dbName).collection(GROCERY_COLLECTIONS.products);
  console.log(`[grocery-images-backfill] ${dryRun ? 'DRY RUN — no writes' : 'LIVE'} → ${dbName}.${GROCERY_COLLECTIONS.products}`);

  // Candidate docs: any image URL that isn't already on our bucket. We can't express isOwnS3Url in a
  // query, so we fetch docs that have any image and filter in code.
  const query = { $or: [{ images: { $exists: true, $ne: [] } }, { 'retailers.imageUrl': { $exists: true, $ne: null } }] };
  const total = await col.countDocuments(query as any);
  console.log(`[grocery-images-backfill] docs with any image: ${total}`);

  const cache = new Map<string, Promise<string | undefined>>();
  const migrate = (url: string): Promise<string | undefined> => {
    let p = cache.get(url);
    if (!p) {
      p = uploadImageFromUrl(url, { folder: FOLDER })
        .then(next => next)
        .catch(err => {
          console.warn(`[grocery-images-backfill] upload failed (${url}): ${(err as Error)?.message ?? err}`);
          return undefined;
        });
      cache.set(url, p);
    }
    return p;
  };

  let scanned = 0, docsNeeding = 0, docsUpdated = 0, urlsToMigrate = 0, urlsUploaded = 0;
  const cursor = col.find(query as any);

  for await (const doc of cursor) {
    scanned++;
    const imgs = (doc.images ?? []).filter(Boolean);
    const retailerImgs = (doc.retailers ?? []).map(r => r.imageUrl).filter((u): u is string => !!u);
    const pending = [...imgs, ...retailerImgs].filter(needsMigration);
    if (!pending.length) continue;
    docsNeeding++;
    urlsToMigrate += new Set(pending).size;

    if (dryRun) {
      if (docsNeeding <= 5) console.log(`[grocery-images-backfill] e.g. ${doc._id}: ${new Set(pending).size} image(s) to migrate`);
      continue;
    }

    // Rewrite images[]
    let newImages = imgs;
    if (imgs.some(needsMigration)) {
      const mapped = await Promise.all(imgs.map(u => (needsMigration(u) ? migrate(u) : Promise.resolve(u))));
      newImages = mapped.filter((u): u is string => !!u);
      urlsUploaded += mapped.filter((u, i) => u && needsMigration(imgs[i])).length;
    }
    // Rewrite retailers[].imageUrl
    const newRetailers = await Promise.all(
      (doc.retailers ?? []).map(async r => {
        if (needsMigration(r.imageUrl)) {
          const next = await migrate(r.imageUrl);
          return { ...r, imageUrl: next ?? null };
        }
        return r;
      }),
    );

    await col.updateOne({ _id: doc._id }, { $set: { images: newImages, retailers: newRetailers } });
    docsUpdated++;
    if (docsUpdated % BATCH === 0) console.log(`[grocery-images-backfill] updated ${docsUpdated} docs…`);
  }

  console.log(
    `[grocery-images-backfill] scanned=${scanned} docsNeeding=${docsNeeding} urlsToMigrate=${urlsToMigrate}` +
      (dryRun ? ' (DRY RUN — re-run without --dry-run to apply)' : ` docsUpdated=${docsUpdated} urlsUploaded=${urlsUploaded}`),
  );
  await client.close();
}

main().catch(err => {
  const { uri } = (() => { try { return getMongoConfig(); } catch { return { uri: '' }; } })();
  console.error('[grocery-images-backfill] fatal:', redactMongoUri(String(err?.stack ?? err), uri));
  process.exit(1);
});
