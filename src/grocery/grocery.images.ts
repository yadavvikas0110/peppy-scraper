import { Semaphore } from '../utils/semaphore';
import { isOwnS3Url } from '../utils/s3.util';
import type { BundledProduct } from '../parsers/types';

/**
 * Grocery counterpart of dining.images.ts. Grocery parsers capture the platform's own image URLs
 * (Talabat / Noon Minutes / Deliveroo CDNs). Before persistence we re-host every image on our own
 * S3/CDN so the storefront never hot-links a retailer CDN (which can rotate, expire, or block).
 *
 * Mirrors the dining rules exactly:
 *   • uploads are content-hashed (same image is stored once — see uploadBufferToS3),
 *   • already-ours URLs are skipped (idempotent across re-scrapes),
 *   • a failed upload DROPS that URL (never keeps the platform URL); the DB merge preserves any
 *     already-stored CDN URL, and the next scrape retries.
 *
 * Rewrites `bundle.images[]` and every `bundle.retailers[].imageUrl` IN PLACE.
 */

const GROCERY_IMAGE_FOLDER = 'grocery/products';
const CONCURRENCY = 8;

export type ImageUploader = (sourceUrl: string, folder: string) => Promise<string>;

export async function uploadGroceryImages(
  bundles: BundledProduct[],
  upload: ImageUploader,
  logger: Pick<Console, 'warn'> = console,
): Promise<{ uploaded: number; failed: number; skipped: number }> {
  const sem = new Semaphore(CONCURRENCY);
  const cache = new Map<string, Promise<string | undefined>>();
  const stats = { uploaded: 0, failed: 0, skipped: 0 };

  const resolve = (url: string): Promise<string | undefined> => {
    if (!url) return Promise.resolve(undefined);
    if (isOwnS3Url(url)) {
      stats.skipped++;
      return Promise.resolve(url); // already on our bucket — keep as-is
    }
    let p = cache.get(url);
    if (!p) {
      p = sem
        .wrap(() => upload(url, GROCERY_IMAGE_FOLDER))
        .then(next => {
          stats.uploaded++;
          return next;
        })
        .catch(err => {
          stats.failed++;
          logger.warn(`[grocery] image upload failed (${url}): ${(err as Error)?.message ?? err}`);
          return undefined;
        });
      cache.set(url, p);
    }
    return p;
  };

  await Promise.all(
    bundles.map(async bundle => {
      // 1. bundle-level images[] (this is what becomes product.images)
      if (bundle.images?.length) {
        const migrated = await Promise.all(bundle.images.map(u => resolve(u)));
        bundle.images = migrated.filter((u): u is string => !!u);
      }
      // 2. each retailer offer's imageUrl
      await Promise.all(
        bundle.retailers.map(async retailer => {
          if (retailer.imageUrl) {
            const next = await resolve(retailer.imageUrl);
            retailer.imageUrl = next ?? null;
          }
        }),
      );
    }),
  );

  return stats;
}
