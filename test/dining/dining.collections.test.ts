/// <reference types="node" />
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { Db, IndexDescription, MongoClient, ObjectId } from 'mongodb';
import {
  DINING_COLLECTIONS,
  DINING_INDEXES,
  ensureDiningIndexes,
  getDiningCollections,
} from '../../src/dining/db/dining.collections';
import { buildMenuItemSourceKey, buildRestaurantSourceKey } from '../../src/dining/dining.source-key';
import { makeMenuItem, makeRestaurant, RESTAURANT_KEY } from './fixtures';

function fakeDb() {
  const created: Record<string, IndexDescription[]> = {};
  const db = {
    collection: (name: string) => ({
      collectionName: name,
      createIndexes: async (specs: IndexDescription[]) => {
        created[name] = specs;
        return specs.map(s => s.name as string);
      },
    }),
  } as unknown as Db;
  return { db, created };
}

describe('dining collections', () => {
  test('uses only dedicated dining_* collections', () => {
    assert.deepEqual(Object.values(DINING_COLLECTIONS).sort(), [
      'dining_menu_categories',
      'dining_menu_items',
      'dining_restaurants',
      'dining_scrape_runs',
    ]);
    for (const name of Object.keys(DINING_INDEXES)) assert.match(name, /^dining_/);
  });

  test('getDiningCollections maps each accessor to its collection', () => {
    const { db } = fakeDb();
    const cols = getDiningCollections(db);
    assert.equal(cols.restaurants.collectionName, 'dining_restaurants');
    assert.equal(cols.menuCategories.collectionName, 'dining_menu_categories');
    assert.equal(cols.menuItems.collectionName, 'dining_menu_items');
    assert.equal(cols.scrapeRuns.collectionName, 'dining_scrape_runs');
  });

  test('ensureDiningIndexes creates the declared indexes on every collection', async () => {
    const { db, created } = fakeDb();
    const result = await ensureDiningIndexes(db);
    assert.equal(result.length, 4);
    assert.deepEqual(Object.keys(created).sort(), Object.keys(DINING_INDEXES).sort());
  });

  test('every collection has a unique identity index', () => {
    const unique = (c: keyof typeof DINING_INDEXES, field: string) =>
      DINING_INDEXES[c].some(i => i.unique && Object.keys(i.key)[0] === field && Object.keys(i.key).length === 1);
    assert.ok(unique('dining_restaurants', 'sourceKey'));
    assert.ok(unique('dining_menu_categories', 'sourceKey'));
    assert.ok(unique('dining_menu_items', 'sourceKey'));
    assert.ok(unique('dining_scrape_runs', 'runId'));
  });

  test('unique indexes on optional platform IDs are partial (missing IDs never collide)', () => {
    const optionalIdFields = ['platformRestaurantId', 'platformCategoryId', 'platformItemId'];
    for (const specs of Object.values(DINING_INDEXES)) {
      for (const spec of specs) {
        const fields = Object.keys(spec.key);
        const optionalField = fields.find(f => optionalIdFields.includes(f));
        if (!spec.unique || !optionalField) continue;
        assert.deepEqual(spec.partialFilterExpression, { [optionalField]: { $type: 'string' } }, spec.name);
      }
    }
  });

  test('index names are unique per collection', () => {
    for (const [collection, specs] of Object.entries(DINING_INDEXES)) {
      const names = specs.map(s => s.name);
      assert.equal(new Set(names).size, names.length, collection);
      assert.ok(names.every(Boolean), `${collection} has an unnamed index`);
    }
  });
});

// Real MongoDB check. Opt-in and local only — never runs against the shared/production cluster.
const TEST_URI = process.env.DINING_TEST_MONGODB_URI;
const isLocalUri = !!TEST_URI && /^mongodb:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/.test(TEST_URI);

describe('dining indexes against a local MongoDB', { skip: !isLocalUri && 'set DINING_TEST_MONGODB_URI=mongodb://127.0.0.1:<port>' }, () => {
  let client: MongoClient;
  let db: Db;

  before(async () => {
    client = new MongoClient(TEST_URI as string, { serverSelectionTimeoutMS: 5000 });
    await client.connect();
    db = client.db(`peppy_dining_test_${Date.now()}`);
    await ensureDiningIndexes(db);
  });

  after(async () => {
    await db?.dropDatabase().catch(() => {});
    await client?.close();
  });

  test('indexes exist with the declared options and re-running is idempotent', async () => {
    await ensureDiningIndexes(db);
    for (const [collection, specs] of Object.entries(DINING_INDEXES)) {
      const existing = await db.collection(collection).indexes();
      for (const spec of specs) {
        const found = existing.find(i => i.name === spec.name);
        assert.ok(found, `${collection}.${spec.name} missing`);
        assert.equal(!!found.unique, !!spec.unique, `${collection}.${spec.name} unique`);
      }
    }
  });

  test('items without platformItemId do not collide; duplicate IDs and sourceKeys do', async () => {
    const { menuItems } = getDiningCollections(db);
    const restaurantId = new ObjectId();
    const anchorItem = (anchor: string) => makeMenuItem({
      restaurantId,
      platformItemId: undefined,
      sourceKeyKind: 'anchor',
      sourceKey: buildMenuItemSourceKey(RESTAURANT_KEY, { kind: 'anchor', value: anchor }),
    });

    await menuItems.insertOne(anchorItem('img/a.jpg'));
    await menuItems.insertOne(anchorItem('img/b.jpg'));

    await menuItems.insertOne(makeMenuItem({ restaurantId }));
    await assert.rejects(
      menuItems.insertOne(makeMenuItem({
        restaurantId,
        sourceKey: buildMenuItemSourceKey(RESTAURANT_KEY, { kind: 'anchor', value: 'different' }),
      })),
      (e: { code?: number }) => e.code === 11000
    );
    await assert.rejects(menuItems.insertOne(anchorItem('img/a.jpg')), (e: { code?: number }) => e.code === 11000);
  });

  test('restaurants without platformRestaurantId do not collide', async () => {
    const { restaurants } = getDiningCollections(db);
    const bySlug = (slug: string) => makeRestaurant({
      platformRestaurantId: undefined,
      sourceKeyKind: 'anchor',
      slug,
      sourceKey: buildRestaurantSourceKey('deliveroo', { kind: 'anchor', value: slug }),
    });
    await restaurants.insertOne(bySlug('dubai/a'));
    await restaurants.insertOne(bySlug('dubai/b'));
    await restaurants.insertOne(makeRestaurant());
    await assert.rejects(
      restaurants.insertOne(makeRestaurant({ sourceKey: buildRestaurantSourceKey('deliveroo', { kind: 'anchor', value: 'x' }) })),
      (e: { code?: number }) => e.code === 11000
    );
  });

  test('EN then AR updates land on the same document', async () => {
    const { menuItems } = getDiningCollections(db);
    const restaurantId = new ObjectId();
    const sourceKey = buildMenuItemSourceKey(RESTAURANT_KEY, { kind: 'id', value: 'merge-1' });
    const base = makeMenuItem({ restaurantId, platformItemId: 'merge-1', sourceKey, name: { en: 'ShackBurger' } });
    const { name: _name, ...rest } = base;
    await menuItems.updateOne({ sourceKey }, { $set: { 'name.en': 'ShackBurger' }, $setOnInsert: rest }, { upsert: true });
    await menuItems.updateOne({ sourceKey }, { $set: { 'name.ar': 'شاك برجر' } }, { upsert: true });

    const docs = await menuItems.find({ sourceKey }).toArray();
    assert.equal(docs.length, 1);
    assert.deepEqual(docs[0].name, { en: 'ShackBurger', ar: 'شاك برجر' });
  });
});
