import type { ObjectId } from 'mongodb';
import type { DiningLocale, DiningPlatform, DiningScrapeRunCounts } from '../dining.types';

// ─── Job (one daily refresh of every stored restaurant, both locales) ────────

export const DINING_CRON_JOB_TRIGGERS = ['schedule', 'manual', 'startup'] as const;
export type DiningCronJobTrigger = (typeof DINING_CRON_JOB_TRIGGERS)[number];

export const DINING_CRON_JOB_STATUSES = ['running', 'succeeded', 'partial', 'failed', 'aborted', 'skipped'] as const;
export type DiningCronJobStatus = (typeof DINING_CRON_JOB_STATUSES)[number];

export type DiningCronTargetStatus = 'succeeded' | 'partial' | 'failed' | 'skipped';

// Why a job stopped before processing every target.
export type DiningCronAbortReason =
  | 'SHUTDOWN'
  | 'SCRAPE_DO_UNAVAILABLE'
  | 'LOW_SCRAPE_DO_CREDITS'
  | 'TOO_MANY_CONSECUTIVE_FAILURES';

// Why a stored restaurant/locale is not scraped. Never guessed around: a missing URL stays missing.
export type DiningCronSkipReason =
  | 'MISSING_LOCALE_URL'
  | 'UNSUPPORTED_PLATFORM'
  | 'INVALID_URL'
  | 'LOCALE_MISMATCH'
  | 'DUPLICATE_URL'
  | 'MAX_TARGETS_EXCEEDED'
  | 'RUN_IN_PROGRESS'
  | DiningCronAbortReason;

export interface DiningCronTarget {
  restaurantId: string;
  restaurantName?: string;
  platform: DiningPlatform;
  locale: DiningLocale;
  url: string;
  // "lastRun": the exact URL of the run that last wrote this restaurant/locale; "restaurant": the stored page URL.
  urlSource: 'lastRun' | 'restaurant';
  // Identity the fetched page must match (see DiningScrapeContext.expectedRestaurant).
  expected: { platformRestaurantId?: string; sourceKey: string };
  estimatedCredits: number;
}

export interface DiningCronSkippedTarget {
  restaurantId: string;
  restaurantName?: string;
  platform: string;
  locale?: DiningLocale;
  url?: string;
  reason: DiningCronSkipReason;
}

export interface DiningCronPlatformPlan {
  restaurants: number;
  targets: number;
  estimatedCredits: number;
}

export interface DiningCronPlan {
  restaurants: number;
  targets: number;
  estimatedCredits: number;
  byPlatform: Partial<Record<DiningPlatform, DiningCronPlatformPlan>>;
  skipped: DiningCronSkippedTarget[];
}

export interface DiningCronChangeSummary {
  recorded: number;
  // Changes beyond the per-target cap are counted here but not stored individually.
  truncated: number;
  byAction: Partial<Record<DiningCronChangeAction, number>>;
}

export interface DiningCronTargetResult {
  restaurantId: string;
  restaurantName?: string;
  platform: string;
  locale?: DiningLocale;
  url?: string;
  status: DiningCronTargetStatus;
  skipReason?: DiningCronSkipReason;
  runIds: string[];
  attempts: number;
  startedAt?: Date;
  finishedAt?: Date;
  durationMs?: number;
  counts?: DiningScrapeRunCounts;
  inactive?: { applied: boolean; reasons: string[] };
  fetch?: { statusCode?: number; requestCost?: number; remainingCredits?: number };
  changes?: DiningCronChangeSummary;
  // Items created by this target that have no active item mapping yet (not price-compared).
  newItemsUnmapped?: number;
  error?: { stage: string; code: string; message: string };
}

export interface DiningCronTotals extends DiningScrapeRunCounts {
  targetsPlanned: number;
  targetsSucceeded: number;
  targetsPartial: number;
  targetsFailed: number;
  targetsSkipped: number;
  changesRecorded: number;
  newItemsUnmapped: number;
  creditsUsed: number;
  remainingCredits?: number;
}

export interface DiningCronJobOptions {
  dryRun: boolean;
  platforms?: DiningPlatform[];
  restaurantIds?: string[];
  locales?: DiningLocale[];
  concurrency: number;
  delayMs: number;
  retryAttempts: number;
  maxTargets: number;
  minRemainingCredits: number;
  maxConsecutiveFailures: number;
}

export interface DiningCronJob {
  _id?: ObjectId;
  jobId: string;
  // Constant while running: the partial unique index on it allows one running job at a time.
  lockKey: string;
  trigger: DiningCronJobTrigger;
  status: DiningCronJobStatus;
  options: DiningCronJobOptions;
  plan?: DiningCronPlan;
  progress: { completed: number; total: number };
  totals: DiningCronTotals;
  targets: DiningCronTargetResult[];
  abortReason?: DiningCronAbortReason;
  skipReason?: 'ALREADY_RUNNING';
  // Other job holding the lock when this one was skipped.
  blockedByJobId?: string;
  errors: Array<{ code: string; message: string }>;
  host: string;
  pid: number;
  startedAt: Date;
  heartbeatAt: Date;
  finishedAt?: Date;
  durationMs?: number;
  createdAt: Date;
  updatedAt: Date;
}

// ─── Change log (field-level audit of what a job changed) ────────────────────

export const DINING_CRON_CHANGE_ACTIONS = ['created', 'updated', 'deactivated', 'reactivated'] as const;
export type DiningCronChangeAction = (typeof DINING_CRON_CHANGE_ACTIONS)[number];

export type DiningCronChangeEntity = 'restaurant' | 'category' | 'item';

export interface DiningCronFieldChange {
  field: string;
  before: unknown;
  after: unknown;
}

export interface DiningCronChange {
  _id?: ObjectId;
  jobId: string;
  runId?: string;
  restaurantId: ObjectId;
  platform: DiningPlatform;
  locale: DiningLocale;
  entity: DiningCronChangeEntity;
  action: DiningCronChangeAction;
  entityId: ObjectId;
  sourceKey: string;
  name?: string;
  // Empty for "created" (the whole record is new).
  changes: DiningCronFieldChange[];
  createdAt: Date;
}
