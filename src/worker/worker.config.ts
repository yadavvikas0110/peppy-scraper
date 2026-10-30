import * as fs from 'fs';
import * as path from 'path';
import { SiteKey } from '../config/sites';
import { partitionSites } from '../config/transport-policy';
import { getBroadCategoryBaseTags } from '../config/taxonomy';

/**
 * Shopping worker configuration — every value comes from the environment with a conservative
 * default, so an unconfigured worker scrapes little and only Amazon UAE.
 */

export interface ShoppingQuery {
  /** Stable id used for job records and checkpoints — never change it for an existing query */
  key: string;
  label: string;
  /** Search text on the retailer (Amazon UAE search) */
  category: string;
  categoryKey?: string;
  broadCategory: string;
  subCategory: string;
  /** Products to discover per run */
  count: number;
  enabled?: boolean;
}

export type WorkerEnv = 'development' | 'production';

export interface WorkerConfig {
  env: WorkerEnv;
  sites: SiteKey[];
  queries: ShoppingQuery[];
  discoveryIntervalMs: number;
  refreshIntervalMs: number;
  /** An offer observed more recently than this is fresh: not refreshed, not re-scraped by discovery */
  freshForMs: number;
  refreshBatchSize: number;
  /** Paid provider requests (Bright Data) allowed per UTC day across all jobs */
  dailyRequestBudget: number;
  minRequestIntervalMs: number;
  maxConcurrency: number;
  tickMs: number;
  retryBaseMs: number;
  maxAttempts: number;
  lockTtlMs: number;
  outputDir: string;
}

const HOUR = 3600 * 1000;

function num(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min || n > max) {
    throw new Error(`${name} must be a number between ${min} and ${max} (got "${raw}")`);
  }
  return n;
}

// src/worker → ../../config ; dist/src/worker → ../../../config
export const DEFAULT_QUERIES_FILE = [path.join(__dirname, '..', '..', 'config', 'shopping-queries.json'), path.join(__dirname, '..', '..', '..', 'config', 'shopping-queries.json')]
  .find(p => fs.existsSync(p)) ?? path.join(process.cwd(), 'config', 'shopping-queries.json');

export function loadQueries(file: string): ShoppingQuery[] {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const list: ShoppingQuery[] = Array.isArray(raw) ? raw : raw.queries;
  if (!Array.isArray(list)) throw new Error(`${file}: expected an array of queries (or { "queries": [...] })`);
  const seen = new Set<string>();
  for (const q of list) {
    for (const field of ['key', 'label', 'category', 'broadCategory', 'subCategory'] as const) {
      if (typeof q[field] !== 'string' || !q[field].trim()) throw new Error(`${file}: query ${JSON.stringify(q.key ?? q.label)} is missing "${field}"`);
    }
    if (!/^[a-z0-9][a-z0-9-]*$/.test(q.key)) throw new Error(`${file}: query key "${q.key}" must be lowercase letters, digits and dashes`);
    if (seen.has(q.key)) throw new Error(`${file}: duplicate query key "${q.key}"`);
    seen.add(q.key);
    if (!Number.isInteger(q.count) || q.count < 1 || q.count > 200) throw new Error(`${file}: query "${q.key}" count must be 1–200`);
    if (getBroadCategoryBaseTags(q.broadCategory, q.subCategory).length === 0) {
      throw new Error(`${file}: query "${q.key}" uses unknown taxonomy "${q.broadCategory} > ${q.subCategory}" (see src/config/taxonomy.ts)`);
    }
  }
  return list.filter(q => q.enabled !== false);
}

export function loadWorkerConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const workerEnv = (env.SHOPPING_WORKER_ENV || 'development') as WorkerEnv;
  if (workerEnv !== 'development' && workerEnv !== 'production') {
    throw new Error('SHOPPING_WORKER_ENV must be "development" or "production"');
  }

  // Amazon UAE only by default. Sites without an authorized source (Noon) are refused outright.
  const requested = (env.SHOPPING_SITES || 'amazon').split(',').map(s => s.trim()).filter(Boolean) as SiteKey[];
  const { supported, unsupported } = partitionSites(requested, env);
  if (unsupported.length) {
    throw new Error(`SHOPPING_SITES includes sites without an authorized data source: ${unsupported.map(u => `${u.site} (${u.reason})`).join('; ')}`);
  }
  if (!supported.length) throw new Error('SHOPPING_SITES is empty');
  if (supported.some(s => s !== 'amazon')) {
    throw new Error('The shopping worker currently supports only "amazon" (Amazon UAE). Other sites need their own refresh adapters first.');
  }

  const queriesFile = env.SHOPPING_QUERIES_FILE ? path.resolve(env.SHOPPING_QUERIES_FILE) : DEFAULT_QUERIES_FILE;
  const queries = loadQueries(queriesFile);

  return {
    env: workerEnv,
    sites: supported,
    queries,
    discoveryIntervalMs: num(env, 'SHOPPING_DISCOVERY_INTERVAL_HOURS', 24, 1, 24 * 30) * HOUR,
    refreshIntervalMs: num(env, 'SHOPPING_REFRESH_INTERVAL_HOURS', 12, 1, 24 * 30) * HOUR,
    freshForMs: num(env, 'SHOPPING_FRESH_FOR_HOURS', 12, 1, 24 * 30) * HOUR,
    refreshBatchSize: num(env, 'SHOPPING_REFRESH_BATCH_SIZE', 100, 1, 5000),
    dailyRequestBudget: num(env, 'SHOPPING_DAILY_REQUEST_BUDGET', 800, 1, 1_000_000),
    minRequestIntervalMs: num(env, 'SHOPPING_MIN_REQUEST_INTERVAL_MS', 2000, 0, 600_000),
    maxConcurrency: num(env, 'SHOPPING_MAX_CONCURRENCY', 2, 1, 50),
    tickMs: num(env, 'SHOPPING_WORKER_TICK_SECONDS', 60, 5, 3600) * 1000,
    retryBaseMs: num(env, 'SHOPPING_RETRY_BASE_MINUTES', 15, 1, 24 * 60) * 60 * 1000,
    maxAttempts: num(env, 'SHOPPING_MAX_ATTEMPTS', 4, 1, 20),
    lockTtlMs: num(env, 'SHOPPING_LOCK_TTL_MINUTES', 10, 1, 24 * 60) * 60 * 1000,
    outputDir: env.SCRAPER_OUTPUT_DIR || path.join(process.cwd(), 'output'),
  };
}
