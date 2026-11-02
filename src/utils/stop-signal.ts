import * as fs from 'fs';
import * as path from 'path';

export const LOCK_FILE = path.join(process.cwd(), 'output', 'cron.lock');
export const STOP_FILE = path.join(process.cwd(), 'output', 'stop.signal');

export function shouldStop(): boolean {
  return fs.existsSync(STOP_FILE);
}

export function clearStopSignal(): void {
  try { fs.unlinkSync(STOP_FILE); } catch {}
}

export type LockMode = 'full' | 'demo' | 'grocery';

export function acquireLock(mode: LockMode = 'full'): boolean {
  try {
    fs.mkdirSync(path.dirname(LOCK_FILE), { recursive: true });
    if (fs.existsSync(LOCK_FILE)) {
      const lock = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8'));
      try {
        process.kill(lock.pid, 0);
        console.warn(`[cron] Pipeline already running (PID ${lock.pid}, started ${lock.startedAt}). Skipping.`);
        return false;
      } catch {
        console.warn('[cron] Stale lock found — previous run exited without cleanup. Proceeding.');
      }
    }
    fs.writeFileSync(LOCK_FILE, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), mode }));
    return true;
  } catch (e: any) {
    console.error(`[cron] Failed to acquire lock: ${e.message}`);
    return false;
  }
}

export function releaseLock(): void {
  try { fs.unlinkSync(LOCK_FILE); } catch {}
}

export function readLock(): { pid: number; startedAt: string; mode?: LockMode } | null {
  if (!fs.existsSync(LOCK_FILE)) return null;
  try { return JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8')); } catch { return null; }
}
