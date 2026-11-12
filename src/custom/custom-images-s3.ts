/**
 * Moves the images of existing products_clean documents of the custom-scraper retailers
 * (Namshi, Mumzworld, Jumbo, Letstango) to our S3/CDN. New pushes re-host their own images;
 * this covers documents written before (by earlier runs or the Bright Data pipeline).
 *
 *   npm run custom:images:s3:dry-run              # count what would move
 *   npm run custom:images:s3 -- --limit 100       # migrate (optionally the first N documents)
 *
 * Same write target and allowlist as the custom scraper. Images already on S3/CDN are skipped;
 * a failed upload keeps the retailer URL (re-run to retry). Requires S3_* and CDN_URL.
 */
import { MongoClient } from 'mongodb';
import { customDbTarget, describeTarget } from './custom.db';
import { CUSTOM_SITES } from './core/types';
import { ImageRehoster, replaceStoredImageUrls } from './core/images-s3';
import { isOwnS3Url, isS3Configured, uploadImageFromUrl } from '../utils/s3.util';
import { redactMongoUri } from '../shared/db/mongo';

const isRemote = (u: unknown): u is string => typeof u === 'string' && /^https?:\/\//.test(u) && !isOwnS3Url(u);

async function main(): Promise<number> {
  const dryRun = process.argv.includes('--dry-run');
  const i = process.argv.indexOf('--limit');
  const limit = i >= 0 ? parseInt(process.argv[i + 1], 10) : 0;
  if (!dryRun && !isS3Configured()) {
    console.error('[images:s3] S3 is not configured (S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY, S3_BUCKET, S3_REGION, CDN_URL).');
    return 2;
  }
  const target = customDbTarget();
  console.log(`[images:s3] ${dryRun ? 'DRY RUN' : 'LIVE'} on ${describeTarget(target)}`);
  const client = new MongoClient(target.uri, { serverSelectionTimeoutMS: 15000 });
  try {
    await client.connect();
    const col = client.db(target.dbName).collection('products_clean');
    const cursor = col.find({ 'retailers.retailerId': { $in: [...CUSTOM_SITES] } }).project({ images: 1, 'retailers.imageUrl': 1 });
    if (limit > 0) cursor.limit(limit);
    const docs = await cursor.toArray();
    const urls = new Set<string>();
    let docsWithRemote = 0;
    for (const d of docs) {
      const remote = [...(d.images ?? []), ...(d.retailers ?? []).map((r: any) => r.imageUrl)].filter(isRemote);
      if (remote.length) docsWithRemote++;
      remote.forEach(u => urls.add(u));
    }
    console.log(`[images:s3] ${docs.length} documents scanned, ${docsWithRemote} with retailer-hosted images, ${urls.size} distinct image URLs to move`);
    if (dryRun || !urls.size) return 0;

    const rehoster = new ImageRehoster((url, folder) => uploadImageFromUrl(url, { folder }), isOwnS3Url, 8);
    let done = 0;
    await Promise.all([...urls].map(async u => {
      await rehoster.rehost(u);
      if (++done % 200 === 0) console.log(`[images:s3] ${done}/${urls.size} images processed`);
    }));
    const swapped = await replaceStoredImageUrls(col as any, rehoster.mapping);
    console.log(`[images:s3] uploaded ${rehoster.stats.uploaded}, failed ${rehoster.stats.failed} (kept retailer URL); ${swapped.images} URL(s) switched on ${swapped.documents} document(s)${swapped.conflicts ? `, ${swapped.conflicts} skipped (edited concurrently — re-run)` : ''}`);
    return rehoster.stats.failed ? 1 : 0;
  } catch (e: any) {
    console.error(`[images:s3] ${redactMongoUri(String(e?.message ?? e), target.uri)}`);
    return 1;
  } finally {
    await client.close().catch(() => {});
  }
}

if (require.main === module) main().then(code => process.exit(code));
