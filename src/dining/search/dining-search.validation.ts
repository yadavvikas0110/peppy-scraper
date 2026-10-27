import { ObjectId } from 'mongodb';
import { keywordTokens, normalizeItemText } from '../canonical-items/canonical-item.text';
import { DINING_LOCALES, DINING_PLATFORMS, DiningLocale, DiningPlatform } from '../dining.types';
import { isPlainRecord } from '../dining.object';
import { DINING_SEARCH_LIMITS, DiningSearchFieldError, DiningSearchRequest } from './dining-search.types';

/*
 * Only these scalar fields are accepted; every value is type-checked and converted here, so no
 * client-supplied object ever reaches a MongoDB filter.
 */

export type DiningSearchValidation =
  | { ok: true; value: DiningSearchRequest }
  | { ok: false; code: DiningSearchFieldError['code']; errors: DiningSearchFieldError[] };

const ALLOWED_FIELDS = new Set(['query', 'locale', 'restaurantGroupId', 'platforms', 'limit']);
const OBJECT_ID_RE = /^[0-9a-f]{24}$/i;

export interface NormalizedSearchQuery {
  normalized: string;
  tokens: string[];
}

// Same normalization/tokenization as the stored canonical signals and search keywords.
export function normalizeSearchQuery(query: string): NormalizedSearchQuery {
  const normalized = normalizeItemText(query) ?? '';
  const tokens = [...new Set(keywordTokens(query))].slice(0, DINING_SEARCH_LIMITS.maxQueryTokens);
  return { normalized, tokens };
}

export function validateDiningSearchRequest(input: unknown): DiningSearchValidation {
  if (!isPlainRecord(input)) {
    return { ok: false, code: 'INVALID_REQUEST', errors: [{ field: 'body', code: 'INVALID_REQUEST', message: 'must be an object' }] };
  }
  const errors: DiningSearchFieldError[] = [];
  const invalid = (field: string, message: string) => errors.push({ field, code: 'INVALID_REQUEST', message });
  for (const key of Object.keys(input)) if (!ALLOWED_FIELDS.has(key)) invalid(key, 'is not an allowed field');

  const { query, locale, restaurantGroupId, platforms, limit } = input;

  let cleanQuery = '';
  if (typeof query !== 'string' || query.trim() === '') invalid('query', 'is required');
  else if (query.length > DINING_SEARCH_LIMITS.maxQueryLength) invalid('query', `must be at most ${DINING_SEARCH_LIMITS.maxQueryLength} characters`);
  else if (!normalizeSearchQuery(query).normalized) invalid('query', 'must contain letters or digits');
  else cleanQuery = query.trim();

  let cleanLocale: DiningLocale = 'en';
  if (locale !== undefined) {
    if (typeof locale !== 'string' || !(DINING_LOCALES as readonly string[]).includes(locale)) {
      errors.push({ field: 'locale', code: 'UNSUPPORTED_LOCALE', message: `must be one of: ${DINING_LOCALES.join(', ')}` });
    } else cleanLocale = locale as DiningLocale;
  }

  let groupId: ObjectId | undefined;
  if (restaurantGroupId !== undefined) {
    if (typeof restaurantGroupId !== 'string' || !OBJECT_ID_RE.test(restaurantGroupId)) invalid('restaurantGroupId', 'must be a 24-character hex ObjectId');
    else groupId = new ObjectId(restaurantGroupId);
  }

  let cleanPlatforms: DiningPlatform[] | undefined;
  if (platforms !== undefined) {
    if (!Array.isArray(platforms) || platforms.length === 0 || platforms.some(p => typeof p !== 'string')) {
      invalid('platforms', 'must be a non-empty list of platform names');
    } else {
      const unknown = platforms.filter(p => !(DINING_PLATFORMS as readonly string[]).includes(p));
      if (unknown.length) errors.push({ field: 'platforms', code: 'UNSUPPORTED_PLATFORM', message: `must be among: ${DINING_PLATFORMS.join(', ')}` });
      else cleanPlatforms = DINING_PLATFORMS.filter(p => platforms.includes(p));
    }
  }

  let cleanLimit: number = DINING_SEARCH_LIMITS.defaultLimit;
  if (limit !== undefined) {
    if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > DINING_SEARCH_LIMITS.maxLimit) {
      invalid('limit', `must be an integer between 1 and ${DINING_SEARCH_LIMITS.maxLimit}`);
    } else cleanLimit = limit;
  }

  if (errors.length) {
    const code = errors.some(e => e.code === 'UNSUPPORTED_PLATFORM')
      ? 'UNSUPPORTED_PLATFORM'
      : errors.some(e => e.code === 'UNSUPPORTED_LOCALE') ? 'UNSUPPORTED_LOCALE' : 'INVALID_REQUEST';
    return { ok: false, code, errors };
  }
  return {
    ok: true,
    value: {
      query: cleanQuery,
      locale: cleanLocale,
      ...(groupId ? { restaurantGroupId: groupId } : {}),
      ...(cleanPlatforms ? { platforms: cleanPlatforms } : {}),
      limit: cleanLimit,
    },
  };
}

/*
 * GET query string → request object. Accepts `q` (or `query`), `locale`, `restaurantGroupId`,
 * `platforms` (comma-separated and/or repeated) and `limit`. Repeated scalar parameters are rejected.
 */
export function searchInputFromQueryString(qs: Record<string, unknown>): { input?: Record<string, unknown>; errors: DiningSearchFieldError[] } {
  const errors: DiningSearchFieldError[] = [];
  const invalid = (field: string, message: string) => errors.push({ field, code: 'INVALID_REQUEST', message });
  const allowed = new Set(['q', 'query', 'locale', 'restaurantGroupId', 'platforms', 'limit']);
  for (const key of Object.keys(qs)) if (!allowed.has(key)) invalid(key, 'is not an allowed parameter');

  const scalar = (field: string): string | undefined => {
    const v = qs[field];
    if (v === undefined) return undefined;
    if (typeof v !== 'string') {
      invalid(field, 'must be given once');
      return undefined;
    }
    return v;
  };

  const input: Record<string, unknown> = {};
  if (qs.q !== undefined && qs.query !== undefined) invalid('q', 'use either q or query, not both');
  const query = scalar('q') ?? scalar('query');
  if (query !== undefined) input.query = query;
  const locale = scalar('locale');
  if (locale !== undefined) input.locale = locale;
  const group = scalar('restaurantGroupId');
  if (group !== undefined) input.restaurantGroupId = group;

  if (qs.platforms !== undefined) {
    const raw = Array.isArray(qs.platforms) ? qs.platforms : [qs.platforms];
    if (raw.some(p => typeof p !== 'string')) invalid('platforms', 'must be platform names');
    else input.platforms = (raw as string[]).flatMap(p => p.split(',')).map(p => p.trim()).filter(Boolean);
  }

  const limit = scalar('limit');
  if (limit !== undefined) {
    if (!/^\d{1,4}$/.test(limit)) invalid('limit', `must be an integer between 1 and ${DINING_SEARCH_LIMITS.maxLimit}`);
    else input.limit = Number(limit);
  }
  return errors.length ? { errors } : { input, errors };
}
