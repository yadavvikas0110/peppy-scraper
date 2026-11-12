import { Semaphore } from '../../utils/semaphore';
import type { ProductsCollection } from '../../cron/push-pipeline';

/**
 * Re-hosts product images on our own S3/CDN (src/utils/s3.util.ts), the same way the existing
 * products_clean migration does (folder products/images, content-hashed keys):
 *   • already-ours URLs are kept as they are (idempotent across runs),
 *   • a failed upload keeps the retailer URL (never drops an image) and is retried next run.
 */

export const PRODUCT_IMAGE_FOLDER = 'products/images';

export type ImageUploader = (sourceUrl: string, folder: string) => Promise<string>;

export interface RehostStats { uploaded: number; reused: number; failed: number; alreadyOwn: number }

export class ImageRehoster {
  private cache = new Map<string, Promise<string>>();
  private sem: Semaphore;
  readonly stats: RehostStats = { uploaded: 0, reused: 0, failed: 0, alreadyOwn: 0 };
  /** source URL → our URL, for every successful upload this run */
  readonly mapping = new Map<string, string>();

  constructor(
    private readonly upload: ImageUploader,
    private readonly isOwn: (url: string) => boolean,
    concurrency = 4,
    private readonly logger: Pick<Console, 'warn'> = console,
  ) {
    this.sem = new Semaphore(concurrency);
  }

  rehost(url: string): Promise<string> {
    if (!url) return Promise.resolve(url);
    if (this.isOwn(url)) { this.stats.alreadyOwn++; return Promise.resolve(url); }
    const cached = this.cache.get(url);
    if (cached) { this.stats.reused++; return cached; }
    const p = this.sem.wrap(() => this.upload(url, PRODUCT_IMAGE_FOLDER))
      .then(next => { this.stats.uploaded++; this.mapping.set(url, next); return next; })
      .catch(e => {
        this.stats.failed++;
        this.logger.warn(`[custom:s3] upload failed, keeping retailer URL (${url}): ${e?.message ?? e}`);
        return url;
      });
    this.cache.set(url, p);
    return p;
  }

  rehostAll(urls: string[]): Promise<string[]> {
    return Promise.all(urls.map(u => this.rehost(u)));
  }
}

/**
 * Stored documents keep their existing images on merge, so URLs re-hosted this run are swapped
 * in place on every document that still holds the retailer URL (images[] and retailers[].imageUrl).
 * Only exact URLs from `mapping` change; order is kept; optimistic concurrency on updatedAt.
 */
export async function replaceStoredImageUrls(
  col: ProductsCollection,
  mapping: Map<string, string>,
  now: Date = new Date(),
): Promise<{ documents: number; images: number; conflicts: number }> {
  const result = { documents: 0, images: 0, conflicts: 0 };
  const sources = [...mapping.keys()];
  for (let i = 0; i < sources.length; i += 200) {
    const batch = sources.slice(i, i + 200);
    const docs = await col.find({ $or: [{ images: { $in: batch } }, { 'retailers.imageUrl': { $in: batch } }] }).toArray();
    for (const d of docs) {
      let changed = 0;
      const images = (d.images ?? []).map((u: string) => { const n = mapping.get(u); if (n) changed++; return n ?? u; });
      const retailers = (d.retailers ?? []).map((r: any) => {
        const n = r?.imageUrl ? mapping.get(r.imageUrl) : undefined;
        if (n) changed++;
        return n ? { ...r, imageUrl: n } : r;
      });
      if (!changed) continue;
      const deduped = images.filter((u: string, idx: number) => images.indexOf(u) === idx);
      const r = await col.updateOne({ _id: d._id, updatedAt: d.updatedAt ?? null }, { $set: { images: deduped, retailers, updatedAt: now } });
      if (r.matchedCount === 0) { result.conflicts++; continue; }
      result.documents++;
      result.images += changed;
    }
  }
  return result;
}
