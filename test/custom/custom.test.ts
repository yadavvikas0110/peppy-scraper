/// <reference types="node" />
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadCustomConfig, parseCustomConfig } from '../../src/custom/custom.config';
import { customDbTarget } from '../../src/custom/custom.db';
import { mapLetstangoProduct } from '../../src/custom/adapters/letstango.adapter';
import { jumboAdapter } from '../../src/custom/adapters/jumbo.adapter';
import { runCustomScrape } from '../../src/custom/custom.runner';
import type { CustomFetcher, PlatformAdapter } from '../../src/custom/core/types';

const SRC = path.join(__dirname, '..', '..', 'src');

describe('isolation from third-party scraping providers', () => {
  // Runtime check: load every custom module (node --test runs each file in its own process),
  // then inspect what Node actually loaded. Type-only imports are erased and correctly ignored.
  test('loading the custom scraper never loads Bright Data, Scrape.do or their orchestrators', () => {
    const files = (fs.readdirSync(path.join(SRC, 'custom'), { recursive: true }) as string[])
      .filter(f => f.endsWith('.ts') && !f.endsWith('custom.cli.ts')); // the CLI runs main() on load
    for (const f of files) require(path.join(SRC, 'custom', f));
    const loaded = Object.keys(require.cache).map(f => path.relative(SRC, f));
    const forbidden = loaded.filter(f =>
      /^services\/(brightdata\.service|scrape\.do\.service|playwright\.service|carrefour\.sitemap)|^shared\/scrapedo\/|^dining\/|^config\/sites|^grocery\/(?!grocery-match-key)/.test(f));
    assert.deepEqual(forbidden, []);
    assert.ok(loaded.some(f => f === 'custom/custom.runner.ts'), 'runner was loaded');
    assert.ok(loaded.some(f => f === 'cron/push-pipeline.ts'), 'shared push pipeline was loaded');
  });

  test('the CLI source loads the runner only after blanking provider credentials', () => {
    const cli = fs.readFileSync(path.join(SRC, 'custom', 'custom.cli.ts'), 'utf8');
    for (const v of ['BRIGHT_DATA_API_KEY', 'BRIGHT_DATA_BROWSER_AUTH', 'SCRAPE_DO_TOKEN', 'CHROMA_API_KEY', 'PEPPY_BE_URL', 'MONGODB_URI']) {
      assert.ok(cli.includes(`'${v}'`), `${v} is blanked`);
    }
    assert.ok(cli.indexOf('ISOLATED_VARS) process.env') < cli.indexOf("require('./custom.runner')"));
    assert.doesNotMatch(cli, /^import .*(custom\.runner|push-pipeline|bundler)/m);
  });
});

describe('config', () => {
  test('shipped config/custom-scraper.json is valid and covers all four sites', () => {
    const c = loadCustomConfig();
    for (const site of ['namshi', 'mumzworld', 'jumbo', 'letstango'] as const) assert.ok(c.sites[site].length > 0, site);
    assert.equal(c.http.respectRobots, true);
    assert.ok(c.http.minIntervalMs >= 1000);
  });
  const base = { settings: { userAgent: 'x' }, sites: {} as any };
  test('unknown taxonomy is refused', () => {
    assert.throws(() => parseCustomConfig({ ...base, sites: { namshi: [{ key: 'a', label: 'a', broadCategory: 'Nope', subCategory: 'X', source: '/a/', limit: 3 }] } }), /unknown taxonomy/);
  });
  test('unsupported site is refused', () => {
    assert.throws(() => parseCustomConfig({ ...base, sites: { amazon: [] } }), /unsupported site "amazon"/);
  });
});

describe('database target', () => {
  const uri = (db: string) => `mongodb://u:p@db.example.com:27017/${db}?authSource=admin`;
  test('dev is allowed by default', () => {
    assert.deepEqual(customDbTarget({ CUSTOM_MONGODB_URI: uri('dev') }), { uri: uri('dev'), dbName: 'dev' });
  });
  test('the production pipeline database "peppy" and prod names are refused', () => {
    assert.throws(() => customDbTarget({ CUSTOM_MONGODB_URI: uri('peppy') }), /not in CUSTOM_DB_ALLOWLIST/);
    assert.throws(() => customDbTarget({ CUSTOM_MONGODB_URI: uri('dev'), CUSTOM_MONGODB_DB: 'production' }), /not in CUSTOM_DB_ALLOWLIST/);
    assert.throws(() => customDbTarget({ CUSTOM_MONGODB_URI: uri('prod'), CUSTOM_DB_ALLOWLIST: 'prod' }), /production database/);
  });
  test('never falls back to the shared MONGODB_URI', () => {
    assert.throws(() => customDbTarget({ MONGODB_URI: uri('dev') }), /CUSTOM_MONGODB_URI is not set/);
  });
});

describe('Letstango (Shopify) mapping', () => {
  test('cheapest available variant, sku, compare-at price; seller is not a brand; marketing suffix removed', () => {
    const p = mapLetstangoProduct({
      title: 'Lattafa Asad EDP 100ml | FREE DELIVERY | 1 Year Warranty', handle: 'lattafa-asad', vendor: 'LetsTango', product_type: 'Perfume', tags: [],
      body_html: '<p>Spicy <b>amber</b></p>', images: [{ src: '//cdn.shopify.com/a.jpg' }],
      variants: [
        { price: '120.00', compare_at_price: '150.00', available: false, sku: 'SOLD' },
        { price: '99.00', compare_at_price: '140.00', available: true, sku: 'LAT-ASAD-100' },
      ],
    });
    assert.equal(p.price, 99);
    assert.equal(p.originalPrice, 140);
    assert.equal(p.sku, 'LAT-ASAD-100');
    assert.equal(p.brand, null);
    assert.equal(p.productName, 'Lattafa Asad EDP 100ml');
    assert.equal(p.description, 'Spicy amber');
    assert.deepEqual(p.imageUrls, ['https://cdn.shopify.com/a.jpg']);
    assert.equal(p.productUrl, 'https://letstango.com/products/lattafa-asad');
  });
});

describe('Jumbo discovery', () => {
  test('skips landing pages and "advance-for-…" pre-order deposits', async () => {
    const listing = ['apple-iphone-17-pro-max-smartphone-silver-256-gb', 'advance-for-apple-iphone-duo-smartphone-star-white-256-gb', 'deal-of-the-day']
      .map(s => `<a href="/${s}.html">x</a>`).join('');
    const { urls } = await jumboAdapter.discover({ key: 'p', label: 'p', broadCategory: 'Electronics', subCategory: 'Smartphones', source: '/mobile-phones.html', limit: 5 }, 10,
      { get: async () => { throw new Error('unused'); }, render: async () => listing });
    assert.deepEqual(urls, ['https://www.jumbo.ae/apple-iphone-17-pro-max-smartphone-silver-256-gb.html']);
  });
});

describe('runner (offline)', () => {
  const html = (name: string, price: string) => `<script type="application/ld+json">{"@type":"Product","name":"${name}","sku":"${name}","image":["https://cdn.x.com/${name}.jpg"],"offers":{"price":"${price}","priceCurrency":"AED","availability":"https://schema.org/InStock"}}</script>`;
  const pages: Record<string, string> = {
    'https://www.jumbo.ae/p1.html': html('Phone One 128GB', '999'),
    'https://www.jumbo.ae/p2.html': '<html>no data</html>',
    'https://www.jumbo.ae/p3.html': html('Phone Three 256GB', '1499'),
    'https://www.jumbo.ae/p4.html': html('Phone Four 256GB', '1799'),
  };
  const fetcher: CustomFetcher = {
    get: async url => ({ url, status: pages[url] ? 200 : 404, body: pages[url] ?? '' }),
    render: async () => '',
  };
  const adapter: PlatformAdapter = { ...jumboAdapter, discover: async () => ({ urls: Object.keys(pages) }) };
  const config = parseCustomConfig({
    settings: { userAgent: 'x' },
    sites: { jumbo: [{ key: 'smartphones', label: 'Phones', broadCategory: 'Electronics', subCategory: 'Smartphones', source: '/m.html', limit: 2 }] },
  });

  test('collects up to the limit, rejects invalid pages, stamps taxonomy, writes JSON, pushes bundles', async () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'custom-'));
    let pushed: any[] = [];
    const result = await runCustomScrape(config, {
      sites: ['jumbo'], ai: false, outputDir: out, shouldStop: () => false,
      push: { uri: 'mongodb://localhost/dev', dbName: 'dev' },
    }, {
      adapters: { jumbo: adapter } as any,
      fetcher,
      push: async bundles => { pushed = bundles; return { mongoInserted: bundles.length, mongoUpdated: 0, matchedExisting: 0, skipped: 0, chromaVectors: 0, mapping: { ok: true, message: '' }, errors: [] }; },
      now: () => new Date('2026-11-12T00:00:00Z'),
    });

    const site = result.sites[0];
    assert.equal(site.status, 'complete');
    assert.equal(site.valid, 2);
    assert.equal(site.rejected, 1); // p2: no data; p4 never fetched (limit reached)
    assert.equal(pushed.length, 2);
    assert.equal(pushed[0].broadCategory, 'Electronics');
    assert.equal(pushed[0].retailers[0].retailerId, 'jumbo');
    const file = JSON.parse(fs.readFileSync(result.outputFile, 'utf8'));
    assert.equal(file.products.length, 2);
    assert.deepEqual(file.rejected[0].reasons, ['no name', 'no price', 'no image']);
    assert.equal(file.products[0].product.scrapedAt, '2026-11-12T00:00:00.000Z');
  });

  test('a page that redirected to another product is rejected; results survive a failed push', async () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'custom-'));
    const redirecting: CustomFetcher = {
      get: async url => url.endsWith('p1.html')
        ? { url: 'https://www.jumbo.ae/other-product.html', status: 200, body: pages['https://www.jumbo.ae/p3.html'] }
        : { url, status: pages[url] ? 200 : 404, body: pages[url] ?? '' },
      render: async () => '',
    };
    await assert.rejects(runCustomScrape(config, {
      sites: ['jumbo'], ai: false, outputDir: out, shouldStop: () => false, push: { uri: 'mongodb://localhost/dev', dbName: 'dev' },
    }, {
      adapters: { jumbo: adapter } as any, fetcher: redirecting,
      push: async () => { throw new Error('DB timeout'); },
    }), /DB timeout/);
    const [file] = fs.readdirSync(out);
    const saved = JSON.parse(fs.readFileSync(path.join(out, file), 'utf8'));
    assert.match(saved.rejected[0].reasons[0], /redirected to https:\/\/www\.jumbo\.ae\/other-product\.html/);
    assert.equal(saved.products.length, 2); // scraped data kept even though the push failed
  });

  test('a stop noticed inside a category ends the site as stopped', async () => {
    let calls = 0;
    const result = await runCustomScrape(config, {
      sites: ['jumbo'], ai: false, outputDir: fs.mkdtempSync(path.join(os.tmpdir(), 'custom-')), shouldStop: () => ++calls > 2,
    }, { adapters: { jumbo: adapter } as any, fetcher });
    assert.equal(result.sites[0].status, 'stopped');
  });
});
