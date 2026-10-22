import { Db, ObjectId } from 'mongodb';
import { getDiningCanonicalItemCollections } from '../canonical-items/canonical-item.collections';
import { assignToAnchorGroup } from '../identity/identity.assign';
import { backfillRestaurantIdentity } from '../identity/identity.backfill';
import { ensureDiningIdentityIndexes, getDiningIdentityCollections } from '../identity/identity.collections';
import { createDiningIdentityRepositories } from '../identity/identity.service';
import { LOCATION_MATCH_METERS } from '../identity/identity.matcher';
import { autoLinkRestaurant, AutoLinkSummary } from '../linking/dining-auto-link';
import { getImportQueueCollection } from './bulk.collections';

/*
 * Batch linking of the restaurants a bulk import brought in, in two steps so the slow part only runs where it matters:
 *
 *   1. identity   every imported restaurant gets a group/mapping from its name and address or coordinates (cheap)
 *   1b. approval  a REVIEW pair that is the same branch beyond doubt is confirmed (see approveStrictPairs)
 *   2. full link  only for groups that now hold two platforms: verify the group, canonical items, dish matching,
 *                 strict approvals, seed mappings (the per-restaurant autoLink pipeline)
 *
 * A restaurant alone in its group needs nothing more: when its twin is imported later, that restaurant's own link run
 * builds the shared dish layer.
 */

export interface LinkBatchSummary {
  restaurants: number;
  identity: Record<string, number>;
  failedIdentity: Array<{ restaurantId: string; name?: string; message?: string }>;
  strictApprovals: StrictApprovalSummary;
  groupsWithTwoPlatforms: number;
  fullLinks: Array<{ restaurantId: string } & Pick<AutoLinkSummary, 'status' | 'reason' | 'verified' | 'itemsMatched' | 'itemsApproved' | 'seedMappingsCreated' | 'problems'>>;
}

export async function linkBatch(db: Db, batchId: string, logger: Pick<Console, 'log' | 'warn'> = console): Promise<LinkBatchSummary> {
  const queue = getImportQueueCollection(db);
  const entries = await queue.find({ batchId, status: { $in: ['imported', 'partial'] }, restaurantId: { $exists: true } }).toArray();
  const restaurantIds = entries.map(e => e.restaurantId as ObjectId);
  const summary: LinkBatchSummary = { restaurants: restaurantIds.length, identity: {}, failedIdentity: [], strictApprovals: { approved: 0, skipped: [] }, groupsWithTwoPlatforms: 0, fullLinks: [] };
  if (!restaurantIds.length) return summary;

  // 1. identity
  await ensureDiningIdentityIndexes(db);
  const identity = getDiningIdentityCollections(db);
  const report = await backfillRestaurantIdentity(createDiningIdentityRepositories(identity), { restaurantIds });
  for (const e of report.entries) {
    summary.identity[e.outcome] = (summary.identity[e.outcome] ?? 0) + 1;
    if (e.outcome === 'FAILED') summary.failedIdentity.push({ restaurantId: e.restaurantId, name: e.name, message: e.error?.message });
  }
  logger.log(`[bulk-link] identity: ${JSON.stringify(summary.identity)}`);

  // 1b. confirm the REVIEW pairs that are the same branch beyond doubt
  summary.strictApprovals = await approveStrictPairs(db, restaurantIds);
  logger.log(`[bulk-link] strict approvals: ${summary.strictApprovals.approved} confirmed, ${summary.strictApprovals.skipped.length} left for review`);

  // 2. full link, only for groups with two platforms
  const mine = await identity.restaurantMappings
    .find({ restaurantId: { $in: restaurantIds }, isActive: true, matchStatus: 'MATCHED', canonicalRestaurantGroupId: { $exists: true } })
    .toArray();
  const groupIds = [...new Map(mine.map(m => [m.canonicalRestaurantGroupId!.toHexString(), m.canonicalRestaurantGroupId!])).values()];
  const members = await identity.restaurantMappings
    .find({ canonicalRestaurantGroupId: { $in: groupIds }, isActive: true, matchStatus: 'MATCHED' }, { projection: { restaurantId: 1, platform: 1, canonicalRestaurantGroupId: 1 } })
    .toArray();
  const byGroup = new Map<string, Array<{ restaurantId: ObjectId; platform: string }>>();
  for (const m of members) {
    const key = m.canonicalRestaurantGroupId!.toHexString();
    byGroup.set(key, [...(byGroup.get(key) ?? []), { restaurantId: m.restaurantId, platform: m.platform }]);
  }
  const pairGroups = [...byGroup.values()].filter(list => new Set(list.map(m => m.platform)).size >= 2);
  summary.groupsWithTwoPlatforms = pairGroups.length;
  logger.log(`[bulk-link] ${pairGroups.length} group(s) hold two platforms; running the full link for ${pairGroups.reduce((n, g) => n + g.length, 0)} restaurants`);

  for (const group of pairGroups) {
    for (const member of group) {
      const result = await autoLinkRestaurant(db, member.restaurantId, { logger });
      summary.fullLinks.push({
        restaurantId: member.restaurantId.toHexString(),
        status: result.status,
        reason: result.reason,
        verified: result.verified,
        itemsMatched: result.itemsMatched,
        itemsApproved: result.itemsApproved,
        seedMappingsCreated: result.seedMappingsCreated,
        problems: result.problems,
      });
    }
  }
  return summary;
}


export interface StrictApprovalSummary {
  approved: number;
  skipped: Array<{ restaurantId: string; reason: string }>;
}

/*
 * The matcher sends "same brand, pins within 75 m, but different branch names" to REVIEW on purpose: a person decides.
 * For a bulk import that is too slow, so this confirms only the clear cases, using the same manual-assignment path
 * (and its own checks: no hard branch conflict, no second listing of a platform in the group, strong location evidence):
 *
 *   - the evidence has LOCATION_NEAR and BRAND_EXACT or NAME_EXACT,
 *   - no conflict at all (so no MULTIPLE_CANDIDATES, no area/city/address mismatch),
 *   - the pins are within 75 m, and there is exactly one candidate group.
 *
 * Everything else stays in REVIEW. The mapping note starts with BULK_STRICT_APPROVAL so these decisions can be audited.
 */
export async function approveStrictPairs(db: Db, restaurantIds: ObjectId[]): Promise<StrictApprovalSummary> {
  const identity = getDiningIdentityCollections(db);
  const repos = createDiningIdentityRepositories(identity);
  const summary: StrictApprovalSummary = { approved: 0, skipped: [] };
  const reviews = await identity.restaurantMappings.find({ restaurantId: { $in: restaurantIds }, isActive: true, matchStatus: 'REVIEW' }).toArray();

  for (const review of reviews) {
    const id = review.restaurantId.toHexString();
    const skip = (reason: string) => summary.skipped.push({ restaurantId: id, reason });
    const e = review.evidence;
    const candidates = e.candidateGroupIds?.length ? e.candidateGroupIds : review.canonicalRestaurantGroupId ? [review.canonicalRestaurantGroupId] : [];
    if (candidates.length !== 1) { skip('NOT_A_SINGLE_CANDIDATE'); continue; }
    if (e.conflicts.length) { skip(`CONFLICTS: ${e.conflicts.join(',')}`); continue; }
    if (!e.signals.includes('LOCATION_NEAR') || !(e.signals.includes('BRAND_EXACT') || e.signals.includes('NAME_EXACT'))) { skip('WEAK_SIGNALS'); continue; }
    if (e.distanceMeters === undefined || e.distanceMeters > LOCATION_MATCH_METERS) { skip('NOT_WITHIN_75M'); continue; }
    const group = await identity.restaurantGroups.findOne({ _id: candidates[0] });
    if (!group?.seedRestaurantId) { skip('GROUP_WITHOUT_ANCHOR'); continue; }
    const note = `BULK_STRICT_APPROVAL: same brand or name, pins ${e.distanceMeters} m apart, no conflicts`;
    try {
      await assignToAnchorGroup(repos, {
        restaurantId: review.restaurantId,
        anchorRestaurantId: group.seedRestaurantId,
        note,
        expectedGroupId: group._id,
        replaceExisting: true,
        dryRun: false,
      });
      summary.approved++;
    } catch (err) {
      skip(String((err as { code?: string }).code ?? (err as Error).message));
    }
  }
  return summary;
}

export interface ResetSummary {
  dryRun: boolean;
  groupsRemoved: number;
  restaurantIds: string[];
}

/*
 * Lets restaurants that sit alone in a group made before the matching rules improved be matched again: removes that
 * single-member group and its SEED mapping. Only an untouched group qualifies: one member, automatic status, a SEED
 * mapping, and no canonical dishes. A verified group, or one with a dish layer, is never touched.
 */
export async function resetSingletonIdentity(db: Db, batchId: string, apply: boolean): Promise<ResetSummary> {
  const queue = getImportQueueCollection(db);
  const identity = getDiningIdentityCollections(db);
  const canonical = getDiningCanonicalItemCollections(db);
  const entries = await queue.find({ batchId, status: { $in: ['imported', 'partial'] }, restaurantId: { $exists: true } }).toArray();
  const summary: ResetSummary = { dryRun: !apply, groupsRemoved: 0, restaurantIds: [] };

  for (const entry of entries) {
    const restaurantId = entry.restaurantId as ObjectId;
    const mapping = await identity.restaurantMappings.findOne({ restaurantId, isActive: true });
    if (!mapping?.canonicalRestaurantGroupId || mapping.matchMethod !== 'SEED' || mapping.matchStatus !== 'MATCHED') continue;
    const groupId = mapping.canonicalRestaurantGroupId;
    const group = await identity.restaurantGroups.findOne({ _id: groupId });
    if (!group || group.identityStatus !== 'auto') continue;
    if ((await identity.restaurantMappings.countDocuments({ canonicalRestaurantGroupId: groupId })) !== 1) continue;
    if (await canonical.canonicalItems.findOne({ restaurantGroupId: groupId }, { projection: { _id: 1 } })) continue;
    if (apply) {
      await identity.restaurantMappings.deleteOne({ _id: mapping._id });
      await identity.restaurantGroups.deleteOne({ _id: groupId });
    }
    summary.groupsRemoved++;
    summary.restaurantIds.push(restaurantId.toHexString());
  }
  return summary;
}
