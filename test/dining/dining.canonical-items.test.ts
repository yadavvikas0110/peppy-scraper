/// <reference types="node" />
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'child_process';
import { join } from 'path';
import { ObjectId, WithId } from 'mongodb';
import { backfillCanonicalItems, CanonicalItemBackfillReport } from '../../src/dining/canonical-items/canonical-item.backfill';
import { buildCanonicalItem, planCanonicalItemEnrichment } from '../../src/dining/canonical-items/canonical-item.builder';
import {
  DINING_CANONICAL_ITEM_INDEXES,
  DiningCanonicalItemCollections,
  ensureDiningCanonicalItemIndexes,
  getDiningCanonicalItemCollections,
} from '../../src/dining/canonical-items/canonical-item.collections';
import { buildSearchKeywords, extractVariant, keywordTokens } from '../../src/dining/canonical-items/canonical-item.text';
import { validateCanonicalItem } from '../../src/dining/canonical-items/canonical-item.validator';
import { persistMappedMenu } from '../../src/dining/dining.persistence';
import { buildMenuItemSourceKey } from '../../src/dining/dining.source-key';
import type { DiningLocale, DiningMenuItem, DiningPlatform, DiningRestaurant } from '../../src/dining/dining.types';
import { backfillRestaurantIdentity } from '../../src/dining/identity/identity.backfill';
import { ensureDiningIdentityIndexes, getDiningIdentityCollections } from '../../src/dining/identity/identity.collections';
import { createDiningIdentityRepositories } from '../../src/dining/identity/identity.service';
import { closeTestClient, LOCAL_DB_SKIP, mappedMenu, openTestDb, TestDb, THALI } from './helpers';

const totals = (r: CanonicalItemBackfillReport) => ({
  itemsInspected: r.itemsInspected,
  canonicalItemsCreated: r.canonicalItemsCreated,
  canonicalItemsReused: r.canonicalItemsReused,
  canonicalItemsEnriched: r.canonicalItemsEnriched,
  skipped: r.skipped,
  invalid: r.invalid,
  restaurantsWithoutGroup: r.restaurantsWithoutGroup,
  failures: r.failures,
});

// ─── Pure ────────────────────────────────────────────────────────────────────

describe('canonical item text helpers (pure)', () => {
  test('variants only come from a number with an adjacent unit, or an explicit size word', () => {
    assert.deepEqual(extractVariant({ en: 'Dosa 2 pcs' }), { label: { en: '2 pcs' }, quantity: 2, unit: 'pcs' });
    assert.deepEqual(extractVariant({ en: 'Dosa 6 pcs' }), { label: { en: '6 pcs' }, quantity: 6, unit: 'pcs' });
    assert.deepEqual(extractVariant({ en: 'Margherita Pizza 10 inch' }), { label: { en: '10 inch' }, size: '10 inch', quantity: 10, unit: 'inch' });
    assert.deepEqual(extractVariant({ en: 'Margherita Pizza 12"' }), { label: { en: '12"' }, size: '12 inch', quantity: 12, unit: 'inch' });
    assert.deepEqual(extractVariant({ en: 'Pepsi 330ml' }), { label: { en: '330ml' }, size: '330 ml', quantity: 330, unit: 'ml' });
    assert.deepEqual(extractVariant({ en: 'Fries Large' }), { label: { en: 'Large' }, size: 'large' });
    assert.deepEqual(extractVariant({ en: 'Wada Pav (2 Pcs)', ar: 'وادا باف (٢ قطع)' }), { label: { en: '2 Pcs', ar: '2 قطع' }, quantity: 2, unit: 'pcs' });
    for (const name of ['Paneer 65', '3 Cheese Sandwich', 'Combo Meal', 'Single Burger', 'Thali', '7up']) assert.equal(extractVariant({ en: name }), undefined, name);
  });

  test('keywords are deterministic, keep numbers and Arabic, drop stopwords, never translate', () => {
    assert.deepEqual(keywordTokens('Corn Cheese Tikki (2 Pcs)'), ['corn', 'cheese', 'tikki', '2', 'pcs']);
    assert.deepEqual(keywordTokens('Idli & Wada'), ['idli', 'wada']);
    assert.deepEqual(keywordTokens('إيدلي بالفلفل الحار'), ['ايدلي', 'بالفلفل', 'الحار']);
    const kw = buildSearchKeywords({ names: { en: 'Thali', ar: 'ثالي' }, category: { en: 'Thali' }, description: { en: '4 Poori or 2 Tandoori Roti' } });
    assert.deepEqual(kw, ['thali', 'ثالي', '4', 'poori', '2', 'tandoori', 'roti']);
    assert.deepEqual(buildSearchKeywords({ names: { en: 'Thali', ar: 'ثالي' } }), buildSearchKeywords({ names: { en: 'Thali', ar: 'ثالي' } }));
  });

  test('builder copies source text only; validator keeps platform data off canonical items', () => {
    const item = { _id: new ObjectId(), restaurantId: new ObjectId(), platform: 'deliveroo', name: { en: ' Thali ' }, price: 32, imageUrl: 'https://x/y.jpg', isAvailable: false } as unknown as WithId<DiningMenuItem>;
    const groupId = new ObjectId();
    const doc = buildCanonicalItem(groupId, item, new Date());
    assert.deepEqual(doc.canonicalName, { en: 'Thali' });
    assert.equal(doc.canonicalDescription, undefined);
    assert.equal(doc.category, undefined);
    assert.deepEqual(doc.aliases, []);
    assert.equal(doc.status, 'active');
    assert.equal(doc.identityStatus, 'auto');
    assert.equal(validateCanonicalItem(doc).valid, true);
    assert.deepEqual(validateCanonicalItem({ ...doc, price: 32, isAvailable: true }).issues.map(i => i.path), ['price', 'isAvailable']);
    assert.deepEqual(validateCanonicalItem({ ...doc, identityKey: 'seed:x' }).issues.map(i => i.path), ['identityKey']);
  });

  test('enrichment fills missing locales, records renames as aliases, never overwrites', () => {
    const now = new Date();
    const existing = { ...buildCanonicalItem(new ObjectId(), { _id: new ObjectId(), restaurantId: new ObjectId(), platform: 'deliveroo', name: { en: 'Thali' } } as unknown as WithId<DiningMenuItem>, now), _id: new ObjectId() };
    const plan = planCanonicalItemEnrichment(existing, { name: { en: 'Kamat Thali', ar: 'ثالي' }, categoryName: { ar: 'ثالي' } } as DiningMenuItem, now)!;
    assert.deepEqual(plan.merged.canonicalName, { en: 'Thali', ar: 'ثالي' });
    assert.deepEqual(plan.merged.aliases, ['Kamat Thali']);
    assert.deepEqual(plan.merged.category, { ar: 'ثالي' });
    assert.equal(planCanonicalItemEnrichment({ ...existing, ...plan.merged, _id: existing._id }, { name: { en: 'Kamat Thali', ar: 'ثالي' }, categoryName: { ar: 'ثالي' } } as DiningMenuItem, now), null);
  });
});

// ─── Local MongoDB ───────────────────────────────────────────────────────────

describe('canonical items (local MongoDB)', { skip: LOCAL_DB_SKIP }, () => {
  let t: TestDb;
  let c: DiningCanonicalItemCollections;
  const now = new Date('2026-10-08T12:00:00Z');

  before(async () => {
    t = await openTestDb('canonical');
    await ensureDiningIdentityIndexes(t.db);
    await ensureDiningCanonicalItemIndexes(t.db);
    c = getDiningCanonicalItemCollections(t.db);
  });
  beforeEach(async () => {
    await t.reset();
    await Promise.all([c.canonicalItems.deleteMany({}), c.restaurantMappings.deleteMany({}), c.restaurantGroups.deleteMany({})]);
  });
  after(async () => {
    await t?.close();
    await closeTestClient();
  });

  async function seedKamat(locales: DiningLocale[] = ['en', 'ar']): Promise<WithId<DiningRestaurant>> {
    for (const locale of locales) await persistMappedMenu(t.repos, mappedMenu(locale), { locale, runId: `run_canonical_${locale}`, now });
    return (await t.collections.restaurants.findOne({ platformRestaurantId: '76728' }))!;
  }

  const mapRestaurants = () => backfillRestaurantIdentity(createDiningIdentityRepositories(getDiningIdentityCollections(t.db)), { now });

  async function groupOf(restaurantId: ObjectId): Promise<ObjectId> {
    return (await c.restaurantMappings.findOne({ restaurantId, isActive: true }))!.canonicalRestaurantGroupId!;
  }

  const thaliSource = async () => (await t.collections.menuItems.findOne({ platformItemId: THALI }))!;

  // A valid extra source item cloned from a real one (new platform ID, given name).
  async function addSourceItem(template: WithId<DiningMenuItem>, platformItemId: string, name: DiningMenuItem['name'], into?: { restaurantId: ObjectId; restaurantSourceKey: string; platformRestaurantId: string; platform: DiningPlatform }) {
    const { _id, categoryId, ...rest } = template;
    const target = into ?? { restaurantId: template.restaurantId, restaurantSourceKey: template.restaurantSourceKey, platformRestaurantId: template.platformRestaurantId!, platform: template.platform };
    const doc: DiningMenuItem = {
      ...rest,
      ...target,
      ...(into ? {} : { categoryId }),
      platformItemId,
      sourceKey: buildMenuItemSourceKey(target.restaurantSourceKey, { kind: 'id', value: platformItemId }),
      name,
    };
    const res = await t.collections.menuItems.insertOne(doc);
    return { ...doc, _id: res.insertedId } as WithId<DiningMenuItem>;
  }

  async function addRestaurant(platform: DiningPlatform, id: string, name: string, location: DiningRestaurant['location']) {
    const doc: DiningRestaurant = {
      platform, platformRestaurantId: id, sourceKey: `${platform}:restaurant:id:${id}`, sourceKeyKind: 'id', name: { en: name },
      url: { en: `https://example.com/${id}` }, cuisines: [], tags: [], currency: 'AED', isActive: true, offers: [], location,
      firstSeenAt: now, lastScrapedAtByLocale: { en: now }, lastRunIdByLocale: { en: 'run_x' }, createdAt: new Date(now.getTime() + 1000), updatedAt: now,
    };
    const res = await t.collections.restaurants.insertOne(doc);
    return { ...doc, _id: res.insertedId } as WithId<DiningRestaurant>;
  }

  test('1. a Kamat Deliveroo source item creates one canonical item in the Kamat group', async () => {
    const kamat = await seedKamat();
    await mapRestaurants();
    await backfillCanonicalItems(c, { now });
    const source = await thaliSource();
    const thali = (await c.canonicalItems.findOne({ seedMenuItemId: source._id }))!;
    const groupId = await groupOf(kamat._id);
    assert.ok(thali.restaurantGroupId.equals(groupId));
    assert.equal(thali.identityKey, `seed:${groupId.toHexString()}:${source._id.toHexString()}`);
    assert.ok(thali.seedRestaurantId.equals(kamat._id));
    assert.equal(thali.seedPlatform, 'deliveroo');
    assert.deepEqual(thali.canonicalName, { en: 'Thali', ar: 'ثالي' });
    assert.deepEqual(thali.canonicalDescription, source.description);
    assert.deepEqual(thali.category, source.categoryName);
    assert.equal(thali.identityStatus, 'auto');
    assert.equal(thali.status, 'active');
    assert.deepEqual(thali.aliases, []);
    assert.equal(thali.variant, undefined);
    for (const k of ['thali', 'ثالي', 'poori', '4', '2', 'سامبار']) assert.ok(thali.searchKeywords.includes(k), k);
    for (const f of ['price', 'imageUrl', 'sourceUrl', 'platformItemId', 'isAvailable', 'currency']) assert.equal(f in thali, false, f);
  });

  test('2. every valid Kamat item is represented exactly once', async () => {
    const kamat = await seedKamat();
    await mapRestaurants();
    const report = await backfillCanonicalItems(c, { now });
    assert.deepEqual(totals(report), { itemsInspected: 332, canonicalItemsCreated: 332, canonicalItemsReused: 0, canonicalItemsEnriched: 0, skipped: 0, invalid: 0, restaurantsWithoutGroup: 0, failures: 0 });
    const sourceIds = (await t.collections.menuItems.find({ restaurantId: kamat._id }).toArray()).map(i => i._id.toHexString()).sort();
    const seeds = (await c.canonicalItems.find().toArray()).map(ci => ci.seedMenuItemId.toHexString()).sort();
    assert.deepEqual(seeds, sourceIds);
    assert.equal(await c.canonicalItems.countDocuments({ restaurantGroupId: { $ne: await groupOf(kamat._id) } }), 0);
  });

  test('3. repeated backfill is idempotent', async () => {
    await seedKamat();
    await mapRestaurants();
    await backfillCanonicalItems(c, { now });
    const before = await c.canonicalItems.find().sort({ _id: 1 }).toArray();
    for (let i = 1; i <= 2; i++) {
      const again = await backfillCanonicalItems(c, { now: new Date(now.getTime() + i * 60_000) });
      assert.deepEqual(totals(again), { itemsInspected: 332, canonicalItemsCreated: 0, canonicalItemsReused: 332, canonicalItemsEnriched: 0, skipped: 0, invalid: 0, restaurantsWithoutGroup: 0, failures: 0 });
    }
    assert.deepEqual(await c.canonicalItems.find().sort({ _id: 1 }).toArray(), before);

    // Concurrent runs on a fresh collection still create one canonical item per source item.
    await c.canonicalItems.deleteMany({});
    const [a, b] = await Promise.all([backfillCanonicalItems(c, { now }), backfillCanonicalItems(c, { now })]);
    assert.equal(a.failures + b.failures, 0);
    assert.equal(a.canonicalItemsCreated + b.canonicalItemsCreated, 332);
    assert.equal(await c.canonicalItems.countDocuments(), 332);
  });

  test('4. EN then AR merges into the same canonical items', async () => {
    await seedKamat(['en']);
    await mapRestaurants();
    await backfillCanonicalItems(c, { now });
    const enOnly = (await c.canonicalItems.findOne({ seedMenuItemId: (await thaliSource())._id }))!;
    assert.deepEqual(enOnly.canonicalName, { en: 'Thali' });
    assert.equal(enOnly.searchKeywords.includes('ثالي'), false);

    await persistMappedMenu(t.repos, mappedMenu('ar'), { locale: 'ar', runId: 'run_canonical_ar', now });
    const report = await backfillCanonicalItems(c, { now: new Date(now.getTime() + 60_000) });
    assert.equal(report.canonicalItemsCreated, 0);
    assert.equal(report.canonicalItemsReused, 332);
    assert.equal(report.canonicalItemsEnriched, 332);
    assert.equal(await c.canonicalItems.countDocuments(), 332);

    const merged = (await c.canonicalItems.findOne({ _id: enOnly._id }))!;
    assert.deepEqual(merged.canonicalName, { en: 'Thali', ar: 'ثالي' });
    assert.ok(merged.canonicalDescription?.en && merged.canonicalDescription.ar);
    assert.ok(merged.category?.en && merged.category.ar);
    assert.ok(merged.searchKeywords.includes('ثالي'));
    assert.ok(merged.signals.normalizedNames.includes('ثالي'));
    assert.deepEqual(merged.aliases, []);
    assert.ok(merged.createdAt.getTime() === enOnly.createdAt.getTime());
    const withBoth = await c.canonicalItems.countDocuments({ 'canonicalName.en': { $exists: true }, 'canonicalName.ar': { $exists: true } });
    assert.equal(withBoth, 332);
  });

  test('5. different restaurant groups stay separate (no global "Thali")', async () => {
    const kamat = await seedKamat(['en']);
    const other = await addRestaurant('deliveroo', '88888', 'Other Place', { city: 'dubai', area: 'Jumeirah Lake Towers', address: 'Cluster D' });
    await mapRestaurants();
    const template = await thaliSource();
    await addSourceItem(template, '700001', { en: 'Thali' }, { restaurantId: other._id, restaurantSourceKey: other.sourceKey, platformRestaurantId: '88888', platform: 'deliveroo' });

    const report = await backfillCanonicalItems(c, { now });
    assert.equal(report.canonicalItemsCreated, 333);
    const thalis = await c.canonicalItems.find({ 'signals.normalizedNames': 'thali' }).toArray();
    assert.equal(thalis.length, 2);
    const groups = new Set(thalis.map(x => x.restaurantGroupId.toHexString()));
    assert.deepEqual(groups, new Set([(await groupOf(kamat._id)).toHexString(), (await groupOf(other._id)).toHexString()]));

    // Group / restaurant / platform filters scope the work.
    await c.canonicalItems.deleteMany({});
    const scoped = await backfillCanonicalItems(c, { now, restaurantGroupId: await groupOf(other._id) });
    assert.deepEqual([scoped.restaurantsInspected, scoped.canonicalItemsCreated], [1, 1]);
    const byRestaurant = await backfillCanonicalItems(c, { now, restaurantId: kamat._id, dryRun: true });
    assert.deepEqual([byRestaurant.restaurantsInspected, byRestaurant.canonicalItemsCreated], [1, 332]);
    assert.equal((await backfillCanonicalItems(c, { now, platform: 'talabat' })).itemsInspected, 0);
  });

  test('6. seedMenuItemId and restaurantGroupId + identityKey are unique', async () => {
    const names = (await c.canonicalItems.indexes()).map(i => i.name);
    for (const spec of DINING_CANONICAL_ITEM_INDEXES) assert.ok(names.includes(spec.name!), spec.name);
    const unique = (await c.canonicalItems.indexes()).filter(i => i.unique).map(i => i.name).sort();
    assert.deepEqual(unique, ['uniq_restaurantGroupId_identityKey', 'uniq_seedMenuItemId']);

    await seedKamat(['en']);
    await mapRestaurants();
    await backfillCanonicalItems(c, { now });
    const { _id, ...existing } = (await c.canonicalItems.findOne({}))!;
    await assert.rejects(c.canonicalItems.insertOne({ ...existing, restaurantGroupId: new ObjectId(), identityKey: 'seed:other' }), (e: { code?: number }) => e.code === 11000);
    await assert.rejects(c.canonicalItems.insertOne({ ...existing, seedMenuItemId: new ObjectId() }), (e: { code?: number }) => e.code === 11000);
    // Same name twice in one group is allowed (no name uniqueness).
    await c.canonicalItems.insertOne({ ...existing, seedMenuItemId: new ObjectId(), identityKey: 'seed:manual-test' });
  });

  test('7. an unavailable or removed source item never deactivates its canonical item', async () => {
    await seedKamat(['en']);
    await mapRestaurants();
    const source = await thaliSource();
    await t.collections.menuItems.updateOne({ _id: source._id }, { $set: { isAvailable: false } });
    await backfillCanonicalItems(c, { now });
    assert.equal((await c.canonicalItems.findOne({ seedMenuItemId: source._id }))!.status, 'active');

    await t.collections.menuItems.updateOne({ _id: source._id }, { $set: { isAvailable: false, isActive: false } });
    const again = await backfillCanonicalItems(c, { now });
    assert.equal(again.canonicalItemsReused, 332);
    const thali = (await c.canonicalItems.findOne({ seedMenuItemId: source._id }))!;
    assert.equal(thali.status, 'active');
    assert.equal(thali.identityStatus, 'auto');

    // A source item that was already off the menu before it was ever canonicalized is skipped, not created.
    const removed = await addSourceItem(source, '700002', { en: 'Old Special' });
    await t.collections.menuItems.updateOne({ _id: removed._id }, { $set: { isActive: false } });
    const third = await backfillCanonicalItems(c, { now });
    assert.equal(third.skipped, 1);
    assert.equal(third.issues[0].code, 'SOURCE_ITEM_INACTIVE');
    assert.equal(await c.canonicalItems.countDocuments({ seedMenuItemId: removed._id }), 0);
  });

  test('8. two source items with the same/similar name are not merged', async () => {
    await seedKamat(['en']);
    await mapRestaurants();
    const template = await thaliSource();
    const a = await addSourceItem(template, '700003', { en: 'Mysore Masala Cheese Dosa' });
    const b = await addSourceItem(template, '700004', { en: 'Mysore Masala Cheese Dosa' });
    const d = await addSourceItem(template, '700005', { en: 'Mysore masala cheese dosa.' });
    const report = await backfillCanonicalItems(c, { now });
    assert.equal(report.canonicalItemsCreated, 335);
    const items = await c.canonicalItems.find({ seedMenuItemId: { $in: [a._id, b._id, d._id] } }).toArray();
    assert.equal(items.length, 3);
    assert.equal(new Set(items.map(i => i._id.toHexString())).size, 3);
    assert.deepEqual(new Set(items.map(i => i.signals.normalizedNames[0])), new Set(['mysore masala cheese dosa']));
  });

  test('9. variants remain distinguishable', async () => {
    await seedKamat();
    await mapRestaurants();
    const template = await thaliSource();
    const added = await Promise.all([
      addSourceItem(template, '700010', { en: 'Plain Dosa (2 Pcs)' }),
      addSourceItem(template, '700011', { en: 'Plain Dosa (6 Pcs)' }),
      addSourceItem(template, '700012', { en: 'Margherita Pizza 10 inch' }),
      addSourceItem(template, '700013', { en: 'Margherita Pizza 12 inch' }),
      addSourceItem(template, '700014', { en: 'Combo Meal' }),
      addSourceItem(template, '700015', { en: 'Single Burger' }),
    ]);
    await backfillCanonicalItems(c, { now });
    const byId = new Map((await c.canonicalItems.find({ seedMenuItemId: { $in: added.map(a => a._id) } }).toArray()).map(ci => [ci.seedMenuItemId.toHexString(), ci]));
    const v = (i: number) => byId.get(added[i]._id.toHexString())!;
    assert.equal(byId.size, 6);
    assert.deepEqual([v(0).variant?.quantity, v(1).variant?.quantity], [2, 6]);
    assert.deepEqual([v(2).variant?.size, v(3).variant?.size], ['10 inch', '12 inch']);
    assert.deepEqual([v(4).variant, v(5).variant], [undefined, undefined]);
    assert.notDeepEqual(v(4).signals.normalizedNames, v(5).signals.normalizedNames);

    // Real Kamat data: "(2 Pcs)" items carry a variant in both locales; "Paneer 65" / "3 Cheese Sandwich" do not.
    const wadaPav = (await c.canonicalItems.findOne({ 'canonicalName.en': 'Wada Pav (2 Pcs)' }))!;
    assert.equal(wadaPav.variant?.quantity, 2);
    assert.equal(wadaPav.variant?.unit, 'pcs');
    assert.equal(wadaPav.variant?.label?.en, '2 Pcs');
    for (const name of ['Paneer 65', '3 Cheese Sandwich']) assert.equal((await c.canonicalItems.findOne({ 'canonicalName.en': name }))!.variant, undefined, name);
    assert.equal(await c.canonicalItems.countDocuments({ 'variant.quantity': 2, seedRestaurantId: template.restaurantId }), 8);
  });

  test('10. dry run reports from the database and writes nothing', async () => {
    await seedKamat();
    await mapRestaurants();
    const sourceBefore = await t.collections.menuItems.find().sort({ _id: 1 }).toArray();
    const mappingsBefore = await c.restaurantMappings.find().toArray();
    const dry = await backfillCanonicalItems(c, { dryRun: true, now });
    assert.equal(dry.dryRun, true);
    assert.deepEqual(totals(dry), { itemsInspected: 332, canonicalItemsCreated: 332, canonicalItemsReused: 0, canonicalItemsEnriched: 0, skipped: 0, invalid: 0, restaurantsWithoutGroup: 0, failures: 0 });
    assert.equal(await c.canonicalItems.countDocuments(), 0);
    assert.deepEqual(await t.collections.menuItems.find().sort({ _id: 1 }).toArray(), sourceBefore);
    assert.deepEqual(await c.restaurantMappings.find().toArray(), mappingsBefore);
  });

  test('11. CLI: dry run by default, --apply writes, second --apply reuses', async () => {
    await seedKamat();
    await mapRestaurants();
    const cli = (args: string[]) => {
      const res = spawnSync(process.execPath, ['--require', 'ts-node/register', join(__dirname, '../../src/dining/canonical-items/canonical-item.backfill.cli.ts'), ...args], {
        cwd: join(__dirname, '../..'),
        env: { ...process.env, MONGODB_URI: process.env.DINING_TEST_MONGODB_URI, MONGODB_DB: t.db.databaseName, NODE_ENV: 'test' },
        encoding: 'utf8',
        timeout: 120_000,
      });
      assert.equal(res.status, 0, res.stderr);
      const last = res.stdout.trim().split('\n').filter(l => l.startsWith('[dining-canonical] {')).pop()!;
      return { out: res.stdout, totals: JSON.parse(last.slice('[dining-canonical] '.length)) };
    };

    const dry = cli([]);
    assert.match(dry.out, /DRY RUN/);
    assert.equal(dry.totals.canonicalItemsCreated, 332);
    assert.equal(await c.canonicalItems.countDocuments(), 0);

    const apply = cli(['--apply']);
    assert.match(apply.out, /APPLY/);
    assert.equal(apply.totals.canonicalItemsCreated, 332);
    assert.equal(await c.canonicalItems.countDocuments(), 332);

    const again = cli(['--apply', '--platform=deliveroo']);
    assert.equal(again.totals.canonicalItemsCreated, 0);
    assert.equal(again.totals.canonicalItemsReused, 332);
    assert.equal(await c.canonicalItems.countDocuments(), 332);
    assert.doesNotMatch(apply.out + again.out, /mongodb:\/\//);
  });

  test('12. a restaurant without a matched group is skipped safely', async () => {
    const kamat = await seedKamat(['en']);
    const none = await backfillCanonicalItems(c, { now });
    assert.deepEqual(totals(none), { itemsInspected: 332, canonicalItemsCreated: 0, canonicalItemsReused: 0, canonicalItemsEnriched: 0, skipped: 332, invalid: 0, restaurantsWithoutGroup: 1, failures: 0 });
    assert.deepEqual(none.issues, [{ outcome: 'SKIPPED', code: 'NO_RESTAURANT_MAPPING', restaurantId: kamat._id.toHexString(), message: 'Restaurant has no matched canonical restaurant group', itemCount: 332 }]);

    await mapRestaurants();
    await c.restaurantMappings.updateOne({ restaurantId: kamat._id }, { $set: { matchStatus: 'REVIEW' } });
    assert.equal((await backfillCanonicalItems(c, { now })).issues[0].code, 'RESTAURANT_NOT_MATCHED');
    await c.restaurantMappings.updateOne({ restaurantId: kamat._id }, { $set: { matchStatus: 'MATCHED' } });
    await c.restaurantGroups.deleteMany({});
    assert.equal((await backfillCanonicalItems(c, { now })).issues[0].code, 'RESTAURANT_GROUP_NOT_FOUND');
    assert.equal(await c.canonicalItems.countDocuments(), 0);
  });

  test('13. a malformed source item is rejected safely; the rest still backfill', async () => {
    const kamat = await seedKamat(['en']);
    await mapRestaurants();
    const bad = await t.collections.menuItems.insertOne({
      platform: 'deliveroo', restaurantId: kamat._id, name: { en: 'PRIVATE-VALUE-123' }, price: -5, sourceKey: 'nonsense',
    } as unknown as DiningMenuItem);
    const report = await backfillCanonicalItems(c, { now });
    assert.equal(report.invalid, 1);
    assert.equal(report.canonicalItemsCreated, 332);
    assert.equal(report.failures, 0);
    const issue = report.issues.find(i => i.code === 'INVALID_SOURCE_ITEM')!;
    assert.equal(issue.menuItemId, bad.insertedId.toHexString());
    assert.match(issue.message, /^Invalid fields: /);
    assert.doesNotMatch(JSON.stringify(report), /PRIVATE-VALUE-123|nonsense/);
    assert.equal(await c.canonicalItems.countDocuments({ seedMenuItemId: bad.insertedId }), 0);
  });
});
