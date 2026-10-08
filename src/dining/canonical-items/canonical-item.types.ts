import type { ObjectId } from 'mongodb';
import type { DiningPlatform, LocalizedText } from '../dining.types';

/*
 * Canonical food item: one logical dish within ONE canonical restaurant group (branch).
 *
 * Source documents in dining_menu_items stay per platform and are never merged. A canonical
 * item is never global — "Thali" at two different groups is two different canonical items.
 * Price, image, URLs, platform IDs and availability are platform data and never live here.
 */

export const CANONICAL_ITEM_STATUSES = ['active', 'inactive'] as const;
export type CanonicalItemStatus = (typeof CANONICAL_ITEM_STATUSES)[number];

export const CANONICAL_ITEM_IDENTITY_STATUSES = ['auto', 'verified', 'review'] as const;
export type CanonicalItemIdentityStatus = (typeof CANONICAL_ITEM_IDENTITY_STATUSES)[number];

// Portion/size as written in the source name (e.g. "(2 Pcs)", "12 inch"). Never inferred.
export interface CanonicalItemVariant {
  size?: string;
  quantity?: number;
  unit?: string;
  label?: LocalizedText;
}

export interface CanonicalItemSignals {
  normalizedNames: string[];
  normalizedDescriptions: string[];
  normalizedCategories: string[];
}

export interface DiningCanonicalItem {
  _id?: ObjectId;
  restaurantGroupId: ObjectId;
  // Backfill idempotency anchor: `seed:<restaurantGroupId>:<seedMenuItemId>`. Not a cross-platform identity.
  identityKey: string;
  canonicalName: LocalizedText;
  canonicalDescription?: LocalizedText;
  // Informational only; never part of identity.
  category?: LocalizedText;
  // Source-provided alternate names only (e.g. a later rename of the seed item). Never generated.
  aliases: string[];
  searchKeywords: string[];
  variant?: CanonicalItemVariant;
  identityStatus: CanonicalItemIdentityStatus;
  // Canonical lifecycle, independent of any platform's availability.
  status: CanonicalItemStatus;
  // The source dining_menu_items document this item was created from. Unique, never removed.
  seedMenuItemId: ObjectId;
  seedRestaurantId: ObjectId;
  seedPlatform: DiningPlatform;
  signals: CanonicalItemSignals;
  createdAt: Date;
  updatedAt: Date;
}
