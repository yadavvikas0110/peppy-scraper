/// <reference types="node" />
import { readFileSync } from 'fs';
import { join } from 'path';
import { Db, MongoClient } from 'mongodb';
import { DiningCollections, ensureDiningIndexes, getDiningCollections } from '../../src/dining/db/dining.collections';
import { createDiningRepositories, DiningRepositories } from '../../src/dining/dining.persistence';
import type { DiningLocale } from '../../src/dining/dining.types';
import { parseDeliverooMenu } from '../../src/dining/platforms/deliveroo/deliveroo.parser';
import { mapDeliverooMenu } from '../../src/dining/platforms/deliveroo/deliveroo.mapper';
import type { DiningMappedMenu } from '../../src/dining/platforms/platform.mapper';
import type { ScrapeDoClient } from '../../src/shared/scrapedo/scrapedo.client';
import type { ScrapeDoRequestOptions, ScrapeDoResponse } from '../../src/shared/scrapedo/scrapedo.types';

// ─── Fixtures (captured once from Deliveroo; no network) ─────────────────────

const FIXTURES = join(__dirname, 'fixtures');
const html: Partial<Record<DiningLocale, string>> = {};

export function fixtureHtml(locale: DiningLocale): string {
  return (html[locale] ??= readFileSync(join(FIXTURES, `deliveroo-${locale}.html`), 'utf8'));
}

export const FIXTURE_URL: Record<DiningLocale, string> = {
  en: 'https://deliveroo.ae/en/menu/Dubai/dubai-business-bay/kamat-dt/?day=today&geohash=thrr3squys8d&time=ASAP',
  ar: 'https://deliveroo.ae/ar/menu/Dubai/dubai-business-bay/kamat-dt/?day=today&geohash=thrr3squys8d&time=ASAP',
};

export const THALI = '1560778015';
export const STUFFED_NAN = '1560778003';
export const COCA_COLA = '1560784058';

const NEXT_DATA_RE = /(<script id="__NEXT_DATA__"[^>]*>)([\s\S]*?)(<\/script>)/;

export function withoutNextData(page: string): string {
  return page.replace(NEXT_DATA_RE, '');
}

// Mutates a copy of the real fixture payload (props.initialState.menuPage.menu.metas.root).
export function withMenuRoot(page: string, mutate: (root: any) => void): string {
  return page.replace(NEXT_DATA_RE, (_m, open, json, close) => {
    const data = JSON.parse(json);
    mutate(data.props.initialState.menuPage.menu.metas.root);
    return `${open}${JSON.stringify(data).replace(/</g, '\\u003c')}${close}`;
  });
}

export function mappedMenu(locale: DiningLocale, page = fixtureHtml(locale)): DiningMappedMenu {
  return mapDeliverooMenu(parseDeliverooMenu(page, { locale, sourceUrl: FIXTURE_URL[locale] }));
}

// ─── Fake Scrape.do client ───────────────────────────────────────────────────

export const FAKE_SCRAPE_DO_TOKEN = 'test-token-must-never-be-stored';

export function fakeScrapeDo(
  pageFor: (url: string) => string | Promise<string>,
  overrides: Partial<ScrapeDoResponse> = {}
): { client: Pick<ScrapeDoClient, 'fetchHtml'>; calls: Array<{ url: string; options?: ScrapeDoRequestOptions }> } {
  const calls: Array<{ url: string; options?: ScrapeDoRequestOptions }> = [];
  return {
    calls,
    client: {
      async fetchHtml(url, options) {
        calls.push({ url, options });
        return {
          html: await pageFor(url),
          statusCode: 200,
          initialStatusCode: 200,
          finalUrl: url,
          targetUrl: url,
          requestCost: 5,
          remainingCredits: 990,
          attempts: 1,
          durationMs: 1200,
          ...overrides,
        };
      },
    },
  };
}

export const pageByLocale = (url: string) => fixtureHtml(url.includes('/ar/') ? 'ar' : 'en');

// ─── Local MongoDB (opt-in; never a shared/production cluster) ───────────────

const TEST_URI = process.env.DINING_TEST_MONGODB_URI;
const isLocal = !!TEST_URI && /^mongodb:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/.test(TEST_URI);

export const LOCAL_DB_SKIP: false | string = isLocal ? false : 'set DINING_TEST_MONGODB_URI=mongodb://127.0.0.1:<port>';

export interface TestDb {
  db: Db;
  collections: DiningCollections;
  repos: DiningRepositories;
  reset(): Promise<void>;
  close(): Promise<void>;
}

let client: MongoClient | null = null;

export async function openTestDb(label: string): Promise<TestDb> {
  if (!isLocal) throw new Error('Local test MongoDB is not configured');
  client ??= await new MongoClient(TEST_URI as string, { serverSelectionTimeoutMS: 5000 }).connect();
  const db = client.db(`peppy_dining_test_${label}_${Date.now()}`);
  await ensureDiningIndexes(db);
  const collections = getDiningCollections(db);
  return {
    db,
    collections,
    repos: createDiningRepositories(collections),
    async reset() {
      await Promise.all(Object.values(collections).map(c => c.deleteMany({})));
    },
    async close() {
      await db.dropDatabase().catch(() => {});
    },
  };
}

export async function closeTestClient(): Promise<void> {
  await client?.close();
  client = null;
}
