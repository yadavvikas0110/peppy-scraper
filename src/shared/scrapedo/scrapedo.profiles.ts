import type { ScrapeDoRequestOptions } from './scrapedo.types';

/**
 * Per-platform Scrape.do profiles — which request options to use for each page kind, in order.
 *
 * Measured on 17 Nov 2026 (src/benchmarks/scrapedo-probe.ts, real pages read by our parsers):
 *   plain = 1 credit, geoCode=ae = 1, super (residential) = 10, render (browser) = 1–5, render+super = 25.
 * The first rung is the cheapest option that worked; later rungs are fallbacks tried only when the
 * previous one times out, errors on the shop's side, or returns a block / unusable page.
 *
 * `timeoutMs` is Scrape.do's own per-request timeout (5–120 s). Slow shops get more time so a
 * page that is merely slow is not abandoned; fast-failing rungs get less so a dead option costs
 * little time before the next one is tried.
 */

export type PageKind = 'listing' | 'product';

export interface Rung {
  label: string;
  options: ScrapeDoRequestOptions;
  timeoutMs?: number;
}

export interface PlatformProfile {
  /** Shown in logs and the admin panel */
  name: string;
  hosts: RegExp;
  listing: Rung[];
  product: Rung[];
}

const plain = (timeoutMs = 45_000): Rung => ({ label: 'plain', options: {}, timeoutMs });
const uae = (timeoutMs = 45_000): Rung => ({ label: 'uae-ip', options: { geoCode: 'ae' }, timeoutMs });
const residential = (timeoutMs = 60_000): Rung => ({ label: 'residential-uae', options: { super: true, geoCode: 'ae' }, timeoutMs });
const browser = (extra: ScrapeDoRequestOptions = {}, timeoutMs = 75_000): Rung => ({ label: 'browser-uae', options: { render: true, geoCode: 'ae', ...extra }, timeoutMs });
const browserResidential = (extra: ScrapeDoRequestOptions = {}, timeoutMs = 90_000): Rung => ({ label: 'browser-residential-uae', options: { render: true, super: true, geoCode: 'ae', ...extra }, timeoutMs });

/** Default for any host without its own profile: cheapest first, residential last. */
const STANDARD: Rung[] = [plain(), uae(), residential()];

export const SCRAPE_DO_PROFILES: Record<string, PlatformProfile> = {
  amazon: { name: 'Amazon', hosts: /(^|\.)amazon\.ae$/, listing: STANDARD, product: STANDARD },
  // noon.com shopping — NOT minutes.noon.com (grocery, below)
  noon: { name: 'Noon', hosts: /(^|\.)(www\.)?noon\.com$/, listing: STANDARD, product: STANDARD },
  // Carrefour blocks data-centre IPs inconsistently (502s after ~60 s): a short plain try for listings,
  // residential IP for product pages (only reliable option, 10 credits).
  carrefour: {
    name: 'Carrefour', hosts: /(^|\.)carrefouruae\.com$/,
    listing: [plain(25_000), residential()],
    product: [residential(), browserResidential()],
  },
  // SharafDG listings need a UAE IP (plain listing timed out); product pages work plain. Slow: up to ~60 s.
  sharafdg: {
    name: 'SharafDG', hosts: /(^|\.)sharafdg\.com$/,
    listing: [uae(90_000), residential(90_000)],
    product: [plain(75_000), uae(75_000), residential(90_000)],
  },
  // Jumbo listings are built by JavaScript after load: browser with an 8 s wait (5 credits). Products are plain.
  jumbo: {
    name: 'Jumbo', hosts: /(^|\.)jumbo\.ae$/,
    listing: [browser({ customWait: 8000 }), browserResidential({ customWait: 8000 })],
    product: STANDARD,
  },
  // Namshi is slow through Scrape.do (listing ~60 s measured) — generous timeouts
  namshi: {
    name: 'Namshi', hosts: /(^|\.)namshi\.com$/,
    listing: [plain(90_000), uae(90_000), residential(90_000)],
    product: [plain(75_000), uae(75_000), residential(90_000)],
  },
  mumzworld: { name: 'Mumzworld', hosts: /(^|\.)mumzworld\.com$/, listing: STANDARD, product: STANDARD },
  letstango: { name: 'Letstango', hosts: /(^|\.)letstango\.com$/, listing: [plain(), uae()], product: [plain(), uae()] },
  // Ounass and the Landmark sites (Centrepoint, Home Centre) sit behind Cloudflare: a direct request gets the
  // challenge page. NOT yet measured through Scrape.do (token inactive when these were added, Nov 2026) —
  // the ladder starts at a UAE IP and escalates; the parser check (isUsable) rejects challenge pages.
  // Re-measure with src/benchmarks/scrapedo-probe.ts and drop rungs that never win.
  ounass: { name: 'Ounass', hosts: /(^|\.)ounass\.ae$/, listing: [uae(), residential(), browserResidential()], product: [uae(), residential(), browserResidential()] },
  centrepoint: { name: 'Centrepoint', hosts: /(^|\.)centrepointstores\.com$/, listing: [uae(), residential(), browserResidential()], product: [uae(), residential(), browserResidential()] },
  homecentre: { name: 'Home Centre', hosts: /(^|\.)homecentre\.com$/, listing: [uae(), residential(), browserResidential()], product: [uae(), residential(), browserResidential()] },
  // talabat.com: grocery (Talabat Mart) and dining
  talabat: { name: 'Talabat', hosts: /(^|\.)talabat\.com$/, listing: STANDARD, product: STANDARD },
  // deliveroo.ae: grocery (HOP) and dining — plain timed out for restaurants, UAE IP worked (1 credit)
  deliveroo: { name: 'Deliveroo', hosts: /(^|\.)deliveroo\.ae$/, listing: [uae(), residential()], product: [uae(), residential()] },
  // minutes.noon.com: location-gated app, needs a browser with a UAE exit
  'noon-minutes': {
    name: 'Noon Minutes', hosts: /(^|\.)minutes\.noon\.com$/,
    listing: [browser({ waitSelector: 'a[href*="/now-product/"]' }), browserResidential({ waitSelector: 'a[href*="/now-product/"]' })],
    product: [browser(), browserResidential()],
  },
};

/** The profile for a URL (by host), or null for hosts without one. */
export function profileForUrl(url: string): { key: string; profile: PlatformProfile } | null {
  let host: string;
  try { host = new URL(url).hostname.toLowerCase(); } catch { return null; }
  // Specific hosts before general ones (minutes.noon.com before noon.com)
  if (SCRAPE_DO_PROFILES['noon-minutes'].hosts.test(host)) return { key: 'noon-minutes', profile: SCRAPE_DO_PROFILES['noon-minutes'] };
  for (const [key, profile] of Object.entries(SCRAPE_DO_PROFILES)) {
    if (key !== 'noon-minutes' && profile.hosts.test(host)) return { key, profile };
  }
  return null;
}

export function rungsFor(url: string, kind: PageKind): { key: string; name: string; rungs: Rung[] } {
  const match = profileForUrl(url);
  if (!match) return { key: 'default', name: 'Other', rungs: STANDARD };
  return { key: match.key, name: match.profile.name, rungs: match.profile[kind] };
}
