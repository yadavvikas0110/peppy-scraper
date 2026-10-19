import { createHash } from 'crypto';
import { Collection, Db, ObjectId, WithId } from 'mongodb';
import type { DiningCanonicalItem } from '../canonical-items/canonical-item.types';
import { DINING_COLLECTIONS } from '../db/dining.collections';
import type { DiningMenuItem, DiningPlatform, DiningRestaurant } from '../dining.types';
import { DiningItemMappingCollections, getDiningItemMappingCollections } from './item-mapping.collections';
import { DiningItemMappingError } from './item-mapping.repository';
import { createItemMappingService, ItemMappingService, MatchSourceItemResult } from './item-mapping.service';
import type { DiningItemMapping, ItemMatchStatus } from './item-mapping.types';

/*
 * Batch cross-platform matching for ONE source restaurant against the canonical items of ONE group
 * that were all seeded from ONE other platform (e.g. Deliveroo Golden Mile → Talabat-seeded Palm items).
 *
 * Every decision comes from ItemMappingService.matchSourceItem (dry run); this module only scopes,
 * reports and guards. A write requires the plan fingerprint of a reviewed dry run and stores exactly
 * the reviewed decisions, so the result never depends on write order. It only fills source items
 * that have no active decision: existing decisions (import, manual or matcher) are never changed,
 * so re-running is a no-op. Items planned as MATCHED to the same canonical item as another item of
 * this restaurant are held back for manual review. The unique active-mapping index stays the final guard.
 */

export const MATCH_BATCH_DRY_RUN_CONCURRENCY = 8;
export const DEFAULT_REPORT_LIMIT = 500;

export type ItemMatchBatchRefusal =
  | 'RESTAURANT_NOT_FOUND'
  | 'RESTAURANT_NOT_IN_GROUP'
  | 'SAME_PLATFORM_AS_SEED'
  | 'NO_SEED_CANONICAL_ITEMS'
  | 'FOREIGN_CANONICAL_ITEMS'
  | 'OUT_OF_SCOPE_CANDIDATE'
  | 'PLAN_REQUIRED'
  | 'PLAN_CHANGED';

export class DiningItemMatchBatchError extends Error {
  readonly code: ItemMatchBatchRefusal;

  constructor(code: ItemMatchBatchRefusal, message: string) {
    super(message);
    this.name = 'DiningItemMatchBatchError';
    this.code = code;
  }
}

export interface ItemMatchBatchInput {
  restaurantGroupId: ObjectId;
  // Source restaurant (dining_restaurants _id) whose items are matched.
  restaurantId: ObjectId;
  // Every active canonical item of the group must be seeded from this platform.
  seedPlatform: DiningPlatform;
  dryRun?: boolean;
  // Required for a write: the `plan` value printed by the reviewed dry run.
  expectedPlan?: string;
  now?: Date;
  reportLimit?: number;
}

export interface ItemRef {
  menuItemId: string;
  name: string | null;
  // Display only; never an input to matching.
  price: number | null;
  currency: string | null;
}

export interface CanonicalRef {
  canonicalItemId: string;
  name: string | null;
  // Price of the canonical item's seed source item. Display only.
  seedPrice: number | null;
}

export interface DecisionLine {
  item: ItemRef;
  outcome: MatchSourceItemResult['outcome'];
  status: ItemMatchStatus;
  decidedBy: DiningItemMapping['decidedBy'];
  matchMethod: string | null;
  confidence: number;
  canonical: CanonicalRef | null;
  otherCandidates: CanonicalRef[];
  reasons: string[];
  conflicts: string[];
}

export interface ItemMatchBatchReport {
  dryRun: boolean;
  plan: string;
  scope: {
    restaurantGroupId: string;
    restaurant: { restaurantId: string; platform: DiningPlatform; platformRestaurantId: string | null; name: string | null };
    seedPlatform: DiningPlatform;
    canonicalItems: number;
    groupMembers: string[];
  };
  sourceItems: { total: number; inspected: number; skippedInactive: number };
  // Decisions for items without an active decision (the ones this batch would write).
  // REJECTED counts existing rejected pairings of these items (history the matcher respects and
  // never proposes again); the matcher itself never produces REJECTED.
  decisions: Record<ItemMatchStatus, number>;
  // matchSourceItem's view per item: created (no active decision), unchanged, updated (the matcher
  // would revise its own earlier decision — reported, never applied here), kept_existing (import/manual).
  outcomes: Record<MatchSourceItemResult['outcome'] | 'failed', number>;
  methods: Record<string, number>;
  confidence: Partial<Record<ItemMatchStatus, { min: number; max: number; avg: number }>>;
  conflicts: Record<string, number>;
  matched: DecisionLine[];
  review: DecisionLine[];
  unmatched: DecisionLine[];
  keptExisting: DecisionLine[];
  revisions: DecisionLine[];
  // Several items of this restaurant planned as MATCHED to one canonical item: none of them is written.
  duplicateTargets: Array<{ canonical: CanonicalRef; items: ItemRef[] }>;
  errors: Array<{ menuItemId: string; code: string; message: string }>;
  // What --apply writes (dry run) or wrote (apply).
  writes: { planned: number; heldDuplicates: number; written?: number; failures?: number };
  truncated: boolean;
}

const hex = (id: ObjectId) => id.toHexString();
const round = (n: number) => Math.round(n * 1000) / 1000;

export function planFingerprint(lines: Array<{ menuItemId: string; outcome: string; status: string; canonicalItemId?: string; method?: string }>): string {
  const body = lines
    .map(l => `${l.menuItemId}|${l.outcome}|${l.status}|${l.canonicalItemId ?? '-'}|${l.method ?? '-'}`)
    .sort()
    .join('\n');
  return createHash('sha256').update(body).digest('hex').slice(0, 16);
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    })
  );
  return out;
}

export type ItemMatchBatchCollections = DiningItemMappingCollections & { restaurants: Collection<DiningRestaurant> };

export function getItemMatchBatchCollections(db: Db): ItemMatchBatchCollections {
  return { ...getDiningItemMappingCollections(db), restaurants: db.collection<DiningRestaurant>(DINING_COLLECTIONS.restaurants) };
}

type Planned = { item: WithId<DiningMenuItem>; result?: MatchSourceItemResult; error?: { code: string; message: string } };

export async function runItemMatchBatch(
  collections: ItemMatchBatchCollections,
  input: ItemMatchBatchInput,
  service: ItemMappingService = createItemMappingService(collections)
): Promise<ItemMatchBatchReport> {
  const dryRun = input.dryRun !== false;
  const now = input.now ?? new Date();
  const reportLimit = input.reportLimit ?? DEFAULT_REPORT_LIMIT;
  const groupId = input.restaurantGroupId;

  // ── Scope checks (read-only) ──
  const restaurant = await collections.restaurants.findOne({ _id: input.restaurantId }, { projection: { platform: 1, platformRestaurantId: 1, name: 1 } });
  if (!restaurant) throw new DiningItemMatchBatchError('RESTAURANT_NOT_FOUND', 'Source restaurant not found');
  if (restaurant.platform === input.seedPlatform) {
    throw new DiningItemMatchBatchError('SAME_PLATFORM_AS_SEED', `Source restaurant is on ${restaurant.platform}, the same platform as the canonical seeds`);
  }
  const members = await collections.restaurantMappings
    .find({ canonicalRestaurantGroupId: groupId, isActive: true, matchStatus: 'MATCHED' }, { projection: { restaurantId: 1, platform: 1, platformRestaurantId: 1 } })
    .toArray();
  if (!members.some(m => m.restaurantId.equals(restaurant._id))) {
    throw new DiningItemMatchBatchError('RESTAURANT_NOT_IN_GROUP', `${restaurant.platform}:${restaurant.platformRestaurantId ?? '?'} has no active MATCHED mapping to group ${hex(groupId)}`);
  }

  const canonicals = await collections.canonicalItems
    .find({ restaurantGroupId: groupId, status: 'active' }, { projection: { canonicalName: 1, seedMenuItemId: 1, seedRestaurantId: 1, seedPlatform: 1 } })
    .toArray();
  const seedMembers = new Set(members.filter(m => m.platform === input.seedPlatform).map(m => hex(m.restaurantId)));
  const foreign = canonicals.filter(c => c.seedPlatform !== input.seedPlatform || !seedMembers.has(hex(c.seedRestaurantId)));
  if (foreign.length) {
    throw new DiningItemMatchBatchError(
      'FOREIGN_CANONICAL_ITEMS',
      `${foreign.length} active canonical item(s) in the group are not seeded from a ${input.seedPlatform} member of the group`
    );
  }
  if (canonicals.length === 0) throw new DiningItemMatchBatchError('NO_SEED_CANONICAL_ITEMS', `Group has no active canonical items seeded from ${input.seedPlatform}`);

  const seedItems = await collections.menuItems.find({ _id: { $in: canonicals.map(c => c.seedMenuItemId) } }, { projection: { price: 1 } }).toArray();
  const seedPrice = new Map(seedItems.map(i => [hex(i._id), typeof i.price === 'number' ? i.price : null]));
  const canonicalById = new Map(canonicals.map(c => [hex(c._id), c as WithId<DiningCanonicalItem>]));
  const canonicalRef = (id: ObjectId): CanonicalRef => {
    const c = canonicalById.get(hex(id));
    return { canonicalItemId: hex(id), name: c?.canonicalName?.en ?? c?.canonicalName?.ar ?? null, seedPrice: c ? seedPrice.get(hex(c.seedMenuItemId)) ?? null : null };
  };

  // ── Plan: matchSourceItem in dry-run mode for this restaurant's active source items only ──
  const items = await collections.menuItems.find({ restaurantId: restaurant._id }).sort({ _id: 1 }).toArray();
  const active = items.filter(i => i.isActive !== false);
  const planned: Planned[] = await mapLimit(active, MATCH_BATCH_DRY_RUN_CONCURRENCY, async item => {
    try {
      return { item, result: await service.matchSourceItem(item._id, { dryRun: true, now }) };
    } catch (err) {
      const code = err instanceof DiningItemMappingError ? err.code : 'UNEXPECTED';
      return { item, error: { code, message: err instanceof DiningItemMappingError ? err.message : 'Unexpected error' } };
    }
  });

  for (const p of planned) {
    const m = p.result?.mapping;
    if (!m) continue;
    if (!m.restaurantGroupId.equals(groupId)) {
      throw new DiningItemMatchBatchError('OUT_OF_SCOPE_CANDIDATE', `Item ${hex(p.item._id)} resolved to group ${hex(m.restaurantGroupId)}`);
    }
    // Existing import/manual decisions may point anywhere in the group; only new decisions must stay in the seed set.
    if (p.result!.outcome === 'kept_existing') continue;
    const ids = [m.canonicalItemId, ...(m.evidence.candidateCanonicalItemIds ?? [])].filter((id): id is ObjectId => !!id);
    if (ids.some(id => !canonicalById.has(hex(id)))) {
      throw new DiningItemMatchBatchError('OUT_OF_SCOPE_CANDIDATE', `Item ${hex(p.item._id)} references canonical item(s) outside the scoped seed set`);
    }
  }

  const fresh = planned.filter(p => p.result?.outcome === 'created');
  const byTarget = new Map<string, Planned[]>();
  for (const p of fresh) {
    if (p.result!.mapping.matchStatus !== 'MATCHED') continue;
    const key = hex(p.result!.mapping.canonicalItemId!);
    byTarget.set(key, [...(byTarget.get(key) ?? []), p]);
  }
  const held = new Set([...byTarget.values()].filter(ps => ps.length > 1).flat().map(p => hex(p.item._id)));
  const toWrite = fresh.filter(p => !held.has(hex(p.item._id)));

  const fingerprint = planFingerprint(
    planned
      .filter(p => p.result)
      .map(p => ({
        menuItemId: hex(p.item._id),
        outcome: held.has(hex(p.item._id)) ? 'held' : p.result!.outcome,
        status: p.result!.mapping.matchStatus,
        canonicalItemId: p.result!.mapping.canonicalItemId?.toHexString(),
        method: p.result!.mapping.matchMethod,
      }))
  );

  // ── Apply: store exactly the reviewed decisions, one insert per source item ──
  const writeErrors: ItemMatchBatchReport['errors'] = [];
  let written = 0;
  if (!dryRun) {
    if (!input.expectedPlan) throw new DiningItemMatchBatchError('PLAN_REQUIRED', 'A write requires --expect-plan from a reviewed dry run');
    if (input.expectedPlan !== fingerprint) {
      throw new DiningItemMatchBatchError('PLAN_CHANGED', `Plan is ${fingerprint}, not the reviewed ${input.expectedPlan}; re-run the dry run and review again`);
    }
    for (const p of toWrite) {
      const mapping = p.result!.mapping;
      const fail = (code: string, message: string) => writeErrors.push({ menuItemId: hex(p.item._id), code, message });
      try {
        if (mapping.matchStatus === 'MATCHED') {
          const clash = await collections.itemMappings.findOne(
            { canonicalItemId: mapping.canonicalItemId, platform: mapping.platform, isActive: true, matchStatus: 'MATCHED' },
            { projection: { _id: 1 } }
          );
          if (clash) {
            fail('PLATFORM_ALREADY_MAPPED', `Canonical item already has an active MATCHED ${mapping.platform} listing`);
            continue;
          }
        }
        // Insert only: the unique active index refuses it if a decision appeared since the plan.
        await service.repository.insert(mapping);
        written++;
      } catch (err) {
        if (err instanceof DiningItemMappingError) fail(err.code, err.message);
        else fail('UNEXPECTED', 'Write failed');
      }
    }
  }

  // ── Report ──
  const rejectedHistory = await collections.itemMappings.countDocuments({ menuItemId: { $in: active.map(i => i._id) }, matchStatus: 'REJECTED' });
  const report: ItemMatchBatchReport = {
    dryRun,
    plan: fingerprint,
    scope: {
      restaurantGroupId: hex(groupId),
      restaurant: { restaurantId: hex(restaurant._id), platform: restaurant.platform, platformRestaurantId: restaurant.platformRestaurantId ?? null, name: restaurant.name?.en ?? restaurant.name?.ar ?? null },
      seedPlatform: input.seedPlatform,
      canonicalItems: canonicals.length,
      groupMembers: members.map(m => `${m.platform}:${m.platformRestaurantId ?? hex(m.restaurantId)}`),
    },
    sourceItems: { total: items.length, inspected: active.length, skippedInactive: items.length - active.length },
    decisions: { MATCHED: 0, REVIEW: 0, UNMATCHED: 0, REJECTED: rejectedHistory },
    outcomes: { created: 0, updated: 0, unchanged: 0, kept_existing: 0, failed: 0 },
    methods: {},
    confidence: {},
    conflicts: {},
    matched: [],
    review: [],
    unmatched: [],
    keptExisting: [],
    revisions: [],
    duplicateTargets: [],
    errors: [],
    writes: { planned: toWrite.length, heldDuplicates: held.size, ...(dryRun ? {} : { written, failures: writeErrors.length }) },
    truncated: false,
  };

  const itemRef = (i: WithId<DiningMenuItem>): ItemRef => ({
    menuItemId: hex(i._id),
    name: i.name?.en ?? i.name?.ar ?? null,
    price: typeof i.price === 'number' ? i.price : null,
    currency: i.currency ?? null,
  });
  const lineOf = (p: Planned): DecisionLine => {
    const { outcome, mapping: m } = p.result!;
    return {
      item: itemRef(p.item),
      outcome,
      status: m.matchStatus,
      decidedBy: m.decidedBy,
      matchMethod: m.matchMethod ?? null,
      confidence: m.confidence,
      canonical: m.canonicalItemId ? canonicalRef(m.canonicalItemId) : null,
      otherCandidates: (m.evidence.candidateCanonicalItemIds ?? []).filter(id => !m.canonicalItemId?.equals(id)).map(canonicalRef),
      reasons: [...m.evidence.reasons],
      conflicts: [...m.evidence.conflicts],
    };
  };
  const push = (list: DecisionLine[], line: DecisionLine) => {
    if (list.length < reportLimit) list.push(line);
    else report.truncated = true;
  };

  const confidences: Partial<Record<ItemMatchStatus, number[]>> = {};
  for (const p of planned) {
    if (p.error || !p.result) {
      report.outcomes.failed++;
      report.errors.push({ menuItemId: hex(p.item._id), code: p.error?.code ?? 'UNEXPECTED', message: p.error?.message ?? 'No result' });
      continue;
    }
    const { outcome, mapping: m } = p.result;
    report.outcomes[outcome]++;
    const line = lineOf(p);
    if (outcome === 'kept_existing') { push(report.keptExisting, line); continue; }
    if (outcome === 'updated') { push(report.revisions, line); continue; }
    if (outcome === 'unchanged') continue;

    if (m.matchStatus !== 'REJECTED') report.decisions[m.matchStatus]++;
    if (m.matchMethod) report.methods[`${m.matchStatus}:${m.matchMethod}`] = (report.methods[`${m.matchStatus}:${m.matchMethod}`] ?? 0) + 1;
    (confidences[m.matchStatus] ??= []).push(m.confidence);
    for (const c of m.evidence.conflicts) report.conflicts[c] = (report.conflicts[c] ?? 0) + 1;
    if (m.matchStatus === 'MATCHED') push(report.matched, line);
    else if (m.matchStatus === 'REVIEW') push(report.review, line);
    else if (m.matchStatus === 'UNMATCHED') push(report.unmatched, line);
  }
  for (const [status, list] of Object.entries(confidences) as Array<[ItemMatchStatus, number[]]>) {
    report.confidence[status] = { min: Math.min(...list), max: Math.max(...list), avg: round(list.reduce((s, n) => s + n, 0) / list.length) };
  }
  for (const [id, ps] of byTarget) {
    if (ps.length > 1) report.duplicateTargets.push({ canonical: canonicalRef(new ObjectId(id)), items: ps.map(p => itemRef(p.item)) });
  }
  report.errors.push(...writeErrors);
  return report;
}
