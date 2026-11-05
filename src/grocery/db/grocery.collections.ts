import { Collection, Db, IndexDescription } from 'mongodb';
import { getMongoDb } from '../../shared/db/mongo';

// All grocery data lives in these collections only — NEVER in the shopping `products_clean`
// collection. This mirrors the dining module's isolation (see dining/db/dining.collections.ts).
export const GROCERY_COLLECTIONS = {
  /** Canonical grocery product + cross-retailer offers (Talabat / noon Minutes / Deliveroo Hop). */
  products: 'grocery_products',
  /** One document per crawl run (platform, counts, timing) — powers the ops dashboard. */
  scrapeRuns: 'grocery_scrape_runs',
  /** Dubai dark-store master (quick-commerce fulfilment hubs) — like dining_restaurants. */
  stores: 'grocery_stores',
} as const;

export type GroceryCollectionName = (typeof GROCERY_COLLECTIONS)[keyof typeof GROCERY_COLLECTIONS];

export interface GroceryScrapeRun {
  runId: string;
  platform: 'talabat' | 'noon-minutes' | 'deliveroo' | 'all';
  startedAt: Date;
  finishedAt?: Date;
  status: 'running' | 'done' | 'failed';
  itemsSeen?: number;
  productsPushed?: number;
  requests?: number;
  errors?: string[];
}

export type GroceryPlatform = 'talabat' | 'noon-minutes' | 'deliveroo';

export interface GroceryStore {
  /** Stable unique key: `${platform}:${slug(name)}`. */
  storeKey: string;
  platform: GroceryPlatform;
  name: string;
  city: 'Dubai';
  area?: string;
  /** Platform-specific addressing hint (Talabat area id, Deliveroo geohash/menu URL, etc.). */
  hubReference?: string;
  isActive: boolean;
  updatedAt?: Date;
}

export interface GroceryCollections {
  products: Collection;
  scrapeRuns: Collection<GroceryScrapeRun>;
  stores: Collection<GroceryStore>;
}

export function getGroceryCollections(db: Db): GroceryCollections {
  return {
    products: db.collection(GROCERY_COLLECTIONS.products),
    scrapeRuns: db.collection<GroceryScrapeRun>(GROCERY_COLLECTIONS.scrapeRuns),
    stores: db.collection<GroceryStore>(GROCERY_COLLECTIONS.stores),
  };
}

export async function getGroceryCollectionsFromEnv(): Promise<GroceryCollections> {
  return getGroceryCollections(await getMongoDb());
}

// ─── Indexes ─────────────────────────────────────────────────────────────────
// Identity lookups mirror the ones the push pipeline relies on for products_clean, so the shared
// writeProducts() upsert logic resolves existing grocery docs correctly.

export const GROCERY_INDEXES: Record<GroceryCollectionName, IndexDescription[]> = {
  grocery_products: [
    { name: 'retailers_productUrl', key: { 'retailers.productUrl': 1 } },
    { name: 'retailers_externalId', key: { 'retailers.externalId': 1 } },
    { name: 'retailers_canonicalUrl', key: { 'retailers.canonicalUrl': 1 } },
    { name: 'name', key: { name: 1 } },
    { name: 'groceryMatchKey', key: { groceryMatchKey: 1 } },
    { name: 'category_subcategory', key: { category: 1, subcategory: 1 } },
    { name: 'ingestMappingStatus', key: { ingestMappingStatus: 1 } },
  ],
  grocery_scrape_runs: [
    { name: 'uniq_runId', key: { runId: 1 }, unique: true },
    { name: 'platform_startedAt', key: { platform: 1, startedAt: -1 } },
    { name: 'status_startedAt', key: { status: 1, startedAt: -1 } },
  ],
  grocery_stores: [
    { name: 'uniq_storeKey', key: { storeKey: 1 }, unique: true },
    { name: 'platform_isActive', key: { platform: 1, isActive: 1 } },
  ],
};

export interface EnsureGroceryIndexesResult {
  collection: GroceryCollectionName;
  indexes: string[];
}

// Idempotent: re-running with unchanged definitions is a no-op (same as the dining module).
export async function ensureGroceryIndexes(db: Db): Promise<EnsureGroceryIndexesResult[]> {
  const results: EnsureGroceryIndexesResult[] = [];
  for (const [collection, specs] of Object.entries(GROCERY_INDEXES) as Array<[GroceryCollectionName, IndexDescription[]]>) {
    const indexes = await db.collection(collection).createIndexes(specs);
    results.push({ collection, indexes });
  }
  return results;
}
