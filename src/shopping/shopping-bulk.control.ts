import { spawn as nodeSpawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { SITE_KEYS } from '../config/sites';
import { SHOPPING_BULK_LOCK_FILE, SHOPPING_BULK_STOP_FILE, readLock } from '../utils/stop-signal';

/**
 * HTTP control for the shopping bulk pipeline in 24/7 mode (POST /api/shopping/bulk/start | stop,
 * GET /api/shopping/bulk/status).
 *
 * Start → run one full pass (shopping-bulk.cli in a CHILD process, so the scraper service's memory and
 * browser pool are never shared), wait SHOPPING_BULK_INTERVAL_HOURS, run the next pass … until Stop.
 * Every pass skips products scraped within SHOPPING_BULK_FRESH_HOURS, so repeat passes spend credits on
 * new products and on prices that are due for a refresh.
 *
 * Stop → no further passes; the pass in progress finishes the pages in flight, saves its checkpoints
 * and exits (the next Start resumes it).
 *
 * The on/off switch is kept in output/shopping-bulk.auto.json, so a deploy or server restart picks the
 * loop back up (resumeShoppingAuto, called at boot) instead of silently ending 24/7 scraping.
 */

export interface AutoOptions {
  count?: number;
  categories?: string[];
  platforms?: string[];
  categoryConcurrency?: number;
  productConcurrency?: number;
  maxPages?: number;
  freshHours?: number;
  intervalHours?: number;
}

interface PersistedState { enabled: boolean; startedAt: string; options: AutoOptions }

export interface LastPass { startedAt: string; finishedAt: string; exitCode: number | null; outcome: string }

export interface ShoppingAutoStatus {
  enabled: boolean;
  phase: 'idle' | 'running' | 'waiting' | 'stopping';
  startedAt?: string;
  options?: AutoOptions;
  intervalHours: number;
  passes: number;
  currentPass?: { startedAt: string; pid?: number };
  nextPassAt?: string;
  lastPass?: LastPass;
  /** A pass started outside this API (PM2 / terminal) holds the bulk lock */
  externalRun?: { pid: number; startedAt: string } | null;
}

type SpawnFn = (cmd: string, args: string[], opts: object) => ChildProcess;

export interface ControlDeps {
  spawn?: SpawnFn;
  outputDir?: string;
  stopFile?: string;
  lockFile?: string;
  env?: NodeJS.ProcessEnv;
  log?: (line: string) => void;
  now?: () => Date;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
}

const LIMITS = {
  count: [1, 500], categoryConcurrency: [1, 10], productConcurrency: [1, 20],
  maxPages: [1, 200], freshHours: [0, 24 * 30], intervalHours: [0, 24 * 7],
} as const;

const EXIT_OUTCOME: Record<number, string> = { 0: 'finished (complete or partial — see the run report)', 1: 'failed', 2: 'skipped (another bulk run holds the lock)', 3: 'stopped', 130: 'stopped' };

/** Validates a start request; returns normalised options or an error message. */
export function parseAutoOptions(body: any): { options: AutoOptions } | { error: string } {
  const b = body && typeof body === 'object' ? body : {};
  const options: AutoOptions = {};
  for (const key of Object.keys(LIMITS) as Array<keyof typeof LIMITS>) {
    if (b[key] === undefined || b[key] === null || b[key] === '') continue;
    const n = Number(b[key]);
    const [min, max] = LIMITS[key];
    if (!Number.isFinite(n) || n < min || n > max || (key !== 'intervalHours' && !Number.isInteger(n))) {
      return { error: `${key} must be ${key === 'intervalHours' ? 'a number' : 'an integer'} ${min}–${max}` };
    }
    options[key] = n;
  }
  const list = (v: unknown) => (Array.isArray(v) ? v : typeof v === 'string' ? v.split(',') : []).map(s => String(s).trim()).filter(Boolean);
  const platforms = list(b.platforms);
  const unknown = platforms.filter(p => !(SITE_KEYS as readonly string[]).includes(p));
  if (unknown.length) return { error: `Unknown platform(s): ${unknown.join(', ')} (known: ${SITE_KEYS.join(', ')})` };
  if (platforms.length) options.platforms = platforms;
  const categories = list(b.categories);
  if (categories.length) options.categories = categories;
  return { options };
}

/** CLI flags for one pass. Anything not given here comes from SHOPPING_BULK_* in the environment. */
export function cliArgsFor(o: AutoOptions): string[] {
  const a: string[] = [];
  if (o.categories?.length) a.push('--categories', o.categories.join(','));
  if (o.platforms?.length) a.push('--platforms', o.platforms.join(','));
  if (o.count !== undefined) a.push('--count', String(o.count));
  if (o.categoryConcurrency !== undefined) a.push('--category-concurrency', String(o.categoryConcurrency));
  if (o.productConcurrency !== undefined) a.push('--product-concurrency', String(o.productConcurrency));
  if (o.maxPages !== undefined) a.push('--max-pages', String(o.maxPages));
  if (o.freshHours !== undefined) a.push('--fresh-hours', String(o.freshHours));
  return a;
}

export function intervalHoursFrom(o: AutoOptions | undefined, env: NodeJS.ProcessEnv): number {
  if (o?.intervalHours !== undefined) return o.intervalHours;
  const n = Number(env.SHOPPING_BULK_INTERVAL_HOURS);
  return env.SHOPPING_BULK_INTERVAL_HOURS?.trim() && Number.isFinite(n) && n >= 0 ? n : 6;
}

function cliCommand(): { cmd: string; args: string[] } {
  // Compiled service (dist/src/index.js) → dist/src/shopping/shopping-bulk.cli.js; ts-node dev → .ts
  const ext = path.extname(__filename);
  const cli = path.join(__dirname, `shopping-bulk.cli${ext}`);
  const pre = ['--max-http-header-size=131072']; // Ounass (via Scrape.do) sends headers above Node's 16 KB default
  return ext === '.ts'
    ? { cmd: process.execPath, args: [...pre, '-r', 'ts-node/register', cli] }
    : { cmd: process.execPath, args: [...pre, cli] };
}

export function createShoppingAutoController(deps: ControlDeps = {}) {
  const spawn = deps.spawn ?? (nodeSpawn as unknown as SpawnFn);
  const outputDir = deps.outputDir ?? path.join(process.cwd(), 'output');
  const stateFile = path.join(outputDir, 'shopping-bulk.auto.json');
  const stopFile = deps.stopFile ?? SHOPPING_BULK_STOP_FILE;
  const lockFile = deps.lockFile ?? SHOPPING_BULK_LOCK_FILE;
  const env = deps.env ?? process.env;
  const log = deps.log ?? ((l: string) => console.log(l));
  const now = deps.now ?? (() => new Date());
  const setTimer = deps.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((t: unknown) => clearTimeout(t as NodeJS.Timeout));

  let state: PersistedState | null = null;
  let child: ChildProcess | null = null;
  let currentPass: { startedAt: string; pid?: number } | undefined;
  let timer: unknown = null;
  let nextPassAt: string | undefined;
  let passes = 0;
  let lastPass: LastPass | undefined;
  let shuttingDown = false;

  const save = () => {
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
  };
  const load = (): PersistedState | null => {
    try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { return null; }
  };

  function scheduleNext(): void {
    if (!state?.enabled || shuttingDown) return;
    const hours = intervalHoursFrom(state.options, env);
    const ms = Math.round(hours * 3600 * 1000);
    nextPassAt = new Date(now().getTime() + ms).toISOString();
    log(`[bulk-auto] next pass at ${nextPassAt} (every ${hours} h after the previous pass ends)`);
    timer = setTimer(() => { timer = null; nextPassAt = undefined; runPass(); }, ms);
  }

  function runPass(): void {
    if (!state?.enabled || child || shuttingDown) return;
    const { cmd, args } = cliCommand();
    const flags = cliArgsFor(state.options);
    try { fs.unlinkSync(stopFile); } catch { /* none */ }
    passes++;
    currentPass = { startedAt: now().toISOString() };
    log(`[bulk-auto] pass ${passes} starting${flags.length ? ` (${flags.join(' ')})` : ''}`);
    let proc: ChildProcess;
    try {
      proc = spawn(cmd, [...args, ...flags], { cwd: process.cwd(), env: { ...env, SHOPPING_BULK_TRIGGER: 'cron' }, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e: any) {
      log(`[bulk-auto] could not start a pass: ${e?.message ?? e}`);
      lastPass = { startedAt: currentPass.startedAt, finishedAt: now().toISOString(), exitCode: null, outcome: `failed to start: ${e?.message ?? e}` };
      currentPass = undefined;
      scheduleNext();
      return;
    }
    child = proc;
    currentPass.pid = proc.pid;
    const relay = (stream: NodeJS.ReadableStream | null | undefined) => {
      if (!stream) return;
      let buf = '';
      stream.on('data', (d: Buffer | string) => {
        buf += d.toString();
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';
        for (const l of lines) if (l.trim()) log(l);
      });
      stream.on('end', () => { if (buf.trim()) log(buf); buf = ''; });
    };
    relay(proc.stdout);
    relay(proc.stderr);
    let done = false;
    const finish = (code: number | null, error?: string) => {
      if (done) return;
      done = true;
      const outcome = error ? `error: ${error}` : code === null ? 'killed' : EXIT_OUTCOME[code] ?? `exit ${code}`;
      lastPass = { startedAt: currentPass?.startedAt ?? now().toISOString(), finishedAt: now().toISOString(), exitCode: code, outcome };
      log(`[bulk-auto] pass ${passes} ended: ${outcome}`);
      child = null;
      currentPass = undefined;
      scheduleNext();
    };
    proc.on('exit', code => finish(code));
    proc.on('error', err => finish(null, err.message));
  }

  function externalRun(): { pid: number; startedAt: string } | null {
    if (child) return null;
    const lock = readLock(lockFile);
    if (!lock) return null;
    try { process.kill(lock.pid, 0); return { pid: lock.pid, startedAt: lock.startedAt }; } catch { return null; }
  }

  return {
    start(body: any): { started: boolean; reason?: string; status: ShoppingAutoStatus } {
      if (state?.enabled) return { started: false, reason: 'Already running in 24/7 mode — call stop first to change options', status: this.status() };
      if (child) return { started: false, reason: 'The previous pass is still finishing after a stop — try again in a minute', status: this.status() };
      const parsed = parseAutoOptions(body);
      if ('error' in parsed) return { started: false, reason: parsed.error, status: this.status() };
      const ext = externalRun();
      if (ext) return { started: false, reason: `A bulk run started outside the API is in progress (PID ${ext.pid}, since ${ext.startedAt}) — stop it first (pm2 stop / npm run shopping:bulk:stop)`, status: this.status() };
      state = { enabled: true, startedAt: now().toISOString(), options: parsed.options };
      save();
      passes = 0;
      runPass();
      return { started: true, status: this.status() };
    },

    stop(): { stopped: boolean; reason?: string; status: ShoppingAutoStatus } {
      const wasEnabled = !!state?.enabled;
      if (!wasEnabled && !child) return { stopped: false, reason: '24/7 scraping is not running', status: this.status() };
      if (state) { state.enabled = false; save(); }
      if (timer) { clearTimer(timer); timer = null; nextPassAt = undefined; }
      if (child) {
        fs.mkdirSync(path.dirname(stopFile), { recursive: true });
        fs.writeFileSync(stopFile, JSON.stringify({ requestedAt: now().toISOString(), by: 'api' }));
        log('[bulk-auto] stop requested — the current pass finishes the pages in flight, saves checkpoints and exits; no further passes');
      } else {
        log('[bulk-auto] stopped — no further passes');
      }
      return { stopped: true, status: this.status() };
    },

    status(): ShoppingAutoStatus {
      const enabled = !!state?.enabled;
      return {
        enabled,
        phase: child ? (enabled ? 'running' : 'stopping') : enabled ? 'waiting' : 'idle',
        startedAt: state?.startedAt,
        options: state?.options,
        intervalHours: intervalHoursFrom(state?.options, env),
        passes,
        currentPass,
        nextPassAt,
        lastPass,
        externalRun: externalRun(),
      };
    },

    /** At boot: continue 24/7 mode if it was on when the service last stopped. */
    resume(): boolean {
      const saved = load();
      if (!saved?.enabled) return false;
      state = saved;
      log(`[bulk-auto] resuming 24/7 shopping scraping (on since ${saved.startedAt})`);
      runPass();
      return true;
    },

    /** Service shutdown (deploy/restart): end the pass gracefully but keep 24/7 mode on, so it resumes at boot. */
    shutdown(waitMs = 5000): Promise<void> {
      shuttingDown = true;
      if (timer) { clearTimer(timer); timer = null; }
      const proc = child;
      if (!proc) return Promise.resolve();
      // The pass saves a checkpoint after every page, so a quick exit loses nothing: the first signal asks it
      // to stop, the second makes it exit at once (the service is going away and cannot relay its output).
      return new Promise<void>(resolve => {
        const t = setTimeout(resolve, waitMs);
        proc.once('exit', () => { clearTimeout(t); resolve(); });
        try { proc.kill('SIGTERM'); } catch { /* gone */ }
        setTimeout(() => { try { proc.kill('SIGTERM'); } catch { /* gone */ } }, Math.min(500, waitMs / 2)).unref?.();
      });
    },
  };
}

export type ShoppingAutoController = ReturnType<typeof createShoppingAutoController>;

let singleton: ShoppingAutoController | null = null;
export function shoppingAuto(): ShoppingAutoController {
  return (singleton ??= createShoppingAutoController());
}
