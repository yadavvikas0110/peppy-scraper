import type { Collection, Filter } from 'mongodb';
import { ObjectId } from 'mongodb';
import type { ScrapeDoRequestOptions } from '../../shared/scrapedo/scrapedo.types';
import { DINING_LOCALES, DiningLocale, DiningPlatform, DiningRestaurant, DiningScrapeRun } from '../dining.types';
import { DiningPlatformRegistry, getDiningPlatformModule } from '../platforms/platform.registry';
import type { DiningCronCollections } from './dining-cron.collections';
import type { DiningCronPlan, DiningCronSkippedTarget, DiningCronTarget } from './dining-cron.types';

/*
 * What the daily job scrapes: every *active* restaurant already stored, in every locale whose page
 * was scraped before, using the same URL as that scrape. Restaurants imported later are picked up
 * automatically. URLs are never invented: a locale without a stored URL is reported as skipped.
 */

// Scrape.do credits per successful request (datacenter / + JS render / residential `super` / both).
export function estimateScrapeDoCredits(options: Pick<ScrapeDoRequestOptions, 'render' | 'super'>): number {
  if (options.super) return options.render ? 25 : 10;
  return options.render ? 5 : 1;
}

export interface DiningCronPlanFilter {
  platforms?: DiningPlatform[];
  restaurantIds?: string[];
  locales?: DiningLocale[];
}

export interface DiningCronRestaurantPlan {
  restaurantId: string;
  restaurantName?: string;
  platform: DiningPlatform;
  // Always in DINING_LOCALES order (en, then ar).
  targets: DiningCronTarget[];
}

export interface DiningCronPlanResult {
  plan: DiningCronPlan;
  restaurants: DiningCronRestaurantPlan[];
}

type RestaurantRow = { _id: ObjectId } & Pick<DiningRestaurant, 'platform' | 'platformRestaurantId' | 'sourceKey' | 'name' | 'url' | 'lastScrapedAtByLocale' | 'lastRunIdByLocale'>;

function oldestScrape(r: RestaurantRow): number {
  const times = DINING_LOCALES.map(l => r.lastScrapedAtByLocale?.[l]?.getTime() ?? 0);
  return Math.min(...times);
}

// Alternates platforms so parallel workers spread across platforms instead of hitting one.
function interleaveByPlatform<T extends { platform: string }>(rows: T[]): T[] {
  const queues = new Map<string, T[]>();
  for (const row of rows) {
    const queue = queues.get(row.platform) ?? [];
    queue.push(row);
    queues.set(row.platform, queue);
  }
  const out: T[] = [];
  const lists = [...queues.values()];
  for (let i = 0; out.length < rows.length; i++) for (const list of lists) if (i < list.length) out.push(list[i]);
  return out;
}

// URL of the run that last wrote each restaurant/locale: exactly what was scraped before, including
// query parameters the stored page URL drops (e.g. Deliveroo's delivery-location geohash).
async function lastScrapedUrls(scrapeRuns: Collection<DiningScrapeRun>, rows: RestaurantRow[]): Promise<Map<string, DiningScrapeRun>> {
  const runIds = rows.reduce<string[]>((ids, r) => {
    for (const locale of DINING_LOCALES) if (r.lastRunIdByLocale?.[locale]) ids.push(r.lastRunIdByLocale[locale] as string);
    return ids;
  }, []);
  if (!runIds.length) return new Map();
  const runs = await scrapeRuns
    .find({ runId: { $in: runIds }, status: { $in: ['succeeded', 'partial'] }, dryRun: false }, { projection: { runId: 1, platform: 1, locale: 1, targetUrl: 1 } })
    .toArray();
  return new Map(runs.map(run => [run.runId, run]));
}

export async function loadDiningCronPlan(
  collections: Pick<DiningCronCollections, 'restaurants' | 'scrapeRuns'>,
  options: { filter?: DiningCronPlanFilter; maxTargets: number; registry?: DiningPlatformRegistry }
): Promise<DiningCronPlanResult> {
  const registry = options.registry ?? getDiningPlatformModule;
  const filter = options.filter ?? {};
  const locales = DINING_LOCALES.filter(l => !filter.locales?.length || filter.locales.includes(l));

  const query: Filter<DiningRestaurant> = { isActive: true };
  if (filter.platforms?.length) query.platform = { $in: filter.platforms };
  if (filter.restaurantIds?.length) {
    query._id = { $in: filter.restaurantIds.filter(id => ObjectId.isValid(id)).map(id => new ObjectId(id)) };
  }
  const rows = await collections.restaurants
    .find(query, { projection: { platform: 1, platformRestaurantId: 1, sourceKey: 1, name: 1, url: 1, lastScrapedAtByLocale: 1, lastRunIdByLocale: 1 } })
    .toArray() as RestaurantRow[];
  const lastRuns = await lastScrapedUrls(collections.scrapeRuns, rows);

  // Least recently refreshed first, so a capped job rotates through every restaurant over days.
  rows.sort((a, b) => oldestScrape(a) - oldestScrape(b) || a._id.toHexString().localeCompare(b._id.toHexString()));

  const skipped: DiningCronSkippedTarget[] = [];
  const planned: DiningCronRestaurantPlan[] = [];
  const seenUrls = new Set<string>();
  let targetCount = 0;

  for (const row of interleaveByPlatform(rows)) {
    const restaurantId = row._id.toHexString();
    const restaurantName = row.name?.en ?? row.name?.ar;
    const base = { restaurantId, restaurantName, platform: row.platform };
    const platformModule = registry(row.platform);
    if (!platformModule) {
      skipped.push({ ...base, reason: 'UNSUPPORTED_PLATFORM' });
      continue;
    }

    const targets: DiningCronTarget[] = [];
    for (const locale of locales) {
      const lastRun = lastRuns.get(row.lastRunIdByLocale?.[locale] ?? '');
      const lastUrl =
        lastRun && lastRun.platform === row.platform && lastRun.locale === locale &&
        platformModule.adapter.matchesUrl(lastRun.targetUrl) && platformModule.adapter.detectLocale(lastRun.targetUrl, locale) === locale
          ? lastRun.targetUrl
          : undefined;
      const stored = lastUrl ?? row.url?.[locale]?.trim();
      if (!stored) {
        skipped.push({ ...base, locale, reason: 'MISSING_LOCALE_URL' });
        continue;
      }
      if (!platformModule.adapter.matchesUrl(stored)) {
        skipped.push({ ...base, locale, url: stored, reason: 'INVALID_URL' });
        continue;
      }
      if (platformModule.adapter.detectLocale(stored, locale) !== locale) {
        skipped.push({ ...base, locale, url: stored, reason: 'LOCALE_MISMATCH' });
        continue;
      }
      const url = platformModule.adapter.toLocaleUrl(stored, locale);
      const urlKey = `${row.platform}|${locale}|${url}`;
      if (seenUrls.has(urlKey)) {
        skipped.push({ ...base, locale, url, reason: 'DUPLICATE_URL' });
        continue;
      }
      if (targetCount >= options.maxTargets) {
        skipped.push({ ...base, locale, url, reason: 'MAX_TARGETS_EXCEEDED' });
        continue;
      }
      seenUrls.add(urlKey);
      targetCount++;
      targets.push({
        ...base,
        locale,
        url,
        urlSource: lastUrl ? 'lastRun' : 'restaurant',
        expected: { platformRestaurantId: row.platformRestaurantId, sourceKey: row.sourceKey },
        estimatedCredits: estimateScrapeDoCredits(platformModule.adapter.getFetchOptions(url, locale)),
      });
    }
    if (targets.length) planned.push({ ...base, targets });
  }

  const plan: DiningCronPlan = { restaurants: planned.length, targets: 0, estimatedCredits: 0, byPlatform: {}, skipped };
  for (const r of planned) {
    const entry = plan.byPlatform[r.platform] ?? { restaurants: 0, targets: 0, estimatedCredits: 0 };
    entry.restaurants++;
    for (const t of r.targets) {
      entry.targets++;
      entry.estimatedCredits += t.estimatedCredits;
      plan.targets++;
      plan.estimatedCredits += t.estimatedCredits;
    }
    plan.byPlatform[r.platform] = entry;
  }
  return { plan, restaurants: planned };
}
