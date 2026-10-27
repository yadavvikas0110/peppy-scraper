/// <reference types="node" />
import * as cheerio from 'cheerio';
import { DELIVEROO_MAP_LAYOUT_ACTION_ID } from '../../../src/dining/platforms/deliveroo/deliveroo.selectors';

/*
 * Reduces a captured Deliveroo menu page to what the parser reads, so fixtures carry no visitor
 * data, tracking state or bundles. Kept: <html lang/dir>, <title>, canonical + hreflang links, and
 * __NEXT_DATA__ with only props.initialState.menuPage.menu:
 *   - metas.root: restaurant, customerLocation, categories, modifierGroups, and items reduced to the
 *     fields the parser reads;
 *   - header;
 *   - layoutGroups reduced to the info panel map layout (restaurant pin).
 *
 * Dropped: every other initialState slice (address, basket, home, request, session, cookies…),
 * sentryContext, buildId, runtime config, item-card layouts, item tracking/marketing fields,
 * and every key that looks like a credential.
 */

type Obj = Record<string, unknown>;

export const DELIVEROO_FIXTURE_DROPPED = [
  'props.initialState (all but menuPage.menu)', 'props.sentryContext', 'buildId', 'runtimeConfig',
  'menu (all but metas.root, header, layoutGroups)', 'metas.root (all but restaurant/customerLocation/categories/items/modifierGroups)',
  'items (all but parser fields)', 'layoutGroups (all but the map layout)',
  'keys matching token|session|cookie|password|secret|email|ipAddress',
] as const;

const SENSITIVE_KEY = /token|session|cookie|password|secret|email|ipaddress/i;
const ROOT_KEYS = ['restaurant', 'customerLocation', 'categories', 'modifierGroups', 'items'];
const ITEM_KEYS = ['id', 'drnId', 'categoryId', 'name', 'description', 'price', 'priceDiscounted', 'image', 'popular', 'available', 'modifierGroupIds'];

function isObj(value: unknown): value is Obj {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function scrub(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(scrub);
  if (!isObj(value)) return value;
  const out: Obj = {};
  for (const [k, v] of Object.entries(value)) if (!SENSITIVE_KEY.test(k)) out[k] = scrub(v);
  return out;
}

function pick(source: Obj, keys: string[]): Obj {
  const out: Obj = {};
  for (const k of keys) if (k in source) out[k] = source[k];
  return out;
}

function mapLayoutsOnly(layoutGroups: unknown): unknown[] {
  const groups = Array.isArray(layoutGroups) ? layoutGroups : [];
  return groups
    .filter(isObj)
    .map(g => ({ ...pick(g, ['id', 'header']), layouts: (Array.isArray(g.layouts) ? g.layouts : []).filter(l => isObj(l) && l.actionId === DELIVEROO_MAP_LAYOUT_ACTION_ID) }))
    .filter(g => g.layouts.length > 0);
}

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
const scriptJson = (data: unknown) => JSON.stringify(data).replace(/</g, '\\u003c');

export function sanitizeDeliverooHtml(html: string): string {
  const $ = cheerio.load(html);
  const raw = $('script#__NEXT_DATA__').first().text();
  if (!raw) throw new Error('No __NEXT_DATA__ in the captured page');
  const data = JSON.parse(raw) as Obj;
  const menu = (data as { props?: { initialState?: { menuPage?: { menu?: unknown } } } }).props?.initialState?.menuPage?.menu;
  if (!isObj(menu) || !isObj(menu.metas) || !isObj(menu.metas.root)) throw new Error('No menu payload in __NEXT_DATA__');
  const root = pick(menu.metas.root, ROOT_KEYS);
  if (Array.isArray(root.items)) root.items = root.items.map(i => (isObj(i) ? pick(i, ITEM_KEYS) : i));

  const sanitized = scrub({
    props: { initialState: { menuPage: { menu: { metas: { root }, header: menu.header, layoutGroups: mapLayoutsOnly(menu.layoutGroups) } } } },
    page: data.page,
  });

  const lang = $('html').attr('lang') ?? '';
  const dir = $('html').attr('dir') ?? '';
  const head: string[] = [`<title>${escapeHtml($('title').first().text())}</title>`];
  const canonical = $('link[rel="canonical"]').attr('href');
  if (canonical) head.push(`<link rel="canonical" href="${escapeHtml(canonical)}"/>`);
  $('link[rel="alternate"][hreflang]').each((_, el) => {
    head.push(`<link rel="alternate" href="${escapeHtml($(el).attr('href') ?? '')}" hreflang="${escapeHtml($(el).attr('hreflang') ?? '')}"/>`);
  });

  return (
    `<!DOCTYPE html><html lang="${escapeHtml(lang)}" dir="${escapeHtml(dir)}"><head>${head.join('')}</head>` +
    `<body><script id="__NEXT_DATA__" type="application/json">${scriptJson(sanitized)}</script></body></html>\n`
  );
}
