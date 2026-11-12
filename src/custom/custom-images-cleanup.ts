/**
 * Removes non-product images (page banners, payment badges, other products' thumbnails) that
 * earlier page-wide <img> scraping stored on products_clean documents. New custom-scraper
 * writes never add them (structured-data galleries only), but the push keeps an existing
 * document's images, so already-stored junk needs this one-off cleanup.
 *
 *   npm run custom:images:clean:dry-run     # report only
 *   npm run custom:images:clean             # apply
 *
 * Same write target and allowlist as the custom scraper (CUSTOM_MONGODB_URI, CUSTOM_DB_ALLOWLIST).
 * Only images matching an explicit rule below are removed; a document is never left without images.
 */
import { MongoClient } from 'mongodb';
import { customDbTarget, describeTarget } from './custom.db';
import { redactMongoUri } from '../shared/db/mongo';

export interface ImageRule {
  retailerId: string;
  /** Always junk for this retailer */
  drop: RegExp[];
  /** Junk only when the document also has at least one image matching `keepWhenPresent` */
  dropIfOwnImages?: { drop: RegExp; keepWhenPresent: RegExp };
}

export const IMAGE_RULES: ImageRule[] = [
  {
    retailerId: 'mumzworld',
    // CMS banners and badges (payment.png, 30-AWARDS-*.jpg) repeated on every product page
    drop: [/^https?:\/\/[^/]*mumzworld\.com\/media\/wysiwyg\//i],
    // Resized cache thumbnails are the "related products" carousel; the product's own gallery
    // is served from /media/catalog/product/<file> without /cache/
    dropIfOwnImages: {
      drop: /^https?:\/\/[^/]*mumzworld\.com\/media\/catalog\/product\/cache\//i,
      keepWhenPresent: /^https?:\/\/[^/]*mumzworld\.com\/media\/catalog\/product\/(?!cache\/)/i,
    },
  },
];

/** Cleaned image list for a document, or null when nothing changes. Never returns an empty list. */
export function cleanImages(images: string[], retailerIds: string[], rules: ImageRule[] = IMAGE_RULES): string[] | null {
  const applicable = rules.filter(r => retailerIds.includes(r.retailerId));
  if (!applicable.length || !images?.length) return null;
  let kept = images.filter(u => !applicable.some(r => r.drop.some(re => re.test(u))));
  for (const r of applicable) {
    const d = r.dropIfOwnImages;
    if (d && kept.some(u => d.keepWhenPresent.test(u))) kept = kept.filter(u => !d.drop.test(u));
  }
  if (kept.length === images.length || kept.length === 0) return null;
  return kept;
}

async function main(): Promise<number> {
  const dryRun = process.argv.includes('--dry-run');
  const target = customDbTarget();
  console.log(`[images] ${dryRun ? 'DRY RUN' : 'LIVE'} on ${describeTarget(target)}`);
  const client = new MongoClient(target.uri, { serverSelectionTimeoutMS: 15000 });
  try {
    await client.connect();
    const col = client.db(target.dbName).collection('products_clean');
    const docs = await col.find({ 'retailers.retailerId': { $in: IMAGE_RULES.map(r => r.retailerId) } })
      .project({ name: 1, images: 1, updatedAt: 1, 'retailers.retailerId': 1 }).toArray();

    let changed = 0, removed = 0, conflicts = 0;
    const now = new Date();
    for (const d of docs) {
      const next = cleanImages(d.images ?? [], (d.retailers ?? []).map((r: any) => r.retailerId));
      if (!next) continue;
      changed++;
      removed += d.images.length - next.length;
      if (changed <= 5) console.log(`  • ${String(d.name).slice(0, 60)}: ${d.images.length} → ${next.length} images`);
      if (dryRun) continue;
      // Optimistic concurrency, as in the push pipeline: skip a document edited meanwhile
      const r = await col.updateOne({ _id: d._id, updatedAt: d.updatedAt ?? null }, { $set: { images: next, updatedAt: now } });
      if (r.matchedCount === 0) conflicts++;
    }
    console.log(`[images] scanned ${docs.length}, ${dryRun ? 'would change' : 'changed'} ${changed - conflicts} document(s), removing ${removed} image(s)${conflicts ? `, ${conflicts} skipped (edited concurrently)` : ''}`);
    return 0;
  } catch (e: any) {
    console.error(`[images] ${redactMongoUri(String(e?.message ?? e), target.uri)}`);
    return 1;
  } finally {
    await client.close().catch(() => {});
  }
}

if (require.main === module) main().then(code => process.exit(code));
