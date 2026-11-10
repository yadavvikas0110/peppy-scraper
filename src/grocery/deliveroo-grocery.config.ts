// Deliveroo Hop (grocery) pilot — confirmed live store menu URLs in Dubai. Deliveroo stores are
// located by geohash (not numeric area ids like Talabat), so a pilot seeds known store URLs; full
// Dubai store discovery (enumerating Hop + partner grocery stores by location) is a follow-up.

export const DELIVEROO_RETAILER_ID = 'deliveroo';
export const DELIVEROO_RETAILER_NAME = 'Deliveroo Hop';

/**
 * Confirmed Deliveroo Hop grocery store menu URLs (carry geohash/day/time for delivery context).
 * Covers the three Dubai Hop dark stores (ops node list 2026-11-10):
 *   DH-JLT-01   Goldcrest Views, Cluster V        → JLT, Jumeirah Islands, Springs
 *   DH-DWTN-02  Burj Al Noujoum Tower, Al Asayel  → Downtown, Burj Khalifa zone
 *   DH-DLAND-03 Control Tower, Al Hebiah 1        → Motor City, Sports City, Dubailand
 */
export const DELIVEROO_PILOT_STORES: string[] = [
  'https://deliveroo.ae/menu/Dubai/hopjlt/deliveroo-hop-goldcrest?day=today&geohash=thrr3b148hez&time=ASAP',
  'https://deliveroo.ae/menu/Dubai/hopdt/deliveroo-hop-burj-al-noujoum-tower?day=today&geohash=thrr3fe45xk6&time=ASAP',
  'https://deliveroo.ae/menu/Dubai/hopmc/deliveroo-hop-motor-city?day=today&geohash=thrq24sm92j2&time=ASAP',
];

export const DELIVEROO_CRAWL_DEFAULTS = {
  /**
   * Budget guard on Bright Data requests per run. NO CAP by default — crawl every configured store
   * fully. Re-impose a cap with DELIVEROO_MAX_REQUESTS. Each request ≈ 1 Unlocker credit.
   */
  maxRequests: process.env.DELIVEROO_MAX_REQUESTS ? Number(process.env.DELIVEROO_MAX_REQUESTS) : Infinity,
  pushBatchSize: Number(process.env.GROCERY_PUSH_BATCH || 200),
  requestDelayMs: Number(process.env.GROCERY_REQUEST_DELAY_MS || 250),
};

/**
 * Resolve the Deliveroo Hop store menu URLs to crawl. Default = the confirmed pilot stores.
 * Add the rest of Dubai's Hop stores via DELIVEROO_STORE_URLS (a JSON array of menu URLs, or a
 * comma-separated list). Each URL must carry its store's geohash/day/time query, e.g.
 *   https://deliveroo.ae/menu/Dubai/<slug>/<store>?day=today&geohash=<hash>&time=ASAP
 * (Deliveroo locates dark stores by geohash, not by area id, so each store needs its own URL.)
 */
export function resolveDeliverooStores(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env.DELIVEROO_STORE_URLS?.trim();
  if (!raw) return DELIVEROO_PILOT_STORES;
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.every(u => typeof u === 'string' && u.length > 0)) return parsed;
  } catch {
    const list = raw.split(',').map(s => s.trim()).filter(Boolean);
    if (list.length) return list;
  }
  return DELIVEROO_PILOT_STORES;
}
