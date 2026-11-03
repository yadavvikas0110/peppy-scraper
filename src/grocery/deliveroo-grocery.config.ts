// Deliveroo Hop (grocery) pilot — confirmed live store menu URLs in Dubai. Deliveroo stores are
// located by geohash (not numeric area ids like Talabat), so a pilot seeds known store URLs; full
// Dubai store discovery (enumerating Hop + partner grocery stores by location) is a follow-up.

export const DELIVEROO_RETAILER_ID = 'deliveroo';
export const DELIVEROO_RETAILER_NAME = 'Deliveroo Hop';

/** Confirmed Deliveroo Hop grocery store menu URLs (carry geohash/day/time for delivery context). */
export const DELIVEROO_PILOT_STORES: string[] = [
  'https://deliveroo.ae/menu/Dubai/hopjlt/deliveroo-hop-goldcrest?day=today&geohash=thrr3b148hez&time=ASAP',
  'https://deliveroo.ae/menu/Dubai/hopmc/deliveroo-hop-motor-city?day=today&geohash=thrq24sm92j2&time=ASAP',
];

export const DELIVEROO_CRAWL_DEFAULTS = {
  /** Hard cap on Bright Data requests per run (budget guard). */
  maxRequests: Number(process.env.DELIVEROO_MAX_REQUESTS || 500),
  pushBatchSize: Number(process.env.GROCERY_PUSH_BATCH || 200),
  requestDelayMs: Number(process.env.GROCERY_REQUEST_DELAY_MS || 250),
};
