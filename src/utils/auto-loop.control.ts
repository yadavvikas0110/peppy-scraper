import { spawn as nodeSpawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { readLock } from './stop-signal';

/**
 * 24/7 loop for a pipeline CLI, controlled over HTTP (start / stop / status). Used by shopping, grocery and dining.
 *
 * Start → run one pass (the pipeline CLI in a CHILD process, so the scraper service's memory is never shared), wait
 * the interval, run the next pass … until Stop. Stop → no further passes; the pass in progress is asked to finish
 * (stop files) and exits on its own. The on/off switch is kept in output/<name>.auto.json, so a deploy or restart of the
 * service resumes the loop at boot until Stop is called.
 */

export interface LastPass { startedAt: string; finishedAt: string; exitCode: number | null; outcome: string }

export interface AutoLoopStatus<O> {
  pipeline: string;
  enabled: boolean;
  phase: 'idle' | 'running' | 'waiting' | 'stopping';
  startedAt?: string;
  options?: O;
  intervalHours: number;
  passes: number;
  currentPass?: { startedAt: string; pid?: number };
  nextPassAt?: string;
  lastPass?: LastPass;
  /** A pass started outside this API (PM2 / terminal) holds the pipeline's lock */
  externalRun?: { pid: number; startedAt: string } | null;
}

type SpawnFn = (cmd: string, args: string[], opts: object) => ChildProcess;

export interface AutoLoopConfig<O extends { intervalHours?: number }> {
  /** Short name, used for the state file and log prefix (e.g. "shopping-bulk", "grocery", "dining") */
  name: string;
  /** Node script of one pass, relative to the compiled module's folder resolution done by the caller */
  command: () => { cmd: string; args: string[] };
  /** Validates the start request body */
  parseOptions: (body: any) => { options: O } | { error: string };
  /** CLI flags for one pass */
  argsFor: (options: O) => string[];
  /** Env var holding the pause between passes (hours) */
  intervalEnv: string;
  defaultIntervalHours?: number;
  /** Files whose existence asks a running pass to stop */
  stopFiles: string[];
  /** Lock files of the pipeline: a live one not owned by this loop blocks Start */
  lockFiles: string[];
  /** Exit code → text for the status */
  exitOutcome?: Record<number, string>;
  /** Extra env for the child */
  childEnv?: Record<string, string>;
}

export interface AutoLoopDeps {
  spawn?: SpawnFn;
  outputDir?: string;
  env?: NodeJS.ProcessEnv;
  log?: (line: string) => void;
  now?: () => Date;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
}

interface PersistedState<O> { enabled: boolean; startedAt: string; options: O }

export function intervalHoursOf(o: { intervalHours?: number } | undefined, env: NodeJS.ProcessEnv, envName: string, fallback = 6): number {
  if (o?.intervalHours !== undefined) return o.intervalHours;
  const raw = env[envName]?.trim();
  const n = Number(raw);
  return raw && Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** Node command for a CLI next to a compiled (dist .js) or ts-node (.ts) module. */
export function nodeCliCommand(dir: string, baseName: string, ext: string, pre: string[] = []): { cmd: string; args: string[] } {
  const cli = path.join(dir, `${baseName}${ext}`);
  return ext === '.ts'
    ? { cmd: process.execPath, args: [...pre, '-r', 'ts-node/register', cli] }
    : { cmd: process.execPath, args: [...pre, cli] };
}

/** Shared validation helper: integer/number fields with ranges, plus comma lists. */
export function parseNumberFields<O>(b: any, limits: Record<string, readonly [number, number]>, decimals: string[] = ['intervalHours']): { options: Partial<O> } | { error: string } {
  const out: any = {};
  for (const key of Object.keys(limits)) {
    if (b?.[key] === undefined || b[key] === null || b[key] === '') continue;
    const n = Number(b[key]);
    const [min, max] = limits[key];
    const isDecimal = decimals.includes(key);
    if (!Number.isFinite(n) || n < min || n > max || (!isDecimal && !Number.isInteger(n))) {
      return { error: `${key} must be ${isDecimal ? 'a number' : 'an integer'} ${min}–${max}` };
    }
    out[key] = n;
  }
  return { options: out };
}

export const listOf = (v: unknown): string[] =>
  (Array.isArray(v) ? v : typeof v === 'string' ? v.split(',') : []).map(s => String(s).trim()).filter(Boolean);

export function createAutoLoopController<O extends { intervalHours?: number }>(config: AutoLoopConfig<O>, deps: AutoLoopDeps = {}) {
  const spawn = deps.spawn ?? (nodeSpawn as unknown as SpawnFn);
  const outputDir = deps.outputDir ?? path.join(process.cwd(), 'output');
  const stateFile = path.join(outputDir, `${config.name}.auto.json`);
  const env = deps.env ?? process.env;
  const log = deps.log ?? ((l: string) => console.log(l));
  const now = deps.now ?? (() => new Date());
  const setTimer = deps.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((t: unknown) => clearTimeout(t as NodeJS.Timeout));
  const tag = `[${config.name}-auto]`;
  const interval = (o?: O) => intervalHoursOf(o, env, config.intervalEnv, config.defaultIntervalHours ?? 6);

  let state: PersistedState<O> | null = null;
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
  const load = (): PersistedState<O> | null => {
    try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { return null; }
  };
  const clearStopFiles = () => { for (const f of config.stopFiles) { try { fs.unlinkSync(f); } catch { /* none */ } } };

  // After a failed pass (e.g. Scrape.do credits used up, database down) wait at least this long, so an interval of 0
  // never turns into a tight restart loop. AUTO_LOOP_FAILURE_BACKOFF_MINUTES, default 15.
  const failureBackoffMs = () => {
    const n = Number(env.AUTO_LOOP_FAILURE_BACKOFF_MINUTES);
    return (env.AUTO_LOOP_FAILURE_BACKOFF_MINUTES?.trim() && Number.isFinite(n) && n >= 0 ? n : 15) * 60 * 1000;
  };

  function scheduleNext(failed = false): void {
    if (!state?.enabled || shuttingDown) return;
    const hours = interval(state.options);
    const ms = Math.max(Math.round(hours * 3600 * 1000), failed ? failureBackoffMs() : 0);
    nextPassAt = new Date(now().getTime() + ms).toISOString();
    log(failed && ms > hours * 3600 * 1000
      ? `${tag} the pass failed — next try at ${nextPassAt} (back-off ${Math.round(ms / 60000)} min)`
      : `${tag} next pass at ${nextPassAt} (every ${hours} h after the previous pass ends)`);
    timer = setTimer(() => { timer = null; nextPassAt = undefined; runPass(); }, ms);
  }

  function runPass(): void {
    if (!state?.enabled || child || shuttingDown) return;
    const { cmd, args } = config.command();
    const flags = config.argsFor(state.options);
    clearStopFiles();
    passes++;
    currentPass = { startedAt: now().toISOString() };
    log(`${tag} pass ${passes} starting${flags.length ? ` (${flags.join(' ')})` : ''}`);
    let proc: ChildProcess;
    try {
      proc = spawn(cmd, [...args, ...flags], { cwd: process.cwd(), env: { ...env, ...(config.childEnv ?? {}) }, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e: any) {
      log(`${tag} could not start a pass: ${e?.message ?? e}`);
      lastPass = { startedAt: currentPass.startedAt, finishedAt: now().toISOString(), exitCode: null, outcome: `failed to start: ${e?.message ?? e}` };
      currentPass = undefined;
      scheduleNext(true);
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
      const outcome = error ? `error: ${error}` : code === null ? 'killed' : config.exitOutcome?.[code] ?? (code === 0 ? 'finished' : `exit ${code}`);
      lastPass = { startedAt: currentPass?.startedAt ?? now().toISOString(), finishedAt: now().toISOString(), exitCode: code, outcome };
      log(`${tag} pass ${passes} ended: ${outcome}`);
      child = null;
      currentPass = undefined;
      // 0 = finished, 3/130 = stopped on request; anything else (or a crash) counts as failed
      scheduleNext(!!error || code === null || ![0, 3, 130].includes(code));
    };
    proc.on('exit', code => finish(code));
    proc.on('error', err => finish(null, err.message));
  }

  function externalRun(): { pid: number; startedAt: string } | null {
    if (child) return null;
    for (const f of config.lockFiles) {
      const lock = readLock(f);
      if (!lock) continue;
      try { process.kill(lock.pid, 0); return { pid: lock.pid, startedAt: lock.startedAt }; } catch { /* stale */ }
    }
    return null;
  }

  const api = {
    start(body: any): { started: boolean; reason?: string; status: AutoLoopStatus<O> } {
      if (state?.enabled) return { started: false, reason: 'Already running in 24/7 mode — call stop first to change options', status: api.status() };
      if (child) return { started: false, reason: 'The previous pass is still finishing after a stop — try again in a minute', status: api.status() };
      const parsed = config.parseOptions(body);
      if ('error' in parsed) return { started: false, reason: parsed.error, status: api.status() };
      const ext = externalRun();
      if (ext) return { started: false, reason: `A run started outside the API is in progress (PID ${ext.pid}, since ${ext.startedAt}) — stop it first`, status: api.status() };
      state = { enabled: true, startedAt: now().toISOString(), options: parsed.options };
      save();
      passes = 0;
      runPass();
      return { started: true, status: api.status() };
    },

    stop(): { stopped: boolean; reason?: string; status: AutoLoopStatus<O> } {
      if (!state?.enabled && !child) return { stopped: false, reason: '24/7 scraping is not running', status: api.status() };
      if (state) { state.enabled = false; save(); }
      if (timer) { clearTimer(timer); timer = null; nextPassAt = undefined; }
      if (child) {
        for (const f of config.stopFiles) {
          fs.mkdirSync(path.dirname(f), { recursive: true });
          fs.writeFileSync(f, JSON.stringify({ requestedAt: now().toISOString(), by: 'api' }));
        }
        log(`${tag} stop requested — the current pass finishes the work in flight and exits; no further passes`);
      } else {
        log(`${tag} stopped — no further passes`);
      }
      return { stopped: true, status: api.status() };
    },

    status(): AutoLoopStatus<O> {
      const enabled = !!state?.enabled;
      return {
        pipeline: config.name,
        enabled,
        phase: child ? (enabled ? 'running' : 'stopping') : enabled ? 'waiting' : 'idle',
        startedAt: state?.startedAt,
        options: state?.options,
        intervalHours: interval(state?.options),
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
      log(`${tag} resuming 24/7 mode (on since ${saved.startedAt})`);
      runPass();
      return true;
    },

    /** Service shutdown (deploy/restart): end the pass quickly but keep 24/7 mode on, so it resumes at boot. */
    shutdown(waitMs = 5000): Promise<void> {
      shuttingDown = true;
      if (timer) { clearTimer(timer); timer = null; }
      const proc = child;
      if (!proc) return Promise.resolve();
      // First signal asks the pass to stop; the second makes it exit at once (it saves progress as it goes).
      return new Promise<void>(resolve => {
        const t = setTimeout(resolve, waitMs);
        proc.once('exit', () => { clearTimeout(t); resolve(); });
        try { proc.kill('SIGTERM'); } catch { /* gone */ }
        setTimeout(() => { try { proc.kill('SIGTERM'); } catch { /* gone */ } }, Math.min(500, waitMs / 2)).unref?.();
      });
    },
  };
  return api;
}

export type AutoLoopController<O extends { intervalHours?: number } = any> = ReturnType<typeof createAutoLoopController<O>>;
