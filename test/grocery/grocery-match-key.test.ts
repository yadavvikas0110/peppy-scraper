/// <reference types="node" />
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { groceryMatchKey, extractSizeTokens } from '../../src/grocery/grocery-match-key';

describe('groceryMatchKey', () => {
  test('same product, different platform titles → same key', () => {
    const a = groceryMatchKey('Maggi Cream Of Mushroom Soup, 68g');      // Noon Minutes
    const b = groceryMatchKey('Maggi Cream of Mushroom Soup 68g');        // Talabat Mart
    assert.ok(a);
    assert.equal(a, b);
  });

  test('ignores stopwords and word order (Fresh / commas)', () => {
    const a = groceryMatchKey('Al Ain Farms Chicken Minced 500g');        // Deliveroo Hop
    const b = groceryMatchKey('Al Ain Farms Fresh Chicken Minced, 500g'); // Noon Minutes
    assert.equal(a, b);
  });

  test('different size → different key (1L vs 2L never merge)', () => {
    assert.notEqual(
      groceryMatchKey('Almarai Fresh Milk Full Fat, 1L'),
      groceryMatchKey('Almarai Fresh Milk Full Fat, 2L'),
    );
  });

  test('different product, same size → different key', () => {
    assert.notEqual(
      groceryMatchKey('Galaxy Smooth Dark Chocolate Bar 40g'),
      groceryMatchKey('Mars Chocolate Bar, 40g'),
    );
  });

  test('multipack normalized (4 x 1L)', () => {
    assert.deepEqual(extractSizeTokens('Nada Long Life Milk 4x1L'), ['4x1l']);
    assert.equal(
      groceryMatchKey('Nada Long Life Milk 4 x 1L'),
      groceryMatchKey('Nada Long Life Milk 4x1L'),
    );
  });

  test('piece count normalized', () => {
    assert.deepEqual(extractSizeTokens('Banana Ripe, 1 Piece'), ['1pc']);
  });

  test('size-less title → null (left to exact-name matching, never fuzzy-merged)', () => {
    assert.equal(groceryMatchKey('Coriander Leaves'), null);
    assert.equal(groceryMatchKey('Fresh Eggplant'), null);
  });

  test('empty / noise input → null', () => {
    assert.equal(groceryMatchKey(''), null);
    assert.equal(groceryMatchKey(null), null);
    assert.equal(groceryMatchKey('500g'), null); // only a size, no product words
  });

  test('deterministic', () => {
    const n = 'Lavazza Crema E Gusto Classico Ground Coffee, 250g';
    assert.equal(groceryMatchKey(n), groceryMatchKey(n));
  });
});
