/// <reference types="node" />
/**
 * End-to-end, offline: the real orchestrator → real scrapeBulk (parallel lanes, checkpoints) → real
 * parsers on fixture pages → real bundler → S3 re-hosting (fake uploader) → real pushToDatabase into
 * an in-memory products_clean. Only the network, S3 and Mongo are faked.
 */
import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { scrapeBulk, BulkScrapeDeps } from '../../src/services/playwright.service';
import { bundleProducts } from '../../src/services/bundler.service';
import { parseLandmark, landmarkState } from '../../src/parsers/landmark.parser';
import { ProductData } from '../../src/parsers/types';
import { ImageRehoster } from '../../src/custom/core/images-s3';
import { ProductsCollection, pushToDatabase } from '../../src/cron/push-pipeline';
import { runShoppingBulk, CatalogCategory } from '../../src/shopping/shopping-bulk';

delete process.env.OPENAI_API_KEY;

const fx = (n: string) => fs.readFileSync(path.join(__dirname, 'fixtures', n), 'utf8');
const CDN = 'https://cdn.peppy.test/products/images';
const quiet = { log() {}, warn() {}, error() {} };
const EAN = '6292495613436';

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bulk-e2e-')); process.env.SCRAPER_CHECKPOINT_DIR = path.join(tmp, 'cp'); });
afterEach(() => { delete process.env.SCRAPER_CHECKPOINT_DIR; fs.rmSync(tmp, { recursive: true, force: true }); });

class MemoryProducts implements ProductsCollection {
  docs: any[] = [];
  private n = 1;
  find() { return { toArray: async () => structuredClone(this.docs) }; }
  async insertMany(docs: any[]) { for (const d of docs) this.docs.push({ _id: `p${this.n++}`, ...structuredClone(d) }); return { insertedCount: docs.length }; }
  async updateOne(f: any, u: any) {
    const d = this.docs.find(x => x._id === f._id);
    const same = d && (f.updatedAt === null ? d.updatedAt == null : d.updatedAt?.getTime?.() === f.updatedAt?.getTime?.());
    if (!same) return { matchedCount: 0, modifiedCount: 0 };
    Object.assign(d, structuredClone(u.$set));
    return { matchedCount: 1, modifiedCount: 1 };
  }
}

const HC_PRODUCT = 'https://www.homecentre.com/ae/en/buy-lusso-office-chair/p/168661612';
const AMAZON_ASIN = 'B0CHAIR001';

function amazonChair(url: string): ProductData {
  return {
    productName: 'Home Centre Lusso Electric Reclining Office Chair, Beige', productUrl: url,
    imageUrl: 'https://m.media-amazon.com/images/I/chair1.jpg', imageUrls: ['https://m.media-amazon.com/images/I/chair1.jpg'],
    price: 1449, currency: 'AED', ratings: 4.2, reviewCount: 31, description: null, inStock: true, category: null, gtin: EAN,
  };
}

/** The real listing fixture, with its first hit pointing at the office chair we have a product page for. */
function hcListingWithChair(): string {
  const html = fx('homecentre-listing.html');
  const state = landmarkState(html);
  state.algoliaProductReducer.data.hits[0].url = '/buy-lusso-office-chair/p/168661612';
  return html.replace(/("initialState":\s*")[^"]+"/, `$1${Buffer.from(JSON.stringify(state)).toString('base64')}"`);
}

function deps(): BulkScrapeDeps {
  let clock = Date.parse('2026-11-25T08:00:00.000Z');
  return {
    fetchSearchHtml: async url => {
      if (url.includes('homecentre.com')) return /\?p=/.test(url) ? '<html><title>empty</title></html>' : hcListingWithChair();
      if (url.includes('amazon.ae')) return /page=1$/.test(url) ? `<a href="/dp/${AMAZON_ASIN}">chair</a>` : '';
      return '';
    },
    scrapeProduct: async url => {
      if (url === HC_PRODUCT) return parseLandmark(fx('homecentre-product.html'), url);
      if (url.includes('amazon.ae')) return amazonChair(url);
      throw Object.assign(new Error(`Scrape.do could not fetch ${url} (404)`), { name: 'ScrapeDoNotFoundError' });
    },
    collectShopify: async () => [],
    bundle: bundleProducts,
    shouldStop: () => false,
    ensureTagger: async () => {},
    now: () => new Date((clock += 1000)),
    outputDir: path.join(tmp, 'out'),
    env: { SCRAPE_DO_TOKEN: 't', SCRAPE_DO_SITES: 'homecentre' },
  };
}

describe('bulk pipeline end-to-end (offline)', () => {
  test('Home Centre + Amazon office chairs → one product, two offers, our S3 images, real prices', async () => {
    const products = new MemoryProducts();
    const uploaded: string[] = [];
    const rehoster = new ImageRehoster(async src => { uploaded.push(src); return `${CDN}/${uploaded.length}.jpg`; }, u => u.startsWith(CDN), 4, quiet);
    const category: CatalogCategory = {
      key: 'office-chairs', label: 'Office Chairs', category: 'office chair', categoryKey: 'office-chairs',
      broadCategory: 'Home & Kitchen', subCategory: 'Furniture & Bedding', count: 6, platforms: ['homecentre', 'amazon'],
    };
    const base = deps();
    const report = await runShoppingBulk({ categories: [category], productConcurrency: 3 }, {
      scrapeBulk, bulkDeps: base, rehoster,
      push: b => pushToDatabase(b, { collection: products, now: new Date('2026-11-25T09:00:00.000Z'), requestMapping: async () => ({ ok: true, message: 't', mapped: 0 }), isOwnImage: u => u.startsWith(CDN) }),
      shouldStop: () => false, now: () => new Date('2026-11-25T09:00:00.000Z'), env: base.env, log: quiet,
    });

    const c = report.categories[0];
    assert.equal(c.siteResults.find(s => s.site === 'homecentre')!.scraped, 1);
    assert.equal(c.siteResults.find(s => s.site === 'homecentre')!.failed, 5, 'the 5 other listing links 404 in this fixture');
    assert.equal(c.comparisons, 1, 'barcode bundled the two platforms in memory');
    assert.equal(c.status, 'partial');

    assert.equal(products.docs.length, 1);
    const doc = products.docs[0];
    assert.deepEqual(doc.retailers.map((r: any) => r.retailerId).sort(), ['amazon', 'homecentre']);
    const hc = doc.retailers.find((r: any) => r.retailerId === 'homecentre');
    assert.equal(hc.price, 1399);
    assert.equal(hc.originalPrice, 1999);
    assert.equal(hc.externalId, '168661612');
    assert.equal(hc.gtin, EAN);
    assert.equal(doc.lowestPrice, 1399);
    assert.equal(doc.highestPrice, 1449);
    assert.deepEqual(doc.gtins, [EAN]);
    assert.equal(doc.category, 'Home & Kitchen');
    assert.equal(doc.subcategory, 'Furniture & Bedding');
    assert.ok(doc.images.length >= 10, 'Home Centre has the bigger gallery');
    assert.ok(doc.images.every((u: string) => u.startsWith(CDN)), 'only our S3 URLs are stored');
    assert.ok(doc.retailers.every((r: any) => !r.imageUrl || r.imageUrl.startsWith(CDN)));
    assert.equal(doc.ingestMappingStatus, 'pending', 'the backend maps categories afterwards');
    assert.ok(uploaded.every(u => !u.startsWith(CDN)));

    // A later, separate Carrefour run with a different title merges into the same product by barcode
    const carrefourBundle = await bundleProducts([{ site: 'carrefour', data: {
      ...amazonChair('https://www.carrefouruae.com/mafuae/en/office-chairs/lusso/p/1234567'),
      productName: 'Lusso Office Chair With Electric Recline', price: 1389, imageUrl: 'https://cdn.mafrservices.com/x.jpg', imageUrls: ['https://cdn.mafrservices.com/x.jpg'],
      scrapedAt: '2026-11-25T10:00:00.000Z',
    } }], 'office chair', 'Home & Kitchen', 'Furniture & Bedding');
    const { rehostBundleImages } = await import('../../src/services/shopping-images');
    await rehostBundleImages(carrefourBundle, rehoster);
    await pushToDatabase(carrefourBundle, { collection: products, now: new Date('2026-11-25T10:05:00.000Z'), requestMapping: async () => ({ ok: true, message: 't', mapped: 0 }), isOwnImage: u => u.startsWith(CDN) });
    assert.equal(products.docs.length, 1);
    assert.equal(products.docs[0].retailers.length, 3);
    assert.equal(products.docs[0].lowestPrice, 1389);
  });
});
