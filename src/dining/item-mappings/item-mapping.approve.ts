import { ObjectId, WithId } from 'mongodb';
import { extractVariant, normalizeItemText } from '../canonical-items/canonical-item.text';
import type { DiningCanonicalItem } from '../canonical-items/canonical-item.types';
import type { DiningMenuItem, LocalizedText } from '../dining.types';
import { ItemMatchBatchCollections, planFingerprint } from './item-mapping.batch';
import { DiningItemMappingError } from './item-mapping.repository';
import { createItemMappingService, ItemMappingService } from './item-mapping.service';
import type { DiningItemMapping } from './item-mapping.types';

/*
 * Strict approval of matcher REVIEW decisions for ONE source restaurant of ONE verified group.
 *
 * Some menus (e.g. McDonald's on both Deliveroo and Talabat) publish no descriptions and no
 * comparable modifiers, so the matcher can never corroborate an exact name beyond REVIEW. This
 * approves — through ItemMappingService.approveMapping (decidedBy manual, MANUAL_APPROVAL) — only
 * REVIEW decisions that leave no reasonable doubt:
 *   - active matcher decision with a canonical item of the same group (active)
 *   - no matcher conflicts at all (AMBIGUOUS_CANDIDATES, CATEGORY_DIFFERENT, variant conflicts, …)
 *   - identical normalized EN name AND identical normalized AR name (both present)
 *   - identical normalized EN and AR category (both present)
 *   - identical variant (size / quantity / unit)
 *   - the canonical item has no active MATCHED listing on the source platform, and no other
 *     source item of this restaurant qualifies for the same canonical item
 * Price and image are never inputs. Dry run by default; a write requires the plan fingerprint of
 * the reviewed dry run, and re-checks that each REVIEW decision is still the active one.
 *
 * Opt-in (allowUniqueTwin): the matcher flags AMBIGUOUS_CANDIDATES whenever sibling variants score
 * close (e.g. "6 pcs McNuggets Large Meal" vs "… Medium Meal"). That single conflict is waived only
 * when every other strict check passes AND the proposed canonical item is the only active canonical
 * item of the group sharing the source's EN or AR name. Any other conflict still blocks.
 */

export type StrictApprovalSkip =
  | 'NOT_MATCHER_DECISION'
  | 'NO_CANONICAL_ITEM'
  | 'CANONICAL_OUT_OF_SCOPE'
  | 'HAS_CONFLICTS'
  | 'NAME_EN_DIFFERS'
  | 'NAME_AR_DIFFERS'
  | 'CATEGORY_EN_DIFFERS'
  | 'CATEGORY_AR_DIFFERS'
  | 'VARIANT_DIFFERS'
  | 'PLATFORM_ALREADY_MAPPED'
  | 'DUPLICATE_TARGET';

export type ItemApprovalRefusal = 'RESTAURANT_NOT_FOUND' | 'RESTAURANT_NOT_IN_GROUP' | 'PLAN_REQUIRED' | 'PLAN_CHANGED';

export class DiningItemApprovalError extends Error {
  readonly code: ItemApprovalRefusal;

  constructor(code: ItemApprovalRefusal, message: string) {
    super(message);
    this.name = 'DiningItemApprovalError';
    this.code = code;
  }
}

export const STRICT_APPROVAL_NOTE = 'STRICT_APPROVAL: identical EN+AR name, EN+AR category and variant; no matcher conflicts';
export const UNIQUE_TWIN_APPROVAL_NOTE =
  'STRICT_APPROVAL_UNIQUE_TWIN: identical EN+AR name, EN+AR category and variant; AMBIGUOUS_CANDIDATES waived, no other canonical item of the group shares the EN or AR name';

const sameText = (a: LocalizedText | undefined, b: LocalizedText | undefined, locale: 'en' | 'ar'): boolean => {
  const x = normalizeItemText(a?.[locale]);
  return !!x && x === normalizeItemText(b?.[locale]);
};

// Reasons a REVIEW decision may NOT be approved; empty means it satisfies the strict rule.
export function checkStrictApproval(
  mapping: Pick<DiningItemMapping, 'decidedBy' | 'canonicalItemId' | 'restaurantGroupId' | 'evidence'>,
  item: Pick<DiningMenuItem, 'name' | 'categoryName'>,
  canonical: Pick<DiningCanonicalItem, 'restaurantGroupId' | 'status' | 'canonicalName' | 'category' | 'variant'> | null | undefined
): StrictApprovalSkip[] {
  const skips: StrictApprovalSkip[] = [];
  if (mapping.decidedBy !== 'matcher') skips.push('NOT_MATCHER_DECISION');
  if (!mapping.canonicalItemId || !canonical) return [...skips, 'NO_CANONICAL_ITEM'];
  if (!canonical.restaurantGroupId.equals(mapping.restaurantGroupId) || canonical.status !== 'active') skips.push('CANONICAL_OUT_OF_SCOPE');
  if (mapping.evidence.conflicts.length > 0) skips.push('HAS_CONFLICTS');
  if (!sameText(item.name, canonical.canonicalName, 'en')) skips.push('NAME_EN_DIFFERS');
  if (!sameText(item.name, canonical.canonicalName, 'ar')) skips.push('NAME_AR_DIFFERS');
  if (!sameText(item.categoryName, canonical.category, 'en')) skips.push('CATEGORY_EN_DIFFERS');
  if (!sameText(item.categoryName, canonical.category, 'ar')) skips.push('CATEGORY_AR_DIFFERS');
  const variant = (v: unknown) => JSON.stringify(v ?? null);
  if (variant(extractVariant(item.name)) !== variant(canonical.variant ?? extractVariant(canonical.canonicalName))) skips.push('VARIANT_DIFFERS');
  return skips;
}

// True when AMBIGUOUS_CANDIDATES is the only matcher conflict and the proposed canonical item is the only
// active canonical item of the group (groupCanonicals) whose EN or AR name equals the source item's.
// Name equality with the target itself is checked by checkStrictApproval, not here.
export function isUniqueBilingualTwin(
  mapping: Pick<DiningItemMapping, 'canonicalItemId' | 'evidence'>,
  item: Pick<DiningMenuItem, 'name'>,
  groupCanonicals: Array<Pick<WithId<DiningCanonicalItem>, '_id' | 'canonicalName'>>
): boolean {
  const conflicts = mapping.evidence.conflicts;
  if (!mapping.canonicalItemId || conflicts.length === 0 || conflicts.some(c => c !== 'AMBIGUOUS_CANDIDATES')) return false;
  const sharing = groupCanonicals.filter(ci => sameText(item.name, ci.canonicalName, 'en') || sameText(item.name, ci.canonicalName, 'ar'));
  return sharing.length === 1 && sharing[0]._id.equals(mapping.canonicalItemId);
}

export interface ItemApprovalInput {
  restaurantGroupId: ObjectId;
  restaurantId: ObjectId;
  dryRun?: boolean;
  expectedPlan?: string;
  note?: string;
  allowUniqueTwin?: boolean;
  now?: Date;
}

export interface ApprovalLine {
  menuItemId: string;
  name: string | null;
  canonicalItemId: string | null;
  canonicalName: string | null;
  skips: StrictApprovalSkip[];
  waived?: 'AMBIGUOUS_CANDIDATES';
}

export interface ItemApprovalReport {
  dryRun: boolean;
  allowUniqueTwin: boolean;
  plan: string;
  restaurant: { restaurantId: string; platform: string; platformRestaurantId: string | null; name: string | null };
  reviewInspected: number;
  approvable: ApprovalLine[];
  skipped: ApprovalLine[];
  // Primary (first) skip reason per item.
  skippedByReason: Partial<Record<StrictApprovalSkip, number>>;
  writes: { planned: number; written?: number; failures?: number };
  errors: Array<{ menuItemId: string; code: string; message: string }>;
}

const hex = (id: ObjectId) => id.toHexString();

export async function runStrictItemApproval(
  collections: ItemMatchBatchCollections,
  input: ItemApprovalInput,
  service: ItemMappingService = createItemMappingService(collections)
): Promise<ItemApprovalReport> {
  const dryRun = input.dryRun !== false;
  const now = input.now ?? new Date();
  const groupId = input.restaurantGroupId;

  const restaurant = await collections.restaurants.findOne({ _id: input.restaurantId }, { projection: { platform: 1, platformRestaurantId: 1, name: 1 } });
  if (!restaurant) throw new DiningItemApprovalError('RESTAURANT_NOT_FOUND', 'Source restaurant not found');
  const member = await collections.restaurantMappings.findOne({ restaurantId: restaurant._id, canonicalRestaurantGroupId: groupId, isActive: true, matchStatus: 'MATCHED' });
  if (!member) {
    throw new DiningItemApprovalError('RESTAURANT_NOT_IN_GROUP', `${restaurant.platform}:${restaurant.platformRestaurantId ?? '?'} has no active MATCHED mapping to group ${hex(groupId)}`);
  }

  const reviews = await collections.itemMappings
    .find({ restaurantId: restaurant._id, restaurantGroupId: groupId, isActive: true, matchStatus: 'REVIEW' })
    .sort({ menuItemId: 1 })
    .toArray();
  const items = await collections.menuItems.find({ _id: { $in: reviews.map(m => m.menuItemId) } }).toArray();
  const itemById = new Map(items.map(i => [hex(i._id), i]));
  const canonicalIds = reviews.map(m => m.canonicalItemId).filter((id): id is ObjectId => !!id);
  const canonicals = await collections.canonicalItems.find({ _id: { $in: canonicalIds } }).toArray();
  const canonicalById = new Map(canonicals.map(c => [hex(c._id), c]));
  const taken = new Set(
    (await collections.itemMappings
      .find({ canonicalItemId: { $in: canonicalIds }, platform: restaurant.platform, isActive: true, matchStatus: 'MATCHED' }, { projection: { canonicalItemId: 1 } })
      .toArray()).map(m => hex(m.canonicalItemId!))
  );

  const allowUniqueTwin = input.allowUniqueTwin === true;
  const groupCanonicals = allowUniqueTwin
    ? await collections.canonicalItems.find({ restaurantGroupId: groupId, status: 'active' }, { projection: { canonicalName: 1 } }).toArray()
    : [];

  type Planned = {
    mapping: WithId<DiningItemMapping>;
    item?: WithId<DiningMenuItem>;
    canonical?: WithId<DiningCanonicalItem>;
    skips: StrictApprovalSkip[];
    waived?: 'AMBIGUOUS_CANDIDATES';
  };
  const planned: Planned[] = reviews.map(mapping => {
    const item = itemById.get(hex(mapping.menuItemId));
    const canonical = mapping.canonicalItemId ? canonicalById.get(hex(mapping.canonicalItemId)) : undefined;
    let skips: StrictApprovalSkip[] = item ? checkStrictApproval(mapping, item, canonical) : ['NO_CANONICAL_ITEM'];
    let waived: Planned['waived'];
    if (allowUniqueTwin && item && skips.length === 1 && skips[0] === 'HAS_CONFLICTS' && isUniqueBilingualTwin(mapping, item, groupCanonicals)) {
      skips = [];
      waived = 'AMBIGUOUS_CANDIDATES';
    }
    if (skips.length === 0 && taken.has(hex(mapping.canonicalItemId!))) skips.push('PLATFORM_ALREADY_MAPPED');
    return { mapping, item, canonical, skips, waived };
  });
  const byTarget = new Map<string, Planned[]>();
  for (const p of planned) if (p.skips.length === 0) byTarget.set(hex(p.mapping.canonicalItemId!), [...(byTarget.get(hex(p.mapping.canonicalItemId!)) ?? []), p]);
  for (const group of byTarget.values()) if (group.length > 1) for (const p of group) p.skips.push('DUPLICATE_TARGET');

  const approvable = planned.filter(p => p.skips.length === 0);
  const plan = planFingerprint(
    approvable.map(p => ({
      menuItemId: hex(p.mapping.menuItemId),
      outcome: `${p.waived ? 'approve-unique-twin' : 'approve'}:${hex(p.mapping._id)}`,
      status: 'MATCHED',
      canonicalItemId: hex(p.mapping.canonicalItemId!),
      method: 'MANUAL',
    }))
  );

  const errors: ItemApprovalReport['errors'] = [];
  let written = 0;
  if (!dryRun) {
    if (!input.expectedPlan) throw new DiningItemApprovalError('PLAN_REQUIRED', 'A write requires --expect-plan from a reviewed dry run');
    if (input.expectedPlan !== plan) throw new DiningItemApprovalError('PLAN_CHANGED', `Plan is ${plan}, not the reviewed ${input.expectedPlan}; re-run the dry run and review again`);
    for (const p of approvable) {
      const note = [p.waived ? UNIQUE_TWIN_APPROVAL_NOTE : STRICT_APPROVAL_NOTE, input.note?.trim()].filter(Boolean).join(' | ');
      const fail = (code: string, message: string) => errors.push({ menuItemId: hex(p.mapping.menuItemId), code, message });
      try {
        const active = await service.repository.findActiveByMenuItem(p.mapping.menuItemId);
        if (!active?._id.equals(p.mapping._id)) {
          fail('DECISION_CHANGED', 'The reviewed REVIEW decision is no longer the active one');
          continue;
        }
        await service.approveMapping(p.mapping.menuItemId, { canonicalItemId: p.mapping.canonicalItemId!, note, now });
        written++;
      } catch (err) {
        if (err instanceof DiningItemMappingError) fail(err.code, err.message);
        else fail('UNEXPECTED', 'Write failed');
      }
    }
  }

  const line = (p: Planned): ApprovalLine => ({
    menuItemId: hex(p.mapping.menuItemId),
    name: p.item?.name?.en ?? p.item?.name?.ar ?? null,
    canonicalItemId: p.mapping.canonicalItemId ? hex(p.mapping.canonicalItemId) : null,
    canonicalName: p.canonical?.canonicalName?.en ?? p.canonical?.canonicalName?.ar ?? null,
    skips: [...p.skips],
    ...(p.waived ? { waived: p.waived } : {}),
  });
  const skipped = planned.filter(p => p.skips.length > 0);
  const skippedByReason: ItemApprovalReport['skippedByReason'] = {};
  for (const p of skipped) skippedByReason[p.skips[0]] = (skippedByReason[p.skips[0]] ?? 0) + 1;

  return {
    dryRun,
    allowUniqueTwin,
    plan,
    restaurant: { restaurantId: hex(restaurant._id), platform: restaurant.platform, platformRestaurantId: restaurant.platformRestaurantId ?? null, name: restaurant.name?.en ?? restaurant.name?.ar ?? null },
    reviewInspected: reviews.length,
    approvable: approvable.map(line),
    skipped: skipped.map(line),
    skippedByReason,
    writes: { planned: approvable.length, ...(dryRun ? {} : { written, failures: errors.length }) },
    errors,
  };
}
