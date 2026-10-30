/// <reference types="node" />
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  canonicalProductUrl,
  extractAmazonAsin,
  extractNoonSku,
  isAffiliateUrl,
  marketplaceIdFor,
  offerIdentityKey,
} from '../../src/services/product-identity';

describe('marketplace identity', () => {
  test('reads the ASIN from every Amazon URL shape, ignoring tags and slugs', () => {
    for (const url of [
      'https://www.amazon.ae/dp/B0DGHYDZR9',
      'https://www.amazon.ae/Apple-iPhone-16-128GB-Black/dp/B0DGHYDZR9/ref=sr_1_1?keywords=iphone',
      'https://www.amazon.ae/dp/B0DGHYDZR9?th=1&linkCode=ll2&tag=peppy1121-21&linkId=1993b85ffd34905688f8007cf260d7b1',
      'https://amazon.ae/gp/product/b0dghydzr9',
    ]) {
      assert.equal(extractAmazonAsin(url), 'B0DGHYDZR9', url);
    }
    assert.equal(extractAmazonAsin('https://www.amazon.ae/s?k=iphone'), null);
    assert.equal(extractAmazonAsin('https://www.noon.com/dp/B0DGHYDZR9'), null);
  });

  test('reads the Noon SKU from the segment before /p/', () => {
    assert.equal(extractNoonSku('https://www.noon.com/uae-en/iphone-16-128gb-black/N70104532V/p/?o=abc'), 'N70104532V');
    assert.equal(extractNoonSku('https://www.noon.com/uae-en/slug/ZB0088742F2F26BC90BEBZ/p/'), 'ZB0088742F2F26BC90BEBZ');
    // Short affiliate links carry no SKU — identity must not be guessed
    assert.equal(extractNoonSku('https://s.noon.com/duNm4YprxUg'), null);
  });

  test('canonical URLs collapse tracking and affiliate differences', () => {
    assert.equal(
      canonicalProductUrl('https://www.amazon.ae/Apple-iPhone/dp/B0DGHYDZR9?tag=peppy1121-21&th=1'),
      canonicalProductUrl('https://amazon.ae/dp/B0DGHYDZR9'),
    );
    assert.equal(
      canonicalProductUrl('https://www.carrefouruae.com/mafuae/en/p/123456?utm_source=x#reviews'),
      'https://carrefouruae.com/mafuae/en/p/123456',
    );
    assert.equal(canonicalProductUrl('not a url'), null);
  });

  test('affiliate links are recognised so they can be preserved', () => {
    assert.equal(isAffiliateUrl('https://www.amazon.ae/dp/B0DGHYDZR9?tag=peppy1121-21'), true);
    assert.equal(isAffiliateUrl('https://s.noon.com/duNm4YprxUg'), true);
    assert.equal(isAffiliateUrl('https://www.amazon.ae/dp/B0DGHYDZR9'), false);
  });

  test('identity keys prefer marketplace IDs and fall back to canonical URLs', () => {
    assert.equal(offerIdentityKey('amazon', 'https://www.amazon.ae/x/dp/B0DGHYDZR9?tag=t'), 'amazon:id:B0DGHYDZR9');
    assert.equal(offerIdentityKey('sharafdg', 'https://uae.sharafdg.com/product/iphone-16/?ref=x'), 'sharafdg:url:https://uae.sharafdg.com/product/iphone-16');
    assert.equal(marketplaceIdFor('carrefour', 'https://www.carrefouruae.com/mafuae/en/smartphones/p/8806095528922'), '8806095528922');
  });
});
