/// <reference types="node" />
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  classifyDeliverooOfferLabel,
  extractDeliverooMenuOffers,
  parseDeliverooOfferListing,
} from '../../src/dining/platforms/deliveroo/deliveroo.offers';
import { offerKeyOf } from '../../src/dining/offers/offer.key';
import { fixtureHtml } from './helpers';

const offerFixture = (name: string) => readFileSync(join(__dirname, 'fixtures', 'offers', name), 'utf8');

describe('Deliveroo menu page offers', () => {
  test('item-specific percentage offer: rule, eligible items, plus the free-delivery threshold', () => {
    const found = extractDeliverooMenuOffers(offerFixture('deliveroo-menu-item-specific-offer.html'))!;
    assert.equal(found.platformRestaurantId, '288186');
    assert.equal(found.offers.length, 2);
    const [items, delivery] = found.offers;
    assert.equal(items.type, 'PERCENT_OFF_ITEMS');
    assert.equal(items.platformTypeName, 'ItemSpecificPercentOffOffer');
    assert.equal(items.percentage, 30);
    assert.equal(items.minimumOrderValue, undefined, 'a zero minimum means no minimum');
    assert.equal(items.platformItemIds?.length, 5);
    assert.equal(items.currency, 'AED');
    assert.equal(delivery.type, 'FREE_DELIVERY');
    assert.equal(delivery.minimumOrderValue, 50);
    assert.equal(delivery.title, 'Spend AED 50 to get free delivery');
  });

  test('whole-menu percentage offer with a minimum order and a cap (listed once, not twice)', () => {
    const found = extractDeliverooMenuOffers(offerFixture('deliveroo-menu-full-menu-offer.html'))!;
    assert.equal(found.platformRestaurantId, '88048');
    assert.deepEqual(found.offers.map(o => [o.type, o.percentage, o.minimumOrderValue, o.maxDiscount]), [['PERCENT_OFF_MENU', 30, 50, 100]]);
    assert.equal(found.offers[0].title, 'Spend AED 50, unlock 30% off up to AED 100');
    assert.equal(found.offers[0].platformItemIds, undefined);
  });

  test('a restaurant with only the free-delivery threshold (existing Kamat fixture)', () => {
    const found = extractDeliverooMenuOffers(fixtureHtml('en'))!;
    assert.equal(found.platformRestaurantId, '76728');
    assert.deepEqual(found.offers.map(o => [o.type, o.minimumOrderValue]), [['FREE_DELIVERY', 50]]);
  });

  test('pages without usable data give null; a restaurant without an offer block gives an empty list', () => {
    assert.equal(extractDeliverooMenuOffers('<html></html>'), null);
    assert.equal(extractDeliverooMenuOffers('<script id="__NEXT_DATA__">{broken</script>'), null);
    const noOffer = '<script id="__NEXT_DATA__">{"props":{"initialState":{"menuPage":{"menu":{"metas":{"root":{"restaurant":{"id":"9"}}}}}}}}</script>';
    assert.deepEqual(extractDeliverooMenuOffers(noOffer), { platformRestaurantId: '9', offers: [] });
  });

  test('an unknown offer type is kept as OTHER with the platform type name', () => {
    const page = '<script id="__NEXT_DATA__">{"props":{"initialState":{"menuPage":{"menu":{"metas":{"root":{"restaurant":{"id":"9"},"offer":{"offers":[{"typeName":"SurpriseOffer"}]}}}}}}}}</script>';
    assert.deepEqual(extractDeliverooMenuOffers(page)!.offers, [{ type: 'OTHER', platformTypeName: 'SurpriseOffer', percentage: undefined, minimumOrderValue: undefined, maxDiscount: undefined, currency: undefined, platformItemIds: undefined, title: undefined }]);
  });
});

describe('Deliveroo listing page offers', () => {
  const listing = parseDeliverooOfferListing(offerFixture('deliveroo-offers-listing.html'));
  const byId = (id: string) => listing.find(r => r.platformRestaurantId === id)!;

  test('one entry per restaurant card with id, name, menu path and badge text', () => {
    assert.equal(listing.length, 7);
    assert.deepEqual(byId('71256'), {
      platformRestaurantId: '71256',
      name: 'Subway',
      menuPath: '/menu/Dubai/knowledge-village/subway-knowledge-village',
      labels: ['Spend AED 50, Get free delivery'],
    });
    assert.equal(parseDeliverooOfferListing('<html></html>').length, 0);
  });

  test('badge texts are classified into offer rules (invisible direction marks and nbsp are ignored)', () => {
    const rule = (id: string) => {
      const o = classifyDeliverooOfferLabel(byId(id).labels[0]);
      return [o.type, o.percentage, o.minimumOrderValue, o.maxDiscount];
    };
    assert.deepEqual(rule('71256'), ['FREE_DELIVERY', undefined, 50, undefined]);
    assert.deepEqual(rule('288186'), ['PERCENT_OFF_ITEMS', 30, undefined, undefined]);
    assert.deepEqual(rule('88048'), ['PERCENT_OFF_MENU', 30, 50, undefined]);
    assert.deepEqual(rule('36591'), ['PERCENT_OFF_MENU', 25, undefined, undefined]);
    assert.deepEqual(rule('294009'), ['PERCENT_OFF_ITEMS', 40, 30, undefined]);
    assert.equal(classifyDeliverooOfferLabel(byId('389870').labels[0]).type, 'BUY_ONE_GET_ONE');
    assert.equal(classifyDeliverooOfferLabel(byId('295186').labels[0]).type, 'OTHER');
    assert.equal(classifyDeliverooOfferLabel('Spend AED 50, unlock 30% off up to AED 100').maxDiscount, 100);
  });
});

describe('offer keys', () => {
  test('the same rule gets the same key whatever the wording or eligible items; different rules differ', () => {
    const a = offerKeyOf({ type: 'PERCENT_OFF_ITEMS', platformTypeName: 'X', percentage: 30, platformItemIds: ['1'], title: 'a' });
    const b = offerKeyOf({ type: 'PERCENT_OFF_ITEMS', platformTypeName: 'X', percentage: 30, platformItemIds: ['1', '2'], title: 'b' });
    assert.equal(a, b);
    assert.notEqual(a, offerKeyOf({ type: 'PERCENT_OFF_ITEMS', platformTypeName: 'X', percentage: 25 }));
    assert.notEqual(offerKeyOf({ type: 'OTHER', title: 'Offers available' }), offerKeyOf({ type: 'OTHER', title: 'Free dessert' }));
  });
});
