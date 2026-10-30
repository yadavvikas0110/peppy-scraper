/// <reference types="node" />
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { QUERIES, queryKey } from '../../scrape-master';
import { getBroadCategoryBaseTags } from '../../src/config/taxonomy';
import { SITES } from '../../src/config/sites';
import { buildJobId } from '../../src/services/checkpoint.service';
import { matchesCategory } from '../../src/services/shopify.service';
import { parseJumboSearch } from '../../src/parsers/search/jumbo.search.parser';

describe('query plan', () => {
  test('every query has a unique resume key', () => {
    const keys = QUERIES.map(queryKey);
    const dupes = keys.filter((k, i) => keys.indexOf(k) !== i);
    assert.deepEqual(dupes, []);
  });

  test('every broadCategory > subCategory pair has base tags', () => {
    const missing = [...new Set(QUERIES.map(q => `${q.broadCategory} > ${q.subCategory}`))]
      .filter(pair => { const [b, s] = pair.split(' > '); return getBroadCategoryBaseTags(b, s).length === 0; });
    assert.deepEqual(missing, []);
  });

  test('every categoryKey exists on at least one of its sites', () => {
    const broken = QUERIES.filter(q => q.categoryKey && !q.sites.some(s => SITES[s].categories?.[q.categoryKey!] || SITES[s].shopify))
      .map(q => `${q.label} (${q.categoryKey})`);
    assert.deepEqual(broken, []);
  });
});

describe('buildJobId', () => {
  test('is unchanged for search jobs and distinct for category jobs', () => {
    const search = buildJobId(['jumbo'], 'smartphones', 30);
    assert.equal(search, buildJobId(['jumbo'], 'smartphones', 30, undefined));
    assert.notEqual(search, buildJobId(['jumbo'], 'smartphones', 30, 'smartphones'));
  });
});

describe('Shopify category match', () => {
  const p = (title: string, tags: string[] = []) =>
    ({ id: 1, title, handle: 'h', body_html: '', vendor: '', product_type: '', tags, variants: [], images: [] });

  test('requires every word as a whole word', () => {
    assert.equal(matchesCategory(p('BaBylissPRO Rotating Hot Air Brush'), 'baby stroller'), false);
    assert.equal(matchesCategory(p('adidas Baby Argentina Home Kit'), 'baby stroller'), false);
    assert.equal(matchesCategory(p('Joie Baby Travel Stroller'), 'baby stroller'), true);
    assert.equal(matchesCategory(p('Lightweight Strollers', ['baby']), 'baby stroller'), true);
  });
});

describe('Jumbo listing parser', () => {
  test('keeps product pages and skips single-segment category pages', () => {
    const html = `
      <a href="/samsung-galaxy-s25-ultra-5g-smartphone-titanium-black-256-gb.html">p1</a>
      <a href="/television-home-theaters.html">cat</a>
      <a href="/mobile-phones.html?pageNo=2">cat</a>
      <a href="/health-and-personal-care.html">cat</a>
      <a href="/personal-computers/laptops.html">cat</a>`;
    assert.deepEqual(parseJumboSearch(html, 'https://www.jumbo.ae/mobile-phones.html'), [
      'https://www.jumbo.ae/samsung-galaxy-s25-ultra-5g-smartphone-titanium-black-256-gb.html',
    ]);
  });
});
