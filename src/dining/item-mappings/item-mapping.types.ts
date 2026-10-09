import type { ObjectId } from 'mongodb';
import type { DiningPlatform } from '../dining.types';

/*
 * Links ONE platform source item (dining_menu_items) to ONE canonical item. Source documents are
 * never merged; a canonical item collects one mapping per platform listing.
 *
 * Every decision is its own document. Changing a decision supersedes the previous document
 * (isActive=false, supersededAt) and inserts a new one, so history is never lost. At most one
 * document per source item is active at any time (unique index).
 */

export const ITEM_MATCH_STATUSES = ['MATCHED', 'REVIEW', 'UNMATCHED', 'REJECTED'] as const;
export type ItemMatchStatus = (typeof ITEM_MATCH_STATUSES)[number];

// SEMANTIC is reserved; nothing produces it yet.
export const ITEM_MATCH_METHODS = [
  'IMPORT',
  'EXACT_NORMALIZED',
  'NAME_CATEGORY',
  'NAME_DESCRIPTION',
  'VARIANT',
  'MODIFIER',
  'SEMANTIC',
  'MANUAL',
] as const;
export type ItemMatchMethod = (typeof ITEM_MATCH_METHODS)[number];

export const ITEM_MAPPING_DECIDERS = ['import', 'matcher', 'manual'] as const;
export type ItemMappingDecider = (typeof ITEM_MAPPING_DECIDERS)[number];

export interface ItemMatchEvidence {
  nameScore?: number;
  descriptionScore?: number;
  categoryScore?: number;
  variantScore?: number;
  modifierScore?: number;
  imageScore?: number;
  reasons: string[];
  conflicts: string[];
  // Other plausible canonical items (REVIEW / ambiguity).
  candidateCanonicalItemIds?: ObjectId[];
}

export interface DiningItemMapping {
  _id?: ObjectId;
  // Absent only while UNMATCHED.
  canonicalItemId?: ObjectId;
  restaurantGroupId: ObjectId;
  menuItemId: ObjectId;
  // Source restaurant of menuItemId; must belong to restaurantGroupId.
  restaurantId: ObjectId;
  platform: DiningPlatform;
  // Informational; only meaningful together with platform + restaurant.
  platformItemId?: string;
  matchStatus: ItemMatchStatus;
  // Absent only while UNMATCHED.
  matchMethod?: ItemMatchMethod;
  confidence: number;
  evidence: ItemMatchEvidence;
  // The current decision for this source item. REJECTED and superseded decisions are inactive history.
  isActive: boolean;
  supersededAt?: Date;
  supersedesMappingId?: ObjectId;
  decidedBy: ItemMappingDecider;
  decidedAt: Date;
  note?: string;
  createdAt: Date;
  updatedAt: Date;
}
