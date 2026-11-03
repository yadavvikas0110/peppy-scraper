/// <reference types="node" />
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { parseTalabatGrocery, parseStoreSubcategories, parseStoreSubcategoryHrefs, parseAreaStoreRefs } from '../../src/grocery/talabat-grocery.parser';
import { collectTalabatGrocery } from '../../src/grocery/talabat-grocery.collector';
import { crawlTalabatGrocery } from '../../src/grocery/grocery-crawl';
import { parseDeliverooGrocery } from '../../src/grocery/deliveroo-grocery.parser';
import { collectDeliverooGrocery } from '../../src/grocery/deliveroo-grocery.collector';
import { TALABAT_PILOT } from '../../src/grocery/talabat-grocery.config';
import * as os from 'os';
import { acquireLock, releaseLock, readLock } from '../../src/utils/stop-signal';

const DELIVEROO_FIXTURE = fs.readFileSync(
  path.join(__dirname, 'fixtures', 'deliveroo-hop.html'),
  'utf-8',
);

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

describe('parseDeliverooGrocery', () => {
  const r = parseDeliverooGrocery(DELIVEROO_FIXTURE, 'https://deliveroo.ae/menu/Dubai/hopjlt/deliveroo-hop-goldcrest');

  test('parses products with price in major units from __NEXT_DATA__', () => {
    assert.ok(r.items.length >= 1);
    for (const it of r.items) {
      assert.ok(it.title.length > 0);
      assert.ok(typeof it.price === 'number' && it.price >= 0);
      assert.ok(it.sku); // Deliveroo item id → externalId
    }
  });

  test('uses discounted price as current, base price as original (fractional/100)', () => {
    const first = r.items[0];
    assert.equal(first.price, 18.23);        // priceDiscounted 1823 → 18.23
    assert.equal(first.originalPrice, 26.04); // price 2604 → 26.04
    assert.equal(first.sku, '2832537561');
    assert.equal(first.stockAmount! > 0, true); // available: true
  });

  test('missing payload yields no items, no throw', () => {
    const empty = parseDeliverooGrocery('<html><body>x</body></html>', 'https://deliveroo.ae/menu/x/y/z');
    assert.equal(empty.items.length, 0);
    assert.ok(empty.warnings.length > 0);
  });

  test('collector produces Deliveroo Hop Groceries bundles with unique per-item URLs (no network/DB)', async () => {
    const res = await collectDeliverooGrocery(['https://deliveroo.ae/menu/Dubai/hopjlt/deliveroo-hop-goldcrest'], {
      fetchHtml: async () => DELIVEROO_FIXTURE,
      logger: { log() {}, warn() {} },
    });
    assert.ok(res.bundles.length >= 1);
    const b = res.bundles[0];
    assert.equal(b.broadCategory, 'Groceries');
    assert.equal(b.retailers[0].retailerId, 'deliveroo');
    assert.equal(b.retailers[0].retailerName, 'Deliveroo Hop');
    assert.equal(b.retailers[0].currency, 'AED');
    const urls = res.bundles.map(x => x.retailers[0].productUrl);
    assert.equal(new Set(urls).size, urls.length); // unique per item
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

  test('falls back to subcategory anchors from a store landing page', () => {
    const storeHtml = `<html><body>
      <a href="/uae/grocery/690014/slug/bananas/local?aid=1172">x</a>
      <a href="/uae/grocery/690014/slug/dairy-eggs/milk?aid=1172">y</a>
      <a href="/uae/grocery/690014/slug/bananas/local?aid=1172">dup</a>
      <a href="/uae/grocery/690014/slug?aid=1172">store landing, not a subcategory</a>
      <a href="/uae/groceries/1172/al-badaa">area, not a subcategory</a>
    </body></html>`;
    const hrefs = parseStoreSubcategoryHrefs(storeHtml);
    assert.equal(hrefs.length, 2); // deduped; landing + area excluded
    assert.ok(hrefs.every(u => u.startsWith('https://www.talabat.com/uae/grocery/690014/slug/')));
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

  test('per-platform locks are independent: holding one does not block the other', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'peppy-lock-'));
    const globalLock = path.join(dir, 'cron.lock');
    const deliverooLock = path.join(dir, 'cron.grocery.deliveroo.lock');
    try {
      // Talabat/e-commerce holds the global lock…
      assert.equal(acquireLock('grocery', globalLock), true);
      // …Deliveroo can still take its own lock and run concurrently.
      assert.equal(acquireLock('grocery', deliverooLock), true);
      assert.ok(readLock(globalLock));
      assert.ok(readLock(deliverooLock));
      // But a SECOND Deliveroo run is refused while the first holds it.
      assert.equal(acquireLock('grocery', deliverooLock), false);
      // Releasing one leaves the other intact.
      releaseLock(deliverooLock);
      assert.equal(readLock(deliverooLock), null);
      assert.ok(readLock(globalLock), 'global lock untouched by Deliveroo release');
      releaseLock(globalLock);
      assert.equal(readLock(globalLock), null);
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    }
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
