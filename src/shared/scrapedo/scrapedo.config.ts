import { ScrapeDoError } from './scrapedo.errors';

export interface ScrapeDoConfig {
  token: string;
  baseUrl: string;
  timeoutMs: number;
  concurrency: number;
  maxRetries: number;
}

export const SCRAPE_DO_DEFAULTS = {
  baseUrl: 'https://api.scrape.do/',
  // Client-side HTTP timeout. Must stay above Scrape.do's own `timeout` (default 60000ms)
  // so we don't abandon requests Scrape.do is still working on (and may still bill).
  timeoutMs: 90000,
  concurrency: 2,
  maxRetries: 2,
} as const;

const LIMITS = {
  timeoutMs: { min: 5000, max: 300000 },
  concurrency: { min: 1, max: 100 },
  maxRetries: { min: 0, max: 5 },
};

function readInt(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  { min, max }: { min: number; max: number }
): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new ScrapeDoError({
      category: 'config',
      message: `${name} must be an integer between ${min} and ${max}`,
    });
  }
  return value;
}

function readBaseUrl(env: NodeJS.ProcessEnv): string {
  const raw = env.SCRAPE_DO_BASE_URL?.trim();
  if (!raw) return SCRAPE_DO_DEFAULTS.baseUrl;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new ScrapeDoError({ category: 'config', message: 'SCRAPE_DO_BASE_URL is not a valid URL' });
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new ScrapeDoError({ category: 'config', message: 'SCRAPE_DO_BASE_URL must use http or https' });
  }
  if (parsed.search || parsed.username || parsed.password) {
    throw new ScrapeDoError({
      category: 'config',
      message: 'SCRAPE_DO_BASE_URL must not contain credentials or query parameters',
    });
  }
  return parsed.toString();
}

// Read on every call so nothing is evaluated at import time and a missing token
// only fails when the client is actually used.
export function getScrapeDoConfig(env: NodeJS.ProcessEnv = process.env): ScrapeDoConfig {
  const token = env.SCRAPE_DO_TOKEN?.trim();
  if (!token) {
    throw new ScrapeDoError({ category: 'config', message: 'SCRAPE_DO_TOKEN is not set' });
  }

  return {
    token,
    baseUrl: readBaseUrl(env),
    timeoutMs: readInt(env, 'SCRAPE_DO_TIMEOUT_MS', SCRAPE_DO_DEFAULTS.timeoutMs, LIMITS.timeoutMs),
    concurrency: readInt(env, 'SCRAPE_DO_CONCURRENCY', SCRAPE_DO_DEFAULTS.concurrency, LIMITS.concurrency),
    maxRetries: readInt(env, 'SCRAPE_DO_MAX_RETRIES', SCRAPE_DO_DEFAULTS.maxRetries, LIMITS.maxRetries),
  };
}
