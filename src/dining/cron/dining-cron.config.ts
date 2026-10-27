import cron from 'node-cron';

/*
 * Daily dining refresh settings. Only ENABLE_DINING_CRON is required to turn the schedule on;
 * everything else has a safe default. Invalid values fail loudly instead of falling back silently.
 */

export interface DiningCronConfig {
  enabled: boolean;
  schedule: string;
  timezone: string;
  // Restaurants refreshed in parallel (each restaurant's locales always run one after another).
  concurrency: number;
  // Pause between two scrapes of the same worker, to spread load on the platforms.
  delayMs: number;
  // Extra attempts for a target after a transient failure (on top of the Scrape.do client's retries).
  retryAttempts: number;
  retryDelayMs: number;
  // Safety cap on Scrape.do requests per job; least recently refreshed restaurants go first.
  maxTargets: number;
  // Stop before the next scrape once Scrape.do reports fewer remaining credits than this.
  minRemainingCredits: number;
  maxConsecutiveFailures: number;
  // Also run once when the dining service starts (in addition to the schedule).
  runOnStart: boolean;
  // Field-level change records stored per restaurant/locale; the rest are only counted.
  maxChangesPerTarget: number;
}

export const DINING_CRON_DEFAULTS: DiningCronConfig = {
  enabled: false,
  schedule: '0 13 * * *',
  timezone: 'Asia/Kolkata',
  concurrency: 2,
  delayMs: 3000,
  retryAttempts: 1,
  retryDelayMs: 60_000,
  maxTargets: 200,
  minRemainingCredits: 50,
  maxConsecutiveFailures: 5,
  runOnStart: false,
  maxChangesPerTarget: 500,
};

const LIMITS = {
  concurrency: { min: 1, max: 4 },
  delayMs: { min: 0, max: 120_000 },
  retryAttempts: { min: 0, max: 3 },
  retryDelayMs: { min: 0, max: 15 * 60_000 },
  maxTargets: { min: 1, max: 2000 },
  minRemainingCredits: { min: 0, max: 10_000_000 },
  maxConsecutiveFailures: { min: 1, max: 100 },
  maxChangesPerTarget: { min: 0, max: 5000 },
} as const;

export class DiningCronConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DiningCronConfigError';
  }
}

const TRUE_VALUES = new Set(['true', '1', 'yes', 'on']);
const FALSE_VALUES = new Set(['false', '0', 'no', 'off', '']);

function readBool(env: NodeJS.ProcessEnv, key: string, fallback: boolean): boolean {
  const raw = env[key]?.trim().toLowerCase();
  if (raw === undefined) return fallback;
  if (TRUE_VALUES.has(raw)) return true;
  if (FALSE_VALUES.has(raw)) return false;
  throw new DiningCronConfigError(`${key} must be true or false`);
}

function readInt(env: NodeJS.ProcessEnv, key: string, fallback: number, limits: { min: number; max: number }): number {
  const raw = env[key]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < limits.min || value > limits.max) {
    throw new DiningCronConfigError(`${key} must be an integer between ${limits.min} and ${limits.max}`);
  }
  return value;
}

export function isValidTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

// The schedule only runs when ENABLE_DINING_CRON is true; any other value (or none) keeps it off.
export function isDiningCronEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return TRUE_VALUES.has(env.ENABLE_DINING_CRON?.trim().toLowerCase() ?? '');
}

export function loadDiningCronConfig(env: NodeJS.ProcessEnv = process.env): DiningCronConfig {
  const schedule = env.DINING_CRON_SCHEDULE?.trim() || DINING_CRON_DEFAULTS.schedule;
  if (!cron.validate(schedule)) throw new DiningCronConfigError(`DINING_CRON_SCHEDULE is not a valid cron expression: "${schedule}"`);
  const timezone = env.DINING_CRON_TIMEZONE?.trim() || DINING_CRON_DEFAULTS.timezone;
  if (!isValidTimezone(timezone)) throw new DiningCronConfigError(`DINING_CRON_TIMEZONE is not a valid IANA time zone: "${timezone}"`);

  const d = DINING_CRON_DEFAULTS;
  return {
    enabled: isDiningCronEnabled(env),
    schedule,
    timezone,
    concurrency: readInt(env, 'DINING_CRON_CONCURRENCY', d.concurrency, LIMITS.concurrency),
    delayMs: readInt(env, 'DINING_CRON_DELAY_MS', d.delayMs, LIMITS.delayMs),
    retryAttempts: readInt(env, 'DINING_CRON_RETRY_ATTEMPTS', d.retryAttempts, LIMITS.retryAttempts),
    retryDelayMs: readInt(env, 'DINING_CRON_RETRY_DELAY_MS', d.retryDelayMs, LIMITS.retryDelayMs),
    maxTargets: readInt(env, 'DINING_CRON_MAX_TARGETS', d.maxTargets, LIMITS.maxTargets),
    minRemainingCredits: readInt(env, 'DINING_CRON_MIN_CREDITS', d.minRemainingCredits, LIMITS.minRemainingCredits),
    maxConsecutiveFailures: readInt(env, 'DINING_CRON_MAX_CONSECUTIVE_FAILURES', d.maxConsecutiveFailures, LIMITS.maxConsecutiveFailures),
    runOnStart: readBool(env, 'DINING_CRON_RUN_ON_START', d.runOnStart),
    maxChangesPerTarget: readInt(env, 'DINING_CRON_MAX_CHANGES_PER_TARGET', d.maxChangesPerTarget, LIMITS.maxChangesPerTarget),
  };
}
