import type { NormalizedOffer, PlatformOffers } from '../../offers/offer.types';
import { isPlainRecord } from '../../dining.object';

/*
 * Deliveroo offers, from two pages:
 *
 *   menu page    script#__NEXT_DATA__ → menuPage.menu.metas.root.offer: the restaurant's running offers as
 *                structured rules (typeName, percentageDiscount, minimumOrderValue, maxDiscount, itemIds) and a
 *                free-delivery threshold in offer.progressBar. Exact; fetched anyway by the daily menu scrape.
 *   listing page the restaurant cards (e.g. /restaurants/dubai/<area>?offer=all+offers): one badge text per
 *                restaurant ("30% off selected items"), parsed into the same shape where the wording allows.
 *
 * Nothing is guessed: an offer type that is not recognised is kept as OTHER with the platform's own type name.
 */

function readNextData(html: string): Record<string, unknown> | null {
  const match = /<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/.exec(html);
  if (!match) return null;
  try {
    const parsed: unknown = JSON.parse(match[1]);
    return isPlainRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function at(value: unknown, ...path: string[]): unknown {
  let current = value;
  for (const key of path) {
    if (!isPlainRecord(current)) return undefined;
    current = current[key];
  }
  return current;
}

// { code: 'AED', fractional: 5000 } → { amount: 50, currency: 'AED' }
function money(value: unknown): { amount: number; currency?: string } | undefined {
  if (!isPlainRecord(value) || typeof value.fractional !== 'number' || !Number.isFinite(value.fractional)) return undefined;
  return { amount: Math.round(value.fractional) / 100, currency: typeof value.code === 'string' ? value.code : undefined };
}

function percentage(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 100 ? value : undefined;
}

function firstText(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    for (const v of value) {
      const t = firstText(v);
      if (t) return t;
    }
  } else if (isPlainRecord(value)) {
    if (typeof value.text === 'string' && value.text.trim()) return value.text.trim();
    for (const v of Object.values(value)) {
      const t = firstText(v);
      if (t) return t;
    }
  }
  return undefined;
}

const TYPE_BY_PLATFORM_NAME: Array<{ test: RegExp; type: NormalizedOffer['type'] }> = [
  { test: /^ItemSpecificPercentOff/i, type: 'PERCENT_OFF_ITEMS' },
  { test: /^FullMenuPercentOff/i, type: 'PERCENT_OFF_MENU' },
  { test: /^FreeDelivery/i, type: 'FREE_DELIVERY' },
  { test: /(buyoneget|bogo|multibuy)/i, type: 'BUY_ONE_GET_ONE' },
];

function normalizeOffer(raw: unknown, title?: string): NormalizedOffer | null {
  if (!isPlainRecord(raw) || typeof raw.typeName !== 'string') return null;
  const platformTypeName = raw.typeName;
  const type = TYPE_BY_PLATFORM_NAME.find(t => t.test.test(platformTypeName))?.type ?? 'OTHER';
  const min = money(raw.minimumOrderValue);
  const max = money(raw.maxDiscount);
  const itemIds = Array.isArray(raw.itemIds) ? raw.itemIds.map(String).filter(Boolean) : [];
  return {
    type,
    platformTypeName,
    percentage: percentage(raw.percentageDiscount),
    // A zero minimum means "no minimum".
    minimumOrderValue: min && min.amount > 0 ? min.amount : undefined,
    maxDiscount: max && max.amount > 0 ? max.amount : undefined,
    currency: min?.currency ?? max?.currency,
    platformItemIds: itemIds.length ? itemIds : undefined,
    title,
  };
}

// The restaurant's own page → every offer it runs, de-duplicated by rule.
export function extractDeliverooMenuOffers(html: string): PlatformOffers | null {
  const data = readNextData(html);
  const root = at(data, 'props', 'initialState', 'menuPage', 'menu', 'metas', 'root');
  const restaurantId = at(root, 'restaurant', 'id');
  if (!isPlainRecord(root) || (typeof restaurantId !== 'string' && typeof restaurantId !== 'number')) return null;

  const block = root.offer;
  if (!isPlainRecord(block)) return { platformRestaurantId: String(restaurantId), offers: [] };

  const progressBar = isPlainRecord(block.progressBar) ? block.progressBar : null;
  const progressOffer = progressBar?.offer;
  const progressText = firstText(progressBar?.initial);

  const raws: unknown[] = [block.offer, ...(Array.isArray(block.offers) ? block.offers : []), progressOffer];
  const found: NormalizedOffer[] = [];
  const seen = new Set<string>();
  for (const raw of raws) {
    if (!isPlainRecord(raw)) continue;
    // The progress bar's text describes its own offer (the free-delivery threshold or the unlock rule).
    const title = raw === progressOffer || JSON.stringify(raw) === JSON.stringify(progressOffer) ? progressText : undefined;
    const offer = normalizeOffer(raw, title);
    if (!offer) continue;
    const key = [offer.type, offer.platformTypeName, offer.percentage, offer.minimumOrderValue, offer.maxDiscount].join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    found.push(offer);
  }
  return { platformRestaurantId: String(restaurantId), offers: found };
}

// ─── Listing page ────────────────────────────────────────────────────────────

// Removes the invisible direction marks and non-breaking spaces Deliveroo puts inside its badge text.
function cleanLabel(label: string): string {
  return label.replace(/[‎‏‪-‮]/g, '').replace(/ /g, ' ').replace(/\s+/g, ' ').trim();
}

const AED = '(?:AED|د\\.إ)';

// A badge text → a structured offer where the wording is one of the known shapes, else OTHER.
export function classifyDeliverooOfferLabel(rawLabel: string): NormalizedOffer {
  const label = cleanLabel(rawLabel);
  const money = (s: string) => Number(s.replace(/,/g, ''));
  let m: RegExpExecArray | null;

  // "Spend AED 50, get 30% off" / "Spend AED 50, unlock 30% off up to AED 100"
  if ((m = new RegExp(`^spend ${AED}\\s?([\\d,.]+),? (?:get|unlock) (\\d+)% off(?: up to ${AED}\\s?([\\d,.]+))?`, 'i').exec(label))) {
    return { type: 'PERCENT_OFF_MENU', minimumOrderValue: money(m[1]), percentage: Number(m[2]), maxDiscount: m[3] ? money(m[3]) : undefined, currency: 'AED', title: label };
  }
  // "Spend AED 50, Get free delivery" / "Spend AED 50 to get free delivery"
  if ((m = new RegExp(`^spend ${AED}\\s?([\\d,.]+),? (?:to )?get free delivery`, 'i').exec(label))) {
    return { type: 'FREE_DELIVERY', minimumOrderValue: money(m[1]), currency: 'AED', title: label };
  }
  // "30% off selected items" / "25% off entire menu" / "40% off selected items on AED 30+"
  if ((m = new RegExp(`^(\\d+)% off (selected items|entire menu)(?: on ${AED}\\s?([\\d,.]+)\\+?)?`, 'i').exec(label))) {
    return {
      type: m[2].toLowerCase() === 'entire menu' ? 'PERCENT_OFF_MENU' : 'PERCENT_OFF_ITEMS',
      percentage: Number(m[1]),
      minimumOrderValue: m[3] ? money(m[3]) : undefined,
      currency: m[3] ? 'AED' : undefined,
      title: label,
    };
  }
  // "Buy 1, get 1 free"
  if (/^buy \d+,? get \d+ free/i.test(label)) return { type: 'BUY_ONE_GET_ONE', title: label };
  // "Offers available" and anything else
  return { type: 'OTHER', title: label };
}

export interface DeliverooListingRestaurant {
  platformRestaurantId: string;
  name?: string;
  // Path of the menu page, e.g. /menu/Dubai/knowledge-village/subway-knowledge-village
  menuPath?: string;
  // The distinct badge texts shown on the card, in display order.
  labels: string[];
}

function collectCards(node: unknown, out: Array<Record<string, unknown>>): void {
  if (Array.isArray(node)) {
    for (const v of node) collectCards(v, out);
  } else if (isPlainRecord(node)) {
    if (typeof node['partner-name.content'] === 'string') out.push(node);
    for (const v of Object.values(node)) collectCards(v, out);
  }
}

// A restaurant listing page → one entry per restaurant card with its offer badge text(s).
export function parseDeliverooOfferListing(html: string): DeliverooListingRestaurant[] {
  const data = readNextData(html);
  if (!data) return [];
  const cards: Array<Record<string, unknown>> = [];
  collectCards(data, cards);

  const byId = new Map<string, DeliverooListingRestaurant>();
  for (const card of cards) {
    const tap = Object.entries(card).find(([k]) => k.endsWith('on-tap'))?.[1];
    const params = at(tap, 'action', 'parameters');
    const id = at(params, 'restaurant_id');
    if (typeof id !== 'string' && typeof id !== 'number') continue;
    const href = at(params, 'restaurant_href');
    const labels: string[] = [];
    for (const [key, value] of Object.entries(card)) {
      if (!/^promotional-.*label\.content$/.test(key) || typeof value !== 'string') continue;
      const label = cleanLabel(value);
      if (label && !labels.includes(label)) labels.push(label);
    }
    const entry = byId.get(String(id)) ?? {
      platformRestaurantId: String(id),
      name: cleanLabel(String(card['partner-name.content'])),
      menuPath: typeof href === 'string' ? href.split('?')[0] : undefined,
      labels: [],
    };
    for (const label of labels) if (!entry.labels.includes(label)) entry.labels.push(label);
    byId.set(entry.platformRestaurantId, entry);
  }
  return [...byId.values()];
}
