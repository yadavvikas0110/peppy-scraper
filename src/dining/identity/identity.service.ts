import { Collection, ObjectId, WithId } from 'mongodb';
import { stripUndefined } from '../dining.object';
import type { DiningRestaurant, LocalizedText } from '../dining.types';
import type { DiningIdentityCollections } from './identity.collections';
import { SourceRestaurantSignals, toGroupSignals, extractSourceSignals } from './identity.signals';
import { assertValid } from '../dining.validator';
import type { DiningRestaurantMapping, DiningRestaurantMatchEvidence } from './identity.types';
import { validateRestaurantMapping } from './identity.validator';
import { createRestaurantGroupRepository, RestaurantGroupRepository, SeededGroup } from './restaurant-group.repository';
import { createRestaurantMappingRepository, DiningIdentityConflictError, RestaurantMappingRepository } from './restaurant-mapping.repository';

export interface DiningIdentityRepositories {
  restaurants: Collection<DiningRestaurant>;
  groups: RestaurantGroupRepository;
  mappings: RestaurantMappingRepository;
}

export function createDiningIdentityRepositories(collections: DiningIdentityCollections): DiningIdentityRepositories {
  return {
    restaurants: collections.restaurants,
    groups: createRestaurantGroupRepository(collections.restaurantGroups),
    mappings: createRestaurantMappingRepository(collections.restaurantMappings),
  };
}

export class DiningIdentityNotFoundError extends Error {
  readonly code: 'RESTAURANT_NOT_FOUND' | 'GROUP_NOT_FOUND' | 'MAPPING_NOT_FOUND';

  constructor(code: DiningIdentityNotFoundError['code'], message: string) {
    super(message);
    this.name = 'DiningIdentityNotFoundError';
    this.code = code;
  }
}

const clean = (v: string | undefined) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

function cleanLocalized(text: LocalizedText | undefined): LocalizedText | undefined {
  const out: LocalizedText = { en: clean(text?.en), ar: clean(text?.ar) };
  return out.en || out.ar ? stripUndefined(out) : undefined;
}

// Canonical branch fields only — prices, fees, URLs, ratings and availability stay on the source restaurant.
export function buildGroupFromRestaurant(
  restaurant: WithId<DiningRestaurant>,
  signals: SourceRestaurantSignals,
  now: Date
): SeededGroup {
  const loc = restaurant.location ?? {};
  const hasCoords = signals.lat !== undefined && signals.lng !== undefined;
  return stripUndefined({
    canonicalName: cleanLocalized(restaurant.name) ?? {},
    brandName: cleanLocalized(restaurant.brandName),
    city: clean(loc.city),
    area: clean(loc.area),
    address: clean(loc.address),
    location: hasCoords ? { lat: signals.lat, lng: signals.lng } : undefined,
    status: restaurant.isActive === false ? 'inactive' : 'active',
    identityStatus: 'auto',
    seedRestaurantId: restaurant._id,
    signals: toGroupSignals(signals),
    createdAt: now,
    updatedAt: now,
  }) as SeededGroup;
}

export interface AssignRestaurantInput {
  restaurantId: ObjectId;
  groupId: ObjectId;
  note?: string;
  // Move a restaurant that is MATCHED/REVIEW to another group. The old mapping becomes REJECTED.
  replaceExisting?: boolean;
  // Branch evidence computed by the caller (recorded alongside the reviewer's note).
  evidence?: Pick<DiningRestaurantMatchEvidence, 'signals' | 'conflicts' | 'distanceMeters'>;
  // Decide and validate exactly as for a write, but write nothing.
  dryRun?: boolean;
}

export interface AssignRestaurantResult {
  status: 'created' | 'updated' | 'unchanged';
  // Without `_id` only in a dry run that would insert a new mapping.
  mapping: DiningRestaurantMapping;
  previousGroupId?: ObjectId;
  dryRun: boolean;
}

// Manual decision: confirms (or moves) a source restaurant into a canonical group.
export async function assignRestaurantToGroup(
  repos: DiningIdentityRepositories,
  input: AssignRestaurantInput,
  now = new Date()
): Promise<AssignRestaurantResult> {
  const dryRun = input.dryRun === true;
  const restaurant = await repos.restaurants.findOne({ _id: input.restaurantId });
  if (!restaurant) throw new DiningIdentityNotFoundError('RESTAURANT_NOT_FOUND', 'Source restaurant not found');
  const group = await repos.groups.findById(input.groupId);
  if (!group) throw new DiningIdentityNotFoundError('GROUP_NOT_FOUND', 'Restaurant group not found');

  const next: DiningRestaurantMapping = stripUndefined({
    canonicalRestaurantGroupId: group._id,
    restaurantId: restaurant._id,
    platform: restaurant.platform,
    platformRestaurantId: restaurant.platformRestaurantId,
    restaurantSourceKey: restaurant.sourceKey,
    matchStatus: 'MATCHED',
    matchMethod: 'MANUAL',
    confidence: 1,
    evidence: {
      signals: [...(input.evidence?.signals ?? [])],
      conflicts: [...(input.evidence?.conflicts ?? [])],
      distanceMeters: input.evidence?.distanceMeters,
      reason: 'MANUAL_ASSIGNMENT',
      note: clean(input.note),
    },
    isActive: true,
    decidedBy: 'manual',
    createdAt: now,
    updatedAt: now,
  }) as DiningRestaurantMapping;

  const active = await repos.mappings.findActiveByRestaurant(restaurant._id);
  const insert = (m: DiningRestaurantMapping) => (dryRun ? planned(m) : repos.mappings.insert(m));
  const replace = (prev: WithId<DiningRestaurantMapping>, m: DiningRestaurantMapping) =>
    dryRun ? planned({ ...m, _id: prev._id, restaurantId: prev.restaurantId, createdAt: prev.createdAt }) : repos.mappings.replace(prev, m);
  let result: AssignRestaurantResult;

  if (!active) {
    result = { status: 'created', mapping: await insert(next), dryRun };
  } else if (active.canonicalRestaurantGroupId?.equals(group._id)) {
    if (active.matchStatus === 'MATCHED' && active.decidedBy === 'manual') return { status: 'unchanged', mapping: active, dryRun };
    result = { status: 'updated', mapping: await replace(active, next), dryRun };
  } else if (active.matchStatus === 'UNMATCHED') {
    result = { status: 'updated', mapping: await replace(active, next), dryRun };
  } else {
    if (!input.replaceExisting) {
      throw new DiningIdentityConflictError(
        'RESTAURANT_ALREADY_MAPPED',
        restaurant._id,
        'Source restaurant is already mapped to another group',
        active.canonicalRestaurantGroupId
      );
    }
    await replace(active, rejected(active, 'REASSIGNED', input.note, now));
    result = { status: 'created', mapping: await insert(next), previousGroupId: active.canonicalRestaurantGroupId, dryRun };
  }

  if (dryRun) return result;
  await repos.groups.addMatchedSignals(group._id, toGroupSignals(extractSourceSignals(restaurant)), now);
  await repos.groups.markVerified(group._id, now);
  return result;
}

async function planned(mapping: DiningRestaurantMapping): Promise<DiningRestaurantMapping> {
  assertValid(validateRestaurantMapping(mapping), 'restaurant mapping');
  return mapping;
}

function rejected(mapping: WithId<DiningRestaurantMapping>, reason: string, note: string | undefined, now: Date): DiningRestaurantMapping {
  return stripUndefined({
    ...mapping,
    _id: undefined,
    matchStatus: 'REJECTED',
    isActive: false,
    decidedBy: 'manual',
    evidence: { ...mapping.evidence, reason, note: clean(note) ?? mapping.evidence.note },
    updatedAt: now,
  }) as DiningRestaurantMapping;
}

// Manual decision: the restaurant is NOT this group. Kept as history so the backfill never
// proposes the same pairing again.
export async function rejectRestaurantMapping(
  repos: DiningIdentityRepositories,
  input: { restaurantId: ObjectId; note?: string },
  now = new Date()
): Promise<WithId<DiningRestaurantMapping>> {
  const active = await repos.mappings.findActiveByRestaurant(input.restaurantId);
  if (!active || !active.canonicalRestaurantGroupId) {
    throw new DiningIdentityNotFoundError('MAPPING_NOT_FOUND', 'No active group mapping to reject');
  }
  return repos.mappings.replace(active, rejected(active, 'REJECTED_BY_REVIEWER', input.note, now));
}
