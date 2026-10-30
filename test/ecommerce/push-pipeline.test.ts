/// <reference types="node" />
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  derivePricing,
  findExistingDocument,
  markStaleInDocument,
  markStaleOffers,
  mergeDuplicateBundles,
  mergeOffer,
  mergeProduct,
  MongoProduct,
  ProductsCollection,
  pushToDatabase,
  toMongoProduct,
  writeProducts,
} from '../../src/cron/push-pipeline';
import { BundledProduct, RetailerOffer } from '../../src/parsers/types';

const SEEN = '2026-10-29T10:00:00.000Z';
const NOW = new Date('2026-10-29T12:00:00.000Z');

function offer(retailerId: string, price: number | null, productUrl = `https://${retailerId}.test/p`, extra: Partial<RetailerOffer> = {}): RetailerOffer {
  return {
    retailerId, retailerName: retailerId, price, currency: 'AED', inStock: true, productUrl, imageUrl: null,
    ratings: null, reviewCount: null, observedAt: SEEN, ...extra,
  };
}

function bundle(name: string, retailers: RetailerOffer[], extra: Partial<BundledProduct> = {}): BundledProduct {
  return {
    name, description: null, category: 'q', broadCategory: 'Electronics', subCategory: 'Smartphones', tags: ['smartphone'],
    images: ['https://img.test/1.jpg'], lowestPrice: null, highestPrice: null, rating: null, reviewCount: null,
    retailerCount: retailers.length, retailers, ...extra,
  };
}

const product = (b: BundledProduct) => toMongoProduct(b)!;

/** In-memory stand-in for products_clean with the same optimistic-concurrency semantics. */
class FakeCollection implements ProductsCollection {
  docs: any[] = [];
  private nextId = 1;
  /** Simulates a concurrent edit: bumps updatedAt of matching docs right before the next update */
  interfereOnce: ((doc: any) => boolean) | null = null;

  constructor(seed: any[] = []) {
    for (const d of seed) this.docs.push({ _id: `seed${this.nextId++}`, ...structuredClone(d) });
  }
  find() {
    return { toArray: async () => structuredClone(this.docs) };
  }
  async insertMany(docs: any[]) {
    for (const d of docs) this.docs.push({ _id: `new${this.nextId++}`, ...structuredClone(d) });
    return { insertedCount: docs.length };
  }
  async updateOne(filter: any, update: any) {
    if (this.interfereOnce) {
      const hit = this.docs.find(this.interfereOnce);
      if (hit) { hit.updatedAt = new Date('2026-10-29T11:59:00.000Z'); this.interfereOnce = null; }
    }
    const doc = this.docs.find(d => d._id === filter._id);
    const sameVersion = doc && (filter.updatedAt === null ? doc.updatedAt == null : doc.updatedAt?.getTime?.() === filter.updatedAt?.getTime?.());
    if (!doc || !sameVersion) return { matchedCount: 0, modifiedCount: 0 };
    Object.assign(doc, structuredClone(update.$set));
    return { matchedCount: 1, modifiedCount: 1 };
  }
}

describe('toMongoProduct stock policy', () => {
  test('keeps evidence-based stock; unknown stays unknown (inStock null), never true', () => {
    const p = product(bundle('Phone', [
      offer('amazon', 100, undefined, { inStock: true }),
      offer('noon', 110, undefined, { inStock: null }),
      offer('carrefour', 90, undefined, { inStock: false }),
    ]));
    assert.deepEqual(p.retailers.map(r => [r.retailerId, r.stockStatus, r.inStock]), [
      ['amazon', 'available', true], ['noon', 'unknown', null], ['carrefour', 'unavailable', false],
    ]);
  });

  test('keeps a priceless offer only when it says unavailable; drops products without images', () => {
    const p = product(bundle('Phone', [offer('amazon', null, undefined, { inStock: false }), offer('noon', null, undefined, { inStock: null })]));
    assert.deepEqual(p.retailers.map(r => r.retailerId), ['amazon']);
    assert.equal('price' in p.retailers[0], false);
    assert.equal(toMongoProduct(bundle('Phone', [offer('amazon', 100)], { images: [] })), null);
  });

  test('lastSeenAt is the observation time, not the push time', () => {
    const p = product(bundle('Phone', [offer('amazon', 100)]));
    assert.equal(p.retailers[0].lastSeenAt?.toISOString(), SEEN);
    const unobserved = product(bundle('Phone', [offer('amazon', 100, undefined, { observedAt: null })]));
    assert.equal('lastSeenAt' in unobserved.retailers[0], false);
  });

  test('stores marketplace identity alongside the URL', () => {
    const p = product(bundle('Phone', [offer('amazon', 100, 'https://www.amazon.ae/Phone/dp/B0DGHYDZR9?ref=x')]));
    assert.equal(p.retailers[0].externalId, 'B0DGHYDZR9');
    assert.equal(p.retailers[0].canonicalUrl, 'https://amazon.ae/dp/B0DGHYDZR9');
  });
});

describe('derivePricing', () => {
  const r = (retailerId: string, price: number, stockStatus: string, isStale = false) => ({ retailerId, price, stockStatus, isStale });

  test('unavailable and stale offers never set the price; unknown stays in the range but not in the confirmed best price', () => {
    const d = derivePricing([
      r('amazon', 999, 'unavailable'),
      r('noon', 1500, 'unknown'),
      r('carrefour', 1700, 'available'),
      r('jumbo', 900, 'available', true),
    ], 4.5, 120);
    assert.equal(d.lowestPrice, 1500);
    assert.equal(d.highestPrice, 1700);
    assert.equal(d.bestConfirmedPrice, 1700);
    assert.equal(d.isTrending, true);
    assert.equal(d.isTopRated, true);
  });

  test('a product whose offers are all unavailable has no price (hidden from listings)', () => {
    const d = derivePricing([r('amazon', 999, 'unavailable')], 5, 500);
    assert.equal(d.lowestPrice, null);
    assert.equal(d.bestConfirmedPrice, null);
    assert.equal(d.isTrending, false);
  });

  test('legacy offers without stockStatus fall back to their inStock flag', () => {
    const d = derivePricing([{ retailerId: 'amazon', price: 50, inStock: false }, { retailerId: 'noon', price: 60, inStock: true }]);
    assert.equal(d.lowestPrice, 60);
    assert.equal(d.bestConfirmedPrice, 60);
  });

  test('trending needs two comparable retailers plus social proof (backend rule)', () => {
    assert.equal(derivePricing([r('amazon', 1, 'available'), r('noon', 1, 'unknown')], 3, 10).isTrending, false);
    assert.equal(derivePricing([r('amazon', 1, 'available'), r('noon', 1, 'unavailable')], 5, 500).isTrending, false);
  });
});

describe('mergeOffer', () => {
  const stored = {
    retailerId: 'amazon', retailerName: 'Amazon', price: 120, currency: 'AED', inStock: true, stockStatus: 'available',
    productUrl: 'https://www.amazon.ae/dp/B0DGHYDZR9?tag=peppy1121-21&linkId=abc', retailerLogo: 'logo.svg',
    lastSeenAt: new Date('2026-10-28T10:00:00.000Z'),
  };
  const incoming = product(bundle('Phone', [offer('amazon', 100, 'https://www.amazon.ae/dp/B0DGHYDZR9')])).retailers[0];

  test('updates the price, keeps the affiliate URL of the same listing and extra fields', () => {
    const m = mergeOffer(stored, incoming);
    assert.equal(m.price, 100);
    assert.equal(m.productUrl, stored.productUrl);
    assert.equal(m.retailerLogo, 'logo.svg');
    assert.equal(m.isStale, false);
    assert.equal(m.lastSeenAt.toISOString(), SEEN);
  });

  test('a different listing replaces the URL', () => {
    const other = product(bundle('Phone', [offer('amazon', 100, 'https://www.amazon.ae/dp/B0OTHER001')])).retailers[0];
    assert.equal(mergeOffer(stored, other).productUrl, 'https://www.amazon.ae/dp/B0OTHER001');
  });

  test('an older observation never overwrites a newer one', () => {
    const newer = { ...stored, lastSeenAt: new Date('2026-10-29T11:00:00.000Z') };
    assert.equal(mergeOffer(newer, incoming), newer);
    const unobserved = { ...incoming, lastSeenAt: undefined };
    assert.equal(mergeOffer(stored, unobserved), stored);
  });

  test('a priceless unavailable observation marks stock only, keeping the stored price and redirect', () => {
    const oos = product(bundle('Phone', [offer('amazon', null, 'https://www.amazon.ae/dp/B0DGHYDZR9', { inStock: false })])).retailers[0];
    const m = mergeOffer(stored, oos);
    assert.equal(m.price, 120);
    assert.equal(m.stockStatus, 'unavailable');
    assert.equal(m.inStock, false);
    assert.equal(m.productUrl, stored.productUrl);
    assert.equal(mergeOffer(undefined, oos), null);
  });
});

describe('mergeProduct', () => {
  test('fills, never overwrites, admin-owned fields and never writes mapping fields', () => {
    const existing = {
      name: 'Admin Name', category: 'Gadgets', images: ['s3.jpg'], productRole: 'main_product', variantGroupId: 'g1',
      categories: ['Gadgets'], retailers: [{ retailerId: 'noon', price: 90, stockStatus: 'available', lastSeenAt: new Date(SEEN) }],
    };
    const set = mergeProduct(existing, product(bundle('Scraped Name', [offer('amazon', 100)])), NOW);
    assert.equal(set.name, 'Admin Name');
    assert.equal(set.category, 'Gadgets');
    assert.deepEqual(set.images, ['s3.jpg']);
    for (const field of ['productRole', 'variantGroupId', 'variantMappingStatus', 'categories', 'discoveryCategories']) {
      assert.equal(field in set, false, field);
    }
    assert.equal(set.ingestMappingStatus, 'pending');
    assert.equal(set.lowestPrice, 90);
    assert.deepEqual((set.retailers as any[]).map(r => r.retailerId), ['noon', 'amazon']);
  });
});

describe('duplicate prevention', () => {
  test('an affiliate-tagged legacy row is matched by ASIN, not duplicated by a different title', () => {
    const legacy = { _id: 'L1', name: 'Apple iPhone 16 128GB', retailers: [{ retailerId: 'amazon', productUrl: 'https://www.amazon.ae/dp/B0DGHYDZR9?th=1&tag=peppy1121-21&linkId=x', price: 3500 }] };
    const decoy = { _id: 'D1', name: 'Apple iPhone 16 (128 GB) - Black', retailers: [] };
    const p = product(bundle('Apple iPhone 16 (128 GB) - Black', [offer('amazon', 3399, 'https://www.amazon.ae/dp/B0DGHYDZR9')]));
    assert.equal(findExistingDocument(p, [decoy, legacy])._id, 'L1');
  });

  test('bundles from two queries for the same ASIN merge before writing', () => {
    const merged = mergeDuplicateBundles([
      bundle('Apple iPhone 16 128GB Black', [offer('amazon', 3399, 'https://www.amazon.ae/dp/B0DGHYDZR9')]),
      bundle('Apple iPhone 16 (128 GB) - Black', [offer('amazon', 3349, 'https://www.amazon.ae/x/dp/B0DGHYDZR9?ref=y', { observedAt: '2026-10-29T11:00:00.000Z' }), offer('noon', 3399)]),
    ]);
    assert.equal(merged.length, 1);
    assert.deepEqual(merged[0].retailers.map(r => [r.retailerId, r.price]), [['amazon', 3349], ['noon', 3399]]);
  });

  test('writing the same scrape twice updates one document instead of inserting two', async () => {
    const col = new FakeCollection([{ name: 'Apple iPhone 16 128GB', updatedAt: new Date(SEEN), retailers: [{ retailerId: 'amazon', productUrl: 'https://www.amazon.ae/dp/B0DGHYDZR9?tag=peppy1121-21', price: 3500 }] }]);
    const p: MongoProduct = product(bundle('Apple iPhone 16 (128 GB) - Black', [offer('amazon', 3399, 'https://www.amazon.ae/dp/B0DGHYDZR9')]));
    const first = await writeProducts(col, [p], NOW);
    const second = await writeProducts(col, [p], new Date('2026-10-29T13:00:00.000Z'));
    assert.deepEqual([first.inserted, first.updated, second.inserted], [0, 1, 0]);
    assert.equal(col.docs.length, 1);
    const stored = col.docs[0];
    assert.equal(stored.name, 'Apple iPhone 16 128GB');
    assert.equal(stored.retailers[0].price, 3399);
    assert.equal(stored.retailers[0].productUrl, 'https://www.amazon.ae/dp/B0DGHYDZR9?tag=peppy1121-21');
    assert.equal(stored.retailers[0].externalId, 'B0DGHYDZR9');
  });

  test('a concurrent edit is never overwritten; the product is re-read and retried', async () => {
    const col = new FakeCollection([{ name: 'Phone', updatedAt: new Date(SEEN), adminNote: 'keep', retailers: [] }]);
    col.interfereOnce = d => d.name === 'Phone';
    const r = await writeProducts(col, [product(bundle('Phone', [offer('amazon', 100)]))], NOW);
    assert.equal(r.conflicts, 1);
    assert.equal(r.updated, 1);
    assert.equal(col.docs[0].adminNote, 'keep');
    assert.equal(col.docs[0].retailers[0].price, 100);
  });

  test('products with only priceless offers never create documents', async () => {
    const col = new FakeCollection();
    const r = await writeProducts(col, [product(bundle('Ghost', [offer('amazon', null, undefined, { inStock: false })]))], NOW);
    assert.equal(r.skipped, 1);
    assert.equal(col.docs.length, 0);
  });
});

describe('stale offers', () => {
  const cutoff = new Date('2026-10-26T12:00:00.000Z');

  test('unseen offers become stale + unknown (not unavailable) and leave the price range', () => {
    const doc = {
      rating: 4.6, reviewCount: 200,
      retailers: [
        { retailerId: 'noon', price: 999, stockStatus: 'available', inStock: true, lastSeenAt: new Date('2026-10-20T00:00:00.000Z') },
        { retailerId: 'amazon', price: 1299, stockStatus: 'available', inStock: true, lastSeenAt: new Date('2026-10-29T00:00:00.000Z') },
        { retailerId: 'seeded', price: 10, inStock: true }, // other importer: no lastSeenAt — untouched
      ],
    };
    const update = markStaleInDocument(doc, cutoff)!;
    const [noon, amazon, seeded] = update.retailers as any[];
    assert.deepEqual([noon.isStale, noon.stockStatus, noon.inStock, noon.price], [true, 'unknown', null, 999]);
    assert.equal(amazon.isStale, undefined);
    assert.equal(seeded, doc.retailers[2]);
    assert.equal(update.lowestPrice, 10);
    assert.equal(update.bestConfirmedPrice, 10);
    assert.equal(markStaleInDocument({ retailers: [amazon] }, cutoff), null);
  });

  test('markStaleOffers recomputes derived prices in the same write', async () => {
    const col = new FakeCollection([{
      updatedAt: new Date(SEEN), rating: 4, reviewCount: 60, lowestPrice: 999, isTrending: true,
      retailers: [
        { retailerId: 'noon', price: 999, stockStatus: 'available', lastSeenAt: new Date('2026-10-20T00:00:00.000Z') },
        { retailerId: 'amazon', price: 1299, stockStatus: 'available', lastSeenAt: new Date('2026-10-29T00:00:00.000Z') },
      ],
    }]);
    const marked = await markStaleOffers(3, { collection: col, now: NOW });
    assert.equal(marked, 1);
    assert.equal(col.docs[0].lowestPrice, 1299);
    assert.equal(col.docs[0].isTrending, false);
  });
});

describe('pushToDatabase', () => {
  test('flags products for backend mapping and reports a failed mapping request', async () => {
    const col = new FakeCollection();
    const result = await pushToDatabase([bundle('Phone', [offer('amazon', 100)])], {
      collection: col, now: NOW, requestMapping: async () => ({ ok: false, message: 'PEPPY_BE_URL is not set' }),
    });
    assert.equal(result.mongoInserted, 1);
    assert.equal(col.docs[0].ingestMappingStatus, 'pending');
    assert.equal(result.mapping.ok, false);
    assert.match(result.errors.join(';'), /Backend mapping not applied/);
  });
});
