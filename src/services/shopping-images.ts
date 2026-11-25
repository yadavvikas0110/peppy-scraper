import type { BundledProduct } from '../parsers/types';
import { ImageRehoster, ImageUploader, RehostStats } from '../custom/core/images-s3';
import { isOwnS3Url, isS3Configured, uploadBufferToS3, uploadImageFromUrl } from '../utils/s3.util';
import { fetchImageViaScrapeDo, needsScrapeDoForImage } from './scrapedo-images';

/**
 * Shopping counterpart of grocery.images.ts / dining.images.ts: before products are written,
 * every gallery image and every offer image is re-hosted on our S3/CDN (content-hashed keys,
 * folder products/images — the same folder the products_clean migration uses).
 *
 *  • A URL already on our bucket/CDN is kept (re-scrapes are idempotent).
 *  • A failed upload DROPS that image — a retailer URL is never stored. A product left with no
 *    image is not inserted (toMongoProduct rejects it); an existing product keeps its stored gallery.
 *  • The same source URL is uploaded once per run (shared rehoster cache), with bounded concurrency.
 *
 * Rewrites `bundle.images` and each `retailers[].imageUrl` in place.
 */

export interface BundleImageStats extends RehostStats {
  /** bundles that lost every image (they will not be inserted as new products) */
  bundlesWithoutImages: number;
}

export async function rehostBundleImages(bundles: BundledProduct[], rehoster: ImageRehoster): Promise<BundleImageStats> {
  let bundlesWithoutImages = 0;
  await Promise.all(bundles.map(async bundle => {
    const gallery = (bundle.images ?? []).filter(Boolean);
    bundle.images = gallery.length ? await rehoster.rehostAll(gallery) : [];
    await Promise.all(bundle.retailers.map(async r => {
      if (!r.imageUrl) return;
      r.imageUrl = (await rehoster.rehost(r.imageUrl)) ?? bundle.images[0] ?? null;
    }));
    // A retailer image that uploaded fills an empty gallery
    if (!bundle.images.length) {
      const fromOffers = bundle.retailers.map(r => r.imageUrl).filter((u): u is string => !!u && rehoster.isOwnUrl(u));
      bundle.images = [...new Set(fromOffers)];
    }
    if (!bundle.images.length) bundlesWithoutImages++;
  }));
  return { ...rehoster.stats, bundlesWithoutImages };
}

/**
 * Direct download for most CDNs; through Scrape.do for hosts that refuse direct downloads
 * (SCRAPE_DO_IMAGE_HOSTS, default Carrefour's cdn.mafrservices.com — about 1 credit per image).
 */
export function createImageUploader(deps: {
  direct?: ImageUploader;
  viaScrapeDo?: (url: string) => Promise<{ body: Buffer; contentType: string }>;
  upload?: (body: Buffer, contentType: string, folder: string) => Promise<string>;
  env?: NodeJS.ProcessEnv;
} = {}): ImageUploader {
  const direct = deps.direct ?? ((url, folder) => uploadImageFromUrl(url, { folder }));
  const viaScrapeDo = deps.viaScrapeDo ?? (url => fetchImageViaScrapeDo(url));
  const upload = deps.upload ?? ((body, type, folder) => uploadBufferToS3(body, type, { folder }));
  return async (sourceUrl, folder) => {
    if (!needsScrapeDoForImage(sourceUrl, deps.env ?? process.env)) return direct(sourceUrl, folder);
    const { body, contentType } = await viaScrapeDo(sourceUrl);
    return upload(body, contentType, folder);
  };
}

const s3Uploader: ImageUploader = createImageUploader();

/** Rehoster wired to our S3 bucket. Throws when S3 is not configured — products must not be written without it. */
export function createS3Rehoster(concurrency = Number(process.env.SHOPPING_IMAGE_CONCURRENCY) || 6): ImageRehoster {
  if (!isS3Configured()) {
    throw new Error('S3 is not configured (S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY, S3_BUCKET) — shopping products are only written with images on our S3');
  }
  return new ImageRehoster(s3Uploader, isOwnS3Url, Math.max(1, concurrency));
}
