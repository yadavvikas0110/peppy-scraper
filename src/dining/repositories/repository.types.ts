import type { ObjectId } from 'mongodb';
import type { DiningLocale, DiningPlatform } from '../dining.types';
import type { ValidationIssue } from '../dining.validator';

// Per-scrape write context shared by the menu repositories.
export interface DiningWriteContext {
  locale: DiningLocale;
  runId: string;
  now: Date;
  // Compute outcomes (validation, created/updated/unchanged) without writing anything.
  dryRun?: boolean;
}

// The canonical restaurant a category/item belongs to.
export interface RestaurantRef {
  _id: ObjectId;
  platform: DiningPlatform;
  sourceKey: string;
  platformRestaurantId?: string;
  // false when the restaurant does not exist yet and this is a dry run (placeholder _id).
  persisted: boolean;
}

export interface RejectedRecord {
  sourceKey: string;
  code: string;
  message: string;
  issues?: ValidationIssue[];
}

export interface BulkUpsertOutcome {
  created: number;
  updated: number;
  unchanged: number;
  rejected: RejectedRecord[];
  // sourceKey → _id for every record that exists after the write (placeholders in dry runs).
  idsBySourceKey: Map<string, ObjectId>;
}

// A scrape identified a record more weakly (slug/position) than the stored record (platform ID).
// Writing it would create a duplicate of the same restaurant, so the write is refused.
export class DiningIdentityDowngradeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DiningIdentityDowngradeError';
  }
}

export function issuesMessage(issues: ValidationIssue[]): string {
  return issues.map(i => `${i.path} ${i.message}`).join('; ');
}
