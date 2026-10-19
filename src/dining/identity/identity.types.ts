import type { ObjectId } from 'mongodb';
import type { DiningPlatform, LocalizedText } from '../dining.types';

/*
 * Cross-platform restaurant identity.
 *
 * dining_restaurants stays platform-specific (one document per platform listing). A
 * DiningRestaurantGroup is the canonical real-world *branch* above it, and a
 * DiningRestaurantMapping links one source restaurant to at most one group.
 * Prices, fees, URLs, ratings and availability are platform data and never live on a group.
 */

export const RESTAURANT_GROUP_STATUSES = ['active', 'inactive'] as const;
export type RestaurantGroupStatus = (typeof RESTAURANT_GROUP_STATUSES)[number];

//   verified → confirmed by a person
//   auto     → created/extended by deterministic matching
//   review   → has a pending REVIEW mapping that needs a decision
export const RESTAURANT_IDENTITY_STATUSES = ['verified', 'auto', 'review'] as const;
export type RestaurantIdentityStatus = (typeof RESTAURANT_IDENTITY_STATUSES)[number];

export const MATCH_STATUSES = ['MATCHED', 'REVIEW', 'UNMATCHED', 'REJECTED'] as const;
export type MatchStatus = (typeof MATCH_STATUSES)[number];

//   SEED → the group was created from this source restaurant
// SEMANTIC and IMPORT are reserved; nothing produces them yet.
export const MATCH_METHODS = [
  'SEED',
  'MANUAL',
  'EXACT_NAME',
  'NAME_ADDRESS',
  'NAME_LOCATION',
  'BRAND_NAME_ADDRESS',
  'SEMANTIC',
  'IMPORT',
] as const;
export type MatchMethod = (typeof MATCH_METHODS)[number];

export const MATCH_SIGNALS = [
  'NAME_EXACT',
  'BRAND_EXACT',
  'CITY_EQUAL',
  'AREA_COMPATIBLE',
  'ADDRESS_EXACT',
  'LOCATION_NEAR',
] as const;
export type MatchSignal = (typeof MATCH_SIGNALS)[number];

export const MATCH_CONFLICTS = [
  'CITY_MISMATCH',
  'AREA_MISMATCH',
  'ADDRESS_MISMATCH',
  'LOCATION_FAR',
  'SAME_PLATFORM_ALREADY_MAPPED',
  'MULTIPLE_CANDIDATES',
] as const;
export type MatchConflict = (typeof MATCH_CONFLICTS)[number];

export const MAPPING_DECIDERS = ['backfill', 'manual'] as const;
export type MappingDecider = (typeof MAPPING_DECIDERS)[number];

// Normalized matching keys derived from source data (see identity.signals.ts). Stored on the
// group so candidates can be found by index; never used as a unique key.
export interface RestaurantMatchSignals {
  names: string[];
  brands: string[];
  city?: string;
  area?: string;
  address?: string;
  lat?: number;
  lng?: number;
}

export interface DiningRestaurantGroup {
  _id?: ObjectId;
  canonicalName: LocalizedText;
  brandName?: LocalizedText;
  city?: string;
  area?: string;
  address?: string;
  location?: {
    lat?: number;
    lng?: number;
  };
  status: RestaurantGroupStatus;
  identityStatus: RestaurantIdentityStatus;
  // Source restaurant the group was created from. Unique, so re-running creation never duplicates a group.
  seedRestaurantId?: ObjectId;
  signals: RestaurantMatchSignals;
  createdAt: Date;
  updatedAt: Date;
}

export interface DiningRestaurantMatchEvidence {
  signals: MatchSignal[];
  conflicts: MatchConflict[];
  distanceMeters?: number;
  candidateGroupIds?: ObjectId[];
  // Short machine-readable reason, e.g. NEW_GROUP, BRANCH_IDENTITY_UNKNOWN.
  reason?: string;
  note?: string;
}

export interface DiningRestaurantMapping {
  _id?: ObjectId;
  // Absent only while UNMATCHED.
  canonicalRestaurantGroupId?: ObjectId;
  restaurantId: ObjectId;
  platform: DiningPlatform;
  // Informational; only meaningful together with `platform`.
  platformRestaurantId?: string;
  restaurantSourceKey: string;
  matchStatus: MatchStatus;
  // Absent only while UNMATCHED.
  matchMethod?: MatchMethod;
  confidence: number;
  evidence: DiningRestaurantMatchEvidence;
  // true for MATCHED / REVIEW / UNMATCHED, false once REJECTED (kept as history, never deleted).
  isActive: boolean;
  decidedBy: MappingDecider;
  createdAt: Date;
  updatedAt: Date;
}
