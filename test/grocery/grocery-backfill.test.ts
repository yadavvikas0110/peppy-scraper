/// <reference types="node" />
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { runGroceryBackfill, mergeRetailers, GroceryDoc } from '../../src/grocery/grocery-backfill';

function fakeCol(docs: GroceryDoc[]) {
  const deleted: any[] = [];
  const updated: any[] = [];
  return {
    col: {
      find: (_q: any) => ({ toArray: async () => docs }),
      updateOne: async (f: any, u: any) => { updated.push({ f, u }); return { matchedCount: 1, modifiedCount: 1 }; },
      deleteMany: async (f: any) => { deleted.push(f); return { deletedCount: 1 }; },
    } as any,
    deleted, updated,
  };
}

describe('mergeRetailers', () => {
  test('one offer per retailerId, newest observation wins', () => {
    const r = mergeRetailers([
      { _id: 1, retailers: [{ retailerId: 'talabat', price: 10, lastSeenAt: '2026-01-01' }] },
      { _id: 2, retailers: [{ retailerId: 'talabat', price: 9, lastSeenAt: '2026-02-01' }, { retailerId: 'noon-minutes', price: 11 }] },
    ]);
    assert.equal(r.length, 2);
    const tal = r.find(x => x.retailerId === 'talabat');
    assert.equal(tal.price, 9); // newer wins
    assert.ok(r.find(x => x.retailerId === 'noon-minutes'));
  });
});

describe('runGroceryBackfill (dry run)', () => {
  const docs: GroceryDoc[] = [
    { _id: 'a', name: 'Maggi Cream Of Mushroom Soup, 68g', category: 'Groceries', createdAt: new Date('2026-01-01'),
      retailers: [{ retailerId: 'noon-minutes', retailerName: 'Noon Minutes', price: 3 }], images: ['x'] },
    { _id: 'b', name: 'Maggi Cream of Mushroom Soup 68g', category: 'Groceries', createdAt: new Date('2026-02-01'),
      retailers: [{ retailerId: 'talabat', retailerName: 'Talabat Mart', price: 3.2 }], images: ['y'] },
    { _id: 'c', name: 'Almarai Milk 1L', category: 'Groceries',
      retailers: [{ retailerId: 'talabat', retailerName: 'Talabat Mart', price: 7 }], images: ['z'] },
    { _id: 'd', name: 'Almarai Milk 2L', category: 'Groceries',
      retailers: [{ retailerId: 'noon-minutes', retailerName: 'Noon Minutes', price: 12 }], images: ['w'] },
  ];

  test('clusters the two Maggi titles, keeps 1L/2L apart, writes nothing', async () => {
    const { col, deleted, updated } = fakeCol(docs);
    const plan = await runGroceryBackfill(col, { apply: false });
    assert.equal(plan.scanned, 4);
    assert.equal(plan.clusters, 1);               // only the Maggi pair
    assert.equal(plan.crossPlatformClusters, 1);  // Noon + Talabat
    assert.equal(plan.docsDeleted, 1);
    assert.equal(deleted.length, 0);              // dry run: no writes
    assert.equal(updated.length, 0);
    assert.equal(plan.samples[0].survivor, 'Maggi Cream Of Mushroom Soup, 68g'); // oldest createdAt
  });

  test('apply=true merges offers and deletes the folded doc', async () => {
    const { col, deleted, updated } = fakeCol(docs);
    let backup: GroceryDoc[] = [];
    const plan = await runGroceryBackfill(col, { apply: true, writeBackup: (d) => { backup = d; } });
    assert.equal(plan.clusters, 1);
    assert.ok(updated.length >= 1);
    assert.equal(deleted.length, 1);
    assert.equal(backup.length, 1);
    assert.equal(backup[0]._id, 'b'); // folded doc backed up
    const survivorUpdate = updated.find(u => u.f._id === 'a');
    assert.ok(survivorUpdate);
    assert.equal(survivorUpdate.u.$set.retailers.length, 2); // both platforms on survivor
  });
});
