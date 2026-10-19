import { Semaphore } from '../utils/semaphore';
import type { DiningMappedMenu } from './platforms/platform.mapper';

const RESTAURANT_FOLDER = 'dining/restaurants';
const MENU_ITEM_FOLDER = 'dining/menu-items';
const CONCURRENCY = 8;

export type ImageUploader = (sourceUrl: string, folder: string) => Promise<string>;

// Replaces every platform image URL on the mapped menu with our S3/CDN URL, in place.
// A failed upload removes the field (never keeps the platform URL): persistence then leaves any
// already-stored CDN URL untouched, and the next scrape retries.
export async function uploadMenuImages(
  menu: DiningMappedMenu,
  upload: ImageUploader,
  logger: Pick<Console, 'warn'> = console
): Promise<{ uploaded: number; failed: number }> {
  const sem = new Semaphore(CONCURRENCY);
  const cache = new Map<string, Promise<string | undefined>>();
  const stats = { uploaded: 0, failed: 0 };

  const resolve = (url: string, folder: string): Promise<string | undefined> => {
    const key = `${folder}|${url}`;
    let p = cache.get(key);
    if (!p) {
      p = sem
        .wrap(() => upload(url, folder))
        .then(n => { stats.uploaded++; return n; })
        .catch(err => {
          stats.failed++;
          logger.warn(`[dining] Image upload failed (${url}): ${(err as Error)?.message ?? err}`);
          return undefined;
        });
      cache.set(key, p);
    }
    return p;
  };

  const targets: Array<{ holder: { imageUrl?: string }; folder: string }> = [];
  if (menu.restaurant.imageUrl) targets.push({ holder: menu.restaurant, folder: RESTAURANT_FOLDER });
  for (const item of menu.items) if (item.imageUrl) targets.push({ holder: item, folder: MENU_ITEM_FOLDER });

  await Promise.all(targets.map(async ({ holder, folder }) => {
    const next = await resolve(holder.imageUrl as string, folder);
    if (next) holder.imageUrl = next;
    else delete holder.imageUrl;
  }));
  return stats;
}
