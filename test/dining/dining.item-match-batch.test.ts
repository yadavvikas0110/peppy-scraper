/// <reference types="node" />
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';
import { ObjectId, WithId } from 'mongodb';
import { backfillCanonicalItems } from '../../src/dining/canonical-items/canonical-item.backfill';
import { ensureDiningCanonicalItemIndexes, getDiningCanonicalItemCollections } from '../../src/dining/canonical-items/canonical-item.collections';
import { normalizeItemText } from '../../src/dining/canonical-items/canonical-item.text';
import { persistMappedMenu } from '../../src/dining/dining.persistence';
import { buildMenuItemSourceKey } from '../../src/dining/dining.source-key';
import type { DiningLocale, DiningMenuItem, DiningRestaurant } from '../../src/dining/dining.types';
import { backfillRestaurantIdentity } from '../../src/dining/identity/identity.backfill';
import { ensureDiningIdentityIndexes, getDiningIdentityCollections } from '../../src/dining/identity/identity.collections';
import { assignRestaurantToGroup, createDiningIdentityRepositories } from '../../src/dining/identity/identity.service';
import {
  DiningItemMatchBatchError,
  getItemMatchBatchCollections,
  ItemMatchBatchCollections,
  ItemMatchBatchInput,
  ItemMatchBatchReport,
  planFingerprint,
  runItemMatchBatch,
} from '../../src/dining/item-mappings/item-mapping.batch';
import { ensureDiningItemMappingIndexes } from '../../src/dining/item-mappings/item-mapping.collections';
import { importSeedItemMappings } from '../../src/dining/item-mappings/item-mapping.import';
import { createItemMappingService } from '../../src/dining/item-mappings/item-mapping.service';
import { matchItem, toMatchSource } from '../../src/dining/item-mappings/item-matcher';
import { mapDeliverooMenu } from '../../src/dining/platforms/deliveroo/deliveroo.mapper';
import { parseDeliverooMenu } from '../../src/dining/platforms/deliveroo/deliveroo.parser';
import type { DiningMappedMenu } from '../../src/dining/platforms/platform.mapper';
import { mapTalabatMenu } from '../../src/dining/platforms/talabat/talabat.mapper';
import { parseTalabatMenu } from '../../src/dining/platforms/talabat/talabat.parser';
import { closeTestClient, GOLDEN_MILE_URL, goldenMileFixtureHtml, LOCAL_DB_SKIP, mappedMenu, openTestDb, TestDb } from './helpers';

// Cross-platform matching of Deliveroo Golden Mile against Talabat-seeded Palm canonical items.
// Real sanitized fixtures of both Palm listings plus Deliveroo Business Bay; no network.

const FIXTURES = join(__dirname, 'fixtures');
const TALABAT_URL: Record<DiningLocale, string> = {
  en: 'https://www.talabat.com/uae/restaurant/773429/kamat-vegetarian-the-palm-jumeirah?aid=1333',
  ar: 'https://www.talabat.com/ar/uae/restaurant/773429/kamat-vegetarian-the-palm-jumeirah?aid=1333',
};
const talabatMenu = (locale: DiningLocale): DiningMappedMenu =>
  mapTalabatMenu(parseTalabatMenu(readFileSync(join(FIXTURES, `talabat-${locale}.html`), 'utf8'), { locale, sourceUrl: TALABAT_URL[locale] }));
const goldenMileMenu = (): DiningMappedMenu => mapDeliverooMenu(parseDeliverooMenu(goldenMileFixtureHtml(), { locale: 'en', sourceUrl: GOLDEN_MILE_URL }));

describe('item match batch (offline)', () => {
  test('both Palm fixtures list the same dishes by name (the data the batch runs on)', () => {
    const names = (m: DiningMappedMenu) => new Set(m.items.map(i => normalizeItemText(i.name.en)));
    const talabat = names(talabatMenu('en'));
    const deliveroo = names(goldenMileMenu());
    assert.ok(talabat.size > 300);
    assert.deepEqual([...deliveroo].filter(n => !talabat.has(n)), []);
  });

  test('the plan fingerprint ignores order and changes with any decision', () => {
    const a = { menuItemId: 'a', outcome: 'created', status: 'MATCHED', canonicalItemId: 'x', method: 'NAME_DESCRIPTION' };
    const b = { menuItemId: 'b', outcome: 'created', status: 'REVIEW', canonicalItemId: 'y', method: 'NAME_CATEGORY' };
    assert.equal(planFingerprint([a, b]), planFingerprint([b, a]));
    assert.match(planFingerprint([a, b]), /^[0-9a-f]{16}$/);
    assert.notEqual(planFingerprint([a, b]), planFingerprint([a, { ...b, status: 'MATCHED' }]));
    assert.notEqual(planFingerprint([a, b]), planFingerprint([a, { ...b, canonicalItemId: 'z' }]));
    assert.notEqual(planFingerprint([a, b]), planFingerprint([a]));
  });

  test('equal name and equal price alone never MATCH; price is not a matcher input', () => {
    const groupId = new ObjectId();
    const deliverooThali = goldenMileMenu().items.find(i => i.name.en === 'Thali')!;
    const source = toMatchSource({ platform: 'deliveroo', name: deliverooThali.name });
    assert.equal('price' in source, false);
    const candidate = { canonicalItemId: new ObjectId(), restaurantGroupId: groupId, canonicalName: { en: 'Thali' }, aliases: [] };
    const decision = matchItem(source, [candidate], { restaurantGroupId: groupId });
    assert.equal(decision.status, 'REVIEW');
    assert.ok(decision.evidence.reasons.includes('INSUFFICIENT_CORROBORATION'));
  });
});

describe('item match batch: Deliveroo Golden Mile → Talabat Palm (local MongoDB)', { skip: LOCAL_DB_SKIP }, () => {
  let t: TestDb;
  let c: ItemMatchBatchCollections;
  let talabat: WithId<DiningRestaurant>;
  let goldenMile: WithId<DiningRestaurant>;
  let businessBay: WithId<DiningRestaurant>;
  let palm: ObjectId;
  let bbGroup: ObjectId;
  const now = new Date('2026-10-09T12:00:00Z');
  const later = (s: number) => new Date(now.getTime() + s * 1000);
  const input = (o: Partial<ItemMatchBatchInput> = {}): ItemMatchBatchInput => ({
    restaurantGroupId: palm, restaurantId: goldenMile._id, seedPlatform: 'talabat', now, ...o,
  });
  const snapshot = async () => ({
    mappings: await c.itemMappings.find().sort({ _id: 1 }).toArray(),
    canonicals: await c.canonicalItems.find().sort({ _id: 1 }).toArray(),
    restaurantMappings: await c.restaurantMappings.find().sort({ _id: 1 }).toArray(),
  });
  const refusal = (code: string) => (e: unknown) => e instanceof DiningItemMatchBatchError && e.code === code;

  before(async () => {
    t = await openTestDb('itemmatch');
    await ensureDiningIdentityIndexes(t.db);
    await ensureDiningCanonicalItemIndexes(t.db);
    await ensureDiningItemMappingIndexes(t.db);
    c = getItemMatchBatchCollections(t.db);
    for (const locale of ['en', 'ar'] as const) {
      await persistMappedMenu(t.repos, talabatMenu(locale), { locale, runId: `run_tb_${locale}`, now });
      await persistMappedMenu(t.repos, mappedMenu(locale), { locale, runId: `run_bb_${locale}`, now });
    }
    await persistMappedMenu(t.repos, goldenMileMenu(), { locale: 'en', runId: 'run_gm_en', now });
    talabat = (await t.collections.restaurants.findOne({ platformRestaurantId: '773429' }))!;
    goldenMile = (await t.collections.restaurants.findOne({ platformRestaurantId: '735078' }))!;
    businessBay = (await t.collections.restaurants.findOne({ platformRestaurantId: '76728' }))!;

    const identity = createDiningIdentityRepositories(getDiningIdentityCollections(t.db));
    await backfillRestaurantIdentity(identity, { platform: 'talabat', now });
    palm = (await c.restaurantMappings.findOne({ restaurantId: talabat._id }))!.canonicalRestaurantGroupId!;
    await assignRestaurantToGroup(identity, { restaurantId: goldenMile._id, groupId: palm, note: 'test: verified same branch' }, now);
    await backfillRestaurantIdentity(identity, { now });
    bbGroup = (await c.restaurantMappings.findOne({ restaurantId: businessBay._id }))!.canonicalRestaurantGroupId!;
    assert.ok(!bbGroup.equals(palm));

    const canonical = getDiningCanonicalItemCollections(t.db);
    await backfillCanonicalItems(canonical, { restaurantGroupId: palm, platform: 'talabat', now });
    // Business Bay gets canonical items with the very same dish names, in its own group.
    await backfillCanonicalItems(canonical, { restaurantGroupId: bbGroup, now });
  });
  beforeEach(async () => {
    await c.itemMappings.deleteMany({});
    await importSeedItemMappings(c, { now });
  });
  after(async () => {
    await t?.close();
    await closeTestClient();
  });

  const talabatItems = () => t.collections.menuItems.countDocuments({ restaurantId: talabat._id });
  const goldenMileItems = () => t.collections.menuItems.countDocuments({ restaurantId: goldenMile._id });

  function assertConsistent(r: ItemMatchBatchReport) {
    assert.equal(r.decisions.MATCHED + r.decisions.REVIEW + r.decisions.UNMATCHED + r.outcomes.failed, r.sourceItems.inspected);
    assert.equal(Object.values(r.outcomes).reduce((s, n) => s + n, 0), r.sourceItems.inspected);
  }

  test('prerequisite state: Talabat-seeded Palm canonical items with seed mappings; Business Bay separate', async () => {
    const palmCanonicals = await c.canonicalItems.find({ restaurantGroupId: palm }).toArray();
    assert.equal(palmCanonicals.length, await talabatItems());
    assert.ok(palmCanonicals.every(ci => ci.seedPlatform === 'talabat' && ci.seedRestaurantId.equals(talabat._id)));
    assert.equal(await c.itemMappings.countDocuments({ restaurantGroupId: palm, platform: 'talabat', matchStatus: 'MATCHED', isActive: true }), palmCanonicals.length);
    assert.equal(await c.itemMappings.countDocuments({ restaurantId: goldenMile._id }), 0);
    assert.ok(await c.canonicalItems.countDocuments({ restaurantGroupId: bbGroup }) > 300);
  });

  test('dry run (default): full report, stable plan, nothing written', async () => {
    const before = await snapshot();
    const r = await runItemMatchBatch(c, input());
    assert.equal(r.dryRun, true);
    assert.deepEqual(await snapshot(), before);

    assert.equal(r.sourceItems.total, await goldenMileItems());
    assert.equal(r.sourceItems.inspected, r.sourceItems.total);
    assertConsistent(r);
    assert.equal(r.outcomes.failed, 0);
    assert.equal(r.outcomes.created, r.sourceItems.inspected);
    assert.equal(r.decisions.REJECTED, 0);
    assert.deepEqual(r.scope.groupMembers.sort(), ['deliveroo:735078', 'talabat:773429']);
    assert.equal(r.scope.canonicalItems, await talabatItems());
    assert.deepEqual(r.decisions, { MATCHED: 323, REVIEW: 10, UNMATCHED: 0, REJECTED: 0 });
    assert.deepEqual(r.methods, { 'MATCHED:EXACT_NORMALIZED': 323, 'REVIEW:EXACT_NORMALIZED': 10 });
    assert.deepEqual(r.writes, { planned: r.sourceItems.inspected, heldDuplicates: 0 });
    assert.deepEqual([r.duplicateTargets, r.revisions, r.keptExisting, r.errors], [[], [], [], []]);
    // The 10 REVIEW items are drinks without descriptions: exact name + category only (0.6 < matchMin).
    assert.deepEqual(r.review.map(l => [l.confidence, l.conflicts, l.item.name === l.canonical!.name]), r.review.map(() => [0.6, [], true]));
    assert.ok(r.review.some(l => l.item.name === 'Coca Cola'));

    for (const l of [...r.matched, ...r.review]) {
      assert.ok(l.canonical && l.matchMethod, 'MATCHED/REVIEW keep the canonical item and method');
      assert.ok(l.reasons.some(x => x.startsWith('NAME_')));
    }
    for (const l of r.matched) {
      assert.ok(l.confidence >= 0.7);
      assert.ok(l.reasons.some(x => ['DESCRIPTION_SIMILAR', 'CATEGORY_MATCH', 'MODIFIERS_AGREE'].includes(x)), 'never MATCHED on name alone');
    }
    assert.equal((await runItemMatchBatch(c, input({ now: later(5) }))).plan, r.plan);
  });

  test('Business Bay is never a candidate and never inspected', async () => {
    const r = await runItemMatchBatch(c, input());
    const bbCanonicalIds = new Set((await c.canonicalItems.find({ restaurantGroupId: bbGroup }, { projection: { _id: 1 } }).toArray()).map(x => x._id.toHexString()));
    const palmCanonicalIds = new Set((await c.canonicalItems.find({ restaurantGroupId: palm }, { projection: { _id: 1 } }).toArray()).map(x => x._id.toHexString()));
    const referenced = [...r.matched, ...r.review, ...r.unmatched].flatMap(l => [l.canonical, ...l.otherCandidates]).filter(Boolean).map(x => x!.canonicalItemId);
    assert.ok(referenced.length > 0);
    assert.ok(referenced.every(id => palmCanonicalIds.has(id) && !bbCanonicalIds.has(id)));
    const bbItemIds = new Set((await t.collections.menuItems.find({ restaurantId: businessBay._id }, { projection: { _id: 1 } }).toArray()).map(x => x._id.toHexString()));
    assert.ok([...r.matched, ...r.review, ...r.unmatched].every(l => !bbItemIds.has(l.item.menuItemId)));

    const before = await snapshot();
    await assert.rejects(runItemMatchBatch(c, input({ restaurantId: businessBay._id })), refusal('RESTAURANT_NOT_IN_GROUP'));
    await assert.rejects(runItemMatchBatch(c, input({ restaurantId: businessBay._id, dryRun: false, expectedPlan: r.plan })), refusal('RESTAURANT_NOT_IN_GROUP'));
    assert.deepEqual(await snapshot(), before);
  });

  test('apply needs the reviewed plan; writes once; rerun is a no-op', async () => {
    const dry = await runItemMatchBatch(c, input());
    const before = await snapshot();
    await assert.rejects(runItemMatchBatch(c, input({ dryRun: false })), refusal('PLAN_REQUIRED'));
    await assert.rejects(runItemMatchBatch(c, input({ dryRun: false, expectedPlan: '0000000000000000' })), refusal('PLAN_CHANGED'));
    assert.deepEqual(await snapshot(), before);

    const applied = await runItemMatchBatch(c, input({ dryRun: false, expectedPlan: dry.plan, now: later(10) }));
    assert.deepEqual(applied.writes, { planned: dry.sourceItems.inspected, heldDuplicates: 0, written: dry.sourceItems.inspected, failures: 0 });
    assert.deepEqual(applied.errors, []);

    // Exactly the reviewed decisions are stored, whatever the write order.
    const gm = await c.itemMappings.find({ restaurantId: goldenMile._id }).toArray();
    assert.equal(gm.length, dry.sourceItems.inspected);
    assert.ok(gm.every(m => m.isActive && m.decidedBy === 'matcher' && m.platform === 'deliveroo' && m.restaurantGroupId.equals(palm)));
    for (const l of [...dry.matched, ...dry.review, ...dry.unmatched]) {
      const stored = gm.find(x => x.menuItemId.toHexString() === l.item.menuItemId)!;
      assert.deepEqual(
        [stored.matchStatus, stored.canonicalItemId?.toHexString() ?? null, stored.matchMethod ?? null, stored.confidence],
        [l.status, l.canonical?.canonicalItemId ?? null, l.matchMethod, l.confidence]
      );
    }
    const matched = gm.filter(m => m.matchStatus === 'MATCHED');
    assert.equal(matched.length, 323);
    const perCanonical = new Map<string, number>();
    for (const m of matched) perCanonical.set(m.canonicalItemId!.toHexString(), (perCanonical.get(m.canonicalItemId!.toHexString()) ?? 0) + 1);
    assert.ok([...perCanonical.values()].every(n => n === 1), 'one Deliveroo listing per canonical item');
    // Talabat seed mappings and canonical items are untouched.
    assert.deepEqual(await c.canonicalItems.find().sort({ _id: 1 }).toArray(), before.canonicals);
    assert.deepEqual(
      await c.itemMappings.find({ platform: 'talabat' }).sort({ _id: 1 }).toArray(),
      before.mappings.filter(m => m.platform === 'talabat')
    );

    // Re-run: nothing left to fill. Once Deliveroo siblings are mapped, their identical add-on modifiers
    // make 39 dish families (dosas, uttapams, …) look ambiguous to the matcher, which would revise its own
    // MATCHED decisions to REVIEW. The batch reports those revisions and never applies them.
    const again = await runItemMatchBatch(c, input({ now: later(20) }));
    assert.equal(again.outcomes.created, 0);
    assert.equal(again.writes.planned, 0);
    assert.equal(again.outcomes.unchanged + again.outcomes.updated, dry.sourceItems.inspected);
    assert.equal(again.revisions.length, 39);
    assert.ok(again.revisions.every(l => l.status === 'REVIEW' && l.conflicts.includes('AMBIGUOUS_CANDIDATES')));
    assert.ok(again.revisions.some(l => l.item.name === 'Masala Dosa'));
    const afterApply = await snapshot();
    const reapplied = await runItemMatchBatch(c, input({ dryRun: false, expectedPlan: again.plan, now: later(30) }));
    assert.deepEqual(reapplied.writes, { planned: 0, heldDuplicates: 0, written: 0, failures: 0 });
    assert.deepEqual(await snapshot(), afterApply);
    assert.equal(await c.itemMappings.countDocuments({ restaurantId: goldenMile._id, isActive: true }), dry.sourceItems.inspected);
  });

  test('duplicate protection: two Golden Mile listings of one dish never both MATCH the same canonical item', async () => {
    const thali = (await t.collections.menuItems.findOne({ restaurantId: goldenMile._id, 'name.en': 'Thali' }))!;
    const { _id, ...rest } = thali;
    const dup: DiningMenuItem = { ...rest, platformItemId: 'dup-thali', sourceKey: buildMenuItemSourceKey(goldenMile.sourceKey, { kind: 'id', value: 'dup-thali' }) };
    const { insertedId } = await t.collections.menuItems.insertOne(dup);
    try {
      const dry = await runItemMatchBatch(c, input());
      const dupTarget = dry.duplicateTargets.find(d => d.items.some(i => i.menuItemId === insertedId.toHexString()));
      assert.ok(dupTarget, 'dry run flags the duplicate target');
      assert.equal(dupTarget.items.length, 2);
      assert.equal(dry.writes.heldDuplicates, 2);
      assert.equal(dry.writes.planned, dry.sourceItems.inspected - 2);

      const applied = await runItemMatchBatch(c, input({ dryRun: false, expectedPlan: dry.plan, now: later(10) }));
      assert.equal(applied.writes.written, dry.sourceItems.inspected - 2);
      assert.equal(await c.itemMappings.countDocuments({ menuItemId: { $in: [thali._id, insertedId] } }), 0, 'both held back for manual review');
      assert.equal(await c.itemMappings.countDocuments({ canonicalItemId: new ObjectId(dupTarget.canonical.canonicalItemId), platform: 'deliveroo' }), 0);

      // A Deliveroo listing that appears on an already-matched canonical item later is never a second MATCHED.
      await t.collections.menuItems.deleteOne({ _id: insertedId });
      const later1 = await runItemMatchBatch(c, input({ now: later(20) }));
      assert.equal(later1.writes.planned, 1);
      await runItemMatchBatch(c, input({ dryRun: false, expectedPlan: later1.plan, now: later(30) }));
      const { insertedId: dup2 } = await t.collections.menuItems.insertOne({ ...dup, platformItemId: 'dup-thali-2', sourceKey: buildMenuItemSourceKey(goldenMile.sourceKey, { kind: 'id', value: 'dup-thali-2' }) });
      try {
        const late = await runItemMatchBatch(c, input({ now: later(40) }));
        const line = late.review.find(l => l.item.menuItemId === dup2.toHexString())!;
        assert.ok(line.conflicts.includes('PLATFORM_ALREADY_MAPPED'));
        await runItemMatchBatch(c, input({ dryRun: false, expectedPlan: late.plan, now: later(50) }));
        assert.equal(await c.itemMappings.countDocuments({ canonicalItemId: new ObjectId(dupTarget.canonical.canonicalItemId), platform: 'deliveroo', isActive: true, matchStatus: 'MATCHED' }), 1);
        assert.equal(await c.itemMappings.countDocuments({ menuItemId: dup2, isActive: true }), 1);
      } finally {
        await t.collections.menuItems.deleteOne({ _id: dup2 });
      }
    } finally {
      await t.collections.menuItems.deleteOne({ _id: insertedId });
    }
  });

  test('existing decisions are kept and rejected pairings are never proposed again', async () => {
    const svc = createItemMappingService(c);
    const dosa = (await t.collections.menuItems.findOne({ restaurantId: goldenMile._id, 'name.en': 'Masala Dosa' }))!;
    const idli = (await t.collections.menuItems.findOne({ restaurantId: goldenMile._id, 'name.en': 'Idli' }))!;
    const dosaPlanned = (await svc.matchSourceItem(dosa._id, { dryRun: true, now })).mapping.canonicalItemId!;
    const fried = (await c.canonicalItems.findOne({ restaurantGroupId: palm, 'canonicalName.en': 'Fried Idli' }))!;
    await svc.remapSourceItem(idli._id, fried._id, { note: 'test manual decision', now });
    await svc.matchSourceItem(dosa._id, { now });
    await svc.rejectMapping(dosa._id, { note: 'test rejection', now: later(1) });

    const r = await runItemMatchBatch(c, input({ now: later(2) }));
    assert.equal(r.decisions.REJECTED, 1);
    assert.equal(r.outcomes.kept_existing, 1);
    const kept = r.keptExisting[0];
    assert.deepEqual([kept.item.menuItemId, kept.decidedBy, kept.canonical!.canonicalItemId], [idli._id.toHexString(), 'manual', fried._id.toHexString()]);
    const dosaLine = [...r.matched, ...r.review, ...r.unmatched].find(l => l.item.menuItemId === dosa._id.toHexString())!;
    assert.notEqual(dosaLine.canonical?.canonicalItemId, dosaPlanned.toHexString());
    assert.ok(!dosaLine.otherCandidates.some(o => o.canonicalItemId === dosaPlanned.toHexString()));
  });

  test('scope refusals: same platform as seeds, foreign canonical items, no canonical items', async () => {
    const before = await snapshot();
    await assert.rejects(runItemMatchBatch(c, input({ restaurantId: talabat._id })), refusal('SAME_PLATFORM_AS_SEED'));
    await assert.rejects(runItemMatchBatch(c, input({ restaurantGroupId: bbGroup, restaurantId: businessBay._id })), refusal('FOREIGN_CANONICAL_ITEMS'));
    await assert.rejects(runItemMatchBatch(c, input({ restaurantGroupId: new ObjectId() })), refusal('RESTAURANT_NOT_IN_GROUP'));
    await assert.rejects(runItemMatchBatch(c, input({ restaurantId: new ObjectId() })), refusal('RESTAURANT_NOT_FOUND'));
    assert.deepEqual(await snapshot(), before);

    // A Deliveroo-seeded canonical item inside the Palm group would widen the candidate set → refused.
    const gmItem = (await t.collections.menuItems.findOne({ restaurantId: goldenMile._id }))!;
    const seed = (await c.canonicalItems.findOne({ restaurantGroupId: palm }))!;
    const { _id, ...rest } = seed;
    const { insertedId } = await c.canonicalItems.insertOne({ ...rest, identityKey: `seed:${palm}:${gmItem._id}`, seedMenuItemId: gmItem._id, seedRestaurantId: goldenMile._id, seedPlatform: 'deliveroo' });
    try {
      await assert.rejects(runItemMatchBatch(c, input()), refusal('FOREIGN_CANONICAL_ITEMS'));
    } finally {
      await c.canonicalItems.deleteOne({ _id: insertedId });
    }

    const inactive = await c.canonicalItems.updateMany({ restaurantGroupId: palm }, { $set: { status: 'inactive' } });
    try {
      await assert.rejects(runItemMatchBatch(c, input()), refusal('NO_SEED_CANONICAL_ITEMS'));
    } finally {
      await c.canonicalItems.updateMany({ restaurantGroupId: palm }, { $set: { status: 'active' } });
    }
    assert.ok(inactive.modifiedCount > 0);
  });
});
