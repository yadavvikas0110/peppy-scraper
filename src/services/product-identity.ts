/**
 * Marketplace identity for retailer offers.
 *
 * Product URLs drift between runs (tracking params, affiliate tags, slugs), so offers are
 * compared by a stable marketplace ID (Amazon ASIN, Noon/Namshi SKU, Carrefour product ID)
 * and, failing that, by a canonical URL. The original URL — including any affiliate tag —
 * is kept separately as the redirect target.
 */

const ASIN_RE = /\/(?:dp|gp\/product|gp\/aw\/d|product)\/([A-Z0-9]{10})(?:[/?#]|$)/i;
// noon.com/uae-en/<slug>/<SKU>/p/  — the segment right before /p/ is the SKU
const NOON_SKU_RE = /\/([A-Z0-9]{6,})\/p\/?(?:[?#]|$)/i;
const CARREFOUR_ID_RE = /\/p\/(\d{5,})(?:[/?#]|$)/;

function parse(url: string | null | undefined): URL | null {
  if (!url) return null;
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

function bareHost(u: URL): string {
  return u.hostname.toLowerCase().replace(/^www\./, '');
}

export function extractAmazonAsin(url: string | null | undefined): string | null {
  const u = parse(url);
  if (!u || !/(^|\.)amazon\./i.test(u.hostname)) return null;
  return ASIN_RE.exec(u.pathname)?.[1]?.toUpperCase() ?? null;
}

export function extractNoonSku(url: string | null | undefined): string | null {
  const u = parse(url);
  if (!u || !/(^|\.)(noon|namshi)\.com$/i.test(u.hostname)) return null;
  return NOON_SKU_RE.exec(u.pathname)?.[1]?.toUpperCase() ?? null;
}

/** Stable marketplace ID for an offer URL, or null when the URL carries none (e.g. short links). */
export function marketplaceIdFor(retailerId: string, url: string | null | undefined): string | null {
  switch (retailerId) {
    case 'amazon':
      return extractAmazonAsin(url);
    case 'noon':
    case 'namshi':
      return extractNoonSku(url);
    case 'carrefour': {
      const u = parse(url);
      return u ? CARREFOUR_ID_RE.exec(u.pathname)?.[1] ?? null : null;
    }
    default:
      return null;
  }
}

/**
 * URL used only for identity comparison: no query string, fragment, `www.` or trailing slash.
 * Amazon collapses to /dp/ASIN so slugged, tagged and /gp/product links compare equal.
 */
export function canonicalProductUrl(url: string | null | undefined): string | null {
  const u = parse(url);
  if (!u || !/^https?:$/.test(u.protocol)) return null;
  const asin = extractAmazonAsin(url);
  if (asin) return `https://${bareHost(u)}/dp/${asin}`;
  const path = u.pathname.replace(/\/+$/, '') || '/';
  return `https://${bareHost(u)}${path.toLowerCase()}`;
}

const AFFILIATE_HOSTS = /^(s\.noon\.com|amzn\.to|amzn\.eu)$/i;
const AFFILIATE_PARAMS = ['tag', 'linkCode', 'linkId', 'affiliate_id', 'aff_id'];

/** True for links that carry Peppy's affiliate attribution and must not be replaced by a bare URL. */
export function isAffiliateUrl(url: string | null | undefined): boolean {
  const u = parse(url);
  if (!u) return false;
  if (AFFILIATE_HOSTS.test(u.hostname)) return true;
  return AFFILIATE_PARAMS.some(p => u.searchParams.has(p));
}

/** Key identifying one retailer listing: marketplace ID when known, else the canonical URL. */
export function offerIdentityKey(retailerId: string, url: string | null | undefined): string | null {
  const id = marketplaceIdFor(retailerId, url);
  if (id) return `${retailerId}:id:${id}`;
  const canonical = canonicalProductUrl(url);
  return canonical ? `${retailerId}:url:${canonical}` : null;
}
