/// <reference types="node" />
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';
import { ObjectId, WithId } from 'mongodb';
import { backfillCanonicalItems } from '../../src/dining/canonical-items/canonical-item.backfill';
import { ensureDiningCanonicalItemIndexes, getDiningCanonicalItemCollections } from '../../src/dining/canonical-items/canonical-item.collections';
import { persistMappedMenu } from '../../src/dining/dining.persistence';
import type { DiningLocale, DiningRestaurant } from '../../src/dining/dining.types';
import { backfillRestaurantIdentity } from '../../src/dining/identity/identity.backfill';
import { ensureDiningIdentityIndexes, getDiningIdentityCollections } from '../../src/dining/identity/identity.collections';
import { assignRestaurantToGroup, createDiningIdentityRepositories } from '../../src/dining/identity/identity.service';
import {
  checkStrictApproval,
  DiningItemApprovalError,
  isUniqueBilingualTwin,
  runStrictItemApproval,
  STRICT_APPROVAL_NOTE,
  UNIQUE_TWIN_APPROVAL_NOTE,
} from '../../src/dining/item-mappings/item-mapping.approve';
import { getItemMatchBatchCollections, ItemMatchBatchCollections, runItemMatchBatch } from '../../src/dining/item-mappings/item-mapping.batch';
import { ensureDiningItemMappingIndexes } from '../../src/dining/item-mappings/item-mapping.collections';
import { importSeedItemMappings } from '../../src/dining/item-mappings/item-mapping.import';
import type { DiningItemMapping } from '../../src/dining/item-mappings/item-mapping.types';
import { mapTalabatMenu } from '../../src/dining/platforms/talabat/talabat.mapper';
import { parseTalabatMenu } from '../../src/dining/platforms/talabat/talabat.parser';
import { closeTestClient, LOCAL_DB_SKIP, mappedMenu, openTestDb, TestDb } from './helpers';

const groupId = new ObjectId();
const mapping = (o: Partial<DiningItemMapping> = {}) => ({
  decidedBy: 'matcher' as const,
  canonicalItemId: new ObjectId(),
  restaurantGroupId: groupId,
  evidence: { reasons: ['NAME_EXACT_EN', 'CATEGORY_MATCH'], conflicts: [] as string[] },
  ...o,
});
const item = (o: object = {}) => ({
  name: { en: 'Big Mac', ar: 'بيج ماك' },
  categoryName: { en: 'Main Menu – Meals', ar: 'القائمة الأساسية - الوجبات' },
  ...o,
});
const canonical = (o: object = {}) => ({
  restaurantGroupId: groupId,
  status: 'active' as const,
  canonicalName: { en: 'Big Mac', ar: 'بيج ماك' },
  category: { en: 'Main Menu - Meals', ar: 'القائمة الأساسية - الوجبات' },
  ...o,
});

describe('strict item approval rule (pure)', () => {
  test('identical EN+AR name, EN+AR category and variant with no conflicts is approvable (punctuation-insensitive)', () => {
    assert.deepEqual(checkStrictApproval(mapping(), item(), canonical()), []);
  });

  test('every missing or differing signal blocks approval', () => {
    assert.deepEqual(checkStrictApproval(mapping({ decidedBy: 'import' }), item(), canonical()), ['NOT_MATCHER_DECISION']);
    assert.deepEqual(checkStrictApproval(mapping({ canonicalItemId: undefined }), item(), canonical()), ['NO_CANONICAL_ITEM']);
    assert.deepEqual(checkStrictApproval(mapping(), item(), null), ['NO_CANONICAL_ITEM']);
    assert.deepEqual(checkStrictApproval(mapping(), item(), canonical({ restaurantGroupId: new ObjectId() })), ['CANONICAL_OUT_OF_SCOPE']);
    assert.deepEqual(checkStrictApproval(mapping(), item(), canonical({ status: 'inactive' })), ['CANONICAL_OUT_OF_SCOPE']);
    assert.deepEqual(
      checkStrictApproval(mapping({ evidence: { reasons: [], conflicts: ['AMBIGUOUS_CANDIDATES'] } }), item(), canonical()),
      ['HAS_CONFLICTS']
    );
    assert.deepEqual(checkStrictApproval(mapping(), item({ name: { en: 'Big Mac', ar: 'بيج ماك دبل' } }), canonical()), ['NAME_AR_DIFFERS']);
    assert.deepEqual(checkStrictApproval(mapping(), item({ name: { en: 'Big Mac' } }), canonical()), ['NAME_AR_DIFFERS']);
    assert.deepEqual(checkStrictApproval(mapping(), item({ name: { en: 'Grand Big Mac', ar: 'بيج ماك' } }), canonical()), ['NAME_EN_DIFFERS']);
    assert.deepEqual(
      checkStrictApproval(mapping(), item({ categoryName: { en: 'Desserts', ar: 'القائمة الأساسية - الوجبات' } }), canonical()),
      ['CATEGORY_EN_DIFFERS']
    );
    assert.deepEqual(checkStrictApproval(mapping(), item({ categoryName: { en: 'Main Menu – Meals' } }), canonical()), ['CATEGORY_AR_DIFFERS']);
    assert.deepEqual(
      checkStrictApproval(mapping(), item({ name: { en: 'Nuggets 6 Pcs', ar: 'ناجتس' } }), canonical({ canonicalName: { en: 'Nuggets 6 Pcs', ar: 'ناجتس' }, variant: { quantity: 9 } })),
      ['VARIANT_DIFFERS']
    );
  });

  test('price and image are not inputs', () => {
    const withPrice = { ...item(), price: 22, imageUrl: 'https://a.example/x.jpg' };
    assert.deepEqual(checkStrictApproval(mapping(), withPrice, canonical()), []);
    assert.equal(checkStrictApproval.length, 3);
  });
});

describe('unique bilingual twin waiver (pure)', () => {
  const ci = (en: string, ar: string) => ({ _id: new ObjectId(), canonicalName: { en, ar } });
  // Shapes observed on McDonald's Mercato (Deliveroo canonical items).
  const nuggetsLarge = ci('6 pcs Chicken McNuggets Large Meal', 'وجبة 6 قطع تشيكن ماك ناجتس بالحجم الكبير');
  const nuggetsMedium = ci('6 pcs Chicken McNuggets Medium Meal', 'وجبة 6 قطع تشيكن ماك ناجتس بالحجم الوسط');
  const nuggets = ci('6 pcs Chicken McNuggets', '6قطع تشيكن ماك ناجتس');
  const chickenMac = ci('Chicken Mac', 'تشيكن ماك');
  const mcChicken = ci('McChicken', 'ماك تشيكن');
  const spicyShrimpLarge = ci('Spicy Shrimp Burger Large Meal', 'وجبة سبايسي شرمب برجر بالحجم الكبير');
  // Both platforms publish Fish & Fries Large Meal with the Spicy Shrimp Arabic name.
  const fishFriesLarge = ci('Fish & Fries Large Meal', 'وجبة سبايسي شرمب برجر بالحجم الكبير');
  const group = [nuggetsLarge, nuggetsMedium, nuggets, chickenMac, mcChicken, spicyShrimpLarge, fishFriesLarge];
  const ambiguous = (target: { _id: ObjectId }, conflicts = ['AMBIGUOUS_CANDIDATES']) => ({ canonicalItemId: target._id, evidence: { reasons: [], conflicts } });
  const src = (c: { canonicalName: { en: string; ar: string } }) => ({ name: { ...c.canonicalName } });

  test('meal-size siblings and the Chicken Mac / McChicken pair are unique twins', () => {
    for (const target of [nuggetsLarge, nuggetsMedium, nuggets, chickenMac, mcChicken]) {
      assert.equal(isUniqueBilingualTwin(ambiguous(target), src(target), group), true, target.canonicalName.en);
    }
  });

  test('a shared Arabic (or English) name with another canonical item is never waived', () => {
    assert.equal(isUniqueBilingualTwin(ambiguous(spicyShrimpLarge), src(spicyShrimpLarge), group), false);
    assert.equal(isUniqueBilingualTwin(ambiguous(fishFriesLarge), src(fishFriesLarge), group), false);
    const hiddenDuplicate = ci('Tall Hot Chocolate', 'شوكولاتة ساخنة');
    const listed = ci('Tall Hot Chocolate', 'شوكولاتة ساخنة وسط');
    assert.equal(isUniqueBilingualTwin(ambiguous(listed), src(listed), [...group, hiddenDuplicate, listed]), false);
  });

  test('only a lone AMBIGUOUS_CANDIDATES conflict on the proposed twin can be waived', () => {
    assert.equal(isUniqueBilingualTwin(ambiguous(chickenMac, []), src(chickenMac), group), false);
    assert.equal(isUniqueBilingualTwin(ambiguous(chickenMac, ['AMBIGUOUS_CANDIDATES', 'CATEGORY_DIFFERENT']), src(chickenMac), group), false);
    assert.equal(isUniqueBilingualTwin(ambiguous(mcChicken), src(chickenMac), group), false);
    assert.equal(isUniqueBilingualTwin({ ...ambiguous(chickenMac), canonicalItemId: undefined }, src(chickenMac), group), false);
  });
});

const TALABAT_URL: Record<DiningLocale, string> = {
  en: 'https://www.talabat.com/uae/restaurant/773429/kamat-vegetarian-the-palm-jumeirah?aid=1333',
  ar: 'https://www.talabat.com/ar/uae/restaurant/773429/kamat-vegetarian-the-palm-jumeirah?aid=1333',
};
const talabatMenu = (locale: DiningLocale) =>
  mapTalabatMenu(parseTalabatMenu(readFileSync(join(__dirname, 'fixtures', `talabat-${locale}.html`), 'utf8'), { locale, sourceUrl: TALABAT_URL[locale] }));

describe('strict item approval batch (local MongoDB)', { skip: LOCAL_DB_SKIP }, () => {
  let t: TestDb;
  let c: ItemMatchBatchCollections;
  let talabat: WithId<DiningRestaurant>;
  let deliveroo: WithId<DiningRestaurant>;
  let group: ObjectId;
  const now = new Date('2026-10-12T12:00:00Z');
  const input = (o: object = {}) => ({ restaurantGroupId: group, restaurantId: deliveroo._id, now, ...o });
  const refusal = (code: string) => (e: unknown) => e instanceof DiningItemApprovalError && e.code === code;

  // Makes one REVIEW decision satisfy the strict rule by aligning its source item with the canonical item.
  async function makeQualifying(m: WithId<DiningItemMapping>, canonicalItemId = m.canonicalItemId!) {
    const ci = (await c.canonicalItems.findOne({ _id: canonicalItemId }))!;
    await c.menuItems.updateOne({ _id: m.menuItemId }, { $set: { name: ci.canonicalName, categoryName: ci.category } });
    await c.itemMappings.updateOne({ _id: m._id }, { $set: { canonicalItemId, 'evidence.conflicts': [] } });
  }
  const reviews = () => c.itemMappings.find({ restaurantId: deliveroo._id, isActive: true, matchStatus: 'REVIEW', canonicalItemId: { $exists: true } }).sort({ _id: 1 }).toArray();

  before(async () => {
    t = await openTestDb('itemapprove');
    await ensureDiningIdentityIndexes(t.db);
    await ensureDiningCanonicalItemIndexes(t.db);
    await ensureDiningItemMappingIndexes(t.db);
    c = getItemMatchBatchCollections(t.db);
  });
  beforeEach(async () => {
    for (const name of ['dining_restaurants', 'dining_menu_items', 'dining_menu_categories', 'dining_restaurant_groups', 'dining_restaurant_mappings', 'dining_canonical_items', 'dining_item_mappings']) {
      await t.db.collection(name).deleteMany({});
    }
    for (const locale of ['en', 'ar'] as const) {
      await persistMappedMenu(t.repos, talabatMenu(locale), { locale, runId: `run_tb_${locale}`, now });
      await persistMappedMenu(t.repos, mappedMenu(locale), { locale, runId: `run_bb_${locale}`, now });
    }
    talabat = (await c.restaurants.findOne({ platformRestaurantId: '773429' }))!;
    deliveroo = (await c.restaurants.findOne({ platformRestaurantId: '76728' }))!;
    const identity = createDiningIdentityRepositories(getDiningIdentityCollections(t.db));
    await backfillRestaurantIdentity(identity, { platform: 'talabat', now });
    group = (await c.restaurantMappings.findOne({ restaurantId: talabat._id }))!.canonicalRestaurantGroupId!;
    // Test-only grouping of two listings so the batch has a cross-platform source.
    await assignRestaurantToGroup(identity, { restaurantId: deliveroo._id, groupId: group, note: 'test only' }, now);
    await backfillCanonicalItems(getDiningCanonicalItemCollections(t.db), { restaurantGroupId: group, platform: 'talabat', now });
    await importSeedItemMappings(c, { now });
    const batch = await runItemMatchBatch(c, { restaurantGroupId: group, restaurantId: deliveroo._id, seedPlatform: 'talabat', now });
    await runItemMatchBatch(c, { restaurantGroupId: group, restaurantId: deliveroo._id, seedPlatform: 'talabat', now, dryRun: false, expectedPlan: batch.plan });
  });
  after(async () => {
    await t?.close();
    await closeTestClient();
  });

  test('dry run writes nothing, is stable, and only lists decisions that satisfy the strict rule', async () => {
    const [a] = await reviews();
    await makeQualifying(a);
    const before = await c.itemMappings.find().sort({ _id: 1 }).toArray();
    const r1 = await runStrictItemApproval(c, input());
    const r2 = await runStrictItemApproval(c, input());
    assert.deepEqual(await c.itemMappings.find().sort({ _id: 1 }).toArray(), before);
    assert.equal(r1.plan, r2.plan);
    assert.ok(r1.approvable.some(l => l.menuItemId === a.menuItemId.toHexString()));
    assert.equal(r1.approvable.length + r1.skipped.length, r1.reviewInspected);
    for (const line of r1.approvable) {
      const m = (await c.itemMappings.findOne({ menuItemId: new ObjectId(line.menuItemId), isActive: true }))!;
      const src = (await c.menuItems.findOne({ _id: m.menuItemId }))!;
      assert.deepEqual(checkStrictApproval(m, src, await c.canonicalItems.findOne({ _id: m.canonicalItemId! })), []);
    }
  });

  test('apply requires the reviewed plan, then approves exactly the plan through the manual path', async () => {
    const [a] = await reviews();
    await makeQualifying(a);
    const reviewed = await runStrictItemApproval(c, input());
    const untouched = await c.itemMappings.find({ restaurantId: deliveroo._id, isActive: true, menuItemId: { $nin: reviewed.approvable.map(l => new ObjectId(l.menuItemId)) } }).sort({ _id: 1 }).toArray();
    await assert.rejects(runStrictItemApproval(c, input({ dryRun: false })), refusal('PLAN_REQUIRED'));
    await assert.rejects(runStrictItemApproval(c, input({ dryRun: false, expectedPlan: '0000000000000000' })), refusal('PLAN_CHANGED'));

    // A change to a reviewed decision changes the plan.
    const original = (await c.itemMappings.findOne({ _id: a._id }))!;
    const otherCanonical = (await c.canonicalItems.findOne({ restaurantGroupId: group, _id: { $ne: a.canonicalItemId! } }))!;
    await c.itemMappings.updateOne({ _id: a._id }, { $set: { canonicalItemId: otherCanonical._id } });
    await assert.rejects(runStrictItemApproval(c, input({ dryRun: false, expectedPlan: reviewed.plan })), refusal('PLAN_CHANGED'));
    await c.itemMappings.replaceOne({ _id: a._id }, original);

    const applied = await runStrictItemApproval(c, input({ dryRun: false, expectedPlan: reviewed.plan, note: 'test evidence' }));
    assert.equal(applied.writes.written, reviewed.approvable.length);
    assert.equal(applied.errors.length, 0);
    for (const line of reviewed.approvable) {
      const active = (await c.itemMappings.findOne({ menuItemId: new ObjectId(line.menuItemId), isActive: true }))!;
      assert.equal(active.matchStatus, 'MATCHED');
      assert.equal(active.matchMethod, 'MANUAL');
      assert.equal(active.decidedBy, 'manual');
      assert.equal(active.canonicalItemId!.toHexString(), line.canonicalItemId);
      assert.ok(active.evidence.reasons.includes('MANUAL_APPROVAL'));
      assert.equal(active.note, `${STRICT_APPROVAL_NOTE} | test evidence`);
    }
    // Decisions outside the plan are unchanged.
    for (const m of untouched) {
      assert.deepEqual(await c.itemMappings.findOne({ _id: m._id }), m);
    }
    // Re-running finds nothing new to approve.
    const again = await runStrictItemApproval(c, input());
    assert.ok(again.approvable.every(l => !reviewed.approvable.some(r => r.menuItemId === l.menuItemId)));
  });

  test('two items qualifying for one canonical item are both held back', async () => {
    const [a, b] = await reviews();
    await makeQualifying(a);
    await makeQualifying(b, a.canonicalItemId!);
    const r = await runStrictItemApproval(c, input());
    for (const m of [a, b]) {
      const line = r.skipped.find(l => l.menuItemId === m.menuItemId.toHexString());
      assert.deepEqual(line?.skips, ['DUPLICATE_TARGET']);
    }
  });

  test('a canonical item already matched on the source platform is never approved again', async () => {
    const [a] = await reviews();
    await makeQualifying(a);
    const other = (await c.itemMappings.findOne({ restaurantId: deliveroo._id, isActive: true, menuItemId: { $ne: a.menuItemId } }))!;
    await c.itemMappings.updateOne({ _id: other._id }, { $set: { matchStatus: 'MATCHED', matchMethod: 'MANUAL', canonicalItemId: a.canonicalItemId, decidedBy: 'manual', confidence: 1 } });
    const r = await runStrictItemApproval(c, input());
    assert.deepEqual(r.skipped.find(l => l.menuItemId === a.menuItemId.toHexString())?.skips, ['PLATFORM_ALREADY_MAPPED']);
  });

  test('--allow-unique-twin waives a lone AMBIGUOUS_CANDIDATES only for a unique twin, with its own plan and note', async () => {
    const [a] = await reviews();
    await makeQualifying(a);
    await c.itemMappings.updateOne({ _id: a._id }, { $set: { 'evidence.conflicts': ['AMBIGUOUS_CANDIDATES'] } });
    const id = a.menuItemId.toHexString();

    const strict = await runStrictItemApproval(c, input());
    assert.deepEqual(strict.skipped.find(l => l.menuItemId === id)?.skips, ['HAS_CONFLICTS']);
    const before = await c.itemMappings.find().sort({ _id: 1 }).toArray();
    const twin = await runStrictItemApproval(c, input({ allowUniqueTwin: true }));
    assert.deepEqual(await c.itemMappings.find().sort({ _id: 1 }).toArray(), before);
    assert.equal(twin.approvable.find(l => l.menuItemId === id)?.waived, 'AMBIGUOUS_CANDIDATES');
    assert.notEqual(twin.plan, strict.plan);
    // Without the flag the reviewed twin plan does not match.
    await assert.rejects(runStrictItemApproval(c, input({ dryRun: false, expectedPlan: twin.plan })), refusal('PLAN_CHANGED'));

    // Another canonical item sharing the Arabic name blocks the waiver.
    const target = (await c.canonicalItems.findOne({ _id: a.canonicalItemId! }))!;
    const other = (await c.canonicalItems.findOne({ restaurantGroupId: group, _id: { $ne: target._id } }))!;
    await c.canonicalItems.updateOne({ _id: other._id }, { $set: { 'canonicalName.ar': target.canonicalName.ar } });
    const blocked = await runStrictItemApproval(c, input({ allowUniqueTwin: true }));
    assert.deepEqual(blocked.skipped.find(l => l.menuItemId === id)?.skips, ['HAS_CONFLICTS']);
    await c.canonicalItems.updateOne({ _id: other._id }, { $set: { canonicalName: other.canonicalName } });

    const applied = await runStrictItemApproval(c, input({ allowUniqueTwin: true, dryRun: false, expectedPlan: twin.plan }));
    assert.equal(applied.errors.length, 0);
    const active = (await c.itemMappings.findOne({ menuItemId: a.menuItemId, isActive: true }))!;
    assert.equal(active.matchStatus, 'MATCHED');
    assert.equal(active.decidedBy, 'manual');
    assert.equal(active.canonicalItemId!.toHexString(), a.canonicalItemId!.toHexString());
    assert.equal(active.note, UNIQUE_TWIN_APPROVAL_NOTE);
  });

  test('--allow-unique-twin leaves the plan unchanged when nothing is waived', async () => {
    const [a] = await reviews();
    await makeQualifying(a);
    const strict = await runStrictItemApproval(c, input());
    const twin = await runStrictItemApproval(c, input({ allowUniqueTwin: true }));
    assert.equal(twin.plan, strict.plan);
    assert.ok(twin.approvable.every(l => !l.waived));
  });

  test('refuses a restaurant that is not a matched member of the group', async () => {
    await assert.rejects(runStrictItemApproval(c, input({ restaurantGroupId: new ObjectId() })), refusal('RESTAURANT_NOT_IN_GROUP'));
    await assert.rejects(runStrictItemApproval(c, input({ restaurantId: new ObjectId() })), refusal('RESTAURANT_NOT_FOUND'));
  });
});
