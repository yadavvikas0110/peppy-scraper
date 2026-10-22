import { Collection, Db, IndexDescription } from 'mongodb';
import type { ImportQueueItem } from './bulk.types';

export const DINING_IMPORT_QUEUE_COLLECTION = 'dining_import_queue' as const;

export function getImportQueueCollection(db: Db): Collection<ImportQueueItem> {
  return db.collection<ImportQueueItem>(DINING_IMPORT_QUEUE_COLLECTION);
}

export const IMPORT_QUEUE_INDEXES: IndexDescription[] = [
  { name: 'uniq_platform_platformRestaurantId', key: { platform: 1, platformRestaurantId: 1 }, unique: true },
  { name: 'status_batchId', key: { status: 1, batchId: 1 } },
  { name: 'batchId_pairKey', key: { batchId: 1, pairKey: 1 } },
];

export async function ensureImportQueueIndexes(db: Db): Promise<string[]> {
  return getImportQueueCollection(db).createIndexes(IMPORT_QUEUE_INDEXES);
}
