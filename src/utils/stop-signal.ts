import * as fs from 'fs';
import * as path from 'path';

export const LOCK_FILE = path.join(process.cwd(), 'output', 'cron.lock');
export const STOP_FILE = path.join(process.cwd(), 'output', 'stop.signal');

// Per-platform lock/stop files. A platform with its own lock can run CONCURRENTLY with the global
// pipeline (e-commerce `full`/`demo` + the main Talabat grocery crawl, which all share LOCK_FILE),
// while two runs of the SAME platform still exclude each other. Each platform also gets its own stop
// signal so stopping one never clobbers another's (e.g. /api/stop targeting the Talabat crawl must
// not silently clear a stop meant for Deliveroo, or vice-versa).
export const DELIVEROO_LOCK_FILE = path.join(process.cwd(), 'output', 'cron.grocery.deliveroo.lock');
export const DELIVEROO_STOP_FILE = path.join(process.cwd(), 'output', 'stop.grocery.deliveroo.signal');

export function shouldStop(stopFile: string = STOP_FILE): boolean {
  return fs.existsSync(stopFile);
}

export function clearStopSignal(stopFile: string = STOP_FILE): void {
  try { fs.unlinkSync(stopFile); } catch {}
}

export type LockMode = 'full' | 'demo' | 'grocery';

export function acquireLock(mode: LockMode = 'full', lockFile: string = LOCK_FILE): boolean {
  try {
    fs.mkdirSync(path.dirname(lockFile), { recursive: true });
    if (fs.existsSync(lockFile)) {
      const lock = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
      try {
        process.kill(lock.pid, 0);
        console.warn(`[cron] Pipeline already running (PID ${lock.pid}, started ${lock.startedAt}). Skipping.`);
        return false;
      } catch {
        console.warn('[cron] Stale lock found — previous run exited without cleanup. Proceeding.');
      }
    }
    fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), mode }));
    return true;
  } catch (e: any) {
    console.error(`[cron] Failed to acquire lock: ${e.message}`);
    return false;
  }
}

export function releaseLock(lockFile: string = LOCK_FILE): void {
  try { fs.unlinkSync(lockFile); } catch {}
}

export function readLock(lockFile: string = LOCK_FILE): { pid: number; startedAt: string; mode?: LockMode } | null {
  if (!fs.existsSync(lockFile)) return null;
  try { return JSON.parse(fs.readFileSync(lockFile, 'utf8')); } catch { return null; }
}
