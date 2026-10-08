import { Collection, Db, IndexDescription } from 'mongodb';
import { DINING_COLLECTIONS } from '../db/dining.collections';
import type { DiningMenuItem } from '../dining.types';
import { DINING_IDENTITY_COLLECTIONS } from '../identity/identity.collections';
import type { DiningRestaurantGroup, DiningRestaurantMapping } from '../identity/identity.types';
import type { DiningCanonicalItem } from './canonical-item.types';

export const DINING_CANONICAL_ITEMS_COLLECTION = 'dining_canonical_items' as const;

export interface DiningCanonicalItemCollections {
  // Read-only inputs.
  menuItems: Collection<DiningMenuItem>;
  restaurantMappings: Collection<DiningRestaurantMapping>;
  restaurantGroups: Collection<DiningRestaurantGroup>;
  canonicalItems: Collection<DiningCanonicalItem>;
}

export function getDiningCanonicalItemCollections(db: Db): DiningCanonicalItemCollections {
  return {
    menuItems: db.collection<DiningMenuItem>(DINING_COLLECTIONS.menuItems),
    restaurantMappings: db.collection<DiningRestaurantMapping>(DINING_IDENTITY_COLLECTIONS.restaurantMappings),
    restaurantGroups: db.collection<DiningRestaurantGroup>(DINING_IDENTITY_COLLECTIONS.restaurantGroups),
    canonicalItems: db.collection<DiningCanonicalItem>(DINING_CANONICAL_ITEMS_COLLECTION),
  };
}

// No name-based unique index: two different dishes may share a name, even in one restaurant.
export const DINING_CANONICAL_ITEM_INDEXES: IndexDescription[] = [
  { name: 'uniq_seedMenuItemId', key: { seedMenuItemId: 1 }, unique: true },
  { name: 'uniq_restaurantGroupId_identityKey', key: { restaurantGroupId: 1, identityKey: 1 }, unique: true },
  { name: 'restaurantGroupId_status', key: { restaurantGroupId: 1, status: 1 } },
  { name: 'restaurantGroupId_identityStatus', key: { restaurantGroupId: 1, identityStatus: 1 } },
  { name: 'restaurantGroupId_normalizedNames', key: { restaurantGroupId: 1, 'signals.normalizedNames': 1 } },
  { name: 'restaurantGroupId_searchKeywords', key: { restaurantGroupId: 1, searchKeywords: 1 } },
  { name: 'seedRestaurantId', key: { seedRestaurantId: 1 } },
  { name: 'status_identityStatus', key: { status: 1, identityStatus: 1 } },
];

export async function ensureDiningCanonicalItemIndexes(db: Db): Promise<string[]> {
  return db.collection(DINING_CANONICAL_ITEMS_COLLECTION).createIndexes(DINING_CANONICAL_ITEM_INDEXES);
}
