/// <reference types="node" />
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMumzworld } from '../../src/parsers/mumzworld.parser';
import { isBlockPage } from '../../src/services/playwright.service';
import { parseCarrefour } from '../../src/parsers/carrefour.parser';
import { parseNamshiSearch } from '../../src/parsers/search/namshi.search.parser';
import { SITES } from '../../src/config/sites';

describe('Namshi listing', () => {
  test('category URLs point at listing pages, not landing pages', () => {
    for (const [key, build] of Object.entries(SITES.namshi.categories!)) {
      assert.doesNotMatch(build(1), /\/uae-en\/(women|men|kids)\/\?/, key);
    }
  });

  test('extracts product URLs and ignores CDN image links', () => {
    const html = `<a href="https://f.nooncdn.com/p/pzsku/ZF39B9981125C65E0E8B2Z/45/x.jpg">img</a>` +
      `<script>{"url":"https://www.namshi.com/uae-en/buy-ginger-maxi-mermaid-skirt/ZB0088742F2F26BC90BEBZ/p/"}</script>`;
    assert.deepEqual(parseNamshiSearch(html, 'https://www.namshi.com/uae-en/women-clothing/'), [
      'https://www.namshi.com/uae-en/buy-ginger-maxi-mermaid-skirt/ZB0088742F2F26BC90BEBZ/p/',
    ]);
  });
});

describe('Carrefour parser price', () => {
  const url = 'https://www.carrefouruae.com/mafuae/en/smartphones/samsung-galaxy-s24-ultra/p/8806095528922';
  // Recommendation widgets embed their own finalPrice before the product's record
  const flight = `self.__next_f.push([1,"{\\"id\\":\\"1234567\\",\\"currency\\":\\"AED\\",\\"finalPrice\\":\\"208.00\\"}` +
    `{\\"id\\":\\"8806095528922\\",\\"originalPrice\\":\\"5599.00\\",\\"discountValue\\":\\"1663.03\\",\\"currency\\":\\"AED\\",\\"finalPrice\\":\\"3935.97\\"}"])`;
  const ld = `<script type="application/ld+json">{"@type":"Product","name":"Samsung Galaxy S24 Ultra","image":["https://img/1.jpg"],` +
    `"offers":{"@type":"Offer","priceCurrency":"AED","price":"3935.97","availability":"https://schema.org/InStock"}}</script>`;

  test('uses the JSON-LD offer price, not the first finalPrice on the page', () => {
    const p = parseCarrefour(`<html><head>${ld}</head><body><h1>x</h1><script>${flight}</script></body></html>`, url);
    assert.equal(p.price, 3935.97);
    assert.equal(p.inStock, true);
  });

  test('falls back to the finalPrice tied to this product ID', () => {
    assert.equal(parseCarrefour(`<html><body><h1>x</h1><script>${flight}</script></body></html>`, url).price, 3935.97);
  });

  test('stays unknown rather than borrowing another product\'s price', () => {
    const other = `<script>self.__next_f.push([1,"{\\"id\\":\\"1234567\\",\\"finalPrice\\":\\"208.00\\"}"])</script>`;
    assert.equal(parseCarrefour(`<html><body><h1>x</h1>${other}</body></html>`, url).price, null);
  });
});

describe('block page detection', () => {
  test('recognises the Akamai Access Denied page Namshi served', () => {
    const akamai = `<html><head>\n<title>Access Denied</title>\n</head><body>\n<h1>Access Denied</h1>\n` +
      `You don't have permission to access "http://www.namshi.com/uae-en/women/?" on this server.<p>\n` +
      `Reference #18.a9c44d17.1793187183.41d57ae\n</p><p>https://errors.edgesuite.net/18.a9c44d17.1793187183.41d57ae</p>\n</body></html>`;
    assert.equal(isBlockPage(akamai), true);
  });

  test('does not flag real listing pages', () => {
    assert.equal(isBlockPage(`<html><head><title>Women's UAE | Best Price Offers | Dubai, Abu Dhabi</title></head><body>${'x'.repeat(5000)}</body></html>`), false);
  });
});

const ldPage = (availability: string) => `<html><head>
  <script type="application/ld+json">{"@type":"BreadcrumbList","itemListElement":[]}</script>
  <script type="application/ld+json">{"@type":"Product","name":"Stroller","offers":{"@type":"Offer","availability":"${availability}","price":"399.00","priceCurrency":"AED"}}</script>
  </head><body><h1>Stroller</h1></body></html>`;

describe('Mumzworld parser stock', () => {
  test('reads availability from the JSON-LD Product offer', () => {
    const url = 'https://www.mumzworld.com/en/stroller';
    assert.equal(parseMumzworld(ldPage('https://schema.org/InStock'), url).inStock, true);
    assert.equal(parseMumzworld(ldPage('https://schema.org/OutOfStock'), url).inStock, false);
  });

  test('stays unknown when the page has no stock signal', () => {
    assert.equal(parseMumzworld('<html><body><h1>x</h1></body></html>', 'https://www.mumzworld.com/en/x').inStock, null);
  });
});
