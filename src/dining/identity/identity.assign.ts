import { ObjectId, WithId } from 'mongodb';
import type { DiningRestaurant } from '../dining.types';
import { compareBranchLocation, HARD_CONFLICTS } from './identity.matcher';
import { assignRestaurantToGroup, AssignRestaurantResult, DiningIdentityNotFoundError, DiningIdentityRepositories } from './identity.service';
import { extractSourceSignals } from './identity.signals';
import type { DiningRestaurantMapping, MatchConflict, MatchSignal } from './identity.types';

/*
 * Manual same-branch assignment: put one source restaurant into the group of an anchor restaurant.
 *
 * The group is never given directly: it is read from the anchor's active MATCHED mapping. The decision
 * is refused when the two listings conflict as branches (city, area, coordinates > 500 m), when there
 * is no strong branch evidence (exact address or coordinates ≤ 75 m), or when the group already has
 * another listing on the same platform. Names, brands and prices are not evidence here.
 */

export const MAX_NOTE_LENGTH = 500;
const STRONG_BRANCH_SIGNALS: readonly MatchSignal[] = ['ADDRESS_EXACT', 'LOCATION_NEAR'];

export type ManualAssignmentRefusal =
  | 'SAME_RESTAURANT'
  | 'ANCHOR_NOT_MAPPED'
  | 'GROUP_MISMATCH'
  | 'BRANCH_CONFLICT'
  | 'WEAK_BRANCH_EVIDENCE'
  | 'SAME_PLATFORM_IN_GROUP'
  | 'NOTE_REQUIRED'
  | 'NOTE_TOO_LONG';

export class DiningManualAssignmentError extends Error {
  readonly code: ManualAssignmentRefusal;

  constructor(code: ManualAssignmentRefusal, message: string) {
    super(message);
    this.name = 'DiningManualAssignmentError';
    this.code = code;
  }
}

export interface ManualAssignmentInput {
  restaurantId: ObjectId;
  anchorRestaurantId: ObjectId;
  // Reviewer's evidence (e.g. phone, signage). Computed location evidence is appended.
  note: string;
  // Required for a write: the group ID the reviewer saw in the dry run.
  expectedGroupId?: ObjectId;
  replaceExisting?: boolean;
  dryRun?: boolean;
  now?: Date;
}

export interface ListingRef {
  restaurantId: string;
  platform: string;
  platformRestaurantId?: string;
  name?: string;
}

export interface ManualAssignmentReport {
  dryRun: boolean;
  restaurant: ListingRef;
  anchor: ListingRef;
  groupId: string;
  evidence: { signals: MatchSignal[]; conflicts: MatchConflict[]; distanceMeters?: number };
  note: string;
  membersBefore: ListingRef[];
  result: AssignRestaurantResult;
}

function restaurantRef(r: WithId<DiningRestaurant>): ListingRef {
  return { restaurantId: r._id.toHexString(), platform: r.platform, platformRestaurantId: r.platformRestaurantId, name: r.name?.en ?? r.name?.ar };
}

function mappingRef(m: DiningRestaurantMapping): ListingRef {
  return { restaurantId: m.restaurantId.toHexString(), platform: m.platform, platformRestaurantId: m.platformRestaurantId };
}

const listing = (r: Pick<DiningRestaurant, 'platform' | 'platformRestaurantId'>) => `${r.platform}:${r.platformRestaurantId ?? '?'}`;

export function composeManualNote(
  reviewerNote: string,
  restaurant: Pick<DiningRestaurant, 'platform' | 'platformRestaurantId'>,
  anchor: Pick<DiningRestaurant, 'platform' | 'platformRestaurantId'>,
  evidence: ManualAssignmentReport['evidence']
): string {
  const distance = evidence.distanceMeters !== undefined ? `${evidence.distanceMeters} m apart` : 'no coordinates';
  return `${reviewerNote.trim()} | computed: ${listing(restaurant)} vs ${listing(anchor)}: ${distance}; ${evidence.signals.join(', ') || 'no signals'}`;
}

export async function assignToAnchorGroup(repos: DiningIdentityRepositories, input: ManualAssignmentInput): Promise<ManualAssignmentReport> {
  const dryRun = input.dryRun !== false;
  if (!dryRun && !input.expectedGroupId) {
    throw new DiningManualAssignmentError('GROUP_MISMATCH', 'A write requires the expected group ID from a reviewed dry run');
  }
  if (input.restaurantId.equals(input.anchorRestaurantId)) {
    throw new DiningManualAssignmentError('SAME_RESTAURANT', 'The restaurant and the anchor are the same record');
  }
  if (!input.note?.trim()) throw new DiningManualAssignmentError('NOTE_REQUIRED', 'A reviewer note with the branch evidence is required');

  const [restaurant, anchor] = await Promise.all([
    repos.restaurants.findOne({ _id: input.restaurantId }),
    repos.restaurants.findOne({ _id: input.anchorRestaurantId }),
  ]);
  if (!restaurant) throw new DiningIdentityNotFoundError('RESTAURANT_NOT_FOUND', 'Source restaurant not found');
  if (!anchor) throw new DiningIdentityNotFoundError('RESTAURANT_NOT_FOUND', 'Anchor restaurant not found');

  const anchorMapping = await repos.mappings.findActiveByRestaurant(anchor._id);
  if (!anchorMapping || anchorMapping.matchStatus !== 'MATCHED' || !anchorMapping.canonicalRestaurantGroupId) {
    throw new DiningManualAssignmentError('ANCHOR_NOT_MAPPED', `Anchor ${listing(anchor)} has no active MATCHED group mapping`);
  }
  const groupId = anchorMapping.canonicalRestaurantGroupId;
  if (input.expectedGroupId && !input.expectedGroupId.equals(groupId)) {
    throw new DiningManualAssignmentError('GROUP_MISMATCH', `Anchor group is ${groupId.toHexString()}, not the expected ${input.expectedGroupId.toHexString()}`);
  }

  const branch = compareBranchLocation(extractSourceSignals(restaurant), extractSourceSignals(anchor));
  const hard = branch.conflicts.filter(c => HARD_CONFLICTS.includes(c));
  if (hard.length) {
    throw new DiningManualAssignmentError('BRANCH_CONFLICT', `${listing(restaurant)} and ${listing(anchor)} are different branches (${hard.join(', ')})`);
  }
  if (!branch.signals.some(s => STRONG_BRANCH_SIGNALS.includes(s))) {
    throw new DiningManualAssignmentError('WEAK_BRANCH_EVIDENCE', 'Needs an exact address or coordinates within 75 m');
  }

  const members = await repos.mappings.findActiveByGroup(groupId);
  const samePlatform = members.filter(m => m.platform === restaurant.platform && m.matchStatus === 'MATCHED' && !m.restaurantId.equals(restaurant._id));
  if (samePlatform.length) {
    throw new DiningManualAssignmentError('SAME_PLATFORM_IN_GROUP', `Group already has ${restaurant.platform} listing ${samePlatform.map(m => m.platformRestaurantId).join(', ')}`);
  }

  const evidence = { signals: branch.signals, conflicts: branch.conflicts, distanceMeters: branch.distanceMeters };
  const note = composeManualNote(input.note, restaurant, anchor, evidence);
  if (note.length > MAX_NOTE_LENGTH) {
    throw new DiningManualAssignmentError('NOTE_TOO_LONG', `Note is ${note.length} characters including computed evidence (max ${MAX_NOTE_LENGTH})`);
  }

  const result = await assignRestaurantToGroup(
    repos,
    { restaurantId: restaurant._id, groupId, note, evidence, replaceExisting: input.replaceExisting, dryRun },
    input.now ?? new Date()
  );

  return {
    dryRun,
    restaurant: restaurantRef(restaurant),
    anchor: restaurantRef(anchor),
    groupId: groupId.toHexString(),
    evidence,
    note,
    membersBefore: members.map(mappingRef),
    result,
  };
}
