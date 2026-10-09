import { createScrapeDoClient, ScrapeDoClient } from '../../../shared/scrapedo/scrapedo.client';
import type { ScrapeDoRequestOptions } from '../../../shared/scrapedo/scrapedo.types';
import type { StableSourceIdentity } from '../../dining.source-key';
import type { DiningLocale } from '../../dining.types';
import type { DiningPlatformAdapter, PlatformIdentityInputs, PlatformParseContext } from '../platform.types';
import { parseTalabatMenu } from './talabat.parser';
import type { TalabatParseResult } from './talabat.types';

export const TALABAT_HOSTS = ['talabat.com'] as const;

// Scrape.do options for a Talabat menu page. The menu is server-rendered into __NEXT_DATA__, so a
// plain datacenter request (no render, no `super`) is enough: both captures succeeded at 1 credit.
export const TALABAT_FETCH_DEFAULTS: ScrapeDoRequestOptions = {};

function parseUrl(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

// English pages have no locale segment (/uae/…); Arabic pages are prefixed (/ar/uae/…).
function localeSegmentIndex(segments: string[]): number {
  return segments[0] === 'en' || segments[0] === 'ar' ? 0 : -1;
}

// https://www.talabat.com/[ar/]<country>/restaurant/<branchId>/<branchSlug>
export function isTalabatMenuUrl(url: string): boolean {
  const parsed = parseUrl(url);
  if (!parsed || parsed.protocol !== 'https:') return false;
  const host = parsed.hostname.toLowerCase();
  if (!TALABAT_HOSTS.some(h => host === h || host === `www.${h}`)) return false;
  const segments = parsed.pathname.split('/').filter(Boolean);
  const offset = localeSegmentIndex(segments) + 1;
  return (
    segments.length === offset + 4 &&
    /^[a-z][a-z-]*$/.test(segments[offset]) &&
    segments[offset + 1] === 'restaurant' &&
    /^[1-9]\d*$/.test(segments[offset + 2]) &&
    segments[offset + 3] !== ''
  );
}

export function detectTalabatLocale(url: string, _fallback: DiningLocale = 'en'): DiningLocale {
  const parsed = parseUrl(url);
  const first = parsed?.pathname.split('/').filter(Boolean)[0];
  // No prefix is Talabat's English site, so the fallback never applies to a valid menu URL.
  return first === 'ar' ? 'ar' : 'en';
}

export function toTalabatLocaleUrl(url: string, locale: DiningLocale): string {
  const parsed = parseUrl(url);
  if (!parsed) throw new Error('Invalid Talabat URL');
  const segments = parsed.pathname.split('/').filter(Boolean);
  if (localeSegmentIndex(segments) === 0) segments.shift();
  if (locale === 'ar') segments.unshift('ar');
  parsed.pathname = `/${segments.join('/')}`;
  return parsed.toString();
}

export function getTalabatFetchOptions(_url: string, _locale: DiningLocale): ScrapeDoRequestOptions {
  return { ...TALABAT_FETCH_DEFAULTS };
}

// ─── Identity ────────────────────────────────────────────────────────────────
// Restaurant: Talabat branch ID → branch URL slug anchor. The chain-level restaurantId (shared by
//             every branch of the brand) is never used: two branches must stay two restaurants.
// Category:   Talabat section ID → position. Synthetic sections ("Picks for you", id -1) are skipped.
// Item:       Talabat item ID → position within its category. Names, prices and images are never
//             used. The same 333 item IDs appear on the EN and AR pages of the captured branch.

export function getTalabatIdentityInputs(result: TalabatParseResult): PlatformIdentityInputs {
  const r = result.restaurant;
  const restaurant: StableSourceIdentity | null = r?.platformRestaurantId
    ? { kind: 'id', value: r.platformRestaurantId }
    : r?.slug
      ? { kind: 'anchor', value: r.slug }
      : null;

  const categories = result.categories.map((c, categoryIndex) => ({
    categoryIndex,
    identity: c.platformCategoryId
      ? { kind: 'id' as const, value: c.platformCategoryId }
      : { kind: 'position' as const, value: c.sortOrder },
  }));

  const items: PlatformIdentityInputs['items'] = [];
  const unresolvedItemIndexes: number[] = [];
  result.items.forEach((item, itemIndex) => {
    if (item.platformItemId) {
      items.push({ itemIndex, identity: { kind: 'id', value: item.platformItemId }, categoryIndex: item.categoryIndex });
    } else if (item.categoryIndex !== undefined && item.positionInCategory !== undefined) {
      items.push({ itemIndex, identity: { kind: 'position', value: item.positionInCategory }, categoryIndex: item.categoryIndex });
    } else {
      unresolvedItemIndexes.push(itemIndex);
    }
  });

  return { restaurant, categories, items, unresolvedItemIndexes };
}

export const talabatAdapter: DiningPlatformAdapter<TalabatParseResult> = {
  platform: 'talabat',
  matchesUrl: isTalabatMenuUrl,
  detectLocale: detectTalabatLocale,
  toLocaleUrl: toTalabatLocaleUrl,
  getFetchOptions: getTalabatFetchOptions,
  parse: (html: string, context: PlatformParseContext) => parseTalabatMenu(html, context),
  getIdentityInputs: getTalabatIdentityInputs,
};

// ─── Fetch (one Scrape.do request per call; parse only, never persists) ─────

export interface TalabatFetchCost {
  requestCost?: number;
  remainingCredits?: number;
  attempts: number;
  durationMs: number;
}

export interface TalabatFetchResult {
  locale: DiningLocale;
  url: string;
  statusCode: number;
  finalUrl: string;
  cost: TalabatFetchCost;
  result: TalabatParseResult;
}

export interface TalabatFetchDeps {
  client?: ScrapeDoClient;
  logger?: Pick<Console, 'log'>;
}

let defaultClient: ScrapeDoClient | null = null;

export async function fetchTalabatMenu(
  url: string,
  locale: DiningLocale,
  deps: TalabatFetchDeps = {}
): Promise<TalabatFetchResult> {
  if (!isTalabatMenuUrl(url)) throw new Error('Not a Talabat menu URL');
  const client = deps.client ?? (defaultClient ??= createScrapeDoClient());
  const logger = deps.logger ?? console;
  const localeUrl = toTalabatLocaleUrl(url, locale);

  const response = await client.fetchHtml(localeUrl, getTalabatFetchOptions(localeUrl, locale));
  const cost: TalabatFetchCost = {
    requestCost: response.requestCost,
    remainingCredits: response.remainingCredits,
    attempts: response.attempts,
    durationMs: response.durationMs,
  };
  logger.log(
    `[dining] talabat ${locale} status=${response.statusCode} cost=${cost.requestCost ?? 'n/a'} ` +
      `remaining=${cost.remainingCredits ?? 'n/a'} attempts=${cost.attempts} ${cost.durationMs}ms`
  );

  const result = parseTalabatMenu(response.html, { locale, sourceUrl: localeUrl });
  return { locale, url: localeUrl, statusCode: response.statusCode, finalUrl: response.finalUrl, cost, result };
}
