/// <reference types="node" />
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  buildDeliverooImageCaptureOptions,
  buildDeliverooItemDetailOptions,
  DELIVEROO_FETCH_DEFAULTS,
  deliverooAdapter,
  fetchDeliverooMenu,
} from '../../src/dining/platforms/deliveroo/deliveroo.adapter';
import { computedBackgroundImagesAction, scrollPageActions } from '../../src/dining/platforms/browser-actions';
import type { ScrapeDoClient } from '../../src/shared/scrapedo/scrapedo.client';
import type { ScrapeDoRequestOptions, ScrapeDoResponse } from '../../src/shared/scrapedo/scrapedo.types';

const MENU_EN = 'https://deliveroo.ae/en/menu/Dubai/dubai-business-bay/kamat-dt/?day=today&geohash=thrr3squys8d&time=ASAP';

describe('Deliveroo adapter — URLs and locale', () => {
  test('matches Deliveroo UAE menu URLs only', () => {
    assert.equal(deliverooAdapter.platform, 'deliveroo');
    for (const url of [
      MENU_EN,
      'https://deliveroo.ae/ar/menu/Dubai/dubai-business-bay/kamat-dt',
      'https://www.deliveroo.ae/menu/Dubai/dubai-marina/some-place/',
    ]) assert.equal(deliverooAdapter.matchesUrl(url), true, url);

    for (const url of [
      'http://deliveroo.ae/en/menu/Dubai/dubai-business-bay/kamat-dt/',
      'https://deliveroo.co.uk/menu/london/soho/place',
      'https://deliveroo.ae/en/restaurants/dubai/dubai-business-bay',
      'https://deliveroo.ae/en/menu/Dubai/dubai-business-bay',
      'https://evil.test/?u=https://deliveroo.ae/en/menu/a/b/c',
      'not a url',
    ]) assert.equal(deliverooAdapter.matchesUrl(url), false, url);
  });

  test('detects locale from the path, with fallback', () => {
    assert.equal(deliverooAdapter.detectLocale(MENU_EN), 'en');
    assert.equal(deliverooAdapter.detectLocale('https://deliveroo.ae/ar/menu/a/b/c'), 'ar');
    assert.equal(deliverooAdapter.detectLocale('https://deliveroo.ae/menu/a/b/c'), 'en');
    assert.equal(deliverooAdapter.detectLocale('https://deliveroo.ae/menu/a/b/c', 'ar'), 'ar');
  });

  test('builds the other-locale URL, keeping the query', () => {
    assert.equal(
      deliverooAdapter.toLocaleUrl(MENU_EN, 'ar'),
      'https://deliveroo.ae/ar/menu/Dubai/dubai-business-bay/kamat-dt/?day=today&geohash=thrr3squys8d&time=ASAP'
    );
    assert.equal(deliverooAdapter.toLocaleUrl('https://deliveroo.ae/menu/a/b/c', 'en'), 'https://deliveroo.ae/en/menu/a/b/c/');
  });

  test('fetch options: rendered, UAE geo, no super proxy, fresh copy each call', () => {
    const options = deliverooAdapter.getFetchOptions(MENU_EN, 'en');
    assert.equal(options.render, true);
    assert.equal(options.geoCode, 'ae');
    assert.equal(options.super, undefined);
    assert.equal(options.returnJSON, undefined);
    options.customWait = 1;
    assert.equal(DELIVEROO_FETCH_DEFAULTS.customWait, 2000);
  });
});

describe('Deliveroo adapter — fetch (fake client, no network)', () => {
  const html = readFileSync(join(__dirname, 'fixtures', 'deliveroo-ar.html'), 'utf8');

  function fakeClient(calls: Array<{ url: string; options?: ScrapeDoRequestOptions }>): ScrapeDoClient {
    return {
      async fetchHtml(url, options) {
        calls.push({ url, options });
        const response: ScrapeDoResponse = {
          html, statusCode: 200, finalUrl: url, targetUrl: url,
          requestCost: 5, remainingCredits: 990, attempts: 1, durationMs: 1234,
        };
        return response;
      },
    };
  }

  test('requests the locale URL once, records cost and parses the page', async () => {
    const calls: Array<{ url: string; options?: ScrapeDoRequestOptions }> = [];
    const logs: string[] = [];
    const out = await fetchDeliverooMenu(MENU_EN, 'ar', { client: fakeClient(calls), logger: { log: (m: string) => logs.push(m) } });

    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /^https:\/\/deliveroo\.ae\/ar\/menu\//);
    assert.deepEqual(calls[0].options, DELIVEROO_FETCH_DEFAULTS);
    assert.deepEqual(out.cost, { requestCost: 5, remainingCredits: 990, attempts: 1, durationMs: 1234 });
    assert.equal(out.result.locale, 'ar');
    assert.equal(out.result.items.length, 332);
    assert.equal(logs.length, 1);
    assert.match(logs[0], /^\[dining\] deliveroo ar status=200 cost=5 remaining=990/);
  });

  test('rejects non-Deliveroo URLs before any request', async () => {
    const calls: Array<{ url: string; options?: ScrapeDoRequestOptions }> = [];
    await assert.rejects(fetchDeliverooMenu('https://example.com/', 'en', { client: fakeClient(calls) }), /Not a Deliveroo menu URL/);
    assert.equal(calls.length, 0);
  });
});

describe('Deliveroo adapter — future browser-action hooks (built, not sent)', () => {
  test('image capture: scroll + computed background images via returnJSON', () => {
    const options = buildDeliverooImageCaptureOptions(3);
    assert.equal(options.render, true);
    assert.equal(options.returnJSON, true);
    assert.equal(options.playWithBrowser!.length, 7);
    const last = options.playWithBrowser![6];
    assert.equal(last.Action, 'Execute');
    assert.match((last as { Execute: string }).Execute, /getComputedStyle/);
  });

  test('item detail: click card by aria-label prefix, wait for dialog, read it', () => {
    const options = buildDeliverooItemDetailOptions('Mom "Special"');
    assert.equal(options.returnJSON, true);
    assert.deepEqual(options.playWithBrowser!.slice(0, 2), [
      { Action: 'Click', Selector: '[role="button"][aria-label^="Mom \\"Special\\""]' },
      { Action: 'WaitSelector', WaitSelector: '[role="dialog"]', Timeout: 10000 },
    ]);
  });

  test('generic action builders', () => {
    assert.deepEqual(scrollPageActions(1, 500, 100), [{ Action: 'ScrollY', Value: 500 }, { Action: 'Wait', Timeout: 100 }]);
    const exec = computedBackgroundImagesAction('[data-x="a"]');
    assert.match((exec as { Execute: string }).Execute, /querySelectorAll\("\[data-x=\\"a\\"\]"\)/);
  });
});
