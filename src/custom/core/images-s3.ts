import { Semaphore } from '../../utils/semaphore';
import type { ProductsCollection } from '../../cron/push-pipeline';

/**
 * Re-hosts product images on our own S3/CDN (src/utils/s3.util.ts), the same way the existing
 * products_clean migration does (folder products/images, content-hashed keys):
 *   • already-ours URLs are kept as they are (idempotent across runs),
 *   • a failed upload DROPS that image, like the dining pipeline (we never store a retailer URL);
 *     the next scrape retries it. Permanent failures (404/410, not an image) are also recorded in
 *     `permanentFailures`, so stored documents can remove those dead retailer URLs.
 */

export const PRODUCT_IMAGE_FOLDER = 'products/images';

export type ImageUploader = (sourceUrl: string, folder: string) => Promise<string>;

export interface RehostStats { uploaded: number; reused: number; failed: number; alreadyOwn: number }

export class ImageRehoster {
  private cache = new Map<string, Promise<string | null>>();
  private sem: Semaphore;
  readonly stats: RehostStats = { uploaded: 0, reused: 0, failed: 0, alreadyOwn: 0 };
  /** source URL → our URL, for every successful upload this run */
  readonly mapping = new Map<string, string>();
  /** Retailer URLs that can never be uploaded (404/410, or the response is not an image) */
  readonly permanentFailures = new Set<string>();

  constructor(
    private readonly upload: ImageUploader,
    private readonly isOwn: (url: string) => boolean,
    concurrency = 4,
    private readonly logger: Pick<Console, 'warn'> = console,
  ) {
    this.sem = new Semaphore(concurrency);
  }

  /** Our URL, or null when the upload failed (the image is dropped). */
  rehost(url: string): Promise<string | null> {
    if (!url) return Promise.resolve(null);
    if (this.isOwn(url)) { this.stats.alreadyOwn++; return Promise.resolve(url); }
    const cached = this.cache.get(url);
    if (cached) { this.stats.reused++; return cached; }
    const p = this.sem.wrap(() => this.upload(url, PRODUCT_IMAGE_FOLDER))
      .then(next => { this.stats.uploaded++; this.mapping.set(url, next); return next; })
      .catch(e => {
        this.stats.failed++;
        const permanent = isPermanentImageFailure(e);
        if (permanent) this.permanentFailures.add(url);
        this.logger.warn(`[custom:s3] upload failed, image dropped${permanent ? ' (permanent)' : ''} (${url}): ${e?.message ?? e}`);
        return null;
      });
    this.cache.set(url, p);
    return p;
  }

  /** Uploaded URLs in the original order; failed images are left out, duplicates removed. */
  async rehostAll(urls: string[]): Promise<string[]> {
    const out = await Promise.all(urls.map(u => this.rehost(u)));
    return out.filter((u, i): u is string => !!u && out.indexOf(u) === i);
  }
}

/** 404/410 from the retailer, or a non-image response: retrying will not help. */
export function isPermanentImageFailure(e: any): boolean {
  const status = e?.response?.status;
  return status === 404 || status === 410 || /^Not an image/.test(String(e?.message ?? ''));
}

/**
 * Stored documents keep their existing images on merge, so URLs re-hosted this run are swapped
 * in place on every document that still holds the retailer URL (images[] and retailers[].imageUrl).
 * URLs in `drop` (permanent failures) are removed — but a gallery is never emptied: a document
 * whose every image would go keeps them and is counted in `keptLastImage`.
 * Only exact URLs change; order is kept; optimistic concurrency on updatedAt.
 */
export async function replaceStoredImageUrls(
  col: ProductsCollection,
  mapping: Map<string, string>,
  now: Date = new Date(),
  drop: Set<string> = new Set(),
): Promise<{ documents: number; images: number; conflicts: number; dropped: number; keptLastImage: number }> {
  const result = { documents: 0, images: 0, conflicts: 0, dropped: 0, keptLastImage: 0 };
  const sources = [...new Set([...mapping.keys(), ...drop])];
  for (let i = 0; i < sources.length; i += 200) {
    const batch = sources.slice(i, i + 200);
    const docs = await col.find({ $or: [{ images: { $in: batch } }, { 'retailers.imageUrl': { $in: batch } }] }).toArray();
    for (const d of docs) {
      let changed = 0;
      const swapped: string[] = (d.images ?? []).map((u: string) => { const n = mapping.get(u); if (n) changed++; return n ?? u; });
      let images = swapped.filter(u => !drop.has(u));
      let dropped = swapped.length - images.length;
      if (!images.length && swapped.length) { images = swapped; dropped = 0; result.keptLastImage++; }
      const keep = new Set(images);
      const retailers = (d.retailers ?? []).map((r: any) => {
        if (!r?.imageUrl) return r;
        const n = mapping.get(r.imageUrl);
        if (n) { changed++; return { ...r, imageUrl: n }; }
        if (drop.has(r.imageUrl) && !keep.has(r.imageUrl)) { dropped++; return { ...r, imageUrl: images[0] ?? null }; }
        return r;
      });
      if (!changed && !dropped) continue;
      const deduped = images.filter((u: string, idx: number) => images.indexOf(u) === idx);
      const r = await col.updateOne({ _id: d._id, updatedAt: d.updatedAt ?? null }, { $set: { images: deduped, retailers, updatedAt: now } });
      if (r.matchedCount === 0) { result.conflicts++; continue; }
      result.documents++;
      result.images += changed;
      result.dropped += dropped;
    }
  }
  return result;
}
