/// <reference types="node" />
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId, WithId } from 'mongodb';
import { backfillCanonicalItems } from '../../src/dining/canonical-items/canonical-item.backfill';
import { ensureDiningCanonicalItemIndexes, getDiningCanonicalItemCollections } from '../../src/dining/canonical-items/canonical-item.collections';
import { persistMappedMenu } from '../../src/dining/dining.persistence';
import { buildMenuItemSourceKey } from '../../src/dining/dining.source-key';
import type { DiningMenuItem, DiningPlatform, DiningRestaurant, MenuModifierGroup } from '../../src/dining/dining.types';
import { backfillRestaurantIdentity } from '../../src/dining/identity/identity.backfill';
import { ensureDiningIdentityIndexes, getDiningIdentityCollections } from '../../src/dining/identity/identity.collections';
import { assignRestaurantToGroup, createDiningIdentityRepositories } from '../../src/dining/identity/identity.service';
import {
  DINING_ITEM_MAPPING_INDEXES,
  DiningItemMappingCollections,
  ensureDiningItemMappingIndexes,
  getDiningItemMappingCollections,
} from '../../src/dining/item-mappings/item-mapping.collections';
import { importSeedItemMappings } from '../../src/dining/item-mappings/item-mapping.import';
import { DiningItemMappingError } from '../../src/dining/item-mappings/item-mapping.repository';
import { createItemMappingService, ItemMappingService } from '../../src/dining/item-mappings/item-mapping.service';
import type { DiningItemMapping } from '../../src/dining/item-mappings/item-mapping.types';
import { validateItemMapping } from '../../src/dining/item-mappings/item-mapping.validator';
import { ITEM_MATCHER_CONFIG } from '../../src/dining/item-mappings/item-matcher.config';
import { ItemMatchCandidate, ItemMatchSource, matchItem, scoreCandidate, toMatchSource } from '../../src/dining/item-mappings/item-matcher';
import { closeTestClient, LOCAL_DB_SKIP, mappedMenu, openTestDb, TestDb } from './helpers';

// ─── Pure matcher ────────────────────────────────────────────────────────────

const G = new ObjectId();
const ctx = { restaurantGroupId: G };
const DOSA_DESC_A = 'Mysore style dosa with cheese and potato filling';
const DOSA_DESC_B = 'Cheese dosa, Mysore style, potato masala';
const CHOICE: MenuModifierGroup[] = [
  { name: { en: 'Your Choice Of' }, required: true, minSelections: 1, maxSelections: 1, options: [{ name: { en: 'Sambar' } }, { name: { en: 'Jain Sambar' } }] },
];

function cand(o: Partial<ItemMatchCandidate> = {}): ItemMatchCandidate {
  return {
    canonicalItemId: new ObjectId(),
    restaurantGroupId: G,
    canonicalName: { en: 'Mysore Masala Cheese Dosa' },
    canonicalDescription: { en: DOSA_DESC_A },
    category: { en: 'Dosa' },
    references: [{ platform: 'deliveroo', modifiers: CHOICE, imageUrl: 'https://img.example/a.jpg?w=200' }],
    matchedPlatforms: ['deliveroo'],
    ...o,
  };
}
const src = (o: Partial<ItemMatchSource> = {}): ItemMatchSource => ({ platform: 'talabat', name: { en: 'Mysore Masala Cheese Dosa' }, ...o });

describe('item matcher (pure)', () => {
  test('5. an exact normalized name is a strong candidate but never sufficient alone ("Chicken Burger")', () => {
    const d = matchItem(src({ name: { en: '  CHICKEN-burger ' } }), [cand({ canonicalName: { en: 'Chicken Burger' }, references: [] })], ctx);
    assert.equal(d.status, 'REVIEW');
    assert.equal(d.evidence.nameScore, 1);
    assert.equal(d.confidence, ITEM_MATCHER_CONFIG.weights.name);
    assert.ok(d.evidence.reasons.includes('NAME_EXACT_EN'));
    assert.ok(d.evidence.reasons.includes('INSUFFICIENT_CORROBORATION'));
    const ar = matchItem(src({ name: { ar: 'دوسا مسالا' } }), [cand({ canonicalName: { en: 'Masala Dosa', ar: 'دوسا مَسالا' }, references: [] })], ctx);
    assert.ok(ar.evidence.reasons.includes('NAME_EXACT_AR'));
    assert.equal(ar.status, 'REVIEW');
  });

  test('6. name + matching category raises confidence; a category mismatch lowers it but does not reject', () => {
    const nameOnly = matchItem(src(), [cand({ references: [], canonicalDescription: undefined })], ctx);
    const withCategory = matchItem(src({ category: { en: 'Dosa' } }), [cand({ references: [], canonicalDescription: undefined })], ctx);
    assert.ok(withCategory.confidence > nameOnly.confidence);
    assert.equal(withCategory.evidence.categoryScore, 1);
    assert.ok(withCategory.evidence.reasons.includes('CATEGORY_MATCH'));
    assert.equal(withCategory.status, 'REVIEW');

    const otherCategory = matchItem(src({ category: { en: 'South Indian' }, description: { en: DOSA_DESC_B }, modifiers: CHOICE }), [cand()], ctx);
    assert.ok(otherCategory.evidence.conflicts.includes('CATEGORY_DIFFERENT'));
    assert.equal(otherCategory.status, 'MATCHED');
  });

  test('7. name + description raises confidence; similar (not identical) descriptions count', () => {
    const base = matchItem(src(), [cand({ references: [], category: undefined })], ctx).confidence;
    const similar = matchItem(src({ description: { en: DOSA_DESC_B } }), [cand({ references: [], category: undefined })], ctx);
    assert.ok(similar.evidence.descriptionScore! >= 0.8, String(similar.evidence.descriptionScore));
    assert.ok(similar.confidence > base);
    const withCategory = matchItem(src({ description: { en: DOSA_DESC_B }, category: { en: 'Dosa' } }), [cand({ references: [] })], ctx);
    assert.equal(withCategory.status, 'MATCHED');
    assert.equal(withCategory.matchMethod, 'NAME_DESCRIPTION');
    const missing = matchItem(src({ category: { en: 'Dosa' } }), [cand({ references: [] })], ctx);
    assert.equal(missing.evidence.descriptionScore, undefined);
    assert.notEqual(missing.status, 'UNMATCHED');
  });

  test('8. quantity mismatch is a recorded conflict and blocks MATCHED; the right variant wins', () => {
    const strong = { canonicalDescription: { en: 'Fried bread' }, category: { en: 'Breads' }, references: [] };
    const four = cand({ canonicalName: { en: 'Poori 4 pcs' }, ...strong });
    const eight = cand({ canonicalName: { en: 'Poori 8 pcs' }, ...strong });
    const source = src({ name: { en: 'Poori (4 Pieces)' }, description: { en: 'Fried bread' }, category: { en: 'Breads' } });

    const onlyEight = matchItem(source, [eight], ctx);
    assert.equal(onlyEight.status, 'REVIEW');
    assert.ok(onlyEight.evidence.conflicts.includes('QUANTITY_MISMATCH'));
    assert.equal(onlyEight.evidence.variantScore, 0);

    const both = matchItem(source, [eight, four], ctx);
    assert.equal(both.status, 'MATCHED');
    assert.ok(both.canonicalItemId!.equals(four.canonicalItemId));
    assert.equal(both.matchMethod, 'VARIANT');
  });

  test('9. size mismatch is a conflict; unit mismatch is implausible; one-sided variant needs review', () => {
    const pizza = { canonicalDescription: { en: 'Tomato, mozzarella' }, category: { en: 'Pizza' }, references: [] };
    const d = matchItem(src({ name: { en: 'Margherita Pizza 12 inch' }, description: { en: 'Tomato, mozzarella' }, category: { en: 'Pizza' } }), [cand({ canonicalName: { en: 'Margherita Pizza 10 inch' }, ...pizza })], ctx);
    assert.equal(d.status, 'REVIEW');
    assert.deepEqual(d.evidence.conflicts, ['QUANTITY_MISMATCH']);
    assert.equal(d.evidence.variantScore, 0);
    const friesCand = cand({ canonicalName: { en: 'Fries Small' }, category: { en: 'Sides' }, canonicalDescription: { en: 'Salted fries' }, references: [] });
    const fries = matchItem(src({ name: { en: 'Fries Large' }, category: { en: 'Sides' }, description: { en: 'Salted fries' } }), [friesCand], ctx);
    assert.equal(fries.status, 'REVIEW');
    assert.deepEqual(fries.evidence.conflicts, ['SIZE_MISMATCH']);
    const weakFries = matchItem(src({ name: { en: 'Fries Large' } }), [friesCand], ctx);
    assert.equal(weakFries.status, 'UNMATCHED');
    assert.equal(weakFries.canonicalItemId, undefined);
    assert.ok(weakFries.evidence.conflicts.includes('SIZE_MISMATCH'));
    assert.ok(weakFries.evidence.candidateCanonicalItemIds![0].equals(friesCand.canonicalItemId));
    const unit = matchItem(src({ name: { en: 'Water 500ml' } }), [cand({ canonicalName: { en: 'Water 2 pcs' }, references: [] })], ctx);
    assert.equal(unit.status, 'UNMATCHED');
    assert.ok(unit.ranked[0].evidence.conflicts.includes('UNIT_MISMATCH'));
    const oneSided = matchItem(src({ name: { en: 'Wada Pav' }, category: { en: 'Snacks' }, description: { en: 'Potato fritter in a bun' } }), [cand({ canonicalName: { en: 'Wada Pav (2 Pcs)' }, category: { en: 'Snacks' }, canonicalDescription: { en: 'Potato fritter in a bun' }, references: [] })], ctx);
    assert.equal(oneSided.status, 'REVIEW');
    assert.ok(oneSided.evidence.conflicts.includes('VARIANT_ONLY_ONE_SIDE'));
  });

  test('10. modifier agreement raises confidence', () => {
    const without = matchItem(src({ category: { en: 'Dosa' } }), [cand({ references: [], canonicalDescription: undefined })], ctx);
    const withMods = matchItem(src({ category: { en: 'Dosa' }, modifiers: CHOICE }), [cand({ canonicalDescription: undefined })], ctx);
    assert.equal(withMods.evidence.modifierScore, 1);
    assert.ok(withMods.evidence.reasons.includes('MODIFIERS_AGREE'));
    assert.ok(withMods.confidence > without.confidence);
    assert.equal(withMods.status, 'MATCHED');
    assert.equal(withMods.matchMethod, 'EXACT_NORMALIZED');
    const partialDesc = matchItem(src({ category: { en: 'Dosa' }, description: { en: 'Dosa with cheese' }, modifiers: CHOICE }), [cand()], ctx);
    assert.equal(partialDesc.status, 'MATCHED');
    assert.equal(partialDesc.matchMethod, 'MODIFIER');
  });

  test('11. modifier conflicts are captured as evidence, not an automatic reject', () => {
    const other: MenuModifierGroup[] = [
      { name: { en: 'Your Choice Of' }, required: false, minSelections: 0, maxSelections: 2, options: [{ name: { en: 'Coconut Chutney' } }, { name: { en: 'Tomato Chutney' } }] },
    ];
    const d = matchItem(src({ description: { en: DOSA_DESC_A }, category: { en: 'Dosa' }, modifiers: other }), [cand()], ctx);
    for (const c of ['MODIFIER_OPTIONS_DIFFER', 'MODIFIER_REQUIRED_DIFFERS', 'MODIFIER_LIMITS_DIFFER']) assert.ok(d.evidence.conflicts.includes(c), c);
    assert.ok(d.evidence.modifierScore! < 0.5);
    assert.notEqual(d.status, 'UNMATCHED');
  });

  test('12. price never reaches the matcher', () => {
    const item = { platform: 'talabat', name: { en: 'Idli' }, description: { en: 'Steamed rice cakes' }, categoryName: { en: 'Idli' }, imageUrl: 'https://x/a.jpg' };
    const at27 = toMatchSource({ ...item, price: 27 } as unknown as DiningMenuItem);
    const at25 = toMatchSource({ ...item, price: 25, originalPrice: 30 } as unknown as DiningMenuItem);
    assert.deepEqual(at27, at25);
    assert.equal('price' in at27, false);
    const c = [cand({ canonicalName: { en: 'Idli' }, canonicalDescription: { en: 'Steamed rice cakes' }, category: { en: 'Idli' } })];
    assert.deepEqual(matchItem(at27, c, ctx), matchItem(at25, c, ctx));
  });

  test('13. image is weak evidence: a different image does not reject, the same image only nudges', () => {
    const strong = src({ description: { en: DOSA_DESC_A }, category: { en: 'Dosa' } });
    const differentImg = matchItem({ ...strong, imageUrl: 'https://img.example/zzz.jpg' }, [cand()], ctx);
    const sameImg = matchItem({ ...strong, imageUrl: 'https://img.example/a.jpg?w=800' }, [cand()], ctx);
    assert.equal(differentImg.status, 'MATCHED');
    assert.equal(differentImg.evidence.imageScore, 0);
    assert.ok(differentImg.evidence.reasons.includes('IMAGE_DIFFERENT'));
    assert.equal(differentImg.evidence.conflicts.length, 0);
    assert.equal(sameImg.evidence.imageScore, 1);
    assert.ok(Math.abs(sameImg.confidence - differentImg.confidence - ITEM_MATCHER_CONFIG.weights.image) < 1e-9);
    // Same image but a different dish: not even plausible.
    assert.equal(matchItem(src({ name: { en: 'Rava Idli' }, imageUrl: 'https://img.example/a.jpg' }), [cand()], ctx).status, 'UNMATCHED');
  });

  test('14. ambiguous candidates become REVIEW; a platform already mapped needs review', () => {
    const twin = { canonicalName: { en: 'Masala Dosa' }, canonicalDescription: { en: 'Potato masala' }, category: { en: 'Dosa' }, references: [] };
    const a = cand(twin);
    const b = cand(twin);
    const d = matchItem(src({ name: { en: 'Masala Dosa' }, description: { en: 'Potato masala' }, category: { en: 'Dosa' } }), [a, b], ctx);
    assert.equal(d.status, 'REVIEW');
    assert.ok(d.evidence.conflicts.includes('AMBIGUOUS_CANDIDATES'));
    assert.equal(d.evidence.candidateCanonicalItemIds?.length, 2);
    const taken = matchItem(src({ name: { en: 'Masala Dosa' }, description: { en: 'Potato masala' }, category: { en: 'Dosa' } }), [cand({ ...twin, matchedPlatforms: ['talabat'] })], ctx);
    assert.equal(taken.status, 'REVIEW');
    assert.ok(taken.evidence.conflicts.includes('PLATFORM_ALREADY_MAPPED'));
  });

  test('15. no plausible candidate becomes UNMATCHED', () => {
    assert.deepEqual(matchItem(src(), [], ctx).evidence.reasons, ['NO_CANDIDATES']);
    const unrelated = matchItem(src({ name: { en: 'Filter Coffee' } }), [cand()], ctx);
    assert.equal(unrelated.status, 'UNMATCHED');
    assert.equal(unrelated.canonicalItemId, undefined);
    assert.deepEqual(unrelated.evidence.reasons, ['NO_PLAUSIBLE_CANDIDATE']);
  });

  test('20 (pure). candidates from another restaurant group are never compared', () => {
    const d = matchItem(src({ description: { en: DOSA_DESC_A }, category: { en: 'Dosa' } }), [cand({ restaurantGroupId: new ObjectId() })], ctx);
    assert.equal(d.status, 'UNMATCHED');
    assert.ok(d.evidence.reasons.includes('OTHER_GROUP_CANDIDATES_IGNORED'));
    assert.equal(d.ranked.length, 0);
  });

  test('scoring is deterministic and bounded', () => {
    const s = src({ description: { en: DOSA_DESC_B }, category: { en: 'Dosa' }, modifiers: CHOICE });
    const c = cand();
    const a = scoreCandidate(s, c);
    assert.deepEqual(a, scoreCandidate(s, c));
    assert.ok(a.confidence >= 0 && a.confidence <= 1);
    const w = ITEM_MATCHER_CONFIG.weights;
    assert.ok(Math.abs(w.name + w.description + w.category + w.modifiers + w.image - 1) < 1e-9);
  });
});

// ─── Local MongoDB ───────────────────────────────────────────────────────────

describe('item mappings (local MongoDB)', { skip: LOCAL_DB_SKIP }, () => {
  let t: TestDb;
  let c: DiningItemMappingCollections;
  let svc: ItemMappingService;
  let kamat: WithId<DiningRestaurant>;
  let kamatGroup: ObjectId;
  const now = new Date('2026-10-09T08:00:00Z');

  before(async () => {
    t = await openTestDb('itemmap');
    await ensureDiningIdentityIndexes(t.db);
    await ensureDiningCanonicalItemIndexes(t.db);
    await ensureDiningItemMappingIndexes(t.db);
    c = getDiningItemMappingCollections(t.db);
    svc = createItemMappingService(c);
  });
  beforeEach(async () => {
    await t.reset();
    await Promise.all([c.itemMappings, c.canonicalItems, c.restaurantMappings, c.restaurantGroups].map(col => col.deleteMany({})));
    for (const locale of ['en', 'ar'] as const) await persistMappedMenu(t.repos, mappedMenu(locale), { locale, runId: `run_itemmap_${locale}`, now });
    kamat = (await t.collections.restaurants.findOne({ platformRestaurantId: '76728' }))!;
    await mapRestaurants();
    await backfillCanonicalItems(getDiningCanonicalItemCollections(t.db), { now });
    kamatGroup = (await c.restaurantMappings.findOne({ restaurantId: kamat._id }))!.canonicalRestaurantGroupId!;
  });
  after(async () => {
    await t?.close();
    await closeTestClient();
  });

  const identityRepos = () => createDiningIdentityRepositories(getDiningIdentityCollections(t.db));
  const mapRestaurants = () => backfillRestaurantIdentity(identityRepos(), { now });

  async function addRestaurant(platform: DiningPlatform, id: string, name: string, location: DiningRestaurant['location'], group?: ObjectId) {
    const doc: DiningRestaurant = {
      platform, platformRestaurantId: id, sourceKey: `${platform}:restaurant:id:${id}`, sourceKeyKind: 'id', name: { en: name },
      url: { en: `https://example.com/${id}` }, cuisines: [], tags: [], currency: 'AED', isActive: true, offers: [], location,
      firstSeenAt: now, lastScrapedAtByLocale: { en: now }, lastRunIdByLocale: { en: 'run_x' }, createdAt: new Date(now.getTime() + 1000), updatedAt: now,
    };
    const res = await t.collections.restaurants.insertOne(doc);
    const restaurant = { ...doc, _id: res.insertedId } as WithId<DiningRestaurant>;
    if (group) await assignRestaurantToGroup(identityRepos(), { restaurantId: restaurant._id, groupId: group }, now);
    return restaurant;
  }

  const kamatItem = async (name: string) => (await t.collections.menuItems.findOne({ restaurantId: kamat._id, 'name.en': name }))!;

  // Synthetic listing (not scraped): a valid source item cloned from a real one into another restaurant.
  async function cloneItem(
    templateName: string,
    into: WithId<DiningRestaurant>,
    platformItemId: string,
    overrides: Partial<DiningMenuItem> = {},
    omit: Array<keyof DiningMenuItem> = []
  ) {
    const { _id, categoryId, ...rest } = await kamatItem(templateName);
    for (const key of omit) delete (rest as Partial<DiningMenuItem>)[key];
    const doc: DiningMenuItem = {
      ...rest,
      platform: into.platform,
      restaurantId: into._id,
      restaurantSourceKey: into.sourceKey,
      platformRestaurantId: into.platformRestaurantId,
      platformItemId,
      sourceKey: buildMenuItemSourceKey(into.sourceKey, { kind: 'id', value: platformItemId }),
      ...(into._id.equals(kamat._id) ? { categoryId } : {}),
      ...overrides,
    };
    const res = await t.collections.menuItems.insertOne(doc);
    return { ...doc, _id: res.insertedId } as WithId<DiningMenuItem>;
  }

  const talabatKamat = () => addRestaurant('talabat', 't-kamat', 'Kamat Vegetarian Business Bay', { city: 'Dubai', area: 'Business Bay' }, kamatGroup);
  const canonicalOf = async (menuItemId: ObjectId) => (await c.canonicalItems.findOne({ seedMenuItemId: menuItemId }))!;
  const activeCount = (menuItemId: ObjectId) => c.itemMappings.countDocuments({ menuItemId, isActive: true });

  test('indexes: one active mapping per source item is a unique constraint', async () => {
    const indexes = await c.itemMappings.indexes();
    for (const spec of DINING_ITEM_MAPPING_INDEXES) assert.ok(indexes.some(i => i.name === spec.name), spec.name);
    assert.deepEqual(indexes.filter(i => i.unique).map(i => [i.name, i.partialFilterExpression]), [['uniq_active_menuItemId', { isActive: true }]]);
  });

  test('3. the Deliveroo seed import creates 332 MATCHED/IMPORT mappings in the Kamat group', async () => {
    const canonicalBefore = await c.canonicalItems.find().sort({ _id: 1 }).toArray();
    const dry = await importSeedItemMappings(c, { dryRun: true, now });
    assert.equal(dry.mappingsCreated, 332);
    assert.equal(await c.itemMappings.countDocuments(), 0);

    const report = await importSeedItemMappings(c, { now, platform: 'deliveroo' });
    assert.deepEqual(
      { ...report, issues: undefined },
      { dryRun: false, canonicalItemsInspected: 332, mappingsCreated: 332, mappingsReused: 0, skipped: 0, invalid: 0, failures: 0, skippedByReason: {}, issues: undefined, issuesTruncated: false }
    );
    const all = await c.itemMappings.find().toArray();
    assert.equal(all.length, 332);
    for (const m of all) {
      assert.deepEqual([m.matchStatus, m.matchMethod, m.decidedBy, m.confidence, m.isActive, m.platform], ['MATCHED', 'IMPORT', 'import', 1, true, 'deliveroo']);
      assert.ok(m.restaurantGroupId.equals(kamatGroup));
      assert.equal(validateItemMapping(m).valid, true);
    }
    const seedPairs = new Set(canonicalBefore.map(ci => `${ci._id}:${ci.seedMenuItemId}`));
    assert.ok(all.every(m => seedPairs.has(`${m.canonicalItemId}:${m.menuItemId}`)));
    assert.deepEqual(await c.canonicalItems.find().sort({ _id: 1 }).toArray(), canonicalBefore);
  });

  test('4. repeating the import is idempotent', async () => {
    await importSeedItemMappings(c, { now });
    const before = await c.itemMappings.find().sort({ _id: 1 }).toArray();
    const again = await importSeedItemMappings(c, { now: new Date(now.getTime() + 60_000) });
    assert.deepEqual([again.mappingsCreated, again.mappingsReused, again.skipped, again.failures], [0, 332, 0, 0]);
    assert.deepEqual(await c.itemMappings.find().sort({ _id: 1 }).toArray(), before);

    await c.itemMappings.deleteMany({});
    const [a, b] = await Promise.all([importSeedItemMappings(c, { now }), importSeedItemMappings(c, { now })]);
    assert.equal(a.mappingsCreated + b.mappingsCreated, 332);
    assert.equal(a.failures + b.failures, 0);
    assert.equal(await c.itemMappings.countDocuments({ isActive: true }), 332);
  });

  test('1. one source item cannot map to two canonical items at the same time', async () => {
    await importSeedItemMappings(c, { now });
    const idli = await kamatItem('Idli');
    const current = (await svc.repository.findActiveByMenuItem(idli._id))!;
    const other = await canonicalOf((await kamatItem('Fried Idli'))._id);
    const { _id, ...copy } = current;
    await assert.rejects(c.itemMappings.insertOne({ ...copy, canonicalItemId: other._id }), (e: { code?: number }) => e.code === 11000);
    await assert.rejects(svc.repository.insert({ ...copy, canonicalItemId: other._id }), (e: unknown) => e instanceof DiningItemMappingError && e.code === 'SOURCE_ALREADY_MAPPED');
    assert.equal(await activeCount(idli._id), 1);
  });

  test('2 + 12 + 13. a Talabat listing joins the same canonical item (different price and image)', async () => {
    await importSeedItemMappings(c, { now });
    const tk = await talabatKamat();
    const deliverooIdli = await kamatItem('Idli');
    const talabatIdli = await cloneItem('Idli', tk, 'tb-idli', { price: deliverooIdli.price - 2, imageUrl: 'https://talabat.example/idli.jpg' });
    const res = await svc.matchSourceItem(talabatIdli._id, { now });
    const idliCanonical = await canonicalOf(deliverooIdli._id);
    assert.equal(res.outcome, 'created');
    assert.equal(res.mapping.matchStatus, 'MATCHED');
    assert.ok(res.mapping.canonicalItemId!.equals(idliCanonical._id));
    assert.equal(res.mapping.decidedBy, 'matcher');
    assert.equal(res.mapping.evidence.modifierScore, 1);
    assert.equal(res.mapping.evidence.imageScore, 0);
    assert.ok(res.mapping.confidence >= ITEM_MATCHER_CONFIG.thresholds.matchMin);
    const members = await svc.repository.findActiveMatchedByCanonical([idliCanonical._id]);
    assert.deepEqual(members.map(m => m.platform).sort(), ['deliveroo', 'talabat']);
    assert.ok(members.every(m => m.restaurantGroupId.equals(kamatGroup)));
    assert.equal((await svc.matchSourceItem(talabatIdli._id, { now })).outcome, 'unchanged');
  });

  test('14 (db). two identical canonical items make the match ambiguous → REVIEW', async () => {
    await cloneItem('Idli', kamat, 'dup-idli');
    await backfillCanonicalItems(getDiningCanonicalItemCollections(t.db), { now });
    await importSeedItemMappings(c, { now });
    const tk = await talabatKamat();
    const res = await svc.matchSourceItem((await cloneItem('Idli', tk, 'tb-idli'))._id, { now });
    assert.equal(res.mapping.matchStatus, 'REVIEW');
    assert.ok(res.mapping.evidence.conflicts.includes('AMBIGUOUS_CANDIDATES'));
    assert.ok(res.mapping.evidence.candidateCanonicalItemIds!.length >= 2);
  });

  test('15 (db). no candidate → UNMATCHED; re-running is unchanged', async () => {
    const tk = await talabatKamat();
    const dish = await cloneItem('Idli', tk, 'tb-new', { name: { en: 'Truffle Ramen Bowl' }, description: { en: 'Noodles in broth' } });
    const res = await svc.matchSourceItem(dish._id, { now });
    assert.equal(res.mapping.matchStatus, 'UNMATCHED');
    assert.equal(res.mapping.canonicalItemId, undefined);
    assert.equal((await svc.matchSourceItem(dish._id, { now })).outcome, 'unchanged');
    assert.equal(await c.itemMappings.countDocuments({ menuItemId: dish._id }), 1);
  });

  // A Talabat "Idli" with no description, modifiers or matching category → name-only → REVIEW.
  async function reviewCase() {
    await importSeedItemMappings(c, { now });
    const tk = await talabatKamat();
    const item = await cloneItem('Idli', tk, 'tb-idli-bare', { categoryName: { en: 'Breakfast' } }, ['description', 'modifiers']);
    const res = await svc.matchSourceItem(item._id, { now });
    assert.equal(res.mapping.matchStatus, 'REVIEW');
    return { item, review: res.mapping as WithId<DiningItemMapping>, idli: await canonicalOf((await kamatItem('Idli'))._id) };
  }

  test('16. manual approval turns REVIEW into MATCHED/MANUAL and keeps the review as history', async () => {
    const { item, review, idli } = await reviewCase();
    assert.ok(review.canonicalItemId!.equals(idli._id));
    const res = await svc.approveMapping(item._id, { note: 'checked menu photos', now: new Date(now.getTime() + 1000) });
    assert.deepEqual([res.mapping.matchStatus, res.mapping.matchMethod, res.mapping.decidedBy, res.mapping.confidence], ['MATCHED', 'MANUAL', 'manual', 1]);
    assert.ok(res.mapping.canonicalItemId!.equals(idli._id));
    assert.ok(res.mapping.supersedesMappingId!.equals(review._id));
    const history = await svc.repository.history(item._id);
    assert.deepEqual(history.map(h => [h.matchStatus, h.isActive]), [['REVIEW', false], ['MATCHED', true]]);
    assert.ok(history[0].supersededAt instanceof Date);
    assert.equal((await svc.matchSourceItem(item._id, { now })).outcome, 'kept_existing');
    assert.equal((await svc.approveMapping(item._id, { now })).outcome, 'unchanged');
  });

  test('17. manual rejection is preserved and never proposed again', async () => {
    const { item, idli } = await reviewCase();
    const res = await svc.rejectMapping(item._id, { note: 'different dish', now: new Date(now.getTime() + 1000) });
    assert.equal(res.mapping.matchStatus, 'REJECTED');
    assert.equal(res.mapping.isActive, false);
    assert.ok(res.mapping.canonicalItemId!.equals(idli._id));
    assert.equal(await activeCount(item._id), 0);
    await assert.rejects(svc.rejectMapping(item._id), (e: unknown) => e instanceof DiningItemMappingError && e.code === 'MAPPING_NOT_FOUND');

    const again = await svc.matchSourceItem(item._id, { now: new Date(now.getTime() + 2000) });
    assert.ok(!again.mapping.canonicalItemId?.equals(idli._id));
    const history = await svc.repository.history(item._id);
    assert.deepEqual(history.map(h => h.matchStatus), ['REVIEW', 'REJECTED', again.mapping.matchStatus]);
    assert.equal(history.filter(h => h.isActive).length, 1);
  });

  test('18. remapping keeps exactly one active mapping and records history', async () => {
    await importSeedItemMappings(c, { now });
    const tk = await talabatKamat();
    const item = await cloneItem('Idli', tk, 'tb-idli');
    const matched = await svc.matchSourceItem(item._id, { now });
    assert.equal(matched.mapping.matchStatus, 'MATCHED');
    const fried = await canonicalOf((await kamatItem('Fried Idli'))._id);

    const res = await svc.remapSourceItem(item._id, fried._id, { note: 'listing is the fried version', now: new Date(now.getTime() + 1000) });
    assert.ok(res.mapping.canonicalItemId!.equals(fried._id));
    assert.equal(res.mapping.matchMethod, 'MANUAL');
    assert.equal(await activeCount(item._id), 1);
    const history = await svc.repository.history(item._id);
    assert.deepEqual(history.map(h => [h.matchStatus, h.isActive]), [['MATCHED', false], ['REJECTED', false], ['MATCHED', true]]);
    assert.ok(history[1].canonicalItemId!.equals(matched.mapping.canonicalItemId!));
    assert.equal((await svc.remapSourceItem(item._id, fried._id, { now })).outcome, 'unchanged');

    // The seed import never overrides a manual decision on a Deliveroo item either.
    const deliverooIdli = await kamatItem('Idli');
    await svc.remapSourceItem(deliverooIdli._id, fried._id, { now });
    const reimport = await importSeedItemMappings(c, { now });
    assert.equal(reimport.skippedByReason.EXISTING_DECISION, 1);
    assert.equal(await activeCount(deliverooIdli._id), 1);
  });

  test('19. restaurant group mismatch is rejected', async () => {
    await importSeedItemMappings(c, { now });
    const other = await addRestaurant('deliveroo', '88888', 'Other Place', { city: 'dubai', area: 'Jumeirah Lake Towers', address: 'Cluster D' });
    await mapRestaurants();
    const otherThali = await cloneItem('Thali', other, 'o-thali');
    await backfillCanonicalItems(getDiningCanonicalItemCollections(t.db), { now });
    const foreignCanonical = await canonicalOf(otherThali._id);
    assert.ok(!foreignCanonical.restaurantGroupId.equals(kamatGroup));

    const kamatThali = await kamatItem('Thali');
    for (const op of [() => svc.remapSourceItem(kamatThali._id, foreignCanonical._id, { now }), () => svc.approveMapping(kamatThali._id, { canonicalItemId: foreignCanonical._id, now })]) {
      await assert.rejects(op(), (e: unknown) => e instanceof DiningItemMappingError && e.code === 'RESTAURANT_GROUP_MISMATCH');
    }
    assert.ok((await svc.repository.findActiveByMenuItem(kamatThali._id))!.canonicalItemId!.equals((await canonicalOf(kamatThali._id))._id));

    const orphanRestaurant = await addRestaurant('talabat', 't-orphan', 'Nowhere', {});
    const orphan = await cloneItem('Thali', orphanRestaurant, 'tb-orphan');
    await assert.rejects(svc.matchSourceItem(orphan._id, { now }), (e: unknown) => e instanceof DiningItemMappingError && e.code === 'RESTAURANT_NOT_MAPPED');
  });

  test('20. matching stays inside the source restaurant group', async () => {
    const other = await addRestaurant('deliveroo', '88888', 'Other Place', { city: 'dubai', area: 'Jumeirah Lake Towers', address: 'Cluster D' });
    await mapRestaurants();
    await cloneItem('Thali', other, 'o-thali');
    await backfillCanonicalItems(getDiningCanonicalItemCollections(t.db), { now });
    await importSeedItemMappings(c, { now });
    const groupB = (await c.restaurantMappings.findOne({ restaurantId: other._id }))!.canonicalRestaurantGroupId!;
    const talabatB = await addRestaurant('talabat', 't-other', 'Other Place JLT', { city: 'Dubai', area: 'JLT' }, groupB);

    const item = await cloneItem('Thali', talabatB, 'tb-thali');
    const candidates = await svc.findCandidates(item, groupB);
    assert.ok(candidates.length > 0);
    assert.ok(candidates.every(cd => cd.restaurantGroupId.equals(groupB)));
    const res = await svc.matchSourceItem(item._id, { now });
    assert.equal(res.mapping.matchStatus, 'MATCHED');
    assert.ok(res.mapping.restaurantGroupId.equals(groupB));
    const target = (await c.canonicalItems.findOne({ _id: res.mapping.canonicalItemId }))!;
    assert.ok(target.restaurantGroupId.equals(groupB));
    const kamatThaliCanonical = await canonicalOf((await kamatItem('Thali'))._id);
    assert.ok(!(res.mapping.evidence.candidateCanonicalItemIds ?? []).some(id => id.equals(kamatThaliCanonical._id)));
    assert.equal(await c.itemMappings.countDocuments({ restaurantGroupId: kamatGroup, menuItemId: item._id }), 0);
  });
});
