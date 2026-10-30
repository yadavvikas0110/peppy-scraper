import * as fs from 'fs';
import * as path from 'path';
import { JobSummary } from './worker.store';

/**
 * Worker logging: a readable line in the terminal and one JSON object per line in
 * output/logs/shopping-worker-YYYY-MM-DD.jsonl (for grep/jq and log shippers).
 */
export interface WorkerLogger {
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
  summary(title: string, summary: JobSummary, extra?: Record<string, unknown>): void;
}

const SUMMARY_ORDER: Array<keyof JobSummary> = ['discovered', 'scraped', 'inserted', 'updated', 'matched', 'reviewRequired', 'failed', 'skipped', 'requests', 'mapped', 'staleMarked'];

export function formatSummary(summary: JobSummary): string {
  return SUMMARY_ORDER.map(k => `${k}=${summary[k]}`).join('  ');
}

function fmtFields(fields: Record<string, unknown>): string {
  return Object.entries(fields)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`)
    .join(' ');
}

export function createWorkerLogger(opts: { dir?: string; echo?: boolean } = {}): WorkerLogger {
  const echo = opts.echo ?? true;
  const write = (level: 'info' | 'warn' | 'error', event: string, fields: Record<string, unknown> = {}) => {
    const at = new Date();
    if (opts.dir) {
      try {
        fs.mkdirSync(opts.dir, { recursive: true });
        fs.appendFileSync(path.join(opts.dir, `shopping-worker-${at.toISOString().slice(0, 10)}.jsonl`), JSON.stringify({ at, level, event, ...fields }) + '\n');
      } catch {
        // Logging must never stop a scrape
      }
    }
    if (!echo) return;
    const line = `${at.toISOString()} [shopping-worker] ${level === 'info' ? '' : level.toUpperCase() + ' '}${event}${Object.keys(fields).length ? '  ' + fmtFields(fields) : ''}`;
    (level === 'error' ? console.error : level === 'warn' ? console.warn : console.log)(line);
  };
  return {
    info: (e, f) => write('info', e, f),
    warn: (e, f) => write('warn', e, f),
    error: (e, f) => write('error', e, f),
    summary(title, summary, extra = {}) {
      write('info', 'job.summary', { title, ...summary, ...extra });
      if (echo) {
        console.log(`┌─ ${title}`);
        console.log(`│  ${formatSummary(summary)}`);
        for (const [k, v] of Object.entries(extra)) if (v !== undefined && v !== '') console.log(`│  ${k}: ${Array.isArray(v) ? v.join('; ') || '—' : v}`);
        console.log('└─');
      }
    },
  };
}
