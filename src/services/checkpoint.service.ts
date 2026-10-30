import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { ProductData } from '../parsers/types';
import { SiteKey } from '../config/sites';

export interface CheckpointData {
  jobId: string;
  sites: SiteKey[];
  category: string;
  categoryKey?: string;
  broadCategory: string;
  subCategory: string;
  countPerSite: number;
  startedAt: string;
  updatedAt: string;
  links: Partial<Record<SiteKey, string[]>>;
  scraped: Array<{ site: SiteKey; url: string; data: ProductData }>;
  failed: Array<{ url: string; message: string }>;
}

const DEFAULT_MAX_AGE_HOURS = 20;

/**
 * How long resumable state (per-query checkpoints and the cron's resume state) may be reused.
 * Older state holds prices from a previous day; resuming it would publish them as current.
 * CHECKPOINT_MAX_AGE_HOURS → CRON_STATE_MAX_AGE_HOURS → 20h.
 */
export function resumeMaxAgeMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.CHECKPOINT_MAX_AGE_HOURS ?? env.CRON_STATE_MAX_AGE_HOURS;
  const hours = raw !== undefined ? parseFloat(raw) : DEFAULT_MAX_AGE_HOURS;
  return (Number.isFinite(hours) && hours > 0 ? hours : DEFAULT_MAX_AGE_HOURS) * 3600 * 1000;
}

/** Usable only when startedAt is a valid time in the past, younger than maxAgeMs. */
export function isResumeStateFresh(startedAt: string | undefined, maxAgeMs: number, now: Date = new Date()): boolean {
  const started = startedAt ? Date.parse(startedAt) : NaN;
  if (!Number.isFinite(started)) return false;
  const age = now.getTime() - started;
  return age >= 0 && age < maxAgeMs;
}

function checkpointDir(): string {
  return process.env.SCRAPER_CHECKPOINT_DIR || path.join(process.cwd(), 'output', 'checkpoints');
}

export function buildJobId(sites: SiteKey[], category: string, countPerSite: number, categoryKey?: string): string {
  let key = [...sites].sort().join(',') + '|' + category.toLowerCase().trim() + '|' + countPerSite;
  // Appended only when set, so existing search-based checkpoints keep their IDs
  if (categoryKey) key += '|' + categoryKey;
  return crypto.createHash('md5').update(key).digest('hex').slice(0, 12);
}

export function getCheckpointPath(jobId: string): string {
  const dir = checkpointDir();
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${jobId}.json`);
}

export function saveCheckpoint(data: CheckpointData): void {
  data.updatedAt = new Date().toISOString();
  fs.writeFileSync(getCheckpointPath(data.jobId), JSON.stringify(data, null, 2));
}

/**
 * Returns a resumable checkpoint, or null when there is none, it is unreadable, or it is
 * older than the resume window. Expired checkpoints are deleted so their prices are never reused.
 */
export function loadCheckpoint(
  jobId: string,
  opts: { maxAgeMs?: number; now?: Date } = {},
): CheckpointData | null {
  const p = getCheckpointPath(jobId);
  if (!fs.existsSync(p)) return null;
  let data: CheckpointData;
  try {
    data = JSON.parse(fs.readFileSync(p, 'utf8')) as CheckpointData;
  } catch {
    return null;
  }
  const maxAgeMs = opts.maxAgeMs ?? resumeMaxAgeMs();
  if (!isResumeStateFresh(data.startedAt, maxAgeMs, opts.now)) {
    console.warn(`[checkpoint] Discarding ${jobId} from ${data.startedAt} — older than ${maxAgeMs / 3600000}h; starting fresh.`);
    deleteCheckpoint(jobId);
    return null;
  }
  return data;
}

export function deleteCheckpoint(jobId: string): void {
  const p = getCheckpointPath(jobId);
  if (fs.existsSync(p)) fs.unlinkSync(p);
}
