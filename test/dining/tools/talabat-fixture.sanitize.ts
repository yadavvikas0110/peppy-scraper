/// <reference types="node" />
import * as cheerio from 'cheerio';

/*
 * Reduces a captured Talabat menu page to what the parser reads, so fixtures carry no visitor
 * data, tracking state or bundles. Kept: <html lang/dir>, <title>, canonical + hreflang links,
 * JSON-LD, and __NEXT_DATA__ with only query/page + pageProps.initialMenuState
 * (area, restaurant, currentCountry subset, menuData.categories/items).
 *
 * Dropped: props.userIpAddress, hostName, initialI18nStore, i18nServerInstance, initialReduxState
 * (customer, cart, wallet), gtmEventData, buildId, experiments, payment methods,
 * menuData.filteredCategories (a copy of categories), and every key that looks like a credential.
 */

type Obj = Record<string, unknown>;

export const TALABAT_FIXTURE_DROPPED = [
  'props.userIpAddress', 'props.hostName', 'props.initialI18nStore', 'props.i18nServerInstance',
  'props.initialReduxState', 'props.pageProps.gtmEventData', 'props.pageProps.namespacesRequired', 'buildId',
  'initialMenuState.orderKillExperimentData', 'initialMenuState.sbExperimentData',
  'initialMenuState.availablePaymentMethods', 'initialMenuState.promotions', 'restaurant.availablePaymentMethods',
  'menuData.filteredCategories', 'currentCountry (all but id/slug/name/code/ISO/currency/languages)',
  'keys matching token|session|cookie|password|secret|email|phone|ipAddress',
] as const;

const SENSITIVE_KEY = /token|session|cookie|password|secret|email|phone|ipaddress/i;
const COUNTRY_KEYS = ['id', 'slug', 'name', 'code', 'ISO', 'currencyISO', 'currency', 'defaultLanguage', 'otherLanguages'];

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

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
const scriptJson = (data: unknown) => JSON.stringify(data).replace(/</g, '\\u003c');

export function sanitizeTalabatHtml(html: string): string {
  const $ = cheerio.load(html);
  const raw = $('script#__NEXT_DATA__').first().text();
  if (!raw) throw new Error('No __NEXT_DATA__ in the captured page');
  const data = JSON.parse(raw) as Obj;
  const props = isObj(data.props) ? data.props : {};
  const pageProps = isObj(props.pageProps) ? props.pageProps : {};
  const state = isObj(pageProps.initialMenuState) ? pageProps.initialMenuState : {};
  const menuData = isObj(state.menuData) ? state.menuData : {};
  const restaurant = isObj(state.restaurant) ? { ...state.restaurant } : undefined;
  if (restaurant) delete restaurant.availablePaymentMethods;

  const sanitized = scrub({
    props: {
      initialLanguage: props.initialLanguage,
      pageProps: {
        currentURL: pageProps.currentURL,
        initialMenuState: {
          baseUrl: state.baseUrl,
          area: state.area,
          restaurant,
          currentCountry: isObj(state.currentCountry) ? pick(state.currentCountry, COUNTRY_KEYS) : state.currentCountry,
          menuData: { categories: menuData.categories, items: menuData.items },
        },
      },
    },
    page: data.page,
    query: data.query,
  });

  const lang = $('html').attr('lang') ?? '';
  const dir = $('html').attr('dir') ?? '';
  const head: string[] = [`<title>${escapeHtml($('title').first().text())}</title>`];
  const canonical = $('link[rel="canonical"]').attr('href');
  if (canonical) head.push(`<link rel="canonical" href="${escapeHtml(canonical)}"/>`);
  $('link[rel="alternate"][hreflang]').each((_, el) => {
    head.push(`<link rel="alternate" href="${escapeHtml($(el).attr('href') ?? '')}" hrefLang="${escapeHtml($(el).attr('hreflang') ?? '')}"/>`);
  });
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      head.push(`<script type="application/ld+json">${scriptJson(scrub(JSON.parse($(el).text())))}</script>`);
    } catch {
      // Malformed JSON-LD is not kept.
    }
  });

  return (
    `<!DOCTYPE html><html lang="${escapeHtml(lang)}" dir="${escapeHtml(dir)}"><head>${head.join('')}</head>` +
    `<body><script id="__NEXT_DATA__" type="application/json">${scriptJson(sanitized)}</script></body></html>\n`
  );
}
