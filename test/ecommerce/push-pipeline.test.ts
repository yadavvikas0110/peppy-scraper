/// <reference types="node" />
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildProductUpdate,
  mergeDuplicateBundles,
  productFilter,
  toMongoProduct,
  MongoProduct,
} from '../../src/cron/push-pipeline';
import { BundledProduct, RetailerOffer } from '../../src/parsers/types';

function offer(retailerId: string, price: number | null, productUrl = `https://${retailerId}.test/p`): RetailerOffer {
  return { retailerId, retailerName: retailerId, price, currency: 'AED', inStock: null, productUrl, imageUrl: null, ratings: null, reviewCount: null };
}

function bundle(name: string, retailers: RetailerOffer[], extra: Partial<BundledProduct> = {}): BundledProduct {
  return {
    name, description: null, category: 'q', broadCategory: 'Electronics', subCategory: 'Smartphones', tags: ['smartphone'],
    images: ['https://img.test/1.jpg'], lowestPrice: null, highestPrice: null, rating: null, reviewCount: null,
    retailerCount: retailers.length, retailers, ...extra,
  };
}

describe('toMongoProduct', () => {
  test('drops offers without a price and products without images', () => {
    const p = toMongoProduct(bundle('Phone', [offer('amazon', 100), offer('noon', null)]))!;
    assert.deepEqual(p.retailers.map(r => r.retailerId), ['amazon']);
    assert.equal(toMongoProduct(bundle('Phone', [offer('amazon', 100)], { images: [] })), null);
    assert.equal(toMongoProduct(bundle('Phone', [offer('amazon', null)])), null);
  });

  test('never emits undefined fields (the driver would store them as null)', () => {
    const p = toMongoProduct(bundle('Phone', [offer('amazon', 100)]))!;
    const hasUndefined = (o: object): boolean => Object.values(o).some(v => v === undefined || (v && typeof v === 'object' && !Array.isArray(v) && hasUndefined(v)));
    assert.equal(hasUndefined(p), false);
    assert.equal(p.retailers.some(r => hasUndefined(r)), false);
    assert.equal('description' in p, false);
  });
});

describe('mergeDuplicateBundles', () => {
  test('combines the same product found by two queries, latest offer per retailer wins', () => {
    const merged = mergeDuplicateBundles([
      bundle('Galaxy S24 256GB', [offer('amazon', 2500), offer('noon', 2400)]),
      bundle('galaxy  s24 256gb', [offer('amazon', 2450), offer('carrefour', 2600)], { tags: ['5g'] }),
      bundle('Other phone', [offer('amazon', 900)]),
    ]);
    assert.equal(merged.length, 2);
    const s24 = merged.find(b => b.name === 'Galaxy S24 256GB')!;
    assert.deepEqual(s24.retailers.map(r => [r.retailerId, r.price]), [['amazon', 2450], ['noon', 2400], ['carrefour', 2600]]);
    assert.deepEqual(s24.tags.sort(), ['5g', 'smartphone']);
    assert.equal(s24.retailerCount, 3);
    assert.equal(s24.lowestPrice, 2400);
  });
});

describe('productFilter', () => {
  test('matches by name or by any retailer URL', () => {
    const p = toMongoProduct(bundle('Phone', [offer('amazon', 100, 'https://amazon.ae/dp/X')]))!;
    assert.deepEqual(productFilter(p), { $or: [{ name: 'Phone' }, { 'retailers.productUrl': { $in: ['https://amazon.ae/dp/X'] } }] });
  });
});

describe('buildProductUpdate', () => {
  const now = new Date('2026-10-28T00:00:00Z');
  const p: MongoProduct = toMongoProduct(bundle('$weird name', [offer('amazon', 100, '$url')]))!;
  const [first, second] = buildProductUpdate(p, now) as any[];

  test('only replaces offers for retailers in this run and keeps their extra fields', () => {
    const retailers = first.$set.retailers.$concatArrays;
    // existing offers from other retailers are kept
    assert.deepEqual(retailers[0].$filter.cond, { $not: [{ $in: ['$$r.retailerId', { $literal: ['amazon'] }] }] });
    // the incoming offer is merged onto the existing one (variants/retailerLogo survive)
    const merge = retailers[1][0].$mergeObjects;
    assert.equal(merge.length, 2);
    assert.equal(merge[1].$literal.price, 100);
    assert.equal(merge[1].$literal.lastSeenAt, now);
  });

  test('fills, never overwrites, name/category/images', () => {
    assert.deepEqual(first.$set.name, { $ifNull: ['$name', { $literal: '$weird name' }] });
    assert.deepEqual(first.$set.category, { $ifNull: ['$category', { $literal: 'Electronics' }] });
    assert.equal(first.$set.images.$cond[1], '$images');
  });

  test('wraps user data in $literal so "$" strings are not field paths', () => {
    const merged = first.$set.retailers.$concatArrays[1][0].$mergeObjects[1];
    assert.equal(merged.$literal.productUrl, '$url');
  });

  test('recomputes price range and flags from the merged retailers', () => {
    assert.ok(second.$set.lowestPrice.$min);
    assert.deepEqual(second.$set.isTrending, { $gte: [{ $size: '$retailers' }, 2] });
  });

  test('does not touch fields owned by the backend', () => {
    for (const field of ['productRole', 'variantGroupId', 'variantMappingStatus', 'variantMappingLocked', 'categories']) {
      assert.equal(field in first.$set, false, field);
    }
  });
});
