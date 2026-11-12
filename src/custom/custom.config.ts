import * as fs from 'fs';
import * as path from 'path';
import { getBroadCategoryBaseTags } from '../config/taxonomy';
import type { HttpOptions } from './core/http';
import { CategoryTarget, CUSTOM_SITES, CustomSite } from './core/types';

export interface CustomScraperConfig {
  http: HttpOptions;
  browserWaitMs: number;
  sites: Record<CustomSite, CategoryTarget[]>;
}

// src/custom → ../../config ; dist/src/custom → ../../../config
export const DEFAULT_CONFIG_FILE = [
  path.join(__dirname, '..', '..', 'config', 'custom-scraper.json'),
  path.join(__dirname, '..', '..', '..', 'config', 'custom-scraper.json'),
].find(p => fs.existsSync(p)) ?? path.join(process.cwd(), 'config', 'custom-scraper.json');

function int(value: unknown, name: string, min: number, max: number): number {
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) {
    throw new Error(`custom-scraper config: ${name} must be an integer ${min}–${max}`);
  }
  return value as number;
}

/** Validates the raw JSON. Throws with the offending entry named. */
export function parseCustomConfig(raw: any): CustomScraperConfig {
  const s = raw?.settings ?? {};
  if (typeof s.userAgent !== 'string' || !s.userAgent.trim()) throw new Error('custom-scraper config: settings.userAgent is required');
  const http: HttpOptions = {
    userAgent: s.userAgent,
    minIntervalMs: int(s.minIntervalMs ?? 2000, 'settings.minIntervalMs', 500, 60000),
    timeoutMs: int(s.timeoutMs ?? 30000, 'settings.timeoutMs', 5000, 120000),
    maxRetries: int(s.maxRetries ?? 2, 'settings.maxRetries', 0, 5),
    respectRobots: s.respectRobots !== false,
  };

  const sites = {} as Record<CustomSite, CategoryTarget[]>;
  for (const site of CUSTOM_SITES) {
    const list: any[] = raw?.sites?.[site] ?? [];
    const seen = new Set<string>();
    sites[site] = list.filter(t => t.enabled !== false).map(t => {
      for (const f of ['key', 'label', 'broadCategory', 'subCategory', 'source'] as const) {
        if (typeof t[f] !== 'string' || !t[f].trim()) throw new Error(`custom-scraper config: ${site} entry ${JSON.stringify(t.key)} is missing "${f}"`);
      }
      if (seen.has(t.key)) throw new Error(`custom-scraper config: duplicate key "${site}/${t.key}"`);
      seen.add(t.key);
      if (getBroadCategoryBaseTags(t.broadCategory, t.subCategory).length === 0) {
        throw new Error(`custom-scraper config: ${site}/${t.key} uses unknown taxonomy "${t.broadCategory} > ${t.subCategory}"`);
      }
      return { key: t.key, label: t.label, broadCategory: t.broadCategory, subCategory: t.subCategory, source: t.source, limit: int(t.limit, `${site}/${t.key}.limit`, 1, 200) };
    });
  }
  for (const site of Object.keys(raw?.sites ?? {})) {
    if (!(CUSTOM_SITES as readonly string[]).includes(site)) throw new Error(`custom-scraper config: unsupported site "${site}" (supported: ${CUSTOM_SITES.join(', ')})`);
  }
  return { http, browserWaitMs: int(s.browserWaitMs ?? 8000, 'settings.browserWaitMs', 1000, 60000), sites };
}

export function loadCustomConfig(file = DEFAULT_CONFIG_FILE): CustomScraperConfig {
  return parseCustomConfig(JSON.parse(fs.readFileSync(file, 'utf8')));
}
