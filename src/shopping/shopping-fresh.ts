/**
 * "Already scraped recently" check for the bulk pipeline, so a run does not pay again for products it
 * (or an earlier run, on any machine) observed within the freshness window.
 *
 * Built from products_clean: every offer with lastSeenAt inside the window, keyed by retailer +
 * marketplace id (ASIN / SKU / product id) and by retailer + canonical URL — the same identities the
 * push uses to merge, so URL variants (tracking params, slugs) are recognised too.
 */
import { canonicalProductUrl, marketplaceIdFor } from '../services/product-identity';

const idKey = (retailerId: string, id: string) => `${retailerId}:id:${String(id).toUpperCase()}`;
const urlKey = (retailerId: string, url: string) => `${retailerId}:url:${url}`;

export function offerKeys(retailerId: string, productUrl?: string | null, externalId?: string | null, canonicalUrl?: string | null): string[] {
  const keys: string[] = [];
  const id = externalId ?? marketplaceIdFor(retailerId, productUrl);
  if (id) keys.push(idKey(retailerId, id));
  const canonical = canonicalUrl ?? canonicalProductUrl(productUrl);
  if (canonical) keys.push(urlKey(retailerId, canonical));
  return keys;
}

export interface FreshIndex {
  size: number;
  isFresh(site: string, url: string): boolean;
}

export function buildFreshIndex(docs: any[], cutoff: Date): FreshIndex {
  const keys = new Set<string>();
  for (const d of docs) {
    for (const r of d?.retailers ?? []) {
      if (!r?.retailerId || !r.lastSeenAt || r.isStale === true || new Date(r.lastSeenAt) < cutoff) continue;
      for (const k of offerKeys(r.retailerId, r.productUrl, r.externalId, r.canonicalUrl)) keys.add(k);
    }
  }
  return {
    size: keys.size,
    isFresh: (site, url) => offerKeys(site, url).some(k => keys.has(k)),
  };
}

export async function loadFreshIndex(
  col: { find(filter: object, options?: object): { toArray(): Promise<any[]> } },
  freshForHours: number,
  now: Date = new Date(),
): Promise<FreshIndex> {
  const cutoff = new Date(now.getTime() - freshForHours * 3600 * 1000);
  const docs = await col.find(
    { retailers: { $elemMatch: { lastSeenAt: { $gte: cutoff }, isStale: { $ne: true } } } },
    { projection: { 'retailers.retailerId': 1, 'retailers.productUrl': 1, 'retailers.externalId': 1, 'retailers.canonicalUrl': 1, 'retailers.lastSeenAt': 1, 'retailers.isStale': 1 } },
  ).toArray();
  return buildFreshIndex(docs, cutoff);
}
