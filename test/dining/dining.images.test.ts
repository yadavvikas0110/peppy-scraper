/// <reference types="node" />
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { uploadMenuImages } from '../../src/dining/dining.images';
import type { DiningMappedMenu } from '../../src/dining/platforms/platform.mapper';

const menu = (): DiningMappedMenu => ({
  restaurant: { imageUrl: 'https://src/r.jpg' },
  items: [
    { imageUrl: 'https://src/a.jpg' },
    { imageUrl: 'https://src/a.jpg' },
    { imageUrl: 'https://src/bad.jpg' },
    {},
  ],
} as unknown as DiningMappedMenu);

describe('uploadMenuImages', () => {
  test('replaces platform URLs with CDN URLs, uploads a shared image once, drops failed ones', async () => {
    const calls: string[] = [];
    const m = menu();
    const stats = await uploadMenuImages(
      m,
      async (url, folder) => {
        calls.push(`${folder}|${url}`);
        if (url.includes('bad')) throw new Error('boom');
        return `https://cdn/${folder}/x.jpg`;
      },
      { warn: () => {} }
    );
    assert.equal(m.restaurant.imageUrl, 'https://cdn/dining/restaurants/x.jpg');
    assert.equal(m.items[0].imageUrl, 'https://cdn/dining/menu-items/x.jpg');
    assert.equal(m.items[1].imageUrl, 'https://cdn/dining/menu-items/x.jpg');
    assert.equal(m.items[2].imageUrl, undefined, 'failed upload must not keep the platform URL');
    assert.equal(m.items[3].imageUrl, undefined);
    assert.equal(calls.filter(c => c.endsWith('a.jpg')).length, 1);
    assert.deepEqual(stats, { uploaded: 2, failed: 1 });
  });
});
