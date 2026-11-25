/// <reference types="node" />
/**
 * Cross-platform merge: the same product scraped by separate (or parallel) jobs on different
 * platforms must end up as ONE products_clean document with one offer per retailer — and different
 * products must never be merged, whatever their titles share.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { crossMatchKeys, crossMatchConflict, findCrossRetailerMatch, brandKey } from '../../src/services/cross-match';
import { ProductsCollection, pushToDatabase, toMongoProduct, mergeImages } from '../../src/cron/push-pipeline';
import { BundledProduct, RetailerOffer } from '../../src/parsers/types';
import { bundleProducts } from '../../src/services/bundler.service';

delete process.env.OPENAI_API_KEY;

const SEEN = '2026-11-25T08:00:00.000Z';
const NOW = new Date('2026-11-25T09:00:00.000Z');
const CDN = 'https://cdn.peppy.test/products/images';
const own = (u: string) => u.startsWith(CDN);

function offer(retailerId: string, price: number, extra: Partial<RetailerOffer> = {}): RetailerOffer {
  return {
    retailerId, retailerName: retailerId, price, currency: 'AED', inStock: true, productUrl: `https://${retailerId}.test/p/${Math.round(price)}`,
    imageUrl: `${CDN}/${retailerId}.jpg`, ratings: null, reviewCount: null, observedAt: SEEN, ...extra,
  };
}

function bundle(name: string, retailers: RetailerOffer[], extra: Partial<BundledProduct> = {}): BundledProduct {
  return {
    name, description: null, category: 'q', broadCategory: 'Electronics', subCategory: 'Smartphones', tags: [],
    images: [`${CDN}/${retailers[0].retailerId}-1.jpg`], lowestPrice: null, highestPrice: null, rating: null, reviewCount: null,
    retailerCount: retailers.length, retailers, ...extra,
  };
}

class FakeCollection implements ProductsCollection {
  docs: any[] = [];
  private id = 1;
  find() { return { toArray: async () => structuredClone(this.docs) }; }
  async insertMany(docs: any[]) { for (const d of docs) this.docs.push({ _id: `d${String(this.id++).padStart(3, '0')}`, ...structuredClone(d) }); return { insertedCount: docs.length }; }
  async updateOne(filter: any, update: any) {
    const doc = this.docs.find(d => d._id === filter._id);
    const same = doc && (filter.updatedAt === null ? doc.updatedAt == null : doc.updatedAt?.getTime?.() === filter.updatedAt?.getTime?.());
    if (!same) return { matchedCount: 0, modifiedCount: 0 };
    Object.assign(doc, structuredClone(update.$set));
    return { matchedCount: 1, modifiedCount: 1 };
  }
}

const push = (col: FakeCollection, bundles: BundledProduct[], now = NOW) =>
  pushToDatabase(bundles, { collection: col, now, requestMapping: async () => ({ ok: true, message: 'test', mapped: 0 }), isOwnImage: own });

describe('match keys', () => {
  test('brand + model tokens; storage, units and years are not model numbers', () => {
    assert.deepEqual(crossMatchKeys('Apple iPhone 16 128GB Black'), ['apple|16']);
    assert.deepEqual(crossMatchKeys('Samsung Galaxy S24 Ultra 5G 256GB (2024)').sort(), ['samsung|s24']);
    assert.deepEqual(crossMatchKeys('Philips Airfryer XXL HD9650/90 7.3L', 'Philips').sort(), ['philips|hd9650', 'philips|90'].sort());
    assert.deepEqual(crossMatchKeys('Lusso Office Chair', 'Home Centre'), [], 'no model token → no fuzzy matching');
    assert.deepEqual(crossMatchKeys('Generic Wireless Earbuds 2'), [], 'no known or stated brand → no fuzzy matching');
    assert.deepEqual(crossMatchKeys('iPhone 16 128GB - Black (Apple)'), ['apple|16'], 'brand implied by the product line');
    assert.deepEqual(crossMatchKeys('Galaxy S25 Ultra 5G 256GB Titanium Gray'), ['samsung|s25']);
  });

  test('a known brand in the title wins over the stated brand string', () => {
    assert.equal(brandKey('Samsung Galaxy S24', 'Samsung Electronics'), 'samsung');
    assert.equal(brandKey('Air Fryer 5.5 L', 'BLACK+DECKER'), 'blackdecker');
    assert.equal(brandKey('Air Fryer 5.5 L', 'Black & Decker'), 'blackdecker');
  });
});

describe('guards (same rules as the in-job bundler)', () => {
  const stored = (name: string, retailers: any[]) => ({ _id: 'x', name, retailers, matchKeys: crossMatchKeys(name) });
  const p = (name: string, retailerId = 'carrefour', price = 3000) => ({ name, matchKeys: crossMatchKeys(name), retailers: [{ retailerId, price, stockStatus: 'available' }] });

  test('same model on another platform matches', () => {
    assert.equal(crossMatchConflict(p('iPhone 16 128GB Black Apple'), stored('Apple iPhone 16 128GB Black', [{ retailerId: 'amazon', price: 3099 }])), null);
  });

  test('variant, accessory, brand, price and same-retailer conflicts never merge', () => {
    const doc = stored('Apple iPhone 16 128GB Black', [{ retailerId: 'amazon', price: 3099 }]);
    assert.equal(crossMatchConflict(p('Apple iPhone 16 256GB Black'), doc), 'variant_mismatch');
    assert.equal(crossMatchConflict(p('Apple iPhone 16 Pro 128GB Black'), doc), 'variant_mismatch');
    assert.equal(crossMatchConflict(p('Apple iPhone 16 Clear Case', 'carrefour', 99), doc), 'role_mismatch');
    assert.equal(crossMatchConflict(p('Apple iPhone 16 128GB Black', 'carrefour', 999), doc), 'price_ratio');
    assert.equal(crossMatchConflict(p('Apple iPhone 16 128GB Black', 'amazon'), doc), 'same_retailer');
    assert.equal(crossMatchConflict(p('Apple iPhone 15 128GB Black'), doc), 'no_shared_key');
  });

  test('barcode wins even when titles differ completely', () => {
    const doc = { _id: 'g', name: 'Prestige 1500W Air Fryer 5.5 L', retailers: [{ retailerId: 'homecentre', price: 298, gtin: '6292495613436' }] };
    const m = findCrossRetailerMatch({ name: 'PRESTIGE Digital Airfryer PR-AF55', gtins: ['6292495613436'], retailers: [{ retailerId: 'amazon', price: 310 }] }, [doc]);
    assert.equal(m?._id, 'g');
  });
});

describe('pushToDatabase: separate platform runs merge into one product', () => {
  test('Amazon run, then a Carrefour run with a different title → one document, two offers, price range', async () => {
    const col = new FakeCollection();
    await push(col, [bundle('Apple iPhone 16 128GB Black', [offer('amazon', 3099)], { brand: 'Apple' })]);
    const r = await push(col, [bundle('iPhone 16 128GB - Black (Apple)', [offer('carrefour', 2999)])]);
    assert.equal(col.docs.length, 1, 'no duplicate product');
    assert.equal(r.matchedExisting, 1);
    const d = col.docs[0];
    assert.deepEqual(d.retailers.map((o: any) => o.retailerId).sort(), ['amazon', 'carrefour']);
    assert.equal(d.lowestPrice, 2999);
    assert.equal(d.highestPrice, 3099);
    assert.equal(d.name, 'Apple iPhone 16 128GB Black', 'stored name is kept');
    assert.ok(d.matchKeys.includes('apple|16'));
  });

  test('two lanes in ONE push (parallel scrapes of a category) also merge, through the batch inserts', async () => {
    const col = new FakeCollection();
    await push(col, [
      bundle('Samsung Galaxy S25 Ultra 256GB Titanium Gray', [offer('amazon', 4499)]),
      bundle('Galaxy S25 Ultra 5G 256GB Titanium Gray Samsung', [offer('noon', 4399)]),
    ]);
    assert.equal(col.docs.length, 1);
    assert.equal(col.docs[0].retailers.length, 2);
  });

  test('barcode merge across Home Centre and Amazon; barcodes are kept on the product', async () => {
    const col = new FakeCollection();
    await push(col, [bundle('Prestige 1500W Air Fryer with Transparent Window - 5.5 L', [offer('homecentre', 298, { gtin: '6291234567893' })], { broadCategory: 'Home & Kitchen', subCategory: 'Kitchen Appliances' })]);
    await push(col, [bundle('PRESTIGE Air Fryer PR50 Digital 5.5L Black', [offer('amazon', 315, { gtin: '6291234567893' })], { broadCategory: 'Home & Kitchen', subCategory: 'Kitchen Appliances' })]);
    assert.equal(col.docs.length, 1);
    assert.deepEqual(col.docs[0].gtins, ['6291234567893']);
    assert.equal(col.docs[0].retailers.find((r: any) => r.retailerId === 'amazon').gtin, '6291234567893');
  });

  test('different variants and accessories stay separate products', async () => {
    const col = new FakeCollection();
    await push(col, [bundle('Apple iPhone 16 128GB Black', [offer('amazon', 3099)])]);
    await push(col, [bundle('Apple iPhone 16 256GB Black', [offer('carrefour', 3499)])]);
    await push(col, [bundle('Apple iPhone 16 Silicone Case with MagSafe', [offer('noon', 199)])]);
    await push(col, [bundle('iPhone 16 128GB Black (Apple)', [offer('jumbo', 899)])]); // implausible price → not merged
    assert.equal(col.docs.length, 4);
  });

  test('re-pushing the same listing updates its offer, never duplicates it', async () => {
    const col = new FakeCollection();
    const b = () => bundle('Apple iPhone 16 128GB Black', [offer('amazon', 3099, { productUrl: 'https://www.amazon.ae/dp/B0DGHYDZR9' })]);
    await push(col, [b()]);
    await push(col, [bundle('Apple iPhone 16 128GB Black', [offer('amazon', 2949, { productUrl: 'https://www.amazon.ae/dp/B0DGHYDZR9', observedAt: '2026-11-25T08:30:00.000Z' })])]);
    assert.equal(col.docs.length, 1);
    assert.equal(col.docs[0].retailers.length, 1);
    assert.equal(col.docs[0].retailers[0].price, 2949);
  });

  test('groceries keep their own key and never use fuzzy model matching', () => {
    const p = toMongoProduct(bundle('Almarai Fresh Milk Full Fat 1L', [offer('talabat', 7)], { broadCategory: 'Groceries', subCategory: 'Dairy & Eggs' }))!;
    assert.equal(p.matchKeys, undefined);
  });
});

describe('in-job bundler: barcode match', () => {
  test('equal GTIN on two platforms bundles even when titles share little', async () => {
    const data = (name: string, url: string, price: number, gtin: string) => ({
      productName: name, productUrl: url, imageUrl: 'https://i/1.jpg', imageUrls: ['https://i/1.jpg'], price, currency: 'AED',
      ratings: null, reviewCount: null, description: null, inStock: true, category: null, gtin,
    });
    const bundles = await bundleProducts([
      { site: 'homecentre', data: data('Lusso Office Chair Beige', 'https://www.homecentre.com/ae/en/buy-lusso/p/168661612', 1399, '6292495613436') },
      { site: 'amazon', data: data('HC Ergonomic Recliner Desk Seat', 'https://www.amazon.ae/dp/B000000001', 1450, '6292495613436') },
    ], 'office chair', 'Home & Kitchen', 'Furniture & Bedding');
    assert.equal(bundles.length, 1);
    assert.equal(bundles[0].retailers.length, 2);
  });
});

describe('images: stored retailer URLs are upgraded to our S3 copies', () => {
  test('own images kept; foreign ones replaced by this run\'s re-hosted images; never emptied', () => {
    assert.deepEqual(mergeImages([`${CDN}/a.jpg`], [`${CDN}/b.jpg`], { isOwnImage: own }), [`${CDN}/a.jpg`]);
    assert.deepEqual(mergeImages(['https://m.media-amazon.com/x.jpg', `${CDN}/a.jpg`], [`${CDN}/b.jpg`], { isOwnImage: own }), [`${CDN}/a.jpg`, `${CDN}/b.jpg`]);
    assert.deepEqual(mergeImages(['https://m.media-amazon.com/x.jpg'], [], { isOwnImage: own }), ['https://m.media-amazon.com/x.jpg']);
    assert.deepEqual(mergeImages(['https://m.media-amazon.com/x.jpg'], [`${CDN}/b.jpg`]), ['https://m.media-amazon.com/x.jpg'], 'without the predicate (other pipelines) nothing changes');
  });

  test('push replaces a legacy retailer-URL gallery on an existing document', async () => {
    const col = new FakeCollection();
    col.docs.push({ _id: 'old', name: 'Apple iPhone 16 128GB Black', images: ['https://m.media-amazon.com/legacy.jpg'], retailers: [], updatedAt: null });
    await push(col, [bundle('Apple iPhone 16 128GB Black', [offer('amazon', 3099)])]);
    assert.deepEqual(col.docs[0].images, [`${CDN}/amazon-1.jpg`]);
  });
});

describe('match-key backfill for products stored before cross-platform matching', () => {
  test('adds keys and barcodes only; groceries and already-keyed products are left alone', async () => {
    const { matchFieldsFor, backfillMatchKeys } = await import('../../src/cron/backfill-match-keys');
    assert.deepEqual(matchFieldsFor({ name: 'Apple iPhone 16 128GB Black', retailers: [{ gtin: '0194253000001' }] }), { matchKeys: ['apple|16'], gtins: ['0194253000001'] });
    assert.equal(matchFieldsFor({ name: 'Apple iPhone 16 128GB Black', matchKeys: ['apple|16'], retailers: [] }), null);
    assert.equal(matchFieldsFor({ name: 'Almarai Milk 1L', category: 'Groceries', retailers: [] }), null);
    assert.equal(matchFieldsFor({ name: 'Lusso Office Chair', brand: 'Home Centre', retailers: [] }), null);

    const docs = [
      { _id: 'a', name: 'Samsung Galaxy S24 Ultra 256GB', retailers: [{ retailerId: 'amazon', price: 4000 }], updatedAt: new Date('2026-01-01') },
      { _id: 'b', name: 'Almarai Milk 1L', category: 'Groceries', retailers: [] },
    ];
    const updates: any[] = [];
    const col = { find: () => ({ toArray: async () => structuredClone(docs) }), updateOne: async (f: any, u: any) => { updates.push([f, u]); return { matchedCount: 1, modifiedCount: 1 }; } };
    const dry = await backfillMatchKeys(col, false);
    assert.equal(dry.updated, 1);
    assert.equal(updates.length, 0, 'dry run writes nothing');
    const live = await backfillMatchKeys(col, true);
    assert.equal(live.updated, 1);
    assert.deepEqual(updates[0], [{ _id: 'a' }, { $set: { matchKeys: ['samsung|s24'] } }], 'only the new fields; updatedAt untouched');
    assert.equal(live.skippedGroceries, 1);

    // After the backfill, a Noon listing finds the stored Amazon product
    const stored = { ...docs[0], matchKeys: ['samsung|s24'] };
    const m = findCrossRetailerMatch({ name: 'Galaxy S24 Ultra 5G 256GB Titanium Black', matchKeys: crossMatchKeys('Galaxy S24 Ultra 5G 256GB Titanium Black'), retailers: [{ retailerId: 'noon', price: 3899 }] }, [stored]);
    assert.equal(m?._id, 'a');
  });
});

describe('colour guard', () => {
  test('different stated colours never merge; a missing colour or a colour-named brand gives no signal', async () => {
    const { coloursCompatible, identityConflict } = await import('../../src/services/bundler.service');
    assert.equal(identityConflict('Apple iPhone 16 128GB Black', 'Apple iPhone 16 128GB White'), 'colour_mismatch');
    assert.equal(coloursCompatible('Apple iPhone 16 128GB Space Gray', 'iPhone 16 128GB Grey'), true);
    assert.equal(coloursCompatible('Apple iPhone 16 128GB', 'Apple iPhone 16 128GB White'), true);
    assert.equal(coloursCompatible('BLACK+DECKER 1.7L Kettle White', 'Black & Decker Kettle 1.7L White'), true);
    assert.equal(coloursCompatible('Black+Decker Kettle', 'BLACK+DECKER Kettle Silver'), true);
    const col = new FakeCollection();
    await push(col, [bundle('Apple iPhone 16 128GB Black', [offer('amazon', 3099)])]);
    await push(col, [bundle('iPhone 16 128GB White (Apple)', [offer('carrefour', 3049)])]);
    assert.equal(col.docs.length, 2);
  });
});

describe('offers whose images could not be uploaded (Carrefour CDN refuses direct downloads)', () => {
  test('join an existing product (price comparison kept) but never create a new one', async () => {
    const col = new FakeCollection();
    await push(col, [bundle('Philips Airfryer NA350 Black', [offer('amazon', 449)], { broadCategory: 'Home & Kitchen', subCategory: 'Kitchen Appliances' })]);
    const r = await push(col, [
      bundle('Philips Airfryer NA350, Black', [offer('carrefour', 435)], { images: [], broadCategory: 'Home & Kitchen', subCategory: 'Kitchen Appliances' }),
      bundle('Kenwood Air Fryer HFP50 Black', [offer('carrefour', 246)], { images: [], broadCategory: 'Home & Kitchen', subCategory: 'Kitchen Appliances' }),
    ]);
    assert.equal(col.docs.length, 1, 'the image-less Kenwood was not inserted');
    assert.equal(r.skipped, 1);
    assert.deepEqual(col.docs[0].retailers.map((o: any) => o.retailerId).sort(), ['amazon', 'carrefour']);
    assert.equal(col.docs[0].lowestPrice, 435);
    assert.ok(col.docs[0].images.length > 0 && col.docs[0].images.every((u: string) => u.startsWith(CDN)), 'gallery untouched');
  });
});
