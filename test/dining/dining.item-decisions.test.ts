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
import { getItemMatchBatchCollections, ItemMatchBatchCollections, runItemMatchBatch } from '../../src/dining/item-mappings/item-mapping.batch';
import { ensureDiningItemMappingIndexes } from '../../src/dining/item-mappings/item-mapping.collections';
import {
  DiningItemDecisionError,
  ManualDecision,
  ManualDecisionEntry,
  MANUAL_DECISION_NOTE,
  parseDecisionEntries,
  runManualItemDecisions,
} from '../../src/dining/item-mappings/item-mapping.decisions';
import { importSeedItemMappings } from '../../src/dining/item-mappings/item-mapping.import';
import type { DiningItemMapping } from '../../src/dining/item-mappings/item-mapping.types';
import { mapTalabatMenu } from '../../src/dining/platforms/talabat/talabat.mapper';
import { parseTalabatMenu } from '../../src/dining/platforms/talabat/talabat.parser';
import { closeTestClient, LOCAL_DB_SKIP, mappedMenu, openTestDb, TestDb } from './helpers';

const id = () => new ObjectId().toHexString();

describe('manual decisions file (pure)', () => {
  test('accepts the reviewed file shape, including KEEP_REVIEW without a target', () => {
    const [approve, keep] = parseDecisionEntries([
      { decision: 'APPROVE', mappingId: id(), menuItemId: id(), target: { canonicalItemId: id() }, reason: ' same dish ', source: { en: 'x' } },
      { decision: 'KEEP_REVIEW', mappingId: id(), menuItemId: id(), target: null, reason: 'portion' },
    ]);
    assert.equal(approve.decision, 'APPROVE');
    assert.ok(approve.canonicalItemId instanceof ObjectId);
    assert.equal(approve.reason, 'same dish');
    assert.equal(keep.canonicalItemId, undefined);
  });

  test('rejects malformed files', () => {
    const invalid = (e: unknown) => e instanceof DiningItemDecisionError && e.code === 'INVALID_FILE';
    assert.throws(() => parseDecisionEntries({}), invalid);
    assert.throws(() => parseDecisionEntries([{ decision: 'MERGE', mappingId: id(), menuItemId: id() }]), invalid);
    assert.throws(() => parseDecisionEntries([{ decision: 'APPROVE', mappingId: 'Coca Cola', menuItemId: id() }]), invalid);
    assert.throws(() => parseDecisionEntries([{ decision: 'APPROVE', mappingId: id(), menuItemId: id(), target: { canonicalItemId: 42 } }]), invalid);
  });
});

const TALABAT_URL: Record<DiningLocale, string> = {
  en: 'https://www.talabat.com/uae/restaurant/773429/kamat-vegetarian-the-palm-jumeirah?aid=1333',
  ar: 'https://www.talabat.com/ar/uae/restaurant/773429/kamat-vegetarian-the-palm-jumeirah?aid=1333',
};
const talabatMenu = (locale: DiningLocale) =>
  mapTalabatMenu(parseTalabatMenu(readFileSync(join(__dirname, 'fixtures', `talabat-${locale}.html`), 'utf8'), { locale, sourceUrl: TALABAT_URL[locale] }));

describe('manual decisions batch (local MongoDB)', { skip: LOCAL_DB_SKIP }, () => {
  let t: TestDb;
  let c: ItemMatchBatchCollections;
  let talabat: WithId<DiningRestaurant>;
  let deliveroo: WithId<DiningRestaurant>;
  let group: ObjectId;
  const now = new Date('2026-10-12T12:00:00Z');
  const input = (entries: ManualDecisionEntry[], o: object = {}) => ({ restaurantGroupId: group, restaurantId: deliveroo._id, entries, now, ...o });
  const refusal = (code: string) => (e: unknown) => e instanceof DiningItemDecisionError && e.code === code;

  // Active Deliveroo decisions and group canonical items not MATCHED on Deliveroo, in a stable order.
  const activeDeliveroo = () => c.itemMappings.find({ restaurantId: deliveroo._id, isActive: true }).sort({ menuItemId: 1 }).toArray();
  async function freeCanonicals() {
    const matched = new Set((await c.itemMappings.find({ platform: 'deliveroo', isActive: true, matchStatus: 'MATCHED' }).toArray()).map(m => String(m.canonicalItemId)));
    return (await c.canonicalItems.find({ restaurantGroupId: group, status: 'active' }).sort({ _id: 1 }).toArray()).filter(ci => !matched.has(String(ci._id)));
  }
  // Puts one active decision into a given matcher state.
  async function asMatcher(m: WithId<DiningItemMapping>, matchStatus: 'REVIEW' | 'UNMATCHED', canonicalItemId?: ObjectId) {
    const set = { matchStatus, decidedBy: 'matcher' as const, ...(canonicalItemId ? { canonicalItemId } : {}) };
    await c.itemMappings.updateOne({ _id: m._id }, canonicalItemId ? { $set: set } : { $set: set, $unset: { canonicalItemId: '' } });
    return (await c.itemMappings.findOne({ _id: m._id }))!;
  }
  const entry = (decision: ManualDecision, m: WithId<DiningItemMapping>, canonicalItemId?: ObjectId, reason = 'reviewed'): ManualDecisionEntry => ({
    decision,
    mappingId: m._id,
    menuItemId: m.menuItemId,
    ...(canonicalItemId ? { canonicalItemId } : {}),
    reason,
  });

  // One entry of every decision type, against distinct free canonical items.
  async function scenario() {
    const [ma, mb, mc, md, me] = await activeDeliveroo();
    const [x1, x2, x3, x4, x5, x6] = await freeCanonicals();
    const a = await asMatcher(ma, 'REVIEW', x1._id);
    const b = await asMatcher(mb, 'REVIEW', x2._id);
    const cc = await asMatcher(mc, 'REVIEW', x4._id);
    const d = await asMatcher(md, 'REVIEW', x5._id);
    const e = await asMatcher(me, 'UNMATCHED');
    const entries = [
      entry('APPROVE', a, x1._id),
      entry('REMAP', b, x3._id),
      entry('REJECT', cc, x4._id),
      entry('KEEP_REVIEW', d),
      entry('MAP_UNMATCHED', e, x6._id),
    ];
    return { a, b, c: cc, d, e, x1, x2, x3, x4, x5, x6, entries };
  }

  before(async () => {
    t = await openTestDb('itemdecide');
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

  test('dry run writes nothing, is stable, and keeps KEEP_REVIEW out of the plan', async () => {
    const s = await scenario();
    const before = await c.itemMappings.find().sort({ _id: 1 }).toArray();
    const r1 = await runManualItemDecisions(c, input(s.entries));
    const r2 = await runManualItemDecisions(c, input(s.entries));
    assert.deepEqual(await c.itemMappings.find().sort({ _id: 1 }).toArray(), before);
    assert.equal(r1.plan, r2.plan);
    assert.deepEqual(r1.refused, []);
    assert.deepEqual(r1.byDecision, { APPROVE: 1, REMAP: 1, REJECT: 1, MAP_UNMATCHED: 1, KEEP_REVIEW: 1 });
    assert.equal(r1.writes.planned, 4);
    const withoutKeep = await runManualItemDecisions(c, input(s.entries.filter(e => e.decision !== 'KEEP_REVIEW')));
    assert.equal(withoutKeep.plan, r1.plan);
  });

  test('apply needs the reviewed plan, then writes each decision through the manual path only', async () => {
    const s = await scenario();
    const reviewed = await runManualItemDecisions(c, input(s.entries));
    await assert.rejects(runManualItemDecisions(c, input(s.entries, { dryRun: false })), refusal('PLAN_REQUIRED'));
    await assert.rejects(runManualItemDecisions(c, input(s.entries, { dryRun: false, expectedPlan: '0000000000000000' })), refusal('PLAN_CHANGED'));
    const touched = new Set([s.a, s.b, s.c, s.e].map(m => String(m.menuItemId)));
    const untouched = (await c.itemMappings.find().sort({ _id: 1 }).toArray()).filter(m => !touched.has(String(m.menuItemId)));

    const applied = await runManualItemDecisions(c, input(s.entries, { dryRun: false, expectedPlan: reviewed.plan }));
    assert.deepEqual(applied.writes, { planned: 4, written: 4, failures: 0 });
    const active = async (m: WithId<DiningItemMapping>) => c.itemMappings.findOne({ menuItemId: m.menuItemId, isActive: true });

    for (const [m, target, reason] of [[s.a, s.x1, 'MANUAL_APPROVAL'], [s.b, s.x3, 'MANUAL_REMAP'], [s.e, s.x6, 'MANUAL_APPROVAL']] as const) {
      const current = (await active(m))!;
      assert.equal(current.matchStatus, 'MATCHED');
      assert.equal(current.decidedBy, 'manual');
      assert.ok(current.canonicalItemId!.equals(target._id));
      assert.ok(current.evidence.reasons.includes(reason));
      assert.ok(current.note!.startsWith(MANUAL_DECISION_NOTE));
    }
    // The remapped-away pairing is kept as REJECTED history.
    assert.ok(await c.itemMappings.findOne({ menuItemId: s.b.menuItemId, canonicalItemId: s.x2._id, matchStatus: 'REJECTED', isActive: false }));
    // A rejected proposal leaves no active decision and is recorded as REJECTED.
    assert.equal(await active(s.c), null);
    assert.ok(await c.itemMappings.findOne({ menuItemId: s.c.menuItemId, canonicalItemId: s.x4._id, matchStatus: 'REJECTED', isActive: false }));
    // KEEP_REVIEW and everything outside the file are unchanged.
    for (const m of untouched) assert.deepEqual(await c.itemMappings.findOne({ _id: m._id }), m);
    assert.equal((await active(s.d))!.matchStatus, 'REVIEW');
  });

  test('every unsafe entry is refused, and any refusal blocks the whole apply', async () => {
    const s = await scenario();
    const [, , , , , , , y, z] = await freeCanonicals();
    await c.canonicalItems.updateOne({ _id: z._id }, { $set: { restaurantGroupId: new ObjectId() } });
    const imported = (await c.itemMappings.findOne({ restaurantId: talabat._id, isActive: true }))!;
    const check = async (e: ManualDecisionEntry, expected: string[]) => {
      const r = await runManualItemDecisions(c, input([e]));
      assert.deepEqual(r.refused[0]?.refusals, expected, `${e.decision} → ${expected}`);
      await assert.rejects(runManualItemDecisions(c, input([e], { dryRun: false, expectedPlan: r.plan })), refusal('DECISIONS_REFUSED'));
    };
    await check({ ...entry('APPROVE', s.a, s.x1._id), mappingId: new ObjectId() }, ['STALE_DECISION']);
    await check(entry('APPROVE', s.a, y._id), ['TARGET_MISMATCH']);
    await check(entry('REMAP', s.b, s.x2._id), ['TARGET_MISMATCH']);
    await check(entry('REJECT', s.c, y._id), ['TARGET_MISMATCH']);
    await check(entry('MAP_UNMATCHED', s.a, s.x1._id), ['STATUS_MISMATCH']);
    await check(entry('APPROVE', s.e, s.x6._id), ['STATUS_MISMATCH', 'TARGET_MISMATCH']);
    await check(entry('MAP_UNMATCHED', s.e), ['TARGET_REQUIRED']);
    await check(entry('MAP_UNMATCHED', s.e, z._id), ['CANONICAL_OUT_OF_SCOPE']);
    await check(entry('APPROVE', s.a, s.x1._id, ''), ['REASON_REQUIRED']);

    const matched = (await c.itemMappings.findOne({ restaurantId: deliveroo._id, isActive: true, matchStatus: 'MATCHED' }))!;
    await check(entry('MAP_UNMATCHED', s.e, matched.canonicalItemId), ['PLATFORM_ALREADY_MAPPED']);
    await c.itemMappings.updateOne({ _id: s.d._id }, { $set: { decidedBy: 'import' } });
    await check(entry('KEEP_REVIEW', s.d), ['NOT_MATCHER_DECISION']);

    const twice = await runManualItemDecisions(c, input([entry('APPROVE', s.a, s.x1._id), entry('REMAP', s.b, s.x1._id), entry('APPROVE', s.a, s.x1._id)]));
    assert.deepEqual(twice.refused.map(l => l.refusals), [['DUPLICATE_ENTRY', 'DUPLICATE_TARGET'], ['DUPLICATE_TARGET'], ['DUPLICATE_ENTRY', 'DUPLICATE_TARGET']]);

    // Entries for other restaurants are ignored, not applied; unknown source items are refused.
    const scoped = await runManualItemDecisions(c, input([entry('APPROVE', s.a, s.x1._id), { ...entry('KEEP_REVIEW', imported), menuItemId: imported.menuItemId }]));
    assert.equal(scoped.otherRestaurants, 1);
    assert.equal(scoped.writable.length, 1);
    await check({ ...entry('APPROVE', s.a, s.x1._id), menuItemId: new ObjectId() }, ['SOURCE_ITEM_NOT_FOUND']);
  });

  test('refuses a restaurant that is not a matched member of the group', async () => {
    await assert.rejects(runManualItemDecisions(c, input([], { restaurantGroupId: new ObjectId() })), refusal('RESTAURANT_NOT_IN_GROUP'));
    await assert.rejects(runManualItemDecisions(c, input([], { restaurantId: new ObjectId() })), refusal('RESTAURANT_NOT_FOUND'));
  });
});
