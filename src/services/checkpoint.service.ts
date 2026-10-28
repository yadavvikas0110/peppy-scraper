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

const CHECKPOINT_DIR = path.join(process.cwd(), 'output', 'checkpoints');

export function buildJobId(sites: SiteKey[], category: string, countPerSite: number, categoryKey?: string): string {
  let key = [...sites].sort().join(',') + '|' + category.toLowerCase().trim() + '|' + countPerSite;
  // Appended only when set, so existing search-based checkpoints keep their IDs
  if (categoryKey) key += '|' + categoryKey;
  return crypto.createHash('md5').update(key).digest('hex').slice(0, 12);
}

export function getCheckpointPath(jobId: string): string {
  fs.mkdirSync(CHECKPOINT_DIR, { recursive: true });
  return path.join(CHECKPOINT_DIR, `${jobId}.json`);
}

export function saveCheckpoint(data: CheckpointData): void {
  data.updatedAt = new Date().toISOString();
  fs.writeFileSync(getCheckpointPath(data.jobId), JSON.stringify(data, null, 2));
}

export function loadCheckpoint(jobId: string): CheckpointData | null {
  const p = getCheckpointPath(jobId);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8')) as CheckpointData;
  } catch {
    return null;
  }
}

export function deleteCheckpoint(jobId: string): void {
  const p = getCheckpointPath(jobId);
  if (fs.existsSync(p)) fs.unlinkSync(p);
}
