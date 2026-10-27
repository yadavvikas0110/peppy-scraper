import { ObjectId, WithId } from 'mongodb';
import { extractVariant, keywordTokens, normalizeCoreName, normalizeItemText } from '../canonical-items/canonical-item.text';
import type { DiningCanonicalItem } from '../canonical-items/canonical-item.types';
import type { DiningMenuItem, DiningPlatform } from '../dining.types';
import { validateMenuItem } from '../dining.validator';
import type { DiningItemMappingCollections } from './item-mapping.collections';
import { createItemMappingRepository, DiningItemMappingError, ItemMappingRepository } from './item-mapping.repository';
import type { DiningItemMapping, ItemMatchEvidence } from './item-mapping.types';
import { ITEM_MATCHER_CONFIG, ItemMatcherConfig } from './item-matcher.config';
import { ItemMatchCandidate, ItemMatchDecision, matchItem, scoreName, toMatchSource } from './item-matcher';

// Candidate generation reads at most this many canonical items per keyword query.
export const CANDIDATE_QUERY_LIMIT = 200;

export interface ItemMappingService {
  repository: ItemMappingRepository;
  resolveRestaurantGroupId(restaurantId: ObjectId): Promise<ObjectId>;
  findCandidates(item: WithId<DiningMenuItem>, restaurantGroupId: ObjectId): Promise<ItemMatchCandidate[]>;
  matchSourceItem(menuItemId: ObjectId, options?: { dryRun?: boolean; now?: Date }): Promise<MatchSourceItemResult>;
  approveMapping(menuItemId: ObjectId, options?: { canonicalItemId?: ObjectId; note?: string; now?: Date }): Promise<ManualResult>;
  rejectMapping(menuItemId: ObjectId, options?: { note?: string; now?: Date }): Promise<ManualResult>;
  remapSourceItem(menuItemId: ObjectId, canonicalItemId: ObjectId, options?: { note?: string; now?: Date }): Promise<ManualResult>;
}

export interface MatchSourceItemResult {
  outcome: 'created' | 'updated' | 'unchanged' | 'kept_existing';
  dryRun: boolean;
  decision?: ItemMatchDecision;
  mapping: DiningItemMapping;
}

export interface ManualResult {
  outcome: 'created' | 'unchanged';
  mapping: DiningItemMapping;
  previous?: WithId<DiningItemMapping>;
}

const cleanNote = (note: string | undefined) => (note && note.trim() ? note.trim().slice(0, 500) : undefined);

export function createItemMappingService(
  collections: DiningItemMappingCollections,
  options: { config?: ItemMatcherConfig } = {}
): ItemMappingService {
  const config = options.config ?? ITEM_MATCHER_CONFIG;
  const repository = createItemMappingRepository(collections.itemMappings);

  async function resolveRestaurantGroupId(restaurantId: ObjectId): Promise<ObjectId> {
    const mapping = await collections.restaurantMappings.findOne({ restaurantId, isActive: true, matchStatus: 'MATCHED' });
    if (!mapping?.canonicalRestaurantGroupId) throw new DiningItemMappingError('RESTAURANT_NOT_MAPPED', 'Source restaurant has no matched restaurant group');
    const group = await collections.restaurantGroups.findOne({ _id: mapping.canonicalRestaurantGroupId }, { projection: { _id: 1 } });
    if (!group) throw new DiningItemMappingError('RESTAURANT_GROUP_NOT_FOUND', 'Restaurant group not found');
    return group._id;
  }

  async function loadSource(menuItemId: ObjectId): Promise<WithId<DiningMenuItem>> {
    const item = await collections.menuItems.findOne({ _id: menuItemId });
    if (!item) throw new DiningItemMappingError('SOURCE_ITEM_NOT_FOUND', 'Source menu item not found');
    const check = validateMenuItem(item);
    if (!check.valid) throw new DiningItemMappingError('INVALID_SOURCE_ITEM', `Invalid source item fields: ${[...new Set(check.issues.map(i => i.path))].join(', ')}`);
    return item;
  }

  // The core scoping rule: source restaurant's group must equal the canonical item's group.
  async function loadScopedCanonical(item: WithId<DiningMenuItem>, canonicalItemId: ObjectId): Promise<{ groupId: ObjectId; canonical: WithId<DiningCanonicalItem> }> {
    const groupId = await resolveRestaurantGroupId(item.restaurantId);
    const canonical = await collections.canonicalItems.findOne({ _id: canonicalItemId });
    if (!canonical) throw new DiningItemMappingError('CANONICAL_ITEM_NOT_FOUND', 'Canonical item not found');
    if (!canonical.restaurantGroupId.equals(groupId)) {
      throw new DiningItemMappingError('RESTAURANT_GROUP_MISMATCH', 'Source item and canonical item belong to different restaurant groups');
    }
    if (canonical.status !== 'active') throw new DiningItemMappingError('CANONICAL_ITEM_INACTIVE', 'Canonical item is inactive');
    return { groupId, canonical };
  }

  function baseDoc(item: WithId<DiningMenuItem>, groupId: ObjectId, now: Date) {
    return {
      restaurantGroupId: groupId,
      menuItemId: item._id,
      restaurantId: item.restaurantId,
      platform: item.platform,
      ...(item.platformItemId ? { platformItemId: item.platformItemId } : {}),
      isActive: true,
      decidedAt: now,
      createdAt: now,
      updatedAt: now,
    };
  }

  /*
   * Candidate generation — never the whole database:
   *   1. same restaurant group, active canonical items only
   *   2. exact normalized name (incl. variant-stripped) via signals.normalizedNames, plus
   *      shared core-name tokens via searchKeywords (bounded)
   *   3. drop previously REJECTED pairings, keep names ≥ nameCandidateMin
   *   4. rank by name score, then same category, then same variant; keep maxCandidates
   */
  async function findCandidates(item: WithId<DiningMenuItem>, groupId: ObjectId): Promise<ItemMatchCandidate[]> {
    const rawNames = [item.name?.en, item.name?.ar].filter((n): n is string => !!n);
    const names = [...new Set(rawNames.flatMap(n => [normalizeItemText(n), normalizeCoreName(n)]).filter((n): n is string => !!n))];
    const tokens = [...new Set(rawNames.flatMap(n => keywordTokens(normalizeCoreName(n))).filter(t => !/^\d/.test(t)))];
    const scope = { restaurantGroupId: groupId, status: 'active' as const };

    const [exact, byKeyword, rejected] = await Promise.all([
      names.length ? collections.canonicalItems.find({ ...scope, 'signals.normalizedNames': { $in: names } }).limit(CANDIDATE_QUERY_LIMIT).toArray() : [],
      tokens.length ? collections.canonicalItems.find({ ...scope, searchKeywords: { $in: tokens } }).limit(CANDIDATE_QUERY_LIMIT).toArray() : [],
      repository.rejectedCanonicalIds(item._id),
    ]);
    const unique = new Map<string, WithId<DiningCanonicalItem>>();
    for (const c of [...exact, ...byKeyword]) if (!rejected.has(c._id.toHexString())) unique.set(c._id.toHexString(), c);

    const srcCategory = normalizeItemText(item.categoryName?.en ?? item.categoryName?.ar);
    const srcVariant = JSON.stringify(extractVariant(item.name) ?? null);
    const shortlisted = [...unique.values()]
      .map(c => ({
        c,
        name: scoreName(item.name, c, config).score,
        category: srcCategory && srcCategory === normalizeItemText(c.category?.en ?? c.category?.ar) ? 1 : 0,
        variant: srcVariant === JSON.stringify(c.variant ?? null) ? 1 : 0,
      }))
      .filter(x => x.name >= config.thresholds.nameCandidateMin)
      .sort((a, b) => b.name - a.name || b.category - a.category || b.variant - a.variant || a.c._id.toHexString().localeCompare(b.c._id.toHexString()))
      .slice(0, config.maxCandidates)
      .map(x => x.c);

    const mapped = (await repository.findActiveMatchedByCanonical(shortlisted.map(c => c._id))).filter(m => !m.menuItemId.equals(item._id));
    const refItems = mapped.length
      ? await collections.menuItems.find({ _id: { $in: mapped.map(m => m.menuItemId) } }, { projection: { platform: 1, modifiers: 1, imageUrl: 1 } }).toArray()
      : [];
    const refById = new Map(refItems.map(r => [r._id.toHexString(), r]));

    return shortlisted.map(c => {
      const mine = mapped.filter(m => m.canonicalItemId!.equals(c._id));
      return {
        canonicalItemId: c._id,
        restaurantGroupId: c.restaurantGroupId,
        canonicalName: c.canonicalName,
        aliases: c.aliases,
        canonicalDescription: c.canonicalDescription,
        category: c.category,
        variant: c.variant,
        references: mine.flatMap(m => {
          const r = refById.get(m.menuItemId.toHexString());
          return r ? [{ platform: r.platform, modifiers: r.modifiers, imageUrl: r.imageUrl }] : [];
        }),
        matchedPlatforms: [...new Set(mine.map(m => m.platform))] as DiningPlatform[],
      };
    });
  }

  async function matchSourceItem(menuItemId: ObjectId, opts: { dryRun?: boolean; now?: Date } = {}): Promise<MatchSourceItemResult> {
    const now = opts.now ?? new Date();
    const dryRun = opts.dryRun ?? false;
    const item = await loadSource(menuItemId);
    const groupId = await resolveRestaurantGroupId(item.restaurantId);
    const active = await repository.findActiveByMenuItem(item._id);
    // Import and manual decisions are authoritative; the matcher only revisits its own.
    if (active && active.decidedBy !== 'matcher') return { outcome: 'kept_existing', dryRun, mapping: active };

    const decision = matchItem(toMatchSource(item), await findCandidates(item, groupId), { restaurantGroupId: groupId, config });
    const next: DiningItemMapping = {
      ...baseDoc(item, groupId, now),
      ...(decision.canonicalItemId ? { canonicalItemId: decision.canonicalItemId } : {}),
      matchStatus: decision.status,
      ...(decision.matchMethod && decision.status !== 'UNMATCHED' ? { matchMethod: decision.matchMethod } : {}),
      confidence: decision.confidence,
      evidence: decision.evidence,
      decidedBy: 'matcher',
    };

    if (
      active &&
      active.matchStatus === next.matchStatus &&
      String(active.canonicalItemId ?? '') === String(next.canonicalItemId ?? '') &&
      active.matchMethod === next.matchMethod &&
      active.confidence === next.confidence
    ) {
      return { outcome: 'unchanged', dryRun, decision, mapping: active };
    }
    if (dryRun) return { outcome: active ? 'updated' : 'created', dryRun, decision, mapping: next };
    const written = await repository.replaceDecision(active, next, now);
    return { outcome: active ? 'updated' : 'created', dryRun, decision, mapping: written };
  }

  async function writeManual(
    menuItemId: ObjectId,
    canonicalItemId: ObjectId,
    reason: 'MANUAL_APPROVAL' | 'MANUAL_REMAP',
    note: string | undefined,
    now: Date
  ): Promise<ManualResult> {
    const item = await loadSource(menuItemId);
    const { groupId } = await loadScopedCanonical(item, canonicalItemId);
    const active = await repository.findActiveByMenuItem(item._id);
    if (active?.matchStatus === 'MATCHED' && active.decidedBy === 'manual' && active.canonicalItemId?.equals(canonicalItemId)) {
      return { outcome: 'unchanged', mapping: active };
    }

    const evidence: ItemMatchEvidence = active?.canonicalItemId?.equals(canonicalItemId)
      ? { ...active.evidence, reasons: [...active.evidence.reasons, reason], conflicts: [...active.evidence.conflicts] }
      : { reasons: [reason], conflicts: [] };
    const next: DiningItemMapping = {
      ...baseDoc(item, groupId, now),
      canonicalItemId,
      matchStatus: 'MATCHED',
      matchMethod: 'MANUAL',
      confidence: 1,
      evidence,
      decidedBy: 'manual',
      ...(cleanNote(note) ? { note: cleanNote(note) } : {}),
    };

    // Moving away from a different canonical item records that pairing as REJECTED history,
    // so the matcher never proposes it again.
    const extra: DiningItemMapping[] = [];
    if (active?.canonicalItemId && !active.canonicalItemId.equals(canonicalItemId)) {
      extra.push({
        ...baseDoc(item, groupId, now),
        canonicalItemId: active.canonicalItemId,
        matchStatus: 'REJECTED',
        matchMethod: 'MANUAL',
        confidence: 0,
        evidence: { ...active.evidence, reasons: [...active.evidence.reasons, 'SUPERSEDED_BY_MANUAL_REMAP'], conflicts: [...active.evidence.conflicts] },
        isActive: false,
        decidedBy: 'manual',
      });
    }
    const mapping = await repository.replaceDecision(active, next, now, extra);
    return { outcome: 'created', mapping, previous: active ?? undefined };
  }

  async function approveMapping(menuItemId: ObjectId, opts: { canonicalItemId?: ObjectId; note?: string; now?: Date } = {}): Promise<ManualResult> {
    const active = await repository.findActiveByMenuItem(menuItemId);
    const target = opts.canonicalItemId ?? active?.canonicalItemId;
    if (!target) throw new DiningItemMappingError('NOTHING_TO_APPROVE', 'No canonical item to approve; pass canonicalItemId');
    return writeManual(menuItemId, target, 'MANUAL_APPROVAL', opts.note, opts.now ?? new Date());
  }

  async function remapSourceItem(menuItemId: ObjectId, canonicalItemId: ObjectId, opts: { note?: string; now?: Date } = {}): Promise<ManualResult> {
    return writeManual(menuItemId, canonicalItemId, 'MANUAL_REMAP', opts.note, opts.now ?? new Date());
  }

  async function rejectMapping(menuItemId: ObjectId, opts: { note?: string; now?: Date } = {}): Promise<ManualResult> {
    const now = opts.now ?? new Date();
    const active = await repository.findActiveByMenuItem(menuItemId);
    if (!active?.canonicalItemId) throw new DiningItemMappingError('MAPPING_NOT_FOUND', 'No active mapping to a canonical item to reject');
    const { _id, supersedesMappingId: _s, supersededAt: _a, ...rest } = active;
    const rejected: DiningItemMapping = {
      ...rest,
      matchStatus: 'REJECTED',
      matchMethod: 'MANUAL',
      confidence: 0,
      evidence: { ...active.evidence, reasons: [...active.evidence.reasons, 'MANUAL_REJECTION'], conflicts: [...active.evidence.conflicts] },
      isActive: false,
      decidedBy: 'manual',
      decidedAt: now,
      createdAt: now,
      updatedAt: now,
      ...(cleanNote(opts.note) ? { note: cleanNote(opts.note) } : {}),
    };
    const mapping = await repository.replaceDecision(active, rejected, now);
    return { outcome: 'created', mapping, previous: active };
  }

  return { repository, resolveRestaurantGroupId, findCandidates, matchSourceItem, approveMapping, rejectMapping, remapSourceItem };
}
