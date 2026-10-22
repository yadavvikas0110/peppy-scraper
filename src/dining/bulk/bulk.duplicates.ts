import { Db, ObjectId, WithId } from 'mongodb';
import { DINING_COLLECTIONS } from '../db/dining.collections';
import type { DiningRestaurant } from '../dining.types';
import { assignToAnchorGroup, MENU_EVIDENCE_MAX_METERS, MENU_EVIDENCE_MIN_OVERLAP } from '../identity/identity.assign';
import { getDiningIdentityCollections } from '../identity/identity.collections';
import { compareBranchLocation, HARD_CONFLICTS } from '../identity/identity.matcher';
import { createDiningIdentityRepositories } from '../identity/identity.service';
import { extractSourceSignals, normalizeIdentityText } from '../identity/identity.signals';
import { autoLinkRestaurant } from '../linking/dining-auto-link';
import { brandKey } from './bulk.select';

/*
 * Finds a Deliveroo and a Talabat listing of the same restaurant that are still shown separately, and merges them.
 *
 * Considered: restaurants alone in their group, or waiting in REVIEW. A pair qualifies only when all of these hold:
 *   - the same brand,
 *   - no hard branch conflict (city, area, far apart),
 *   - pins within 75 m, or within 150 m when at least 80% of the smaller menu's dishes are on the other menu.
 * A restaurant with two qualifying partners is left alone. A chain's other branches share the menu but sit kilometres
 * away, so they never qualify. The merge goes through the manual-assignment path (its own checks apply again) with
 * a note starting DUPLICATE_MERGE, then the dish layer is built so prices can be compared.
 */

export interface DuplicatePair {
  deliveroo: { restaurantId: string; name: string };
  talabat: { restaurantId: string; name: string };
  distanceMeters: number;
  menuOverlap: number;
  outcome?: 'merged' | 'planned' | string;
}

interface Listing {
  restaurant: WithId<DiningRestaurant>;
  matched: boolean;
  groupId?: ObjectId;
  brand: string;
  brands: string[];
  dishes: Set<string>;
}

function overlap(a: Set<string>, b: Set<string>): number {
  const [small, big] = a.size <= b.size ? [a, b] : [b, a];
  if (!small.size) return 0;
  let hits = 0;
  for (const name of small) if (big.has(name)) hits++;
  return hits / small.size;
}

export async function findDuplicatePairs(db: Db): Promise<Array<DuplicatePair & { anchorId: ObjectId; movingId: ObjectId }>> {
  const identity = getDiningIdentityCollections(db);
  const mappings = await identity.restaurantMappings.find({ isActive: true, matchStatus: { $in: ['MATCHED', 'REVIEW'] } }).toArray();
  const members = new Map<string, number>();
  for (const m of mappings) if (m.matchStatus === 'MATCHED') members.set(String(m.canonicalRestaurantGroupId), (members.get(String(m.canonicalRestaurantGroupId)) ?? 0) + 1);
  const alone = mappings.filter(m => m.matchStatus === 'REVIEW' || members.get(String(m.canonicalRestaurantGroupId)) === 1);

  const restaurants = await db.collection<DiningRestaurant>(DINING_COLLECTIONS.restaurants).find({ _id: { $in: alone.map(m => m.restaurantId) } }).toArray();
  const byId = new Map(restaurants.map(r => [r._id.toHexString(), r]));
  const listings: Listing[] = [];
  for (const m of alone) {
    const restaurant = byId.get(m.restaurantId.toHexString());
    if (!restaurant) continue;
    const items = await db.collection(DINING_COLLECTIONS.menuItems).find({ restaurantId: restaurant._id, isActive: { $ne: false } }, { projection: { name: 1 } }).toArray();
    const dishes = new Set(items.map(i => normalizeIdentityText(i.name?.en ?? '')).filter((n): n is string => !!n));
    listings.push({
      restaurant,
      matched: m.matchStatus === 'MATCHED',
      groupId: m.canonicalRestaurantGroupId,
      brand: brandKey(restaurant.name?.en ?? ''),
      brands: extractSourceSignals(restaurant).brands,
      dishes,
    });
  }

  const candidates: Array<DuplicatePair & { anchorId: ObjectId; movingId: ObjectId; key: [string, string] }> = [];
  for (const d of listings.filter(l => l.restaurant.platform === 'deliveroo')) {
    for (const t of listings.filter(l => l.restaurant.platform === 'talabat')) {
      if (d.brand !== t.brand && !d.brands.some(b => t.brands.includes(b))) continue;
      const branch = compareBranchLocation(extractSourceSignals(d.restaurant), extractSourceSignals(t.restaurant));
      if (branch.distanceMeters === undefined || branch.conflicts.some(c => HARD_CONFLICTS.includes(c))) continue;
      const menuOverlap = overlap(d.dishes, t.dishes);
      const near = branch.signals.includes('LOCATION_NEAR');
      if (!near && !(branch.distanceMeters <= MENU_EVIDENCE_MAX_METERS && menuOverlap >= MENU_EVIDENCE_MIN_OVERLAP)) continue;
      // The listing already in a MATCHED group keeps it; the other one joins. Talabat anchors when both are.
      const [anchor, moving] = t.matched ? [t, d] : [d, t];
      candidates.push({
        deliveroo: { restaurantId: d.restaurant._id.toHexString(), name: d.restaurant.name?.en ?? '' },
        talabat: { restaurantId: t.restaurant._id.toHexString(), name: t.restaurant.name?.en ?? '' },
        distanceMeters: branch.distanceMeters,
        menuOverlap: Math.round(menuOverlap * 100) / 100,
        anchorId: anchor.restaurant._id,
        movingId: moving.restaurant._id,
        key: [d.restaurant._id.toHexString(), t.restaurant._id.toHexString()],
      });
    }
  }
  // Ambiguous: a listing with more than one qualifying partner.
  const seen = new Map<string, number>();
  for (const c of candidates) for (const k of c.key) seen.set(k, (seen.get(k) ?? 0) + 1);
  return candidates.filter(c => c.key.every(k => seen.get(k) === 1)).map(({ key: _key, ...rest }) => rest);
}

export async function mergeDuplicatePairs(db: Db, apply: boolean, logger: Pick<Console, 'log' | 'warn'> = console): Promise<DuplicatePair[]> {
  const identity = getDiningIdentityCollections(db);
  const repos = createDiningIdentityRepositories(identity);
  const pairs = await findDuplicatePairs(db);
  const results: DuplicatePair[] = [];

  for (const pair of pairs) {
    const { anchorId, movingId, ...report } = pair;
    if (!apply) {
      results.push({ ...report, outcome: 'planned' });
      continue;
    }
    const anchorMapping = await repos.mappings.findActiveByRestaurant(anchorId);
    const previous = await repos.mappings.findActiveByRestaurant(movingId);
    try {
      await assignToAnchorGroup(repos, {
        restaurantId: movingId,
        anchorRestaurantId: anchorId,
        note: `DUPLICATE_MERGE: same brand, pins ${pair.distanceMeters} m apart, ${Math.round(pair.menuOverlap * 100)}% same dishes`,
        expectedGroupId: anchorMapping?.canonicalRestaurantGroupId,
        replaceExisting: true,
        menuOverlap: pair.menuOverlap,
        dryRun: false,
      });
    } catch (err) {
      results.push({ ...report, outcome: `refused: ${String((err as { code?: string }).code ?? (err as Error).message)}` });
      continue;
    }
    // The group the moving listing leaves is now empty: retire it (kept, not deleted).
    const left = previous?.matchStatus === 'MATCHED' ? previous.canonicalRestaurantGroupId : undefined;
    if (left && !(await identity.restaurantMappings.findOne({ canonicalRestaurantGroupId: left, isActive: true, matchStatus: 'MATCHED' }))) {
      await identity.restaurantGroups.updateOne({ _id: left }, { $set: { status: 'inactive', updatedAt: new Date() } });
    }
    for (const id of [anchorId, movingId]) {
      const link = await autoLinkRestaurant(db, id, { logger });
      if (link.status !== 'linked') logger.warn(`[duplicates] link ${id.toHexString()}: ${link.reason}`);
    }
    results.push({ ...report, outcome: 'merged' });
  }
  return results;
}
