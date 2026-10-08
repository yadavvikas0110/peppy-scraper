import type { ScrapeDoRequestOptions } from '../../shared/scrapedo/scrapedo.types';
import type { SourceIdentity, StableSourceIdentity } from '../dining.source-key';
import type { DiningLocale, DiningPlatform } from '../dining.types';

// Platform-agnostic contract every dining platform (Deliveroo, Talabat, Careem, …) implements.
// The generic Scrape.do client and the Dining domain never import platform code.

export interface PlatformParseContext {
  locale: DiningLocale;
  // The page URL that produced the HTML (the platform URL, never a Scrape.do URL).
  sourceUrl: string;
}

export type PlatformParseScope = 'page' | 'restaurant' | 'category' | 'item';

// Warning codes meaning "this record was dropped" (parsers and mappers use these consistently).
export const PLATFORM_REJECTION_CODES: ReadonlySet<string> = new Set([
  'INVALID_ITEM', 'MISSING_NAME', 'INVALID_PRICE', 'PARSE_ERROR',
  'UNRESOLVED_IDENTITY', 'INVALID_ITEM_IDENTITY', 'DUPLICATE_SOURCE_KEY',
]);

// One bad record produces a warning; it never aborts the whole parse.
export interface PlatformParseWarning {
  scope: PlatformParseScope;
  code: string;
  field?: string;
  itemIndex?: number;
  categoryIndex?: number;
  message: string;
}

// Locale-neutral identity inputs for the source-key helpers (dining.source-key.ts).
export interface PlatformIdentityInputs {
  restaurant: StableSourceIdentity | null;
  categories: Array<{ categoryIndex: number; identity: SourceIdentity }>;
  items: Array<{ itemIndex: number; identity: SourceIdentity; categoryIndex?: number }>;
  // Items with no id, no unique anchor and no category position: they cannot be keyed and must be skipped.
  unresolvedItemIndexes: number[];
}

export interface DiningPlatformAdapter<TParseResult> {
  readonly platform: DiningPlatform;
  matchesUrl(url: string): boolean;
  detectLocale(url: string, fallback?: DiningLocale): DiningLocale;
  toLocaleUrl(url: string, locale: DiningLocale): string;
  getFetchOptions(url: string, locale: DiningLocale): ScrapeDoRequestOptions;
  parse(html: string, context: PlatformParseContext): TParseResult;
  getIdentityInputs(result: TParseResult): PlatformIdentityInputs;
}
