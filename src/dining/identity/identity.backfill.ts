import { Filter, ObjectId, WithId } from 'mongodb';
import { stripUndefined } from '../dining.object';
import type { DiningPlatform, DiningRestaurant } from '../dining.types';
import { DiningValidationError } from '../dining.validator';
import { decideMatch, MatchCandidate } from './identity.matcher';
import { extractSourceSignals, hasBranchLocator, SourceRestaurantSignals, toGroupSignals } from './identity.signals';
import type { DiningRestaurantGroup, DiningRestaurantMapping, MatchMethod, MatchStatus } from './identity.types';
import { buildGroupFromRestaurant, DiningIdentityRepositories } from './identity.service';
import { DiningIdentityConflictError } from './restaurant-mapping.repository';
import { validateRestaurantGroup, validateRestaurantMapping } from './identity.validator';
import { assertValid } from '../dining.validator';

/*
 * Builds canonical groups + mappings from existing dining_restaurants documents only (no network).
 *
 * Idempotent: a restaurant with an active MATCHED/REVIEW mapping is skipped; UNMATCHED ones are
 * re-evaluated (new source data or new groups may resolve them). Group creation is keyed by the
 * seed restaurant, so retries never duplicate a group. Dry run computes the same decisions —
 * including groups created earlier in the same run — without writing anything.
 */

export interface IdentityBackfillOptions {
  dryRun?: boolean;
  platform?: DiningPlatform;
  restaurantIds?: ObjectId[];
  now?: Date;
}

export type IdentityBackfillOutcome =
  | 'GROUP_CREATED'
  | 'MATCHED_EXISTING_GROUP'
  | 'REVIEW'
  | 'UNMATCHED'
  | 'ALREADY_MAPPED'
  | 'FAILED';

export interface IdentityBackfillEntry {
  restaurantId: string;
  platform: DiningPlatform;
  platformRestaurantId?: string;
  name?: string;
  outcome: IdentityBackfillOutcome;
  matchStatus?: MatchStatus;
  matchMethod?: MatchMethod;
  groupId?: string;
  confidence?: number;
  reason?: string;
  error?: { code: string; message: string };
}

export interface IdentityBackfillReport {
  dryRun: boolean;
  restaurantsInspected: number;
  groupsCreated: number;
  // Restaurants whose group already existed (newly matched or already mapped).
  groupsReused: number;
  mappingsCreated: number;
  // UNMATCHED mappings resolved by this run.
  mappingsUpdated: number;
  // Restaurants left as they were (already mapped, or still UNMATCHED).
  mappingsSkipped: number;
  // Restaurants whose active mapping is REVIEW after this run.
  mappingsRequiringReview: number;
  mappingsUnmatched: number;
  failed: number;
  entries: IdentityBackfillEntry[];
}

function emptyReport(dryRun: boolean): IdentityBackfillReport {
  return {
    dryRun,
    restaurantsInspected: 0,
    groupsCreated: 0,
    groupsReused: 0,
    mappingsCreated: 0,
    mappingsUpdated: 0,
    mappingsSkipped: 0,
    mappingsRequiringReview: 0,
    mappingsUnmatched: 0,
    failed: 0,
    entries: [],
  };
}

// Dry-run stand-ins for writes that did not happen, so later restaurants see earlier decisions.
class PendingState {
  readonly groups: Array<WithId<DiningRestaurantGroup>> = [];
  private readonly claims = new Map<string, DiningPlatform[]>();

  groupsMatching(signals: SourceRestaurantSignals): Array<WithId<DiningRestaurantGroup>> {
    const keys = new Set([...signals.names, ...signals.brands]);
    return this.groups.filter(g => [...g.signals.names, ...g.signals.brands].some(k => keys.has(k)));
  }

  claim(groupId: ObjectId, platform: DiningPlatform): void {
    const key = groupId.toHexString();
    this.claims.set(key, [...(this.claims.get(key) ?? []), platform]);
  }

  claimsFor(groupId: ObjectId): DiningPlatform[] {
    return this.claims.get(groupId.toHexString()) ?? [];
  }
}

type Planned = {
  outcome: Exclude<IdentityBackfillOutcome, 'ALREADY_MAPPED' | 'FAILED'>;
  mapping: DiningRestaurantMapping;
  createGroup?: ReturnType<typeof buildGroupFromRestaurant>;
};

export async function backfillRestaurantIdentity(
  repos: DiningIdentityRepositories,
  options: IdentityBackfillOptions = {}
): Promise<IdentityBackfillReport> {
  const dryRun = options.dryRun ?? false;
  const now = options.now ?? new Date();
  const report = emptyReport(dryRun);
  const pending = new PendingState();

  const filter: Filter<DiningRestaurant> = {};
  if (options.platform) filter.platform = options.platform;
  if (options.restaurantIds) filter._id = { $in: options.restaurantIds };

  for await (const restaurant of repos.restaurants.find(filter).sort({ createdAt: 1, _id: 1 })) {
    report.restaurantsInspected++;
    const base = {
      restaurantId: restaurant._id.toHexString(),
      platform: restaurant.platform,
      platformRestaurantId: restaurant.platformRestaurantId,
      name: restaurant.name?.en ?? restaurant.name?.ar,
    };
    try {
      const entry = await backfillOne(restaurant);
      report.entries.push({ ...base, ...entry });
    } catch (err) {
      report.failed++;
      report.entries.push({ ...base, outcome: 'FAILED', error: describeError(err) });
    }
  }
  return report;

  async function backfillOne(restaurant: WithId<DiningRestaurant>): Promise<EntryResult> {
    const existing = await repos.mappings.findActiveByRestaurant(restaurant._id);
    if (existing && existing.matchStatus !== 'UNMATCHED') return skipExisting(existing);

    const signals = extractSourceSignals(restaurant);
    const plan = await planFor(restaurant, signals);

    if (existing && plan.mapping.matchStatus === 'UNMATCHED') {
      report.mappingsSkipped++;
      report.mappingsUnmatched++;
      return summary(existing, 'UNMATCHED');
    }

    let mapping = plan.mapping;
    let outcome = plan.outcome;
    if (plan.createGroup) {
      const created = await createGroup(plan.createGroup);
      if (created.rejectedSeed) {
        mapping = unmatched(restaurant, 'SEED_GROUP_REJECTED', now);
        outcome = 'UNMATCHED';
      } else {
        mapping = { ...mapping, canonicalRestaurantGroupId: created.groupId };
        if (!created.created) {
          outcome = 'MATCHED_EXISTING_GROUP';
          mapping = { ...mapping, evidence: { ...mapping.evidence, reason: 'SEED_GROUP_REUSED' } };
        }
      }
    }

    if (dryRun) {
      assertValid(validateRestaurantMapping(mapping), 'restaurant mapping');
      if (existing) report.mappingsUpdated++;
      else report.mappingsCreated++;
    } else {
      try {
        if (existing) {
          await repos.mappings.replace(existing, mapping);
          report.mappingsUpdated++;
        } else {
          await repos.mappings.insert(mapping);
          report.mappingsCreated++;
        }
      } catch (err) {
        if (!(err instanceof DiningIdentityConflictError)) throw err;
        // Another writer mapped it first; leave that decision alone.
        const current = await repos.mappings.findActiveByRestaurant(restaurant._id);
        if (!current) throw err;
        return skipExisting(current);
      }
    }

    const groupId = mapping.canonicalRestaurantGroupId;
    if (mapping.matchStatus === 'MATCHED' && groupId) {
      if (dryRun) pending.claim(groupId, restaurant.platform);
      else if (mapping.matchMethod !== 'SEED') await repos.groups.addMatchedSignals(groupId, toGroupSignals(signals), now);
    }
    if (mapping.matchStatus === 'REVIEW' && groupId && !dryRun) await repos.groups.markReview(groupId, now);

    if (outcome === 'GROUP_CREATED') report.groupsCreated++;
    if (outcome === 'MATCHED_EXISTING_GROUP') report.groupsReused++;
    if (outcome === 'REVIEW') report.mappingsRequiringReview++;
    if (outcome === 'UNMATCHED') report.mappingsUnmatched++;
    return summary(mapping, outcome);
  }

  function skipExisting(existing: DiningRestaurantMapping) {
    report.mappingsSkipped++;
    if (existing.matchStatus === 'MATCHED') report.groupsReused++;
    if (existing.matchStatus === 'REVIEW') report.mappingsRequiringReview++;
    if (existing.matchStatus === 'UNMATCHED') report.mappingsUnmatched++;
    return summary(existing, 'ALREADY_MAPPED');
  }

  async function planFor(restaurant: WithId<DiningRestaurant>, signals: SourceRestaurantSignals): Promise<Planned> {
    const rejected = await repos.mappings.rejectedGroupIds(restaurant._id);
    const stored = await repos.groups.findCandidates(signals);
    const groups = [...stored, ...pending.groupsMatching(signals)].filter(g => !rejected.has(g._id.toHexString()));
    const claims = await repos.mappings.matchedPlatformsByGroup(stored.map(g => g._id));
    const candidates: MatchCandidate[] = groups.map(g => ({
      groupId: g._id,
      signals: g.signals,
      matchedPlatforms: [...(claims.get(g._id.toHexString()) ?? []), ...pending.claimsFor(g._id)],
    }));

    const decision = decideMatch(signals, candidates);
    if (decision.kind === 'match' || decision.kind === 'review') {
      return {
        outcome: decision.kind === 'match' ? 'MATCHED_EXISTING_GROUP' : 'REVIEW',
        mapping: mappingFor(restaurant, {
          canonicalRestaurantGroupId: decision.groupId,
          matchStatus: decision.kind === 'match' ? 'MATCHED' : 'REVIEW',
          matchMethod: decision.method,
          confidence: decision.confidence,
          evidence: decision.evidence,
        }, now),
      };
    }
    if (!hasBranchLocator(signals)) {
      return { outcome: 'UNMATCHED', mapping: unmatched(restaurant, 'BRANCH_IDENTITY_UNKNOWN', now) };
    }
    return {
      outcome: 'GROUP_CREATED',
      createGroup: buildGroupFromRestaurant(restaurant, signals, now),
      mapping: mappingFor(restaurant, {
        matchStatus: 'MATCHED',
        matchMethod: 'SEED',
        confidence: 1,
        evidence: { signals: [], conflicts: [], reason: 'NEW_GROUP' },
      }, now),
    };
  }

  async function createGroup(group: ReturnType<typeof buildGroupFromRestaurant>): Promise<{ groupId: ObjectId; created: boolean; rejectedSeed?: boolean }> {
    const rejected = await repos.mappings.rejectedGroupIds(group.seedRestaurantId);
    if (dryRun) {
      assertValid(validateRestaurantGroup(group), 'restaurant group');
      const placeholder = { ...group, _id: new ObjectId() };
      pending.groups.push(placeholder);
      return { groupId: placeholder._id, created: true };
    }
    const { group: stored, created } = await repos.groups.createFromSeed(group);
    if (!created && rejected.has(stored._id.toHexString())) return { groupId: stored._id, created, rejectedSeed: true };
    return { groupId: stored._id, created };
  }
}

function mappingFor(
  restaurant: WithId<DiningRestaurant>,
  decision: Pick<DiningRestaurantMapping, 'matchStatus' | 'confidence' | 'evidence'> & Partial<Pick<DiningRestaurantMapping, 'canonicalRestaurantGroupId' | 'matchMethod'>>,
  now: Date
): DiningRestaurantMapping {
  return stripUndefined({
    canonicalRestaurantGroupId: decision.canonicalRestaurantGroupId,
    restaurantId: restaurant._id,
    platform: restaurant.platform,
    platformRestaurantId: restaurant.platformRestaurantId,
    restaurantSourceKey: restaurant.sourceKey,
    matchStatus: decision.matchStatus,
    matchMethod: decision.matchMethod,
    confidence: decision.confidence,
    evidence: decision.evidence,
    isActive: true,
    decidedBy: 'backfill',
    createdAt: now,
    updatedAt: now,
  }) as DiningRestaurantMapping;
}

function unmatched(restaurant: WithId<DiningRestaurant>, reason: string, now: Date): DiningRestaurantMapping {
  return mappingFor(restaurant, { matchStatus: 'UNMATCHED', confidence: 0, evidence: { signals: [], conflicts: [], reason } }, now);
}

type EntryResult = Pick<IdentityBackfillEntry, 'outcome' | 'matchStatus' | 'matchMethod' | 'groupId' | 'confidence' | 'reason'>;

function summary(mapping: DiningRestaurantMapping, outcome: IdentityBackfillOutcome): EntryResult {
  return stripUndefined<EntryResult>({
    outcome,
    matchStatus: mapping.matchStatus,
    matchMethod: mapping.matchMethod,
    groupId: mapping.canonicalRestaurantGroupId?.toHexString(),
    confidence: mapping.confidence,
    reason: mapping.evidence.reason,
  });
}

function describeError(err: unknown): { code: string; message: string } {
  if (err instanceof DiningValidationError) return { code: 'VALIDATION_FAILED', message: err.message.slice(0, 500) };
  if (err instanceof DiningIdentityConflictError) return { code: err.code, message: err.message };
  return { code: 'BACKFILL_FAILED', message: 'Unexpected error while mapping this restaurant' };
}
