import type { ObjectId } from 'mongodb';
import { keywordTokens, normalizeItemText } from '../canonical-items/canonical-item.text';
import type { DiningLocale, LocalizedText } from '../dining.types';
import { DINING_SEARCH_LIMITS, SEARCH_MATCH_TYPES, SearchMatch } from './dining-search.types';
import type { NormalizedSearchQuery } from './dining-search.validation';

/*
 * Deterministic ranking over fields already stored by Phase 8 (no fuzzy/typo tolerance, no models):
 *
 *   1. EXACT_NAME   normalized query == normalized canonicalName.en or .ar
 *   2. EXACT_ALIAS  normalized query == a normalized alias
 *   3. KEYWORD      every query token is one of the item's searchKeywords
 *   4. PARTIAL      some query tokens are keywords, or start a keyword (tokens ≥ minPrefixLength chars)
 *
 * Ties inside a tier: more query tokens found in the item's own name/aliases (not just its
 * description/category) → more exact tokens → more prefix-only tokens → shorter display name →
 * display name → canonical item id. Same input always yields the same order.
 */

export interface RankableCanonicalItem {
  _id: ObjectId;
  canonicalName: LocalizedText;
  aliases?: string[];
  searchKeywords?: string[];
}

export interface RankedCandidate<T extends RankableCanonicalItem> {
  item: T;
  match: SearchMatch;
}

function displayKey(name: LocalizedText, locale: DiningLocale): string {
  return normalizeItemText(name[locale] ?? name[locale === 'en' ? 'ar' : 'en']) ?? '';
}

export function scoreSearchMatch(item: RankableCanonicalItem, query: NormalizedSearchQuery): SearchMatch | undefined {
  const names = [item.canonicalName.en, item.canonicalName.ar].map(normalizeItemText).filter((n): n is string => !!n);
  const aliases = (item.aliases ?? []).map(normalizeItemText).filter((n): n is string => !!n);
  const keywords = new Set(item.searchKeywords ?? []);
  const nameTokens = new Set([item.canonicalName.en, item.canonicalName.ar, ...(item.aliases ?? [])].flatMap(keywordTokens));

  const matchedTokens = query.tokens.filter(t => keywords.has(t));
  const prefixTokens = query.tokens.filter(
    t => !keywords.has(t) && t.length >= DINING_SEARCH_LIMITS.minPrefixLength && !/^\d/.test(t) && [...keywords].some(k => k.startsWith(t))
  );
  const nameCoverage = query.tokens.length ? query.tokens.filter(t => nameTokens.has(t)).length / query.tokens.length : 0;

  let type: SearchMatch['type'] | undefined;
  if (query.normalized && names.includes(query.normalized)) type = 'EXACT_NAME';
  else if (query.normalized && aliases.includes(query.normalized)) type = 'EXACT_ALIAS';
  else if (query.tokens.length && matchedTokens.length === query.tokens.length) type = 'KEYWORD';
  else if (matchedTokens.length + prefixTokens.length > 0) type = 'PARTIAL';
  if (!type) return undefined;
  return { type, matchedTokens, prefixTokens, nameCoverage };
}

export function rankCandidates<T extends RankableCanonicalItem>(items: T[], query: NormalizedSearchQuery, locale: DiningLocale): RankedCandidate<T>[] {
  const seen = new Set<string>();
  const ranked: Array<RankedCandidate<T> & { key: string; id: string }> = [];
  for (const item of items) {
    const id = item._id.toHexString();
    if (seen.has(id)) continue;
    seen.add(id);
    const match = scoreSearchMatch(item, query);
    if (match) ranked.push({ item, match, key: displayKey(item.canonicalName, locale), id });
  }
  const tier = (m: SearchMatch) => SEARCH_MATCH_TYPES.indexOf(m.type);
  ranked.sort(
    (a, b) =>
      tier(a.match) - tier(b.match) ||
      b.match.nameCoverage - a.match.nameCoverage ||
      b.match.matchedTokens.length - a.match.matchedTokens.length ||
      b.match.prefixTokens.length - a.match.prefixTokens.length ||
      a.key.length - b.key.length ||
      (a.key < b.key ? -1 : a.key > b.key ? 1 : 0) ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
  return ranked.map(({ item, match }) => ({ item, match }));
}
