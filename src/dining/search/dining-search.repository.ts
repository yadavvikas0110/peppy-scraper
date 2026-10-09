import { Collection, Db, Filter, IndexDescription, ObjectId, WithId } from 'mongodb';
import { DINING_CANONICAL_ITEMS_COLLECTION } from '../canonical-items/canonical-item.collections';
import type { DiningCanonicalItem } from '../canonical-items/canonical-item.types';
import { DINING_COLLECTIONS } from '../db/dining.collections';
import type { DiningMenuItem, DiningPlatform, DiningRestaurant } from '../dining.types';
import { DINING_IDENTITY_COLLECTIONS } from '../identity/identity.collections';
import type { DiningRestaurantGroup, DiningRestaurantMapping } from '../identity/identity.types';
import { DINING_ITEM_MAPPINGS_COLLECTION } from '../item-mappings/item-mapping.collections';
import type { DiningItemMapping } from '../item-mappings/item-mapping.types';
import type { SearchMappingDoc, SearchMenuItemDoc, SearchRestaurantDoc } from './dining-search.offers';

/*
 * Read-only data access for canonical search. Every read is a bulk `$in` query with a projection,
 * so one search costs a fixed number of round trips regardless of how many results it returns.
 */

export interface DiningSearchCollections {
  canonicalItems: Collection<DiningCanonicalItem>;
  itemMappings: Collection<DiningItemMapping>;
  menuItems: Collection<DiningMenuItem>;
  restaurants: Collection<DiningRestaurant>;
  restaurantMappings: Collection<DiningRestaurantMapping>;
  restaurantGroups: Collection<DiningRestaurantGroup>;
}

export function getDiningSearchCollections(db: Db): DiningSearchCollections {
  return {
    canonicalItems: db.collection<DiningCanonicalItem>(DINING_CANONICAL_ITEMS_COLLECTION),
    itemMappings: db.collection<DiningItemMapping>(DINING_ITEM_MAPPINGS_COLLECTION),
    menuItems: db.collection<DiningMenuItem>(DINING_COLLECTIONS.menuItems),
    restaurants: db.collection<DiningRestaurant>(DINING_COLLECTIONS.restaurants),
    restaurantMappings: db.collection<DiningRestaurantMapping>(DINING_IDENTITY_COLLECTIONS.restaurantMappings),
    restaurantGroups: db.collection<DiningRestaurantGroup>(DINING_IDENTITY_COLLECTIONS.restaurantGroups),
  };
}

/*
 * Group-scoped searches use Phase 8's restaurantGroupId_normalizedNames / restaurantGroupId_searchKeywords.
 * Unscoped searches (no restaurantGroupId) need these two, otherwise every search scans all
 * canonical items. Non-unique: equal names in different groups (or one group) are legitimate.
 * Offer loading uses existing indexes only (canonicalItemId_isActive_matchStatus,
 * uniq_active_menuItemId, _id, restaurantId on dining_restaurant_mappings).
 */
export const DINING_SEARCH_INDEXES: IndexDescription[] = [
  { name: 'search_status_normalizedNames', key: { status: 1, 'signals.normalizedNames': 1 } },
  { name: 'search_status_searchKeywords', key: { status: 1, searchKeywords: 1 } },
];

export async function ensureDiningSearchIndexes(db: Db): Promise<string[]> {
  return db.collection(DINING_CANONICAL_ITEMS_COLLECTION).createIndexes(DINING_SEARCH_INDEXES);
}

export type SearchCanonicalDoc = Pick<
  WithId<DiningCanonicalItem>,
  '_id' | 'restaurantGroupId' | 'canonicalName' | 'canonicalDescription' | 'category' | 'aliases' | 'searchKeywords' | 'variant' | 'status'
>;

export type SearchGroupDoc = Pick<WithId<DiningRestaurantGroup>, '_id' | 'canonicalName' | 'city' | 'area'>;

const CANONICAL_PROJECTION = {
  restaurantGroupId: 1, canonicalName: 1, canonicalDescription: 1, category: 1, aliases: 1, searchKeywords: 1, variant: 1, status: 1,
} as const;
const MAPPING_PROJECTION = {
  canonicalItemId: 1, restaurantGroupId: 1, menuItemId: 1, restaurantId: 1, platform: 1, platformItemId: 1,
  matchStatus: 1, matchMethod: 1, confidence: 1, decidedBy: 1, isActive: 1, decidedAt: 1,
} as const;
const MENU_ITEM_PROJECTION = {
  platform: 1, restaurantId: 1, platformItemId: 1, name: 1, price: 1, originalPrice: 1, currency: 1,
  imageUrl: 1, isActive: 1, isAvailable: 1, availabilityStatus: 1, lastSeenAt: 1,
} as const;
const RESTAURANT_PROJECTION = { platform: 1, platformRestaurantId: 1, name: 1, url: 1, isActive: 1 } as const;

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export interface CanonicalCandidateQuery {
  normalizedQuery: string;
  tokens: string[];
  prefixTokens: string[];
  restaurantGroupId?: ObjectId;
  cap: number;
}

export interface DiningSearchRepository {
  findCanonicalCandidates(q: CanonicalCandidateQuery): Promise<{ items: SearchCanonicalDoc[]; capped: boolean }>;
  findConfirmedMappings(canonicalItemIds: ObjectId[], platforms?: DiningPlatform[]): Promise<SearchMappingDoc[]>;
  findConfirmedMappingsForMenuItems(menuItemIds: ObjectId[]): Promise<Array<Pick<SearchMappingDoc, '_id' | 'menuItemId' | 'canonicalItemId'>>>;
  findMenuItems(ids: ObjectId[]): Promise<SearchMenuItemDoc[]>;
  findRestaurants(ids: ObjectId[]): Promise<SearchRestaurantDoc[]>;
  findRestaurantGroupIds(restaurantIds: ObjectId[]): Promise<Map<string, string>>;
  findRestaurantGroups(ids: ObjectId[]): Promise<SearchGroupDoc[]>;
}

export function createDiningSearchRepository(c: DiningSearchCollections): DiningSearchRepository {
  return {
    // Two bounded reads: exact names/aliases first (so they can never be crowded out by the cap),
    // then keyword/prefix matches. Sorted by _id so the capped subset is deterministic.
    async findCanonicalCandidates(q) {
      const scope: Filter<DiningCanonicalItem> = { status: 'active', ...(q.restaurantGroupId ? { restaurantGroupId: q.restaurantGroupId } : {}) };
      const keywordClauses: Filter<DiningCanonicalItem>[] = [];
      if (q.tokens.length) keywordClauses.push({ searchKeywords: { $in: q.tokens } });
      for (const t of q.prefixTokens) keywordClauses.push({ searchKeywords: { $regex: `^${escapeRegex(t)}` } });

      const [exact, keyword] = await Promise.all([
        q.normalizedQuery
          ? c.canonicalItems.find({ ...scope, 'signals.normalizedNames': q.normalizedQuery }, { projection: CANONICAL_PROJECTION }).sort({ _id: 1 }).limit(q.cap).toArray()
          : [],
        keywordClauses.length
          ? c.canonicalItems.find({ ...scope, $or: keywordClauses }, { projection: CANONICAL_PROJECTION }).sort({ _id: 1 }).limit(q.cap).toArray()
          : [],
      ]);
      return { items: [...exact, ...keyword] as SearchCanonicalDoc[], capped: exact.length >= q.cap || keyword.length >= q.cap };
    },

    async findConfirmedMappings(canonicalItemIds, platforms) {
      if (!canonicalItemIds.length) return [];
      return (await c.itemMappings
        .find(
          { canonicalItemId: { $in: canonicalItemIds }, isActive: true, matchStatus: 'MATCHED', ...(platforms ? { platform: { $in: platforms } } : {}) },
          { projection: MAPPING_PROJECTION }
        )
        .sort({ _id: 1 })
        .toArray()) as SearchMappingDoc[];
    },

    async findConfirmedMappingsForMenuItems(menuItemIds) {
      if (!menuItemIds.length) return [];
      return (await c.itemMappings
        .find({ menuItemId: { $in: menuItemIds }, isActive: true, matchStatus: 'MATCHED' }, { projection: { menuItemId: 1, canonicalItemId: 1 } })
        .toArray()) as Array<Pick<SearchMappingDoc, '_id' | 'menuItemId' | 'canonicalItemId'>>;
    },

    async findMenuItems(ids) {
      if (!ids.length) return [];
      return (await c.menuItems.find({ _id: { $in: ids } }, { projection: MENU_ITEM_PROJECTION }).toArray()) as SearchMenuItemDoc[];
    },

    async findRestaurants(ids) {
      if (!ids.length) return [];
      return (await c.restaurants.find({ _id: { $in: ids } }, { projection: RESTAURANT_PROJECTION }).toArray()) as SearchRestaurantDoc[];
    },

    async findRestaurantGroupIds(restaurantIds) {
      const out = new Map<string, string>();
      if (!restaurantIds.length) return out;
      const mappings = await c.restaurantMappings
        .find({ restaurantId: { $in: restaurantIds }, isActive: true, matchStatus: 'MATCHED' }, { projection: { restaurantId: 1, canonicalRestaurantGroupId: 1 } })
        .toArray();
      const groupsByRestaurant = new Map<string, Set<string>>();
      for (const m of mappings) {
        if (!m.canonicalRestaurantGroupId) continue;
        const key = m.restaurantId.toHexString();
        groupsByRestaurant.set(key, (groupsByRestaurant.get(key) ?? new Set()).add(m.canonicalRestaurantGroupId.toHexString()));
      }
      // A restaurant with two active MATCHED groups is ambiguous → treated as not in any group.
      for (const [restaurantId, groups] of groupsByRestaurant) if (groups.size === 1) out.set(restaurantId, [...groups][0]);
      return out;
    },

    async findRestaurantGroups(ids) {
      if (!ids.length) return [];
      return (await c.restaurantGroups.find({ _id: { $in: ids } }, { projection: { canonicalName: 1, city: 1, area: 1 } }).toArray()) as SearchGroupDoc[];
    },
  };
}
