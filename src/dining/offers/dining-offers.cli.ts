import dotenv from 'dotenv';
import { closeMongo, getMongoConfig, getMongoDb, redactMongoUri } from '../../shared/db/mongo';
import { createScrapeDoClient } from '../../shared/scrapedo/scrapedo.client';
import { DINING_COLLECTIONS } from '../db/dining.collections';
import { DiningRestaurant } from '../dining.types';
import { getDeliverooFetchOptions } from '../platforms/deliveroo/deliveroo.adapter';
import { classifyDeliverooOfferLabel, parseDeliverooOfferListing } from '../platforms/deliveroo/deliveroo.offers';
import { ensureDiningOfferIndexes, getDiningOfferCollection } from './offer.collections';
import { syncRestaurantOffers } from './offer.repository';

// Operator tool for restaurant offers shown on a Deliveroo restaurant listing page (all restaurants of an area,
// including ones not imported yet). Offers of imported restaurants are also refreshed by every menu scrape.
//
//   npm run dining:offers -- --url=<listing url>[,<listing url>]    what would be fetched + estimated credits (read-only)
//   npm run dining:offers -- --url=<listing url> --run              fetch (about 5 credits per URL) and store the offers
//   npm run dining:offers -- --url=<listing url> --run --dry-run    fetch and parse, store nothing (still uses credits)
//
// Without --url the URLs come from DINING_OFFER_LISTING_URLS (comma separated).

const CREDITS_PER_LISTING = 5;

function parseArgs(argv: string[]): { urls: string[]; run: boolean; dryRun: boolean } {
  let urls = (process.env.DINING_OFFER_LISTING_URLS ?? '').split(',');
  let run = false;
  let dryRun = false;
  for (const arg of argv) {
    if (arg === '--run') run = true;
    else if (arg === '--dry-run') dryRun = true;
    else if (arg.startsWith('--url=')) urls = arg.slice('--url='.length).split(',');
    else throw new Error(`Unknown argument: ${arg}`);
  }
  urls = urls.map(u => u.trim()).filter(Boolean);
  if (!urls.length) throw new Error('Give a listing page with --url=<url> or set DINING_OFFER_LISTING_URLS');
  for (const url of urls) {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error(`Not a URL: ${url}`);
    }
    if (parsed.protocol !== 'https:' || !/(^|\.)deliveroo\.ae$/.test(parsed.hostname) || !/\/restaurants\//.test(parsed.pathname)) {
      throw new Error(`Not a Deliveroo restaurant listing page (expected https://deliveroo.ae/en/restaurants/...): ${url}`);
    }
  }
  if (dryRun && !run) throw new Error('--dry-run only applies to --run');
  return { urls, run, dryRun };
}

// Offers are shown in English on the listing; the apps word them in the user's language from the stored rule.
function toEnglishUrl(url: string): string {
  const parsed = new URL(url);
  const segments = parsed.pathname.split('/').filter(Boolean);
  if (segments[0] === 'en' || segments[0] === 'ar') segments[0] = 'en';
  else segments.unshift('en');
  parsed.pathname = `/${segments.join('/')}`;
  return parsed.toString();
}

async function main(): Promise<void> {
  dotenv.config();
  const { urls, run, dryRun } = parseArgs(process.argv.slice(2));
  const { dbName } = getMongoConfig();
  console.log(`[dining-offers] Database "${dbName}"; ${urls.length} listing page(s), ~${urls.length * CREDITS_PER_LISTING} credits`);
  if (!run) {
    for (const url of urls) console.log(`  ${toEnglishUrl(url)}`);
    console.log('[dining-offers] Plan only (add --run to fetch)');
    return;
  }

  const db = await getMongoDb();
  if (!dryRun) await ensureDiningOfferIndexes(db);
  const offers = getDiningOfferCollection(db);
  const restaurants = db.collection<DiningRestaurant>(DINING_COLLECTIONS.restaurants);
  const scrapeDo = createScrapeDoClient();

  for (const url of urls) {
    const target = toEnglishUrl(url);
    const response = await scrapeDo.fetchHtml(target, getDeliverooFetchOptions(target, 'en'));
    const listing = parseDeliverooOfferListing(response.html);
    console.log(`[dining-offers] ${target}: ${listing.length} restaurants (cost ${response.requestCost ?? '?'}, ${response.remainingCredits ?? '?'} credits left)`);
    if (!listing.length) {
      console.warn('[dining-offers] No restaurant cards found on the page; nothing stored');
      continue;
    }

    const known = await restaurants
      .find({ platform: 'deliveroo', platformRestaurantId: { $in: listing.map(r => r.platformRestaurantId) } }, { projection: { platformRestaurantId: 1 } })
      .toArray();
    const ourId = new Map(known.map(r => [r.platformRestaurantId as string, r._id]));

    const byType: Record<string, number> = {};
    let withOffers = 0;
    let ended = 0;
    for (const restaurant of listing) {
      const normalized = restaurant.labels.map(classifyDeliverooOfferLabel);
      if (normalized.length) withOffers++;
      for (const o of normalized) byType[o.type] = (byType[o.type] ?? 0) + 1;
      if (dryRun) continue;
      const result = await syncRestaurantOffers(offers, {
        platform: 'deliveroo',
        platformRestaurantId: restaurant.platformRestaurantId,
        restaurantId: ourId.get(restaurant.platformRestaurantId),
        source: 'listing',
        locale: 'en',
        offers: normalized,
      });
      ended += result.ended;
    }
    console.log(
      `[dining-offers]   ${withOffers} with offers, ${ourId.size} already imported; by type ${JSON.stringify(byType)}` +
      (dryRun ? ' (dry run: nothing stored)' : `; ${ended} offers ended`)
    );
  }
}

main()
  .catch(err => {
    console.error(`[dining-offers] Failed: ${redactMongoUri(String((err as Error)?.message ?? err))}`);
    process.exitCode = 1;
  })
  .finally(() => closeMongo());
