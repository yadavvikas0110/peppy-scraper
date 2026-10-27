import type { ObjectId } from 'mongodb';
import type { DiningLocale, DiningPlatform } from '../dining.types';

/*
 * The bulk import queue: every restaurant found on a platform listing page, and what happened to it.
 * It is the resumable state of a bulk import (nothing is held in memory between steps).
 *
 *   discovered → queued (picked for a batch) → running → imported | partial | failed       (or skipped)
 */

export const IMPORT_STATUSES = ['discovered', 'queued', 'running', 'imported', 'partial', 'failed', 'skipped'] as const;
export type ImportStatus = (typeof IMPORT_STATUSES)[number];

export interface ImportLocaleResult {
  status: 'succeeded' | 'partial' | 'failed';
  runId?: string;
  itemsSeen?: number;
  credits?: number;
  error?: string;
}

// What discovery finds on a listing page.
export interface ImportCandidate {
  platform: DiningPlatform;
  // The platform's own restaurant/branch id, the one its menu page reports.
  platformRestaurantId: string;
  name: string;
  // English menu URL (the other locale is derived by the platform adapter).
  url: string;
  slug?: string;
  lat?: number;
  lng?: number;
  rating?: number;
  ratingCount?: number;
  cuisines?: string[];
  // Listing page it came from, for auditing.
  sourceUrl: string;
  // Offer wording shown on the listing card, when there is one.
  offerLabels?: string[];
}

export interface ImportQueueItem extends ImportCandidate {
  _id?: ObjectId;
  status: ImportStatus;
  batchId?: string;
  // Why it was picked (pair hint, control, popularity) or skipped.
  reason?: string;
  // Same-brand, same-area candidates on both platforms share a pairKey.
  pairKey?: string;
  priority?: number;
  locales: Partial<Record<DiningLocale, ImportLocaleResult>>;
  restaurantId?: ObjectId;
  attempts: number;
  creditsUsed: number;
  lastError?: string;
  discoveredAt: Date;
  updatedAt: Date;
}
