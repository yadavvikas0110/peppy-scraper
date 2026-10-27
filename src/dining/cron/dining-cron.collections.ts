import { Collection, Db, IndexDescription } from 'mongodb';
import { DINING_COLLECTIONS } from '../db/dining.collections';
import type { DiningMenuCategory, DiningMenuItem, DiningRestaurant, DiningScrapeRun } from '../dining.types';
import { DINING_ITEM_MAPPINGS_COLLECTION } from '../item-mappings/item-mapping.collections';
import type { DiningItemMapping } from '../item-mappings/item-mapping.types';
import type { DiningCronChange, DiningCronJob } from './dining-cron.types';

export const DINING_CRON_COLLECTIONS = {
  jobs: 'dining_cron_jobs',
  changes: 'dining_cron_changes',
} as const;

// Change records are an audit trail, not menu data: they expire after this long.
export const DINING_CRON_CHANGE_TTL_SECONDS = 180 * 24 * 60 * 60;

export interface DiningCronCollections {
  jobs: Collection<DiningCronJob>;
  changes: Collection<DiningCronChange>;
  // Read-only inputs (targets and their last scraped URLs, before/after snapshots, mapping coverage).
  restaurants: Collection<DiningRestaurant>;
  scrapeRuns: Collection<DiningScrapeRun>;
  menuCategories: Collection<DiningMenuCategory>;
  menuItems: Collection<DiningMenuItem>;
  itemMappings: Collection<DiningItemMapping>;
}

export function getDiningCronCollections(db: Db): DiningCronCollections {
  return {
    jobs: db.collection<DiningCronJob>(DINING_CRON_COLLECTIONS.jobs),
    changes: db.collection<DiningCronChange>(DINING_CRON_COLLECTIONS.changes),
    restaurants: db.collection<DiningRestaurant>(DINING_COLLECTIONS.restaurants),
    scrapeRuns: db.collection<DiningScrapeRun>(DINING_COLLECTIONS.scrapeRuns),
    menuCategories: db.collection<DiningMenuCategory>(DINING_COLLECTIONS.menuCategories),
    menuItems: db.collection<DiningMenuItem>(DINING_COLLECTIONS.menuItems),
    itemMappings: db.collection<DiningItemMapping>(DINING_ITEM_MAPPINGS_COLLECTION),
  };
}

export const DINING_CRON_INDEXES: Record<(typeof DINING_CRON_COLLECTIONS)[keyof typeof DINING_CRON_COLLECTIONS], IndexDescription[]> = {
  dining_cron_jobs: [
    { name: 'uniq_jobId', key: { jobId: 1 }, unique: true },
    // At most one running job across all processes (the cross-process cron lock).
    { name: 'uniq_running_lockKey', key: { lockKey: 1 }, unique: true, partialFilterExpression: { status: 'running' } },
    { name: 'startedAt', key: { startedAt: -1 } },
    { name: 'status_startedAt', key: { status: 1, startedAt: -1 } },
  ],
  dining_cron_changes: [
    { name: 'jobId_entity_action', key: { jobId: 1, entity: 1, action: 1 } },
    { name: 'restaurantId_createdAt', key: { restaurantId: 1, createdAt: -1 } },
    { name: 'entityId_createdAt', key: { entityId: 1, createdAt: -1 } },
    { name: 'ttl_createdAt', key: { createdAt: 1 }, expireAfterSeconds: DINING_CRON_CHANGE_TTL_SECONDS },
  ],
};

export async function ensureDiningCronIndexes(db: Db): Promise<void> {
  for (const [collection, specs] of Object.entries(DINING_CRON_INDEXES)) {
    await db.collection(collection).createIndexes(specs);
  }
}
