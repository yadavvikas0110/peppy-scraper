import type { Collection } from 'mongodb';
import { stripUndefined } from '../dining.object';
import { parseDeliverooOfferListing } from '../platforms/deliveroo/deliveroo.offers';
import { parseTalabatListing, talabatMenuUrl } from '../platforms/talabat/talabat.listing';
import type { ImportCandidate, ImportQueueItem } from './bulk.types';

/*
 * Discovery: restaurants found on a platform's area listing page become import candidates. Nothing is imported here;
 * candidates are stored in the queue as "discovered" and picked for a batch by `select`.
 */

// Listing pages also carry groceries and shops. Deliveroo's cards have no category, so obvious non-restaurants are
// recognised by name; every exclusion is reported so it can be reviewed. Talabat gives a vertical type instead.
const NON_RESTAURANT_NAME =
  /\b(supermarket|hypermarket|minimart|mini ?market|grocer(?:y|ies)|pharmacy|hop|carrefour|choithrams|spinneys|lulu|viva|waitrose|union co-?op|nesto|best mart|grandiose|fresh ?market|flowers?|florist|pet shop|electronics)\b/i;

export function isLikelyRestaurantName(name: string): boolean {
  return !NON_RESTAURANT_NAME.test(name);
}

export interface DiscoveredPage {
  candidates: ImportCandidate[];
  excluded: Array<{ name: string; reason: string }>;
  // Listing size as the platform reports it (Talabat), for planning.
  totalVendors?: number;
}

export function candidatesFromDeliverooListing(html: string, listingUrl: string): DiscoveredPage {
  const geohash = (() => {
    try {
      return new URL(listingUrl).searchParams.get('geohash') ?? undefined;
    } catch {
      return undefined;
    }
  })();
  const out: DiscoveredPage = { candidates: [], excluded: [] };
  for (const r of parseDeliverooOfferListing(html)) {
    if (!r.menuPath) continue;
    if (!isLikelyRestaurantName(r.name ?? '')) {
      out.excluded.push({ name: r.name ?? r.platformRestaurantId, reason: 'NOT_A_RESTAURANT' });
      continue;
    }
    const query = geohash ? `?day=today&geohash=${geohash}&time=ASAP` : '';
    out.candidates.push({
      platform: 'deliveroo',
      platformRestaurantId: r.platformRestaurantId,
      name: r.name ?? r.platformRestaurantId,
      url: `https://deliveroo.ae/en${r.menuPath}/${query}`,
      slug: r.menuPath.split('/').filter(Boolean).pop(),
      sourceUrl: listingUrl,
      offerLabels: r.labels.length ? r.labels : undefined,
    });
  }
  return out;
}

export function candidatesFromTalabatListing(html: string, listingUrl: string): DiscoveredPage | null {
  const page = parseTalabatListing(html);
  if (!page) return null;
  const out: DiscoveredPage = { candidates: [], excluded: [], totalVendors: page.totalVendors };
  for (const v of page.vendors) {
    if (!v.isRestaurant) {
      out.excluded.push({ name: v.name, reason: 'NOT_A_RESTAURANT' });
      continue;
    }
    out.candidates.push({
      platform: 'talabat',
      platformRestaurantId: v.branchId,
      name: v.branchName ?? v.name,
      url: talabatMenuUrl(v, page.area?.id),
      slug: v.branchSlug,
      lat: v.lat,
      lng: v.lng,
      rating: v.rating,
      ratingCount: v.ratingCount,
      cuisines: v.cuisines,
      sourceUrl: listingUrl,
      offerLabels: [v.promotionText, v.discountText].filter((t): t is string => !!t),
    });
  }
  return out;
}

export interface StoreResult {
  added: number;
  alreadyKnown: number;
}

// New candidates are added as "discovered"; a known one keeps its status and only refreshes the listing facts.
export async function storeCandidates(queue: Collection<ImportQueueItem>, candidates: ImportCandidate[], now = new Date()): Promise<StoreResult> {
  let added = 0;
  let alreadyKnown = 0;
  for (const c of candidates) {
    const { platform, platformRestaurantId, offerLabels, ...facts } = c;
    const res = await queue.updateOne(
      { platform, platformRestaurantId },
      {
        $set: stripUndefined({ ...facts, offerLabels: offerLabels?.length ? offerLabels : undefined, updatedAt: now }),
        $setOnInsert: { status: 'discovered', locales: {}, attempts: 0, creditsUsed: 0, discoveredAt: now },
      },
      { upsert: true }
    );
    if (res.upsertedCount) added++;
    else alreadyKnown++;
  }
  return { added, alreadyKnown };
}
