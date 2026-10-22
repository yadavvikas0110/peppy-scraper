import { Collection, Db, ObjectId } from 'mongodb';
import type { ScrapeDoClient } from '../../shared/scrapedo/scrapedo.client';
import { DINING_COLLECTIONS } from '../db/dining.collections';
import { getDiningIdentityCollections } from '../identity/identity.collections';
import { getDeliverooFetchOptions } from '../platforms/deliveroo/deliveroo.adapter';
import { candidatesFromDeliverooListing, storeCandidates } from './bulk.discover';
import { brandKey } from './bulk.select';
import type { ImportCandidate, ImportQueueItem } from './bulk.types';

/*
 * Finding the Deliveroo listing of a restaurant that is only on Talabat.
 *
 * Deliveroo's listing page takes a map position (geohash) and shows the restaurants that deliver there, so the position
 * of the Talabat restaurant is enough to ask Deliveroo "which branches of this brand serve this spot". The branches
 * found are queued for the normal import; whether one is really the same branch is then decided by the identity
 * matcher (same brand, pins within 75 m), never here. Talabat cannot be searched the same way (its area lists hold
 * thousands of vendors and have no search), so this works in one direction: Talabat → Deliveroo.
 */

const BASE32 = '0123456789bcdefghjkmnpqrstuvwxyz';

export function encodeGeohash(lat: number, lng: number, length = 12): string {
  const latRange = [-90, 90];
  const lngRange = [-180, 180];
  let hash = '';
  let bit = 0;
  let ch = 0;
  let even = true;
  while (hash.length < length) {
    const range = even ? lngRange : latRange;
    const value = even ? lng : lat;
    const mid = (range[0] + range[1]) / 2;
    if (value > mid) {
      ch = ch * 2 + 1;
      range[0] = mid;
    } else {
      ch *= 2;
      range[1] = mid;
    }
    even = !even;
    if (++bit === 5) {
      hash += BASE32[ch];
      bit = 0;
      ch = 0;
    }
  }
  return hash;
}

export interface TwinSource {
  restaurantId: ObjectId;
  name: string;
  lat: number;
  lng: number;
}

export interface TwinSearchOptions {
  batchId: string;
  // Listing requests are shared between restaurants whose positions share this many geohash characters.
  cacheLength?: number;
  maxPerRestaurant?: number;
  maxListings?: number;
  listingUrlBase?: string;
  logger?: Pick<Console, 'log'>;
}

export interface TwinSearchResult {
  sources: number;
  listingsFetched: number;
  withBranches: number;
  queued: number;
  noBranchOnDeliveroo: string[];
}

const LISTING_BASE = 'https://deliveroo.ae/en/restaurants/dubai/dubai-business-bay';

// Restaurants that sit alone in their group and are on Talabat.
export async function talabatSingletons(db: Db): Promise<TwinSource[]> {
  const mappings = await getDiningIdentityCollections(db).restaurantMappings
    .find({ isActive: true, matchStatus: 'MATCHED' }, { projection: { canonicalRestaurantGroupId: 1, restaurantId: 1, platform: 1 } })
    .toArray();
  const perGroup = new Map<string, number>();
  for (const m of mappings) perGroup.set(String(m.canonicalRestaurantGroupId), (perGroup.get(String(m.canonicalRestaurantGroupId)) ?? 0) + 1);
  const ids = mappings.filter(m => m.platform === 'talabat' && perGroup.get(String(m.canonicalRestaurantGroupId)) === 1).map(m => m.restaurantId as ObjectId);
  const restaurants = await db.collection(DINING_COLLECTIONS.restaurants).find({ _id: { $in: ids } }).toArray();
  return restaurants
    .filter(r => typeof r.location?.lat === 'number' && typeof r.location?.lng === 'number')
    .map(r => ({ restaurantId: r._id as ObjectId, name: String(r.name?.en ?? r.name?.ar ?? ''), lat: r.location.lat as number, lng: r.location.lng as number }));
}

export async function findDeliverooTwins(
  db: Db,
  queue: Collection<ImportQueueItem>,
  scrapeDo: Pick<ScrapeDoClient, 'fetchHtml'>,
  sources: TwinSource[],
  options: TwinSearchOptions
): Promise<TwinSearchResult> {
  const logger = options.logger ?? console;
  const cacheLength = options.cacheLength ?? 7;
  const maxPer = options.maxPerRestaurant ?? 3;
  const result: TwinSearchResult = { sources: sources.length, listingsFetched: 0, withBranches: 0, queued: 0, noBranchOnDeliveroo: [] };

  const known = new Set(
    (await db.collection(DINING_COLLECTIONS.restaurants).find({ platform: 'deliveroo' }, { projection: { platformRestaurantId: 1 } }).toArray()).map(r => `deliveroo:${r.platformRestaurantId}`)
  );
  const listings = new Map<string, ImportCandidate[]>();
  const chosen = new Map<string, ImportCandidate>();

  for (const source of sources) {
    const geohash = encodeGeohash(source.lat, source.lng);
    const key = geohash.slice(0, cacheLength);
    let cards = listings.get(key);
    if (!cards) {
      if (options.maxListings !== undefined && result.listingsFetched >= options.maxListings) {
        logger.log(`[twins] listing budget reached (${options.maxListings}); stopping`);
        break;
      }
      const url = `${options.listingUrlBase ?? LISTING_BASE}?geohash=${geohash}&collection=restaurants`;
      const res = await scrapeDo.fetchHtml(url, getDeliverooFetchOptions(url, 'en'));
      result.listingsFetched++;
      cards = candidatesFromDeliverooListing(res.html, url).candidates;
      listings.set(key, cards);
    }
    const brand = brandKey(source.name);
    const branches = cards.filter(c => brandKey(c.name) === brand).slice(0, maxPer);
    if (!branches.length) {
      result.noBranchOnDeliveroo.push(source.name);
      continue;
    }
    result.withBranches++;
    for (const b of branches) chosen.set(`${b.platform}:${b.platformRestaurantId}`, b);
  }

  const fresh = [...chosen.values()].filter(c => !known.has(`deliveroo:${c.platformRestaurantId}`));
  await storeCandidates(queue, fresh);
  for (const c of fresh) {
    const res = await queue.updateOne(
      { platform: c.platform, platformRestaurantId: c.platformRestaurantId, status: { $in: ['discovered', 'skipped'] } },
      { $set: { status: 'queued', batchId: options.batchId, reason: 'TWIN: same brand delivers to a Talabat restaurant\'s position', updatedAt: new Date() } }
    );
    result.queued += res.modifiedCount;
  }
  logger.log(`[twins] ${result.sources} Talabat restaurants | ${result.listingsFetched} Deliveroo listing(s) fetched | branches found for ${result.withBranches} | ${result.queued} queued (${chosen.size - fresh.length} already imported)`);
  return result;
}
