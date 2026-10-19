import { Collection, Db, IndexDescription } from 'mongodb';
import type { DiningRestaurant } from '../dining.types';
import { DINING_COLLECTIONS } from '../db/dining.collections';
import type { DiningRestaurantGroup, DiningRestaurantMapping } from './identity.types';

export const DINING_IDENTITY_COLLECTIONS = {
  restaurantGroups: 'dining_restaurant_groups',
  restaurantMappings: 'dining_restaurant_mappings',
} as const;

export type DiningIdentityCollectionName = (typeof DINING_IDENTITY_COLLECTIONS)[keyof typeof DINING_IDENTITY_COLLECTIONS];

export interface DiningIdentityCollections {
  // Read-only source of truth for the identity layer.
  restaurants: Collection<DiningRestaurant>;
  restaurantGroups: Collection<DiningRestaurantGroup>;
  restaurantMappings: Collection<DiningRestaurantMapping>;
}

export function getDiningIdentityCollections(db: Db): DiningIdentityCollections {
  return {
    restaurants: db.collection<DiningRestaurant>(DINING_COLLECTIONS.restaurants),
    restaurantGroups: db.collection<DiningRestaurantGroup>(DINING_IDENTITY_COLLECTIONS.restaurantGroups),
    restaurantMappings: db.collection<DiningRestaurantMapping>(DINING_IDENTITY_COLLECTIONS.restaurantMappings),
  };
}

const ACTIVE = { isActive: true };

export const DINING_IDENTITY_INDEXES: Record<DiningIdentityCollectionName, IndexDescription[]> = {
  dining_restaurant_groups: [
    {
      name: 'uniq_seedRestaurantId',
      key: { seedRestaurantId: 1 },
      unique: true,
      partialFilterExpression: { seedRestaurantId: { $type: 'objectId' } },
    },
    // Candidate lookup only — names are never unique.
    { name: 'signals_names_city', key: { 'signals.names': 1, 'signals.city': 1 } },
    { name: 'signals_brands_city', key: { 'signals.brands': 1, 'signals.city': 1 } },
    { name: 'status_identityStatus', key: { status: 1, identityStatus: 1 } },
  ],

  dining_restaurant_mappings: [
    // A source restaurant has at most one active mapping, hence at most one canonical group.
    { name: 'uniq_active_restaurantId', key: { restaurantId: 1 }, unique: true, partialFilterExpression: ACTIVE },
    {
      name: 'uniq_active_group_platform_restaurantId',
      key: { canonicalRestaurantGroupId: 1, platform: 1, restaurantId: 1 },
      unique: true,
      partialFilterExpression: { isActive: true, canonicalRestaurantGroupId: { $type: 'objectId' } },
    },
    {
      name: 'platform_platformRestaurantId',
      key: { platform: 1, platformRestaurantId: 1 },
      partialFilterExpression: { platformRestaurantId: { $type: 'string' } },
    },
    { name: 'group_isActive_matchStatus', key: { canonicalRestaurantGroupId: 1, isActive: 1, matchStatus: 1 } },
    { name: 'restaurantId_matchStatus', key: { restaurantId: 1, matchStatus: 1 } },
    { name: 'matchStatus_updatedAt', key: { matchStatus: 1, updatedAt: -1 } },
  ],
};

export async function ensureDiningIdentityIndexes(db: Db): Promise<Array<{ collection: DiningIdentityCollectionName; indexes: string[] }>> {
  const results: Array<{ collection: DiningIdentityCollectionName; indexes: string[] }> = [];
  for (const [collection, specs] of Object.entries(DINING_IDENTITY_INDEXES) as Array<[DiningIdentityCollectionName, IndexDescription[]]>) {
    results.push({ collection, indexes: await db.collection(collection).createIndexes(specs) });
  }
  return results;
}
