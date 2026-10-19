import { Collection, Db, IndexDescription } from 'mongodb';
import { getMongoDb } from '../../shared/db/mongo';
import {
  DiningMenuCategory,
  DiningMenuItem,
  DiningRestaurant,
  DiningScrapeRun,
} from '../dining.types';

// All dining data lives in these collections only — never in Module 1's ecommerce collections.
export const DINING_COLLECTIONS = {
  restaurants: 'dining_restaurants',
  menuCategories: 'dining_menu_categories',
  menuItems: 'dining_menu_items',
  scrapeRuns: 'dining_scrape_runs',
} as const;

export type DiningCollectionName = (typeof DINING_COLLECTIONS)[keyof typeof DINING_COLLECTIONS];

export interface DiningCollections {
  restaurants: Collection<DiningRestaurant>;
  menuCategories: Collection<DiningMenuCategory>;
  menuItems: Collection<DiningMenuItem>;
  scrapeRuns: Collection<DiningScrapeRun>;
}

export function getDiningCollections(db: Db): DiningCollections {
  return {
    restaurants: db.collection<DiningRestaurant>(DINING_COLLECTIONS.restaurants),
    menuCategories: db.collection<DiningMenuCategory>(DINING_COLLECTIONS.menuCategories),
    menuItems: db.collection<DiningMenuItem>(DINING_COLLECTIONS.menuItems),
    scrapeRuns: db.collection<DiningScrapeRun>(DINING_COLLECTIONS.scrapeRuns),
  };
}

export async function getDiningCollectionsFromEnv(): Promise<DiningCollections> {
  return getDiningCollections(await getMongoDb());
}

// ─── Indexes ─────────────────────────────────────────────────────────────────
// Optional platform IDs use *partial* unique indexes ($type: 'string') so documents
// without the ID are excluded from the constraint instead of colliding on `null`.

const HAS_STRING = { $type: 'string' };

export const DINING_INDEXES: Record<DiningCollectionName, IndexDescription[]> = {
  dining_restaurants: [
    { name: 'uniq_sourceKey', key: { sourceKey: 1 }, unique: true },
    {
      name: 'uniq_platform_platformRestaurantId',
      key: { platform: 1, platformRestaurantId: 1 },
      unique: true,
      partialFilterExpression: { platformRestaurantId: HAS_STRING },
    },
    {
      name: 'platform_slug',
      key: { platform: 1, slug: 1 },
      partialFilterExpression: { slug: HAS_STRING },
    },
    { name: 'platform_isActive', key: { platform: 1, isActive: 1 } },
  ],

  dining_menu_categories: [
    { name: 'uniq_sourceKey', key: { sourceKey: 1 }, unique: true },
    {
      name: 'uniq_restaurantId_platformCategoryId',
      key: { restaurantId: 1, platformCategoryId: 1 },
      unique: true,
      partialFilterExpression: { platformCategoryId: HAS_STRING },
    },
    { name: 'restaurantId_isActive_sortOrder', key: { restaurantId: 1, isActive: 1, sortOrder: 1 } },
  ],

  dining_menu_items: [
    { name: 'uniq_sourceKey', key: { sourceKey: 1 }, unique: true },
    {
      name: 'uniq_restaurantId_platformItemId',
      key: { restaurantId: 1, platformItemId: 1 },
      unique: true,
      partialFilterExpression: { platformItemId: HAS_STRING },
    },
    { name: 'restaurantId_isAvailable', key: { restaurantId: 1, isAvailable: 1 } },
    { name: 'restaurantId_isActive', key: { restaurantId: 1, isActive: 1 } },
    {
      name: 'categoryId',
      key: { categoryId: 1 },
      partialFilterExpression: { categoryId: { $type: 'objectId' } },
    },
  ],

  dining_scrape_runs: [
    { name: 'uniq_runId', key: { runId: 1 }, unique: true },
    // At most one *running* run per platform + locale + target URL (concurrent-run lock).
    {
      name: 'uniq_running_platform_locale_targetUrl',
      key: { platform: 1, locale: 1, targetUrl: 1 },
      unique: true,
      partialFilterExpression: { status: 'running' },
    },
    { name: 'platform_startedAt', key: { platform: 1, startedAt: -1 } },
    { name: 'targetUrl_startedAt', key: { targetUrl: 1, startedAt: -1 } },
    { name: 'status_startedAt', key: { status: 1, startedAt: -1 } },
  ],
};

export interface EnsureDiningIndexesResult {
  collection: DiningCollectionName;
  indexes: string[];
}

// Idempotent: re-running with unchanged definitions is a no-op. A changed definition under an
// existing name fails loudly (IndexOptionsConflict) rather than silently replacing an index.
export async function ensureDiningIndexes(db: Db): Promise<EnsureDiningIndexesResult[]> {
  const results: EnsureDiningIndexesResult[] = [];
  for (const [collection, specs] of Object.entries(DINING_INDEXES) as Array<[DiningCollectionName, IndexDescription[]]>) {
    const indexes = await db.collection(collection).createIndexes(specs);
    results.push({ collection, indexes });
  }
  return results;
}
