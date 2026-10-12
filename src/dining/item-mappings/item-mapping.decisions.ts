import { ObjectId, WithId } from 'mongodb';
import type { DiningCanonicalItem } from '../canonical-items/canonical-item.types';
import type { DiningMenuItem } from '../dining.types';
import { ItemMatchBatchCollections, planFingerprint } from './item-mapping.batch';
import { DiningItemMappingError } from './item-mapping.repository';
import { createItemMappingService, ItemMappingService } from './item-mapping.service';
import type { DiningItemMapping } from './item-mapping.types';

/*
 * Applies a human-reviewed list of per-item decisions for ONE source restaurant of ONE verified group.
 * Every entry names the exact active matcher decision it was reviewed against (mappingId); if that
 * decision changed since review, the entry is refused. Writes go only through ItemMappingService
 * (decidedBy manual). Dry run by default; a write requires zero refused entries and the plan
 * fingerprint of the reviewed dry run.
 *
 *   APPROVE        REVIEW → MATCHED to the proposed canonical item (target must equal the proposal)
 *   MAP_UNMATCHED  UNMATCHED → MATCHED to the named canonical item
 *   REMAP          REVIEW → MATCHED to a different canonical item (the old pairing is kept as REJECTED history)
 *   REJECT         REVIEW → REJECTED (target must equal the proposal being rejected)
 *   KEEP_REVIEW    no write
 */

export const MANUAL_DECISIONS = ['APPROVE', 'MAP_UNMATCHED', 'REMAP', 'REJECT', 'KEEP_REVIEW'] as const;
export type ManualDecision = (typeof MANUAL_DECISIONS)[number];

export interface ManualDecisionEntry {
  decision: ManualDecision;
  mappingId: ObjectId;
  menuItemId: ObjectId;
  canonicalItemId?: ObjectId;
  reason: string;
}

export type DecisionRefusal =
  | 'SOURCE_ITEM_NOT_FOUND'
  | 'DUPLICATE_ENTRY'
  | 'STALE_DECISION'
  | 'NOT_MATCHER_DECISION'
  | 'STATUS_MISMATCH'
  | 'TARGET_REQUIRED'
  | 'TARGET_MISMATCH'
  | 'CANONICAL_OUT_OF_SCOPE'
  | 'PLATFORM_ALREADY_MAPPED'
  | 'DUPLICATE_TARGET'
  | 'REASON_REQUIRED';

export type DecisionRunRefusal = 'INVALID_FILE' | 'RESTAURANT_NOT_FOUND' | 'RESTAURANT_NOT_IN_GROUP' | 'DECISIONS_REFUSED' | 'PLAN_REQUIRED' | 'PLAN_CHANGED';

export class DiningItemDecisionError extends Error {
  readonly code: DecisionRunRefusal;

  constructor(code: DecisionRunRefusal, message: string) {
    super(message);
    this.name = 'DiningItemDecisionError';
    this.code = code;
  }
}

export const MANUAL_DECISION_NOTE = 'MANUAL_DECISION';

const HEX_ID = /^[0-9a-f]{24}$/i;

// Accepts the reviewed decisions file: [{ decision, mappingId, menuItemId, target: { canonicalItemId } | null, reason }].
export function parseDecisionEntries(raw: unknown): ManualDecisionEntry[] {
  if (!Array.isArray(raw)) throw new DiningItemDecisionError('INVALID_FILE', 'Decisions file must be a JSON array');
  return raw.map((e, i) => {
    const bad = (what: string) => new DiningItemDecisionError('INVALID_FILE', `Entry ${i}: ${what}`);
    if (!e || typeof e !== 'object') throw bad('not an object');
    const o = e as Record<string, unknown>;
    if (!MANUAL_DECISIONS.includes(o.decision as ManualDecision)) throw bad(`unknown decision ${JSON.stringify(o.decision)}`);
    for (const k of ['mappingId', 'menuItemId'] as const) if (typeof o[k] !== 'string' || !HEX_ID.test(o[k] as string)) throw bad(`${k} must be an ObjectId`);
    const target = o.target as { canonicalItemId?: unknown } | null | undefined;
    const canonicalItemId = target?.canonicalItemId;
    if (canonicalItemId !== undefined && (typeof canonicalItemId !== 'string' || !HEX_ID.test(canonicalItemId))) throw bad('target.canonicalItemId must be an ObjectId');
    return {
      decision: o.decision as ManualDecision,
      mappingId: new ObjectId(o.mappingId as string),
      menuItemId: new ObjectId(o.menuItemId as string),
      ...(canonicalItemId ? { canonicalItemId: new ObjectId(canonicalItemId) } : {}),
      reason: typeof o.reason === 'string' ? o.reason.trim() : '',
    };
  });
}

export interface ManualDecisionsInput {
  restaurantGroupId: ObjectId;
  restaurantId: ObjectId;
  entries: ManualDecisionEntry[];
  dryRun?: boolean;
  expectedPlan?: string;
  now?: Date;
}

export interface DecisionLine {
  decision: ManualDecision;
  menuItemId: string;
  mappingId: string;
  name: string | null;
  fromCanonicalItemId: string | null;
  canonicalItemId: string | null;
  canonicalName: string | null;
  refusals: DecisionRefusal[];
}

export interface ManualDecisionsReport {
  dryRun: boolean;
  plan: string;
  restaurant: { restaurantId: string; platform: string; platformRestaurantId: string | null; name: string | null };
  entriesInFile: number;
  // Entries whose source item belongs to another restaurant; ignored by this run.
  otherRestaurants: number;
  writable: DecisionLine[];
  kept: DecisionLine[];
  refused: DecisionLine[];
  byDecision: Partial<Record<ManualDecision, number>>;
  writes: { planned: number; written?: number; failures?: number };
  errors: Array<{ menuItemId: string; code: string; message: string }>;
}

const hex = (id: ObjectId) => id.toHexString();
const WRITES_TARGET = new Set<ManualDecision>(['APPROVE', 'MAP_UNMATCHED', 'REMAP']);
const REQUIRED_STATUS: Record<ManualDecision, DiningItemMapping['matchStatus']> = {
  APPROVE: 'REVIEW',
  MAP_UNMATCHED: 'UNMATCHED',
  REMAP: 'REVIEW',
  REJECT: 'REVIEW',
  KEEP_REVIEW: 'REVIEW',
};

export async function runManualItemDecisions(
  collections: ItemMatchBatchCollections,
  input: ManualDecisionsInput,
  service: ItemMappingService = createItemMappingService(collections)
): Promise<ManualDecisionsReport> {
  const dryRun = input.dryRun !== false;
  const now = input.now ?? new Date();
  const groupId = input.restaurantGroupId;

  const restaurant = await collections.restaurants.findOne({ _id: input.restaurantId }, { projection: { platform: 1, platformRestaurantId: 1, name: 1 } });
  if (!restaurant) throw new DiningItemDecisionError('RESTAURANT_NOT_FOUND', 'Source restaurant not found');
  const member = await collections.restaurantMappings.findOne({ restaurantId: restaurant._id, canonicalRestaurantGroupId: groupId, isActive: true, matchStatus: 'MATCHED' });
  if (!member) {
    throw new DiningItemDecisionError('RESTAURANT_NOT_IN_GROUP', `${restaurant.platform}:${restaurant.platformRestaurantId ?? '?'} has no active MATCHED mapping to group ${hex(groupId)}`);
  }

  const items = await collections.menuItems.find({ _id: { $in: input.entries.map(e => e.menuItemId) } }).toArray();
  const itemById = new Map(items.map(i => [hex(i._id), i]));
  // Entries of other restaurants are out of scope; unknown source items are refused (the file cannot be trusted).
  const scoped = input.entries.filter(e => {
    const item = itemById.get(hex(e.menuItemId));
    return !item || item.restaurantId.equals(restaurant._id);
  });

  const actives = await collections.itemMappings.find({ menuItemId: { $in: scoped.map(e => e.menuItemId) }, isActive: true }).toArray();
  const activeByItem = new Map(actives.map(m => [hex(m.menuItemId), m]));
  const targetIds = [...new Set(scoped.flatMap(e => [e.canonicalItemId, activeByItem.get(hex(e.menuItemId))?.canonicalItemId]).filter((id): id is ObjectId => !!id).map(hex))].map(
    id => new ObjectId(id)
  );
  const canonicals = await collections.canonicalItems.find({ _id: { $in: targetIds } }).toArray();
  const canonicalById = new Map(canonicals.map(c => [hex(c._id), c]));
  const taken = new Set(
    (await collections.itemMappings
      .find({ canonicalItemId: { $in: targetIds }, platform: restaurant.platform, isActive: true, matchStatus: 'MATCHED' }, { projection: { canonicalItemId: 1 } })
      .toArray()).map(m => hex(m.canonicalItemId!))
  );

  type Planned = { entry: ManualDecisionEntry; item?: WithId<DiningMenuItem>; active?: WithId<DiningItemMapping>; canonical?: WithId<DiningCanonicalItem>; refusals: DecisionRefusal[] };
  const seen = new Map<string, number>();
  for (const e of scoped) seen.set(hex(e.menuItemId), (seen.get(hex(e.menuItemId)) ?? 0) + 1);
  const planned: Planned[] = scoped.map(entry => {
    const item = itemById.get(hex(entry.menuItemId));
    const active = activeByItem.get(hex(entry.menuItemId));
    const canonical = entry.canonicalItemId ? canonicalById.get(hex(entry.canonicalItemId)) : undefined;
    const refusals: DecisionRefusal[] = [];
    if (!item) return { entry, refusals: ['SOURCE_ITEM_NOT_FOUND'] };
    if ((seen.get(hex(entry.menuItemId)) ?? 0) > 1) refusals.push('DUPLICATE_ENTRY');
    if (!entry.reason) refusals.push('REASON_REQUIRED');
    if (!active || !active._id.equals(entry.mappingId)) return { entry, item, active, canonical, refusals: [...refusals, 'STALE_DECISION'] };
    if (active.decidedBy !== 'matcher') refusals.push('NOT_MATCHER_DECISION');
    if (active.matchStatus !== REQUIRED_STATUS[entry.decision]) refusals.push('STATUS_MISMATCH');
    if (entry.decision === 'KEEP_REVIEW') return { entry, item, active, canonical, refusals };

    if (!entry.canonicalItemId) return { entry, item, active, canonical, refusals: [...refusals, 'TARGET_REQUIRED'] };
    const proposal = active.canonicalItemId;
    if ((entry.decision === 'APPROVE' || entry.decision === 'REJECT') && !proposal?.equals(entry.canonicalItemId)) refusals.push('TARGET_MISMATCH');
    if (entry.decision === 'REMAP' && (!proposal || proposal.equals(entry.canonicalItemId))) refusals.push('TARGET_MISMATCH');
    if (!canonical || !canonical.restaurantGroupId.equals(groupId) || canonical.status !== 'active') refusals.push('CANONICAL_OUT_OF_SCOPE');
    if (WRITES_TARGET.has(entry.decision) && taken.has(hex(entry.canonicalItemId))) refusals.push('PLATFORM_ALREADY_MAPPED');
    return { entry, item, active, canonical, refusals };
  });
  const byTarget = new Map<string, Planned[]>();
  for (const p of planned) {
    if (!WRITES_TARGET.has(p.entry.decision) || !p.entry.canonicalItemId) continue;
    const k = hex(p.entry.canonicalItemId);
    byTarget.set(k, [...(byTarget.get(k) ?? []), p]);
  }
  for (const group of byTarget.values()) if (group.length > 1) for (const p of group) p.refusals.push('DUPLICATE_TARGET');

  const refused = planned.filter(p => p.refusals.length > 0);
  const kept = planned.filter(p => p.refusals.length === 0 && p.entry.decision === 'KEEP_REVIEW');
  const writable = planned.filter(p => p.refusals.length === 0 && p.entry.decision !== 'KEEP_REVIEW');
  const plan = planFingerprint(
    writable.map(p => ({
      menuItemId: hex(p.entry.menuItemId),
      outcome: `${p.entry.decision}:${hex(p.entry.mappingId)}`,
      status: p.entry.decision === 'REJECT' ? 'REJECTED' : 'MATCHED',
      canonicalItemId: hex(p.entry.canonicalItemId!),
      method: 'MANUAL',
    }))
  );

  const errors: ManualDecisionsReport['errors'] = [];
  let written = 0;
  if (!dryRun) {
    if (refused.length) throw new DiningItemDecisionError('DECISIONS_REFUSED', `${refused.length} entr${refused.length === 1 ? 'y is' : 'ies are'} refused; fix the file and re-run the dry run`);
    if (!input.expectedPlan) throw new DiningItemDecisionError('PLAN_REQUIRED', 'A write requires --expect-plan from a reviewed dry run');
    if (input.expectedPlan !== plan) throw new DiningItemDecisionError('PLAN_CHANGED', `Plan is ${plan}, not the reviewed ${input.expectedPlan}; re-run the dry run and review again`);
    for (const p of writable) {
      const fail = (code: string, message: string) => errors.push({ menuItemId: hex(p.entry.menuItemId), code, message });
      const note = `${MANUAL_DECISION_NOTE} ${p.entry.decision}: ${p.entry.reason}`;
      try {
        const current = await service.repository.findActiveByMenuItem(p.entry.menuItemId);
        if (!current?._id.equals(p.entry.mappingId)) {
          fail('DECISION_CHANGED', 'The reviewed decision is no longer the active one');
          continue;
        }
        if (p.entry.decision === 'REJECT') await service.rejectMapping(p.entry.menuItemId, { note, now });
        else if (p.entry.decision === 'REMAP') await service.remapSourceItem(p.entry.menuItemId, p.entry.canonicalItemId!, { note, now });
        else await service.approveMapping(p.entry.menuItemId, { canonicalItemId: p.entry.canonicalItemId!, note, now });
        written++;
      } catch (err) {
        if (err instanceof DiningItemMappingError) fail(err.code, err.message);
        else fail('UNEXPECTED', 'Write failed');
      }
    }
  }

  const line = (p: Planned): DecisionLine => ({
    decision: p.entry.decision,
    menuItemId: hex(p.entry.menuItemId),
    mappingId: hex(p.entry.mappingId),
    name: p.item?.name?.en ?? p.item?.name?.ar ?? null,
    fromCanonicalItemId: p.active?.canonicalItemId ? hex(p.active.canonicalItemId) : null,
    canonicalItemId: p.entry.canonicalItemId ? hex(p.entry.canonicalItemId) : null,
    canonicalName: p.canonical?.canonicalName?.en ?? p.canonical?.canonicalName?.ar ?? null,
    refusals: [...p.refusals],
  });
  const byDecision: ManualDecisionsReport['byDecision'] = {};
  for (const p of [...writable, ...kept]) byDecision[p.entry.decision] = (byDecision[p.entry.decision] ?? 0) + 1;

  return {
    dryRun,
    plan,
    restaurant: { restaurantId: hex(restaurant._id), platform: restaurant.platform, platformRestaurantId: restaurant.platformRestaurantId ?? null, name: restaurant.name?.en ?? restaurant.name?.ar ?? null },
    entriesInFile: input.entries.length,
    otherRestaurants: input.entries.length - scoped.length,
    writable: writable.map(line),
    kept: kept.map(line),
    refused: refused.map(line),
    byDecision,
    writes: { planned: writable.length, ...(dryRun ? {} : { written, failures: errors.length }) },
    errors,
  };
}
