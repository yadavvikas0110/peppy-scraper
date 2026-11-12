import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { CUSTOM_SITES, CustomSite } from './core/types';
import { loadCustomConfig } from './custom.config';

/**
 * HTTP control for the custom scraper (used by the scraper service → backend → admin panel).
 *
 * A run is the custom CLI in a CHILD process, so its isolation holds: the child blanks every
 * third-party provider credential before loading anything, and the main service's in-memory
 * state (Bright Data browser pool, budgets) is never shared. The child's output is relayed to
 * this process's console, which feeds the service's Live Logs.
 *
 * Paths match custom.cli.ts (lock, stop signal and reports live under <cwd>/output).
 */
const OUTPUT_DIR = path.join(process.cwd(), 'output');
export const CUSTOM_LOCK = path.join(OUTPUT_DIR, 'cron.custom.lock');
export const CUSTOM_STOP = path.join(OUTPUT_DIR, 'stop.custom.signal');
export const CUSTOM_REPORTS = path.join(OUTPUT_DIR, 'custom');

export interface CustomTriggerRequest {
  sites?: string[];
  categories?: string[];
  limit?: number;
  /** Write to the allowlisted database (default true from the admin panel) */
  push?: boolean;
}

export interface CustomTriggerResult { triggered: boolean; reason?: string; startedAt?: string; args?: string[] }

const ENV_FILE = () => path.join(process.cwd(), '.env.custom');

/**
 * The environment a run will see: the service's own variables win, .env.custom fills the rest —
 * the same precedence `node --env-file` gives the child. Read without loading it into this process.
 */
export function effectiveCustomEnv(envFile = ENV_FILE(), env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  let fromFile: Record<string, string> = {};
  try { fromFile = require('dotenv').parse(fs.readFileSync(envFile)); } catch { /* no file */ }
  return { ...fromFile, ...Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined)) };
}

let child: ChildProcess | null = null;
let current: { startedAt: string; args: string[] } | null = null;
let lastExit: { code: number | null; finishedAt: string; error?: string } | null = null;
const recentLines: string[] = [];

function readLock(): { pid: number; startedAt: string } | null {
  let lock: { pid: number; startedAt: string };
  try { lock = JSON.parse(fs.readFileSync(CUSTOM_LOCK, 'utf8')); } catch { return null; }
  try {
    process.kill(lock.pid, 0); // throws ESRCH when that process is gone (stale lock)
    return lock;
  } catch (e: any) {
    return e?.code === 'EPERM' ? lock : null; // EPERM: alive, owned by another user
  }
}

function cliCommand(): { cmd: string; args: string[] } {
  // Compiled service (dist/src/index.js) → dist/src/custom/custom.cli.js; ts-node dev → .ts via ts-node
  const ext = path.extname(__filename);
  const cli = path.join(__dirname, `custom.cli${ext}`);
  // The custom scraper's own variables (CUSTOM_MONGODB_*, S3_*) live in .env.custom when present;
  // on a server they can be set in the service environment instead (inherited by the child).
  const envFile = ENV_FILE();
  const pre = fs.existsSync(envFile) ? [`--env-file=${envFile}`] : [];
  return ext === '.ts'
    ? { cmd: process.execPath, args: [...pre, '-r', 'ts-node/register', cli] }
    : { cmd: process.execPath, args: [...pre, cli] };
}

/** Validates a trigger request against the shipped config; returns CLI flags or an error. */
export function buildCliArgs(req: CustomTriggerRequest, configFile?: string): { args: string[] } | { error: string } {
  const config = loadCustomConfig(configFile);
  const args: string[] = [];
  const sites = (req.sites ?? []).map(s => String(s).trim()).filter(Boolean);
  const unknownSites = sites.filter(s => !(CUSTOM_SITES as readonly string[]).includes(s));
  if (unknownSites.length) return { error: `Unknown site(s): ${unknownSites.join(', ')}` };
  if (sites.length) args.push('--site', sites.join(','));

  const chosenSites = (sites.length ? sites : [...CUSTOM_SITES]) as CustomSite[];
  const known = new Set(chosenSites.flatMap(s => config.sites[s].map(t => t.key)));
  const categories = (req.categories ?? []).map(c => String(c).trim()).filter(Boolean);
  const unknownCats = categories.filter(c => !known.has(c));
  if (unknownCats.length) return { error: `Unknown category key(s) for the selected sites: ${unknownCats.join(', ')}` };
  if (categories.length) args.push('--category', categories.join(','));

  if (req.limit !== undefined && req.limit !== null) {
    const n = Number(req.limit);
    if (!Number.isInteger(n) || n < 1 || n > 50) return { error: 'limit must be an integer 1–50 (products per category)' };
    args.push('--limit', String(n));
  }
  if (req.push !== false) args.push('--push');
  return { args };
}

export function triggerCustomRun(req: CustomTriggerRequest): CustomTriggerResult {
  const env = effectiveCustomEnv();
  if (env.CUSTOM_SCRAPER_ENABLED === 'false') return { triggered: false, reason: 'Custom scraper is disabled (CUSTOM_SCRAPER_ENABLED=false)' };
  if (req.push !== false && !(env.S3_ACCESS_KEY_ID && env.S3_SECRET_ACCESS_KEY && env.S3_BUCKET)) {
    return { triggered: false, reason: 'Saving needs S3 settings on the scraper server (S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY, S3_BUCKET, S3_REGION, CDN_URL). Use a test run, or configure S3.' };
  }
  if (req.push !== false && !env.CUSTOM_MONGODB_URI) {
    return { triggered: false, reason: 'Saving needs CUSTOM_MONGODB_URI on the scraper server. Use a test run, or configure the database.' };
  }
  const lock = readLock();
  if (child || lock) return { triggered: false, reason: 'Custom scraper already running', startedAt: current?.startedAt ?? lock?.startedAt };

  const built = buildCliArgs(req);
  if ('error' in built) return { triggered: false, reason: built.error };

  const { cmd, args } = cliCommand();
  const startedAt = new Date().toISOString();
  current = { startedAt, args: built.args };
  recentLines.length = 0;
  try { fs.unlinkSync(CUSTOM_STOP); } catch {}

  child = spawn(cmd, [...args, ...built.args], { cwd: process.cwd(), env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  const relay = (stream: NodeJS.ReadableStream | null, isErr: boolean) => {
    let buf = '';
    stream?.on('data', chunk => {
      buf += chunk.toString();
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        const msg = line.startsWith('[custom') ? line : `[custom] ${line}`;
        recentLines.push(msg);
        if (recentLines.length > 200) recentLines.shift();
        (isErr ? console.error : console.log)(msg);
      }
    });
  };
  relay(child.stdout, false);
  relay(child.stderr, true);
  child.on('exit', code => {
    lastExit = { code, finishedAt: new Date().toISOString() };
    console.log(`[custom] Run finished (exit code ${code}).`);
    child = null;
    current = null;
  });
  child.on('error', e => {
    lastExit = { code: null, finishedAt: new Date().toISOString(), error: e.message };
    console.error(`[custom] Could not start run: ${e.message}`);
    child = null;
    current = null;
  });
  console.log(`[custom] Run started from admin: ${built.args.join(' ') || '(all sites, all categories, no push)'}`);
  return { triggered: true, startedAt, args: built.args };
}

export function stopCustomRun(): { stopped: boolean; reason?: string } {
  if (!child && !readLock()) return { stopped: false, reason: 'Custom scraper not running' };
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  fs.writeFileSync(CUSTOM_STOP, JSON.stringify({ requestedAt: new Date().toISOString() }));
  console.log('[custom] Stop signal written — the run ends after the current product.');
  return { stopped: true };
}

/** Summary of the newest report in output/custom (never the full product list). */
export function lastCustomReport(dir = CUSTOM_REPORTS): Record<string, unknown> | null {
  try {
    const files = fs.readdirSync(dir).filter(f => /^custom_.*\.json$/.test(f)).sort();
    if (!files.length) return null;
    const r = JSON.parse(fs.readFileSync(path.join(dir, files[files.length - 1]), 'utf8'));
    const valid = (r.sites ?? []).reduce((a: number, s: any) => a + (s.valid ?? 0), 0);
    return {
      startedAt: r.startedAt,
      finishedAt: r.finishedAt,
      productsScraped: valid,
      status: (r.sites ?? []).every((s: any) => s.status === 'complete') ? 'complete'
        : (r.sites ?? []).some((s: any) => s.valid > 0) ? 'partial' : 'failed',
      sites: (r.sites ?? []).map((s: any) => ({ site: s.site, status: s.status, valid: s.valid, rejected: s.rejected, reason: s.reason, coverage: s.coverage })),
      requests: r.requests,
      push: r.push ? { target: r.push.target, inserted: r.push.mongoInserted, updated: r.push.mongoUpdated, skipped: r.push.skipped, errors: r.push.errors } : null,
      s3: r.s3 ?? null,
    };
  } catch { return null; }
}

export function customStatus() {
  const lock = readLock();
  return {
    enabled: effectiveCustomEnv().CUSTOM_SCRAPER_ENABLED !== 'false',
    running: !!child || !!lock,
    startedAt: current?.startedAt ?? lock?.startedAt ?? null,
    args: current?.args ?? null,
    recentLogs: recentLines.slice(-30),
    lastExit,
    lastRun: lastCustomReport(),
  };
}

/** Read-only facts for the admin panel: sites, categories, and whether DB/S3 are configured (no secrets). */
export function customConfig() {
  let sites: unknown[] = [];
  let error: string | undefined;
  try {
    const config = loadCustomConfig();
    const methods: Record<CustomSite, string> = {
      namshi: 'Plain HTTP (own)', mumzworld: 'Plain HTTP (own)',
      jumbo: 'Local headless Chrome + HTTP (own)', letstango: 'Shopify JSON (own)',
    };
    sites = CUSTOM_SITES.map(site => ({
      key: site,
      method: methods[site],
      categories: config.sites[site].map(t => ({ key: t.key, label: t.label, broadCategory: t.broadCategory, subCategory: t.subCategory, limit: t.limit })),
    }));
  } catch (e: any) { error = e.message; }
  const env = effectiveCustomEnv();
  const uri = env.CUSTOM_MONGODB_URI?.trim();
  // Host and database name only — never the credentials part of the URI
  const host = uri ? /^mongodb(?:\+srv)?:\/\/(?:[^@/]+@)?([^/?]+)/.exec(uri)?.[1] ?? null : null;
  return {
    label: 'Custom Scraper (no third party)',
    enabled: env.CUSTOM_SCRAPER_ENABLED !== 'false',
    sites,
    database: uri ? { host, name: env.CUSTOM_MONGODB_DB || null, allowlist: (env.CUSTOM_DB_ALLOWLIST || 'dev').split(',') } : null,
    s3Configured: !!(env.S3_ACCESS_KEY_ID && env.S3_SECRET_ACCESS_KEY && env.S3_BUCKET),
    ...(error ? { error } : {}),
  };
}
