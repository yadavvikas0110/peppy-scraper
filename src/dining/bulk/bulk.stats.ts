import { Db, ObjectId } from 'mongodb';
import { getDiningIdentityCollections } from '../identity/identity.collections';
import { getImportQueueCollection } from './bulk.collections';
import type { ImportQueueItem } from './bulk.types';

/*
 * What a batch actually produced, measured from the database (not from the run logs): which restaurants imported
 * properly, how complete their menus are, what the offers look like, which restaurants were merged across platforms,
 * and how many dishes became comparable.
 */

// MongoDB's regex engine (PCRE2) takes \\x{...} escapes, not \\u.... The Arabic block.
const ARABIC = '[\\x{0600}-\\x{06FF}]';

export interface RestaurantQuality {
  platform: string;
  platformRestaurantId: string;
  name: string;
  status: ImportQueueItem['status'];
  restaurantId?: string;
  categories: number;
  items: number;
  priced: number;
  withImage: number;
  withDescription: number;
  arabicNames: number;
  hasEn: boolean;
  hasAr: boolean;
  hasCoordinates: boolean;
  credits: number;
  flags: string[];
  // Imported in both languages with a real menu and nothing flagged.
  ok: boolean;
}

export interface PairCheck {
  pairKey: string;
  kind: 'PAIR' | 'CONTROL';
  members: string[];
  merged: boolean;
  // Only one platform of the pair has been imported so far: nothing to judge yet.
  pending: boolean;
  // PAIR: merging is the expected outcome. CONTROL: keeping them apart is.
  asExpected: boolean;
}

export interface GroupStats {
  groupId: string;
  name?: string;
  identityStatus?: string;
  platforms: string[];
  itemsByPlatform: Record<string, number>;
  comparableDishes: number;
  review: number;
  unmatched: number;
}

export interface BulkStats {
  batchId: string;
  queue: { total: number; byStatus: Record<string, number>; byPlatform: Record<string, Record<string, number>>; credits: number };
  failures: Array<{ platform: string; id: string; name: string; error?: string }>;
  restaurants: RestaurantQuality[];
  totals: {
    imported: number;
    ok: number;
    flagged: number;
    items: number;
    categories: number;
    priced: number;
    withImage: number;
    withDescription: number;
    arabicNames: number;
    byPlatform: Record<string, { restaurants: number; ok: number; items: number }>;
  };
  offers: { active: number; byType: Record<string, number>; restaurantsWithOffers: number };
  linking: {
    groups: number;
    twoPlatformGroups: number;
    verifiedTwoPlatformGroups: number;
    singles: number;
    pairChecks: PairCheck[];
    groupStats: GroupStats[];
    comparableDishes: number;
  };
}

const inc = (map: Record<string, number>, key: string, by = 1) => {
  map[key] = (map[key] ?? 0) + by;
};

export async function computeBulkStats(db: Db, batchId: string): Promise<BulkStats> {
  const queue = getImportQueueCollection(db);
  const entries = await queue.find({ batchId }).toArray();

  const byStatus: Record<string, number> = {};
  const byPlatform: Record<string, Record<string, number>> = {};
  let credits = 0;
  for (const e of entries) {
    inc(byStatus, e.status);
    inc((byPlatform[e.platform] ??= {}), e.status);
    credits += e.creditsUsed ?? 0;
  }
  const failures = entries
    .filter(e => e.status === 'failed' || e.status === 'partial')
    .map(e => ({ platform: e.platform, id: e.platformRestaurantId, name: e.name, error: e.lastError }));

  const imported = entries.filter(e => e.restaurantId && (e.status === 'imported' || e.status === 'partial'));
  const ids = imported.map(e => e.restaurantId as ObjectId);

  const [restaurantDocs, itemAgg, categoryAgg, offerAgg] = await Promise.all([
    db.collection('dining_restaurants').find({ _id: { $in: ids } }, { projection: { lastRunIdByLocale: 1, location: 1 } }).toArray(),
    db.collection('dining_menu_items').aggregate<{ _id: ObjectId; items: number; priced: number; withImage: number; withDescription: number; arabicNames: number }>([
      { $match: { restaurantId: { $in: ids }, isActive: true } },
      {
        $group: {
          _id: '$restaurantId',
          items: { $sum: 1 },
          priced: { $sum: { $cond: [{ $gt: ['$price', 0] }, 1, 0] } },
          withImage: { $sum: { $cond: [{ $gt: [{ $strLenCP: { $ifNull: ['$imageUrl', ''] } }, 0] }, 1, 0] } },
          withDescription: { $sum: { $cond: [{ $or: [{ $gt: [{ $strLenCP: { $ifNull: ['$description.en', ''] } }, 0] }, { $gt: [{ $strLenCP: { $ifNull: ['$description.ar', ''] } }, 0] }] }, 1, 0] } },
          arabicNames: { $sum: { $cond: [{ $regexMatch: { input: { $ifNull: ['$name.ar', ''] }, regex: ARABIC } }, 1, 0] } },
        },
      },
    ]).toArray(),
    db.collection('dining_menu_categories').aggregate<{ _id: ObjectId; n: number }>([{ $match: { restaurantId: { $in: ids }, isActive: true } }, { $group: { _id: '$restaurantId', n: { $sum: 1 } } }]).toArray(),
    db.collection('dining_restaurant_offers').aggregate<{ _id: { type: string }; n: number; restaurants: ObjectId[] }>([
      { $match: { restaurantId: { $in: ids }, isActive: true } },
      { $group: { _id: { type: '$type' }, n: { $sum: 1 }, restaurants: { $addToSet: '$restaurantId' } } },
    ]).toArray(),
  ]);
  const docById = new Map(restaurantDocs.map(r => [r._id.toHexString(), r]));
  const itemsById = new Map(itemAgg.map(r => [r._id.toHexString(), r]));
  const catsById = new Map(categoryAgg.map(r => [r._id.toHexString(), r.n]));

  const restaurants: RestaurantQuality[] = entries
    .filter(e => e.restaurantId)
    .map(e => {
      const id = (e.restaurantId as ObjectId).toHexString();
      const doc = docById.get(id) as { lastRunIdByLocale?: { en?: string; ar?: string }; location?: { lat?: number; lng?: number } } | undefined;
      const it = itemsById.get(id);
      const q: RestaurantQuality = {
        platform: e.platform,
        platformRestaurantId: e.platformRestaurantId,
        name: e.name,
        status: e.status,
        restaurantId: id,
        categories: catsById.get(id) ?? 0,
        items: it?.items ?? 0,
        priced: it?.priced ?? 0,
        withImage: it?.withImage ?? 0,
        withDescription: it?.withDescription ?? 0,
        arabicNames: it?.arabicNames ?? 0,
        hasEn: !!doc?.lastRunIdByLocale?.en,
        hasAr: !!doc?.lastRunIdByLocale?.ar,
        hasCoordinates: typeof doc?.location?.lat === 'number' && typeof doc?.location?.lng === 'number',
        credits: e.creditsUsed ?? 0,
        flags: [],
        ok: false,
      };
      if (q.items === 0) q.flags.push('NO_ITEMS');
      else if (q.items < 5) q.flags.push('FEW_ITEMS');
      if (q.items > 0 && q.priced === 0) q.flags.push('NO_PRICES');
      if (!q.hasEn || !q.hasAr) q.flags.push('LOCALE_INCOMPLETE');
      if (!q.hasCoordinates) q.flags.push('NO_COORDINATES');
      if (e.status !== 'imported') q.flags.push(`STATUS_${e.status.toUpperCase()}`);
      q.ok = q.flags.length === 0;
      return q;
    });

  const totals: BulkStats['totals'] = { imported: imported.length, ok: 0, flagged: 0, items: 0, categories: 0, priced: 0, withImage: 0, withDescription: 0, arabicNames: 0, byPlatform: {} };
  for (const r of restaurants) {
    const p = (totals.byPlatform[r.platform] ??= { restaurants: 0, ok: 0, items: 0 });
    p.restaurants++;
    p.items += r.items;
    if (r.ok) {
      totals.ok++;
      p.ok++;
    } else totals.flagged++;
    totals.items += r.items;
    totals.categories += r.categories;
    totals.priced += r.priced;
    totals.withImage += r.withImage;
    totals.withDescription += r.withDescription;
    totals.arabicNames += r.arabicNames;
  }

  const offerTypes: Record<string, number> = {};
  const offerRestaurants = new Set<string>();
  for (const o of offerAgg) {
    offerTypes[o._id.type] = o.n;
    o.restaurants.forEach(r => offerRestaurants.add(r.toHexString()));
  }

  // ── Linking
  const identity = getDiningIdentityCollections(db);
  const mappings = await identity.restaurantMappings.find({ restaurantId: { $in: ids }, isActive: true, matchStatus: 'MATCHED', canonicalRestaurantGroupId: { $exists: true } }).toArray();
  const groupOf = new Map(mappings.map(m => [m.restaurantId.toHexString(), m.canonicalRestaurantGroupId!.toHexString()]));
  const groupIds = [...new Set(groupOf.values())].map(g => new ObjectId(g));
  const [allMembers, groups] = await Promise.all([
    identity.restaurantMappings.find({ canonicalRestaurantGroupId: { $in: groupIds }, isActive: true, matchStatus: 'MATCHED' }, { projection: { restaurantId: 1, platform: 1, canonicalRestaurantGroupId: 1 } }).toArray(),
    identity.restaurantGroups.find({ _id: { $in: groupIds } }, { projection: { canonicalName: 1, identityStatus: 1 } }).toArray(),
  ]);
  const membersByGroup = new Map<string, Array<{ restaurantId: ObjectId; platform: string }>>();
  for (const m of allMembers) {
    const key = m.canonicalRestaurantGroupId!.toHexString();
    membersByGroup.set(key, [...(membersByGroup.get(key) ?? []), { restaurantId: m.restaurantId, platform: m.platform }]);
  }
  const groupDoc = new Map(groups.map(g => [g._id.toHexString(), g]));
  const twoPlatform = [...membersByGroup.entries()].filter(([, list]) => new Set(list.map(m => m.platform)).size >= 2);
  const twoPlatformIds = twoPlatform.map(([id]) => new ObjectId(id));

  const comparableAgg = twoPlatformIds.length
    ? await db.collection('dining_item_mappings').aggregate<{ _id: { group: ObjectId; canonical: ObjectId }; platforms: string[] }>([
        { $match: { restaurantGroupId: { $in: twoPlatformIds }, isActive: true, matchStatus: 'MATCHED' } },
        { $group: { _id: { group: '$restaurantGroupId', canonical: '$canonicalItemId' }, platforms: { $addToSet: '$platform' } } },
        { $match: { 'platforms.1': { $exists: true } } },
      ]).toArray()
    : [];
  const comparableByGroup = new Map<string, number>();
  for (const c of comparableAgg) comparableByGroup.set(c._id.group.toHexString(), (comparableByGroup.get(c._id.group.toHexString()) ?? 0) + 1);

  const mappingOutcome = twoPlatformIds.length
    ? await db.collection('dining_item_mappings').aggregate<{ _id: { group: ObjectId; status: string }; n: number }>([
        { $match: { restaurantGroupId: { $in: twoPlatformIds }, isActive: true, matchStatus: { $in: ['REVIEW', 'UNMATCHED'] } } },
        { $group: { _id: { group: '$restaurantGroupId', status: '$matchStatus' }, n: { $sum: 1 } } },
      ]).toArray()
    : [];
  const outcomeBy = new Map<string, number>(mappingOutcome.map(o => [`${o._id.group.toHexString()}:${o._id.status}`, o.n]));

  const memberIds = twoPlatform.flatMap(([, list]) => list.map(m => m.restaurantId));
  const itemCounts = memberIds.length
    ? await db.collection('dining_menu_items').aggregate<{ _id: ObjectId; n: number }>([{ $match: { restaurantId: { $in: memberIds }, isActive: true } }, { $group: { _id: '$restaurantId', n: { $sum: 1 } } }]).toArray()
    : [];
  const itemCountOf = new Map(itemCounts.map(i => [i._id.toHexString(), i.n]));

  const groupStats: GroupStats[] = twoPlatform.map(([groupId, list]) => {
    const itemsByPlatform: Record<string, number> = {};
    for (const m of list) inc(itemsByPlatform, m.platform, itemCountOf.get(m.restaurantId.toHexString()) ?? 0);
    const doc = groupDoc.get(groupId) as { canonicalName?: { en?: string; ar?: string }; identityStatus?: string } | undefined;
    return {
      groupId,
      name: doc?.canonicalName?.en ?? doc?.canonicalName?.ar,
      identityStatus: doc?.identityStatus,
      platforms: [...new Set(list.map(m => m.platform))].sort(),
      itemsByPlatform,
      comparableDishes: comparableByGroup.get(groupId) ?? 0,
      review: outcomeBy.get(`${groupId}:REVIEW`) ?? 0,
      unmatched: outcomeBy.get(`${groupId}:UNMATCHED`) ?? 0,
    };
  });

  // Hinted pairs should merge; controls (same brand, different area) must stay apart.
  const pairChecks: PairCheck[] = [];
  const byPairKey = new Map<string, ImportQueueItem[]>();
  for (const e of entries) if (e.pairKey && e.restaurantId) byPairKey.set(e.pairKey, [...(byPairKey.get(e.pairKey) ?? []), e]);
  for (const [pairKey, list] of byPairKey) {
    const groupsOfPair = new Set(list.map(e => groupOf.get((e.restaurantId as ObjectId).toHexString())));
    const platforms = new Set(list.map(e => e.platform));
    const merged = platforms.size >= 2 && groupsOfPair.size === 1 && !groupsOfPair.has(undefined);
    const kind = pairKey.startsWith('control:') ? 'CONTROL' : 'PAIR';
    pairChecks.push({ pairKey, kind, members: list.map(e => `${e.platform}:${e.name}`), merged, pending: platforms.size < 2, asExpected: kind === 'PAIR' ? merged : !merged });
  }

  return {
    batchId,
    queue: { total: entries.length, byStatus, byPlatform, credits },
    failures,
    restaurants,
    totals,
    offers: { active: offerAgg.reduce((n, o) => n + o.n, 0), byType: offerTypes, restaurantsWithOffers: offerRestaurants.size },
    linking: {
      groups: groupIds.length,
      twoPlatformGroups: twoPlatform.length,
      verifiedTwoPlatformGroups: groupStats.filter(g => g.identityStatus === 'verified').length,
      singles: groupIds.length - twoPlatform.length,
      pairChecks,
      groupStats,
      comparableDishes: [...comparableByGroup.values()].reduce((a, b) => a + b, 0),
    },
  };
}

const pct = (n: number, d: number) => (d ? `${Math.round((n / d) * 100)}%` : 'n/a');

export function formatBulkStats(s: BulkStats): string {
  const L: string[] = [];
  const t = s.totals;
  L.push(`BATCH ${s.batchId}`);
  L.push(`Queue: ${s.queue.total} restaurants | ${Object.entries(s.queue.byStatus).map(([k, v]) => `${k} ${v}`).join(', ')} | ${s.queue.credits} credits used`);
  for (const [p, st] of Object.entries(s.queue.byPlatform)) L.push(`  ${p}: ${Object.entries(st).map(([k, v]) => `${k} ${v}`).join(', ')}`);
  L.push('');
  L.push(`SCRAPED: ${t.imported} restaurants imported (both languages attempted); ${t.ok} fully OK, ${t.flagged} flagged`);
  for (const [p, v] of Object.entries(t.byPlatform)) L.push(`  ${p}: ${v.restaurants} restaurants, ${v.ok} OK, ${v.items} menu items`);
  L.push(`MENUS: ${t.items} active dishes in ${t.categories} categories | priced ${t.priced} (${pct(t.priced, t.items)}) | with image ${t.withImage} (${pct(t.withImage, t.items)}) | with description ${t.withDescription} (${pct(t.withDescription, t.items)}) | Arabic names ${t.arabicNames} (${pct(t.arabicNames, t.items)})`);
  L.push(`OFFERS: ${s.offers.active} active on ${s.offers.restaurantsWithOffers} restaurants | ${Object.entries(s.offers.byType).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}`);
  L.push('');
  const flagged = s.restaurants.filter(r => !r.ok);
  if (flagged.length) {
    L.push('FLAGGED RESTAURANTS:');
    for (const r of flagged) L.push(`  ${r.platform} ${r.platformRestaurantId} "${r.name.slice(0, 40)}": ${r.flags.join(', ')} (items ${r.items})`);
    L.push('');
  }
  if (s.failures.length) {
    L.push('FAILED / PARTIAL IMPORTS:');
    for (const f of s.failures) L.push(`  ${f.platform} ${f.id} "${f.name.slice(0, 40)}": ${f.error ?? 'no error recorded'}`);
    L.push('');
  }
  const l = s.linking;
  L.push(`LINKING: ${l.groups} restaurant groups | ${l.twoPlatformGroups} hold both platforms (${l.verifiedTwoPlatformGroups} verified) | ${l.singles} single-platform | ${l.comparableDishes} comparable dishes`);
  for (const g of l.groupStats) L.push(`  ${g.name ?? g.groupId} [${g.identityStatus}] ${g.platforms.join('+')} | items ${JSON.stringify(g.itemsByPlatform)} | comparable ${g.comparableDishes} | review ${g.review} | unmatched ${g.unmatched}`);
  if (l.pairChecks.length) {
    L.push('PAIR CHECKS (hinted pairs should merge, controls must stay apart):');
    for (const c of l.pairChecks) L.push(`  ${c.pending ? 'wait' : c.asExpected ? 'ok  ' : 'FAIL'} ${c.kind.padEnd(7)} ${c.pairKey} -> ${c.pending ? 'only one platform imported yet' : c.merged ? 'merged' : 'kept apart'} | ${c.members.join(' / ')}`);
  }
  return L.join('\n');
}
