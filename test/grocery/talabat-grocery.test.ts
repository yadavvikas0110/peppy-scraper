/// <reference types="node" />
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { parseTalabatGrocery, parseStoreSubcategories, parseAreaStoreRefs } from '../../src/grocery/talabat-grocery.parser';
import { collectTalabatGrocery } from '../../src/grocery/talabat-grocery.collector';
import { crawlTalabatGrocery } from '../../src/grocery/grocery-crawl';
import { TALABAT_PILOT } from '../../src/grocery/talabat-grocery.config';

const FIXTURE = fs.readFileSync(
  path.join(__dirname, 'fixtures', 'talabat-grocery-bananas.html'),
  'utf-8',
);
const SRC_URL = 'https://www.talabat.com/uae/grocery/690014/talabat-mart-just-fruits-veg-jumeirah-1/bananas/local?aid=1172';

describe('parseTalabatGrocery', () => {
  const r = parseTalabatGrocery(FIXTURE, SRC_URL);

  test('reads the store header', () => {
    assert.equal(r.store.branchId, '690014');
    assert.equal(r.store.name, 'just fruits & veg');
  });

  test('parses every product with a price and image', () => {
    assert.equal(r.items.length, 5);
    for (const it of r.items) {
      assert.ok(it.title.length > 0);
      assert.ok(typeof it.price === 'number' && it.price >= 0);
      assert.ok(it.images.length > 0);
    }
  });

  test('maps fields exactly for a known product', () => {
    const delmonte = r.items.find(i => i.sku === '939827');
    assert.ok(delmonte, 'Del Monte Banana (sku 939827) present');
    assert.equal(delmonte!.title, 'Del Monte Banana - Ecuador, 150g');
    assert.equal(delmonte!.price, 2.15);
    assert.equal(delmonte!.stockAmount! > 0, true);
  });

  test('missing __NEXT_DATA__ yields no items, no throw', () => {
    const empty = parseTalabatGrocery('<html><body>no data</body></html>', SRC_URL);
    assert.equal(empty.items.length, 0);
    assert.ok(empty.warnings.length > 0);
  });
});

describe('collectTalabatGrocery', () => {
  const stubFetch = async () => FIXTURE;

  test('produces Groceries bundles with a single Talabat Mart offer', async () => {
    // One category page so the SKUs are unique (no cross-page dedupe collapse).
    const target = { ...TALABAT_PILOT, categories: [TALABAT_PILOT.categories[0]] };
    const res = await collectTalabatGrocery(target, { fetchHtml: stubFetch, logger: { log() {}, warn() {} } });

    assert.equal(res.bundles.length, 5);
    const b = res.bundles[0];
    assert.equal(b.broadCategory, 'Groceries');
    assert.equal(b.category, 'Groceries');
    assert.equal(b.subCategory, 'Fruits & Vegetables');
    assert.equal(b.retailerCount, 1);

    const offer = b.retailers[0];
    assert.equal(offer.retailerName, 'Talabat Mart');
    assert.equal(offer.retailerId, 'talabat');
    assert.equal(offer.currency, 'AED');
    assert.ok(offer.price! >= 0);
    assert.ok(offer.externalId); // SKU carried as externalId
  });

  test('each item on a shared page gets a UNIQUE productUrl (no write-time collapse)', async () => {
    const target = { ...TALABAT_PILOT, categories: [TALABAT_PILOT.categories[0]] };
    const res = await collectTalabatGrocery(target, { fetchHtml: stubFetch, logger: { log() {}, warn() {} } });
    const urls = res.bundles.map(b => b.retailers[0].productUrl);
    assert.equal(new Set(urls).size, urls.length, 'productUrls must be distinct per item');
  });

  test('parses the store category tree into subcategory targets', () => {
    const subs = parseStoreSubcategories(FIXTURE);
    assert.ok(subs.length > 0);
    for (const s of subs.slice(0, 5)) {
      assert.ok(s.categorySlug.length > 0);
      assert.ok(s.subCategorySlug.length > 0);
    }
  });

  test('extracts unique store refs + max page from an area listing', () => {
    const areaHtml = `<html><body>
      <a href="/uae/grocery/690014/talabat-mart-just-fruits-veg-jumeirah-1?aid=1172">store</a>
      <a href="/uae/grocery/690014/talabat-mart-just-fruits-veg-jumeirah-1/bananas/local?aid=1172">same store, category</a>
      <a href="/uae/grocery/783298/caesar-supermarket-business-bay?aid=1172">store 2</a>
      <a href="/uae/groceries/1172/al-badaa?page=4">next page</a>
    </body></html>`;
    const { stores, maxPage } = parseAreaStoreRefs(areaHtml);
    assert.equal(stores.length, 2); // deduped by branch id
    assert.ok(stores.some(s => s.branchId === '690014'));
    assert.equal(maxPage, 4);
  });

  test('crawl: discovers stores, crawls subcategories, respects the request cap (no network/DB)', async () => {
    const areaHtml = `<html><body>
      <a href="/uae/grocery/690014/talabat-mart-just-fruits-veg-jumeirah-1?aid=1172">store</a>
    </body></html>`;
    const fetchHtml = async (url: string) => (url.includes('/uae/groceries/') ? areaHtml : FIXTURE);
    const p = await crawlTalabatGrocery({
      areas: [{ id: '1172', slug: 'al-badaa' }],
      dryRun: true,
      maxRequests: 10,
      fetchHtml,
      logger: { log() {}, warn() {}, error() {} },
    });
    assert.equal(p.storesFound, 1);
    assert.equal(p.storesCrawled, 1);
    assert.ok(p.requests <= 10);
    assert.equal(p.capReached, true); // the fixture store has many subcategories, so the cap trips
    assert.ok(p.itemsSeen > 0);
  });

  test('dedupes by SKU across pages and caps at max', async () => {
    // Same page twice → same SKUs → must not double-count.
    const target = { ...TALABAT_PILOT, categories: [TALABAT_PILOT.categories[0], TALABAT_PILOT.categories[0]] };
    const res = await collectTalabatGrocery(target, { fetchHtml: stubFetch, logger: { log() {}, warn() {} } });
    assert.equal(res.bundles.length, 5);

    const capped = await collectTalabatGrocery(target, { fetchHtml: stubFetch, max: 3, logger: { log() {}, warn() {} } });
    assert.equal(capped.bundles.length, 3);
  });
});
