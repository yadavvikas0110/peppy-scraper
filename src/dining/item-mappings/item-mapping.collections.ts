import { Collection, Db, IndexDescription } from 'mongodb';
import { DINING_CANONICAL_ITEMS_COLLECTION } from '../canonical-items/canonical-item.collections';
import type { DiningCanonicalItem } from '../canonical-items/canonical-item.types';
import { DINING_COLLECTIONS } from '../db/dining.collections';
import type { DiningMenuItem } from '../dining.types';
import { DINING_IDENTITY_COLLECTIONS } from '../identity/identity.collections';
import type { DiningRestaurantGroup, DiningRestaurantMapping } from '../identity/identity.types';
import type { DiningItemMapping } from './item-mapping.types';

export const DINING_ITEM_MAPPINGS_COLLECTION = 'dining_item_mappings' as const;

export interface DiningItemMappingCollections {
  // Read-only inputs.
  menuItems: Collection<DiningMenuItem>;
  canonicalItems: Collection<DiningCanonicalItem>;
  restaurantMappings: Collection<DiningRestaurantMapping>;
  restaurantGroups: Collection<DiningRestaurantGroup>;
  itemMappings: Collection<DiningItemMapping>;
}

export function getDiningItemMappingCollections(db: Db): DiningItemMappingCollections {
  return {
    menuItems: db.collection<DiningMenuItem>(DINING_COLLECTIONS.menuItems),
    canonicalItems: db.collection<DiningCanonicalItem>(DINING_CANONICAL_ITEMS_COLLECTION),
    restaurantMappings: db.collection<DiningRestaurantMapping>(DINING_IDENTITY_COLLECTIONS.restaurantMappings),
    restaurantGroups: db.collection<DiningRestaurantGroup>(DINING_IDENTITY_COLLECTIONS.restaurantGroups),
    itemMappings: db.collection<DiningItemMapping>(DINING_ITEM_MAPPINGS_COLLECTION),
  };
}

export const DINING_ITEM_MAPPING_INDEXES: IndexDescription[] = [
  // One active decision per source item → a source item maps to at most one canonical item.
  { name: 'uniq_active_menuItemId', key: { menuItemId: 1 }, unique: true, partialFilterExpression: { isActive: true } },
  { name: 'canonicalItemId_isActive_matchStatus', key: { canonicalItemId: 1, isActive: 1, matchStatus: 1 } },
  { name: 'restaurantGroupId_isActive_matchStatus', key: { restaurantGroupId: 1, isActive: 1, matchStatus: 1 } },
  { name: 'menuItemId_createdAt', key: { menuItemId: 1, createdAt: -1 } },
  {
    name: 'platform_platformItemId',
    key: { platform: 1, platformItemId: 1 },
    partialFilterExpression: { platformItemId: { $type: 'string' } },
  },
  { name: 'matchStatus_updatedAt', key: { matchStatus: 1, updatedAt: -1 } },
];

export async function ensureDiningItemMappingIndexes(db: Db): Promise<string[]> {
  return db.collection(DINING_ITEM_MAPPINGS_COLLECTION).createIndexes(DINING_ITEM_MAPPING_INDEXES);
}
