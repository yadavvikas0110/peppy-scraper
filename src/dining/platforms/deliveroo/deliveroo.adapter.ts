import { createScrapeDoClient, ScrapeDoClient } from '../../../shared/scrapedo/scrapedo.client';
import type { ScrapeDoRequestOptions } from '../../../shared/scrapedo/scrapedo.types';
import type { StableSourceIdentity } from '../../dining.source-key';
import type { DiningLocale } from '../../dining.types';
import {
  clickAction,
  computedBackgroundImagesAction,
  executeAction,
  scrollPageActions,
  waitForSelectorAction,
} from '../browser-actions';
import type { DiningPlatformAdapter, PlatformIdentityInputs, PlatformParseContext } from '../platform.types';
import { extractDeliverooMenuOffers } from './deliveroo.offers';
import { parseDeliverooMenu } from './deliveroo.parser';
import { DELIVEROO_SELECTORS } from './deliveroo.selectors';
import type { DeliverooItemDetail, DeliverooParseResult } from './deliveroo.types';

export const DELIVEROO_HOSTS = ['deliveroo.ae'] as const;

// Scrape.do options for a Deliveroo menu page that needs the browser (the fallback, and the browser-action hooks
// below). Datacenter proxy (no `super`); 5 credits per request.
export const DELIVEROO_FETCH_DEFAULTS: ScrapeDoRequestOptions = {
  render: true,
  geoCode: 'ae',
  waitUntil: 'networkidle2',
  customWait: 2000,
  blockResources: false,
  timeout: 90000,
};

// The normal request: a plain HTML fetch (1 credit, about 5 s). The menu is server-rendered into script#__NEXT_DATA__,
// and a plain and a rendered fetch of the same page were compared dish by dish (212 of 212 dishes, no difference in
// price, image, description, item options or offers, English and Arabic), at a fifth of the credits.
export const DELIVEROO_PLAIN_FETCH_OPTIONS: ScrapeDoRequestOptions = {
  render: false,
  geoCode: 'ae',
  timeout: 60000,
};

function parseUrl(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

function localeSegmentIndex(segments: string[]): number {
  return segments[0] === 'en' || segments[0] === 'ar' ? 0 : -1;
}

export function isDeliverooMenuUrl(url: string): boolean {
  const parsed = parseUrl(url);
  if (!parsed || parsed.protocol !== 'https:') return false;
  const host = parsed.hostname.toLowerCase();
  if (!DELIVEROO_HOSTS.some(h => host === h || host === `www.${h}`)) return false;
  const segments = parsed.pathname.split('/').filter(Boolean);
  const offset = localeSegmentIndex(segments) + 1;
  return segments[offset] === 'menu' && segments.length >= offset + 4;
}

export function detectDeliverooLocale(url: string, fallback: DiningLocale = 'en'): DiningLocale {
  const parsed = parseUrl(url);
  const first = parsed?.pathname.split('/').filter(Boolean)[0];
  return first === 'ar' ? 'ar' : first === 'en' ? 'en' : fallback;
}

export function toDeliverooLocaleUrl(url: string, locale: DiningLocale): string {
  const parsed = parseUrl(url);
  if (!parsed) throw new Error('Invalid Deliveroo URL');
  const segments = parsed.pathname.split('/').filter(Boolean);
  if (localeSegmentIndex(segments) === 0) segments[0] = locale;
  else segments.unshift(locale);
  parsed.pathname = `/${segments.join('/')}/`;
  return parsed.toString();
}

export function getDeliverooFetchOptions(_url: string, _locale: DiningLocale): ScrapeDoRequestOptions {
  return { ...DELIVEROO_PLAIN_FETCH_OPTIONS };
}

// Tried once (5 credits) when the plain request fails or returns a page without menu data.
export function getDeliverooFallbackFetchOptions(_url: string, _locale: DiningLocale): ScrapeDoRequestOptions {
  return { ...DELIVEROO_FETCH_DEFAULTS };
}

// The page carries the menu: __NEXT_DATA__ with menu items. A bot-check or error page does not.
export function hasDeliverooMenuData(html: string): boolean {
  const match = /<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/.exec(html);
  if (!match) return false;
  try {
    const data = JSON.parse(match[1]) as { props?: { initialState?: { menuPage?: { menu?: { metas?: { root?: { items?: unknown } } } } } } };
    const items = data.props?.initialState?.menuPage?.menu?.metas?.root?.items;
    return Array.isArray(items) && items.length > 0;
  } catch {
    return false;
  }
}

// ─── Identity ────────────────────────────────────────────────────────────────
// Restaurant: Deliveroo restaurant ID → URL slug (uname) anchor.
// Category:   Deliveroo category ID → position. (The DOM section id "layout-<n>" carries the same
//             category ID as __NEXT_DATA__; verified on the EN and AR fixtures.)
// Item:       Deliveroo item ID → position within its category. Names are never used.
//             Image asset paths are not identities: restaurants reuse one photo for several items
//             (11 shared images in the fixture menu) and lazy loading makes them render-dependent.

export function getDeliverooIdentityInputs(result: DeliverooParseResult): PlatformIdentityInputs {
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

export const deliverooAdapter: DiningPlatformAdapter<DeliverooParseResult> = {
  platform: 'deliveroo',
  matchesUrl: isDeliverooMenuUrl,
  detectLocale: detectDeliverooLocale,
  toLocaleUrl: toDeliverooLocaleUrl,
  getFetchOptions: getDeliverooFetchOptions,
  getFallbackFetchOptions: getDeliverooFallbackFetchOptions,
  isUsablePage: hasDeliverooMenuData,
  parse: (html: string, context: PlatformParseContext) => parseDeliverooMenu(html, context),
  getIdentityInputs: getDeliverooIdentityInputs,
  getAlternateUrls: result => result.restaurant?.alternateUrls ?? {},
  extractOffers: html => extractDeliverooMenuOffers(html),
};

// ─── Fetch (one Scrape.do request per call) ──────────────────────────────────

export interface DeliverooFetchCost {
  requestCost?: number;
  remainingCredits?: number;
  attempts: number;
  durationMs: number;
}

export interface DeliverooFetchResult {
  locale: DiningLocale;
  url: string;
  statusCode: number;
  finalUrl: string;
  cost: DeliverooFetchCost;
  result: DeliverooParseResult;
}

export interface DeliverooFetchDeps {
  client?: ScrapeDoClient;
  logger?: Pick<Console, 'log'>;
}

let defaultClient: ScrapeDoClient | null = null;

export async function fetchDeliverooMenu(
  url: string,
  locale: DiningLocale,
  deps: DeliverooFetchDeps = {}
): Promise<DeliverooFetchResult> {
  if (!isDeliverooMenuUrl(url)) throw new Error('Not a Deliveroo menu URL');
  const client = deps.client ?? (defaultClient ??= createScrapeDoClient());
  const logger = deps.logger ?? console;
  const localeUrl = toDeliverooLocaleUrl(url, locale);

  const response = await client.fetchHtml(localeUrl, getDeliverooFetchOptions(localeUrl, locale));
  const cost: DeliverooFetchCost = {
    requestCost: response.requestCost,
    remainingCredits: response.remainingCredits,
    attempts: response.attempts,
    durationMs: response.durationMs,
  };
  logger.log(
    `[dining] deliveroo ${locale} status=${response.statusCode} cost=${cost.requestCost ?? 'n/a'} ` +
      `remaining=${cost.remainingCredits ?? 'n/a'} attempts=${cost.attempts} ${cost.durationMs}ms`
  );

  const result = parseDeliverooMenu(response.html, { locale, sourceUrl: localeUrl });
  return { locale, url: localeUrl, statusCode: response.statusCode, finalUrl: response.finalUrl, cost, result };
}

// ─── Future hooks (not used by any flow yet) ─────────────────────────────────

function cssString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

// Runtime image capture: scroll so lazy images render, then read computed background images
// of every item image. Only needed if a page ever lacks __NEXT_DATA__ image URLs.
export function buildDeliverooImageCaptureOptions(scrollSteps = 20): ScrapeDoRequestOptions {
  return {
    ...DELIVEROO_FETCH_DEFAULTS,
    returnJSON: true,
    playWithBrowser: [
      ...scrollPageActions(scrollSteps, 1200, 300),
      computedBackgroundImagesAction(DELIVEROO_SELECTORS.itemImage),
    ],
  };
}

// Item-detail modal capture for a single item card (selected by aria-label prefix = item name).
// The modal selector is the generic ARIA dialog role; it has not been verified against a live modal.
// Modifier data is already embedded in __NEXT_DATA__, so this is a fallback, not the primary path.
export const DELIVEROO_ITEM_MODAL_SELECTOR = '[role="dialog"]';

export function buildDeliverooItemDetailOptions(itemName: string): ScrapeDoRequestOptions {
  const card = `${DELIVEROO_SELECTORS.menuItem.replace('[aria-label]', '')}[aria-label^=${cssString(itemName)}]`;
  return {
    ...DELIVEROO_FETCH_DEFAULTS,
    returnJSON: true,
    playWithBrowser: [
      clickAction(card),
      waitForSelectorAction(DELIVEROO_ITEM_MODAL_SELECTOR),
      executeAction(
        `(function(){var d=document.querySelector(${JSON.stringify(DELIVEROO_ITEM_MODAL_SELECTOR)});` +
          `return d?d.innerText:null;})()`
      ),
    ],
  };
}

// Item detail from data already embedded in the page (no extra request).
export function getDeliverooItemDetail(result: DeliverooParseResult, platformItemId: string): DeliverooItemDetail | null {
  const item = result.items.find(i => i.platformItemId === platformItemId);
  if (!item) return null;
  return {
    locale: result.locale,
    platformItemId: item.platformItemId,
    name: item.name,
    description: item.description,
    price: item.price,
    currency: item.currency,
    isAvailable: item.isAvailable,
    modifiers: item.modifiers,
  };
}
