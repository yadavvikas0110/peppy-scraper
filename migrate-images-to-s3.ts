import dotenv from 'dotenv';
import path from 'path';
import { closeMongo, getMongoDb } from './src/shared/db/mongo';
import { isOwnS3Url, uploadImageFromUrl } from './src/utils/s3.util';

// Migrates scraped image URLs to our S3/CDN and rewrites them in MongoDB.
// Usage: npx ts-node migrate-images-to-s3.ts <target> [--dry-run] [--limit=N] [--concurrency=N]
// Failed downloads keep the old URL and are listed at the end. Safe to re-run (own URLs are skipped).

// Add a target per collection. `field` is a top-level string field holding the image URL.
const TARGETS: Record<string, { collection: string; field: string; folder: string }> = {
  'dining-restaurants': { collection: 'dining_restaurants', field: 'imageUrl', folder: 'dining/restaurants' },
  'dining-menu-items': { collection: 'dining_menu_items', field: 'imageUrl', folder: 'dining/menu-items' },
};

const flag = (name: string): string | undefined =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];

async function main(): Promise<void> {
  dotenv.config();
  // Fall back to the backend's S3 creds if the scraper .env doesn't have them.
  dotenv.config({ path: path.join(__dirname, '../shikhar-peppy-backend/.env') });

  const targetName = process.argv[2];
  const target = TARGETS[targetName];
  if (!target) {
    console.error(`Usage: migrate-images-to-s3.ts <${Object.keys(TARGETS).join('|')}> [--dry-run] [--limit=N] [--concurrency=N]`);
    process.exit(1);
  }
  const dryRun = process.argv.includes('--dry-run');
  const limit = Number(flag('limit') ?? 0) || Infinity;
  const concurrency = Number(flag('concurrency') ?? 5);

  const col = (await getMongoDb()).collection(target.collection);
  const query = { [target.field]: { $type: 'string', $nin: ['', null] } };
  const total = await col.countDocuments(query);
  console.log(`[images] ${target.collection}.${target.field}: ${total} docs with a URL${dryRun ? ' (dry run)' : ''}`);

  const stats = { migrated: 0, skipped: 0, failed: 0 };
  const failures: Array<{ id: string; url: string; error: string }> = [];
  let seen = 0;

  const process1 = async (doc: { _id: unknown; [k: string]: unknown }): Promise<void> => {
    const oldUrl = doc[target.field] as string;
    if (isOwnS3Url(oldUrl) || !/^https?:\/\//.test(oldUrl)) { stats.skipped++; return; }
    if (dryRun) { stats.migrated++; return; }
    try {
      const newUrl = await uploadImageFromUrl(oldUrl, { folder: target.folder });
      await col.updateOne({ _id: doc._id as never, [target.field]: oldUrl }, { $set: { [target.field]: newUrl } });
      stats.migrated++;
    } catch (e) {
      stats.failed++;
      failures.push({ id: String(doc._id), url: oldUrl, error: (e as Error).message });
    }
  };

  const cursor = col.find(query, { projection: { [target.field]: 1 } });
  let batch: Array<{ _id: unknown; [k: string]: unknown }> = [];
  const flush = async () => {
    await Promise.all(batch.map(process1));
    batch = [];
    console.log(`[images] ${seen}/${Math.min(total, limit)}  migrated=${stats.migrated} skipped=${stats.skipped} failed=${stats.failed}`);
  };
  for await (const doc of cursor) {
    if (seen >= limit) break;
    seen++;
    batch.push(doc);
    if (batch.length >= concurrency) await flush();
  }
  if (batch.length) await flush();

  console.log(`[images] Done. migrated=${stats.migrated} skipped=${stats.skipped} failed=${stats.failed}`);
  for (const f of failures) console.log(`  FAILED ${f.id} ${f.url} — ${f.error}`);
  await closeMongo();
}

main().catch((e) => { console.error(e); process.exit(1); });
