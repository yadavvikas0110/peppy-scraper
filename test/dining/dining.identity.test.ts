/// <reference types="node" />
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId, WithId } from 'mongodb';
import { persistMappedMenu } from '../../src/dining/dining.persistence';
import type { DiningPlatform, DiningRestaurant } from '../../src/dining/dining.types';
import { backfillRestaurantIdentity } from '../../src/dining/identity/identity.backfill';
import { assignToAnchorGroup, DiningManualAssignmentError } from '../../src/dining/identity/identity.assign';
import {
  DINING_IDENTITY_COLLECTIONS,
  DINING_IDENTITY_INDEXES,
  DiningIdentityCollections,
  ensureDiningIdentityIndexes,
  getDiningIdentityCollections,
} from '../../src/dining/identity/identity.collections';
import { decideMatch, evaluateCandidate, MatchCandidate } from '../../src/dining/identity/identity.matcher';
import {
  assignRestaurantToGroup,
  buildGroupFromRestaurant,
  createDiningIdentityRepositories,
  DiningIdentityRepositories,
  rejectRestaurantMapping,
} from '../../src/dining/identity/identity.service';
import { extractSourceSignals, normalizeIdentityText, SourceRestaurantSignals } from '../../src/dining/identity/identity.signals';
import type { DiningRestaurantMapping } from '../../src/dining/identity/identity.types';
import { validateRestaurantGroup, validateRestaurantMapping } from '../../src/dining/identity/identity.validator';
import { DiningIdentityConflictError } from '../../src/dining/identity/restaurant-mapping.repository';
import { readFileSync } from 'fs';
import { join } from 'path';
import { parseDeliverooMenu } from '../../src/dining/platforms/deliveroo/deliveroo.parser';
import { mapDeliverooMenu } from '../../src/dining/platforms/deliveroo/deliveroo.mapper';
import type { DiningMappedMenu } from '../../src/dining/platforms/platform.mapper';
import { parseTalabatMenu } from '../../src/dining/platforms/talabat/talabat.parser';
import { mapTalabatMenu } from '../../src/dining/platforms/talabat/talabat.mapper';
import { closeTestClient, GOLDEN_MILE_URL, goldenMileFixtureHtml, LOCAL_DB_SKIP, mappedMenu, openTestDb, TestDb } from './helpers';

const KAMAT_NAME = 'Kamat Vegetarian - Business Bay';
const KAMAT_ADDRESS = 'Ground Level, Bay Avenue, Executive Tower G, Dubai';
const KAMAT_PIN = { lat: 25.189217736842103, lng: 55.26528257142861 };

// ─── Pure: normalization, matching, validation ───────────────────────────────

function source(overrides: Partial<SourceRestaurantSignals> = {}): SourceRestaurantSignals {
  return { platform: 'talabat', names: ['kamat'], brands: [], city: 'dubai', ...overrides };
}

function candidate(overrides: Partial<MatchCandidate['signals']> = {}, matchedPlatforms: DiningPlatform[] = ['deliveroo']): MatchCandidate {
  return { groupId: new ObjectId(), signals: { names: ['kamat'], brands: [], city: 'dubai', ...overrides }, matchedPlatforms };
}

describe('identity signals and matcher (pure)', () => {
  test('normalization folds case, punctuation, diacritics and Arabic letter variants', () => {
    assert.equal(normalizeIdentityText('  Kamat Vegetarian - Business Bay '), 'kamat vegetarian business bay');
    assert.equal(normalizeIdentityText('Café & Grill'), 'cafe and grill');
    assert.equal(normalizeIdentityText('مَطْعَم الأمِيرة'), normalizeIdentityText('مطعم الاميره'));
    assert.equal(normalizeIdentityText(' - '), undefined);
  });

  test('identical name alone never auto-matches', () => {
    const d = decideMatch(source(), [candidate()]);
    assert.equal(d.kind, 'review');
    if (d.kind === 'review') assert.equal(d.method, 'EXACT_NAME');
  });

  test('same name, different branch (area or far coordinates) → different group', () => {
    const jlt = decideMatch(source({ area: 'jumeirah lake towers', address: 'cluster d jlt' }), [candidate({ area: 'business bay', address: 'bay avenue' })]);
    assert.equal(jlt.kind, 'new');
    const far = evaluateCandidate(source({ lat: 25.187, lng: 55.262 }), candidate({ lat: 25.07, lng: 55.14 }));
    assert.equal(far.verdict, 'none');
    assert.ok(far.evidence.conflicts.includes('LOCATION_FAR'));
  });

  test('name + exact address or near coordinates → MATCHED', () => {
    const byAddress = decideMatch(source({ area: 'business bay', address: 'bay avenue tower g' }), [candidate({ area: 'dubai business bay', address: 'bay avenue tower g' })]);
    assert.equal(byAddress.kind, 'match');
    if (byAddress.kind === 'match') {
      assert.equal(byAddress.method, 'NAME_ADDRESS');
      assert.deepEqual(byAddress.evidence.signals, ['NAME_EXACT', 'CITY_EQUAL', 'AREA_COMPATIBLE', 'ADDRESS_EXACT']);
    }
    const byLocation = decideMatch(source({ lat: 25.18721, lng: 55.26201 }), [candidate({ lat: 25.18741, lng: 55.26211 })]);
    assert.equal(byLocation.kind, 'match');
    if (byLocation.kind === 'match') assert.equal(byLocation.method, 'NAME_LOCATION');
  });

  test('a second listing on an already-matched platform, or several strong candidates → REVIEW', () => {
    const samePlatform = decideMatch(source({ platform: 'deliveroo', address: 'x' }), [candidate({ address: 'x' })]);
    assert.equal(samePlatform.kind, 'review');
    assert.ok(samePlatform.evidence.conflicts.includes('SAME_PLATFORM_ALREADY_MAPPED'));
    const multiple = decideMatch(source({ address: 'x' }), [candidate({ address: 'x' }), candidate({ address: 'x' })]);
    assert.equal(multiple.kind, 'review');
    assert.equal(multiple.evidence.candidateGroupIds?.length, 2);
  });

  test('validators keep platform data off groups and enforce mapping state rules', () => {
    const now = new Date();
    const group = { canonicalName: { en: 'Kamat' }, status: 'active', identityStatus: 'auto', signals: { names: ['kamat'], brands: [] }, createdAt: now, updatedAt: now };
    assert.equal(validateRestaurantGroup(group).valid, true);
    assert.deepEqual(validateRestaurantGroup({ ...group, rating: 4.8 }).issues.map(i => i.path), ['rating']);

    const mapping = {
      restaurantId: new ObjectId(), platform: 'deliveroo', restaurantSourceKey: 'deliveroo:restaurant:id:1', matchStatus: 'UNMATCHED',
      confidence: 0, evidence: { signals: [], conflicts: [] }, isActive: true, decidedBy: 'backfill', createdAt: now, updatedAt: now,
    };
    assert.equal(validateRestaurantMapping(mapping).valid, true);
    assert.equal(validateRestaurantMapping({ ...mapping, canonicalRestaurantGroupId: new ObjectId() }).valid, false);
    assert.equal(validateRestaurantMapping({ ...mapping, matchStatus: 'MATCHED', matchMethod: 'SEED' }).valid, false);
    assert.equal(validateRestaurantMapping({ ...mapping, matchStatus: 'REJECTED', matchMethod: 'MANUAL', canonicalRestaurantGroupId: new ObjectId() }).valid, false);
  });

  test('Kamat fixtures with map-pin coordinates: Business Bay never matches a Palm listing; Palm pair is never auto-merged', () => {
    const signalsOf = (menu: DiningMappedMenu) => extractSourceSignals({ ...menu.restaurant, location: menu.restaurant.location ?? {} } as DiningRestaurant);
    const businessBay = signalsOf(mappedMenu('en'));
    const goldenMile = signalsOf(mapDeliverooMenu(parseDeliverooMenu(goldenMileFixtureHtml(), { locale: 'en', sourceUrl: GOLDEN_MILE_URL })));
    const palm = signalsOf(mapTalabatMenu(parseTalabatMenu(readFileSync(join(__dirname, 'fixtures', 'talabat-en.html'), 'utf8'), {
      locale: 'en', sourceUrl: 'https://www.talabat.com/uae/restaurant/773429/kamat-vegetarian-the-palm-jumeirah?aid=1333',
    })));
    assert.ok(businessBay.lat !== undefined && goldenMile.lat !== undefined && palm.lat !== undefined);
    const group = (s: SourceRestaurantSignals): MatchCandidate => {
      const { platform, platformRestaurantId: _id, slug: _slug, ...signals } = s;
      return { groupId: new ObjectId(), signals, matchedPlatforms: [platform] };
    };

    // As extracted: branch-specific names and no Deliveroo brand → no candidate at all.
    assert.equal(decideMatch(goldenMile, [group(businessBay), group(palm)]).kind, 'new');
    assert.equal(decideMatch(palm, [group(businessBay)]).kind, 'new');

    // Even with a shared brand, Business Bay is a hard non-match (area and distance) and the Palm pair only reaches REVIEW.
    const brands = ['kamat vegetarian'];
    for (const [a, b] of [[businessBay, palm], [palm, businessBay], [goldenMile, businessBay], [businessBay, goldenMile]]) {
      const v = evaluateCandidate({ ...a, brands }, group({ ...b, brands }));
      assert.equal(v.verdict, 'none');
      assert.ok(v.evidence.conflicts.includes('AREA_MISMATCH'));
      assert.ok(v.evidence.conflicts.includes('LOCATION_FAR'));
    }
    const palmPair = decideMatch({ ...goldenMile, brands }, [group({ ...businessBay, brands }), group({ ...palm, brands })]);
    assert.equal(palmPair.kind, 'review');
    assert.equal(palmPair.evidence.distanceMeters, 39);
    assert.ok(palmPair.evidence.signals.includes('LOCATION_NEAR'));
  });
});

// ─── Local MongoDB ───────────────────────────────────────────────────────────

describe('restaurant identity layer (local MongoDB)', { skip: LOCAL_DB_SKIP }, () => {
  let t: TestDb;
  let c: DiningIdentityCollections;
  let repos: DiningIdentityRepositories;
  const now = new Date('2026-10-08T12:00:00Z');

  before(async () => {
    t = await openTestDb('identity');
    await ensureDiningIdentityIndexes(t.db);
    c = getDiningIdentityCollections(t.db);
    repos = createDiningIdentityRepositories(c);
  });
  beforeEach(async () => {
    await t.reset();
    await Promise.all([c.restaurantGroups.deleteMany({}), c.restaurantMappings.deleteMany({})]);
  });
  after(async () => {
    await t?.close();
    await closeTestClient();
  });

  // Real Kamat data, written by the Phase 5 persistence path from the captured fixtures (no network).
  async function seedKamat(): Promise<WithId<DiningRestaurant>> {
    for (const locale of ['en', 'ar'] as const) {
      await persistMappedMenu(t.repos, mappedMenu(locale), { locale, runId: `run_identity_${locale}`, now });
    }
    return (await c.restaurants.findOne({ platform: 'deliveroo', platformRestaurantId: '76728' }))!;
  }

  // Synthetic platform listings inserted directly (Talabat/Careem are not scraped in this phase).
  async function addRestaurant(platform: DiningPlatform, id: string, name: string, location: DiningRestaurant['location'], extra: Partial<DiningRestaurant> = {}) {
    const doc: DiningRestaurant = {
      platform, platformRestaurantId: id, sourceKey: `${platform}:restaurant:id:${id}`, sourceKeyKind: 'id',
      name: { en: name }, url: { en: `https://example.com/${platform}/${id}` }, cuisines: [], tags: [], currency: 'AED',
      isActive: true, offers: [], location, firstSeenAt: now, lastScrapedAtByLocale: { en: now }, lastRunIdByLocale: { en: 'run_x' },
      createdAt: new Date(now.getTime() + Number(id.replace(/\D/g, '').slice(-6) || 1)), updatedAt: now, ...extra,
    };
    const res = await c.restaurants.insertOne(doc);
    return { ...doc, _id: res.insertedId } as WithId<DiningRestaurant>;
  }

  const counts = async () => ({
    groups: await c.restaurantGroups.countDocuments(),
    mappings: await c.restaurantMappings.countDocuments(),
    active: await c.restaurantMappings.countDocuments({ isActive: true }),
  });

  test('1. first Deliveroo restaurant: one canonical group + one MATCHED mapping', async () => {
    const kamat = await seedKamat();
    const report = await backfillRestaurantIdentity(repos, { now });
    assert.deepEqual(
      { ...report, entries: undefined },
      { dryRun: false, restaurantsInspected: 1, groupsCreated: 1, groupsReused: 0, mappingsCreated: 1, mappingsUpdated: 0, mappingsSkipped: 0, mappingsRequiringReview: 0, mappingsUnmatched: 0, failed: 0, entries: undefined }
    );
    const mapping = (await c.restaurantMappings.findOne({ restaurantId: kamat._id }))!;
    assert.equal(mapping.platform, 'deliveroo');
    assert.equal(mapping.platformRestaurantId, '76728');
    assert.equal(mapping.restaurantSourceKey, 'deliveroo:restaurant:id:76728');
    assert.equal(mapping.matchStatus, 'MATCHED');
    assert.equal(mapping.matchMethod, 'SEED');
    assert.equal(mapping.confidence, 1);
    assert.equal(mapping.isActive, true);
    assert.equal(mapping.evidence.reason, 'NEW_GROUP');
    const group = (await c.restaurantGroups.findOne({ _id: mapping.canonicalRestaurantGroupId }))!;
    assert.deepEqual(group.canonicalName, { en: KAMAT_NAME, ar: KAMAT_NAME });
    assert.equal(report.entries[0].outcome, 'GROUP_CREATED');
    assert.equal(report.entries[0].groupId, group._id.toHexString());
  });

  test('2. repeated backfill is a no-op (no duplicate groups or mappings)', async () => {
    await seedKamat();
    await backfillRestaurantIdentity(repos, { now });
    const before = await c.restaurantGroups.find().toArray();
    for (let i = 0; i < 3; i++) {
      const again = await backfillRestaurantIdentity(repos, { now: new Date(now.getTime() + 60_000 * (i + 1)) });
      assert.equal(again.groupsCreated, 0);
      assert.equal(again.groupsReused, 1);
      assert.equal(again.mappingsCreated, 0);
      assert.equal(again.mappingsSkipped, 1);
      assert.equal(again.entries[0].outcome, 'ALREADY_MAPPED');
    }
    assert.deepEqual(await counts(), { groups: 1, mappings: 1, active: 1 });
    assert.deepEqual(await c.restaurantGroups.find().toArray(), before);
  });

  test('3. duplicate source restaurant: same-platform duplicate listing goes to REVIEW; concurrent backfills create one group', async () => {
    await seedKamat();
    await backfillRestaurantIdentity(repos, { now });
    const dup = await addRestaurant('deliveroo', '99999', KAMAT_NAME, { city: 'dubai', area: 'Dubai Business Bay', address: KAMAT_ADDRESS });
    const report = await backfillRestaurantIdentity(repos, { now });
    assert.equal(report.groupsCreated, 0);
    assert.equal(report.mappingsRequiringReview, 1);
    const review = (await c.restaurantMappings.findOne({ restaurantId: dup._id }))!;
    assert.equal(review.matchStatus, 'REVIEW');
    assert.ok(review.evidence.conflicts.includes('SAME_PLATFORM_ALREADY_MAPPED'));
    const group = (await c.restaurantGroups.findOne({ _id: review.canonicalRestaurantGroupId }))!;
    assert.equal(group.identityStatus, 'review');
    assert.equal((await repos.mappings.findActiveByGroup(group._id)).filter(m => m.matchStatus === 'MATCHED').length, 1);

    // Same source restaurant processed by two backfills at once → still one group, one mapping.
    await t.reset();
    await Promise.all([c.restaurantGroups.deleteMany({}), c.restaurantMappings.deleteMany({})]);
    await seedKamat();
    const [a, b] = await Promise.all([backfillRestaurantIdentity(repos, { now }), backfillRestaurantIdentity(repos, { now })]);
    assert.equal(a.failed + b.failed, 0);
    assert.deepEqual(await counts(), { groups: 1, mappings: 1, active: 1 });
  });

  test('4. same name but different branch → separate groups (no merge on name)', async () => {
    await addRestaurant('talabat', 't-100', 'Kamat', { city: 'Dubai', area: 'Business Bay', address: 'Bay Avenue, Tower G' }, { brandName: { en: 'Kamat' } });
    await addRestaurant('talabat', 't-200', 'Kamat', { city: 'Dubai', area: 'Jumeirah Lake Towers', address: 'Cluster D, JLT' }, { brandName: { en: 'Kamat' } });
    const report = await backfillRestaurantIdentity(repos, { now });
    assert.equal(report.groupsCreated, 2);
    assert.equal(report.mappingsRequiringReview, 0);
    const groups = await c.restaurantGroups.find().sort({ area: 1 }).toArray();
    assert.deepEqual(groups.map(g => g.area), ['Business Bay', 'Jumeirah Lake Towers']);
    assert.notEqual(groups[0]._id.toHexString(), groups[1]._id.toHexString());
  });

  test('5. one source restaurant cannot map to two groups', async () => {
    const kamat = await seedKamat();
    await backfillRestaurantIdentity(repos, { now });
    const original = (await repos.mappings.findActiveByRestaurant(kamat._id))!;
    const other = await addRestaurant('talabat', 't-300', 'Kamat', { city: 'Dubai', area: 'Jumeirah Lake Towers', address: 'Cluster D, JLT' });
    const { group: otherGroup } = await repos.groups.createFromSeed(buildGroupFromRestaurant(other, extractSourceSignals(other), now));

    const second: DiningRestaurantMapping = { ...original, _id: undefined, canonicalRestaurantGroupId: otherGroup._id, matchMethod: 'MANUAL', decidedBy: 'manual' };
    delete second._id;
    await assert.rejects(repos.mappings.insert(second), (e: unknown) => e instanceof DiningIdentityConflictError && e.code === 'RESTAURANT_ALREADY_MAPPED' && !!e.existingGroupId?.equals(original.canonicalRestaurantGroupId!));
    await assert.rejects(assignRestaurantToGroup(repos, { restaurantId: kamat._id, groupId: otherGroup._id }, now), DiningIdentityConflictError);
    assert.equal(await c.restaurantMappings.countDocuments({ restaurantId: kamat._id, isActive: true }), 1);

    // An explicit move keeps exactly one active mapping and records the old one as REJECTED.
    const moved = await assignRestaurantToGroup(repos, { restaurantId: kamat._id, groupId: otherGroup._id, replaceExisting: true, note: 'test move' }, now);
    assert.equal(moved.status, 'created');
    assert.ok(moved.previousGroupId?.equals(original.canonicalRestaurantGroupId!));
    const all = await c.restaurantMappings.find({ restaurantId: kamat._id }).sort({ isActive: 1 }).toArray();
    assert.deepEqual(all.map(m => [m.matchStatus, m.isActive]), [['REJECTED', false], ['MATCHED', true]]);
  });

  test('6. two (and three) platforms map to one canonical group', async () => {
    const kamat = await seedKamat();
    const talabat = await addRestaurant('talabat', 't-400', KAMAT_NAME, { city: 'Dubai', area: 'Business Bay', address: 'Ground level - Bay Avenue Executive Tower G, Dubai' });
    const report = await backfillRestaurantIdentity(repos, { now });
    assert.equal(report.groupsCreated, 1);
    assert.equal(report.groupsReused, 1);
    const groupId = (await repos.mappings.findActiveByRestaurant(kamat._id))!.canonicalRestaurantGroupId!;
    const t400 = (await repos.mappings.findActiveByRestaurant(talabat._id))!;
    assert.ok(t400.canonicalRestaurantGroupId!.equals(groupId));
    assert.equal(t400.matchStatus, 'MATCHED');
    assert.equal(t400.matchMethod, 'NAME_ADDRESS');
    assert.equal(t400.confidence, 0.95);

    const careem = await addRestaurant('careem', 'c-1', 'Kamat Restaurant', { city: 'Dubai' });
    assert.equal((await assignRestaurantToGroup(repos, { restaurantId: careem._id, groupId }, now)).status, 'created');
    const members = await repos.mappings.findActiveByGroup(groupId);
    assert.deepEqual(members.map(m => m.platform), ['careem', 'deliveroo', 'talabat']);
    const group = (await repos.groups.findById(groupId))!;
    assert.equal(group.identityStatus, 'verified');
    assert.ok(group.signals.names.includes('kamat restaurant'));
  });

  test('7. mapping uniqueness enforced by MongoDB indexes', async () => {
    const indexNames = (await c.restaurantMappings.indexes()).map(i => i.name);
    for (const spec of DINING_IDENTITY_INDEXES.dining_restaurant_mappings) assert.ok(indexNames.includes(spec.name!), spec.name);
    assert.deepEqual(Object.values(DINING_IDENTITY_COLLECTIONS).sort(), ['dining_restaurant_groups', 'dining_restaurant_mappings']);

    const restaurantId = new ObjectId();
    const base = {
      restaurantId, platform: 'deliveroo' as const, restaurantSourceKey: 'deliveroo:restaurant:id:1', matchStatus: 'MATCHED' as const,
      matchMethod: 'MANUAL' as const, confidence: 1, evidence: { signals: [], conflicts: [] }, isActive: true, decidedBy: 'manual' as const, createdAt: now, updatedAt: now,
    };
    await c.restaurantMappings.insertOne({ ...base, canonicalRestaurantGroupId: new ObjectId() });
    await assert.rejects(c.restaurantMappings.insertOne({ ...base, canonicalRestaurantGroupId: new ObjectId() }), (e: { code?: number }) => e.code === 11000);
    await assert.rejects(c.restaurantMappings.insertOne({ ...base, matchStatus: 'UNMATCHED', matchMethod: undefined }), (e: { code?: number }) => e.code === 11000);
    // Rejected history rows are inactive and do not collide.
    const rejectedGroup = new ObjectId();
    await c.restaurantMappings.insertMany([
      { ...base, canonicalRestaurantGroupId: rejectedGroup, matchStatus: 'REJECTED', isActive: false },
      { ...base, canonicalRestaurantGroupId: rejectedGroup, matchStatus: 'REJECTED', isActive: false },
    ]);
    assert.equal(await c.restaurantMappings.countDocuments({ restaurantId, isActive: true }), 1);

    // Same platformRestaurantId on two platforms is two different listings.
    const d = await addRestaurant('deliveroo', '555', 'Alpha', { city: 'Dubai', area: 'Marina' });
    const tb = await addRestaurant('talabat', '555', 'Beta', { city: 'Dubai', area: 'Deira' });
    const report = await backfillRestaurantIdentity(repos, { now });
    assert.equal(report.groupsCreated, 2);
    const [md, mt] = await Promise.all([repos.mappings.findActiveByRestaurant(d._id), repos.mappings.findActiveByRestaurant(tb._id)]);
    assert.ok(!md!.canonicalRestaurantGroupId!.equals(mt!.canonicalRestaurantGroupId!));
  });

  test('8. canonical group creation: branch fields only, idempotent by seed restaurant', async () => {
    const kamat = await seedKamat();
    await backfillRestaurantIdentity(repos, { now });
    const group = (await c.restaurantGroups.findOne({}))!;
    assert.deepEqual(Object.keys(group).sort(), ['_id', 'address', 'area', 'canonicalName', 'city', 'createdAt', 'identityStatus', 'location', 'seedRestaurantId', 'signals', 'status', 'updatedAt']);
    assert.equal(group.city, 'dubai');
    assert.equal(group.area, 'Dubai Business Bay');
    assert.equal(group.address, KAMAT_ADDRESS);
    assert.deepEqual(group.location, KAMAT_PIN);
    assert.equal(group.status, 'active');
    assert.equal(group.identityStatus, 'auto');
    assert.ok(group.seedRestaurantId!.equals(kamat._id));
    assert.deepEqual(group.signals, {
      names: ['kamat vegetarian business bay'], brands: [], city: 'dubai', area: 'dubai business bay',
      address: 'ground level bay avenue executive tower g dubai', ...KAMAT_PIN,
    });

    const again = await repos.groups.createFromSeed(buildGroupFromRestaurant(kamat, extractSourceSignals(kamat), now));
    assert.equal(again.created, false);
    assert.ok(again.group._id.equals(group._id));
    assert.equal(await c.restaurantGroups.countDocuments(), 1);
  });

  test('9. dry run reports the same decisions and writes nothing', async () => {
    await seedKamat();
    await addRestaurant('talabat', 't-500', KAMAT_NAME, { city: 'Dubai', area: 'Business Bay', address: KAMAT_ADDRESS });
    await addRestaurant('careem', 'c-2', 'Kamat', { city: 'Dubai' });
    const restaurantsBefore = await c.restaurants.find().toArray();

    const dry = await backfillRestaurantIdentity(repos, { dryRun: true, now });
    const expected = { restaurantsInspected: 3, groupsCreated: 1, groupsReused: 1, mappingsCreated: 3, mappingsUpdated: 0, mappingsSkipped: 0, mappingsRequiringReview: 0, mappingsUnmatched: 1, failed: 0 };
    const pick = (r: typeof dry) => Object.fromEntries(Object.keys(expected).map(k => [k, r[k as keyof typeof expected]]));
    assert.equal(dry.dryRun, true);
    assert.deepEqual(pick(dry), expected);
    assert.deepEqual(await counts(), { groups: 0, mappings: 0, active: 0 });
    assert.deepEqual(await c.restaurants.find().toArray(), restaurantsBefore);

    const real = await backfillRestaurantIdentity(repos, { now });
    assert.deepEqual(pick(real), expected);
    assert.deepEqual(dry.entries.map(e => [e.outcome, e.matchMethod]), real.entries.map(e => [e.outcome, e.matchMethod]));
    assert.deepEqual(await counts(), { groups: 1, mappings: 3, active: 3 });

    const dryAgain = await backfillRestaurantIdentity(repos, { dryRun: true, now });
    assert.equal(dryAgain.groupsCreated, 0);
    assert.equal(dryAgain.mappingsSkipped, 3);
  });

  test('UNMATCHED (no branch locator) is re-evaluated once branch data appears', async () => {
    const r = await addRestaurant('talabat', 't-600', 'Somewhere Cafe', {});
    const first = await backfillRestaurantIdentity(repos, { now });
    assert.equal(first.mappingsUnmatched, 1);
    assert.equal(first.entries[0].reason, 'BRANCH_IDENTITY_UNKNOWN');
    assert.equal(await c.restaurantGroups.countDocuments(), 0);
    assert.equal((await backfillRestaurantIdentity(repos, { now })).mappingsSkipped, 1);

    await c.restaurants.updateOne({ _id: r._id }, { $set: { location: { city: 'Dubai', area: 'Al Barsha' } } });
    const third = await backfillRestaurantIdentity(repos, { now });
    assert.equal(third.mappingsUpdated, 1);
    assert.equal(third.groupsCreated, 1);
    assert.deepEqual(await counts(), { groups: 1, mappings: 1, active: 1 });
  });

  test('a rejected pairing is never proposed again', async () => {
    await seedKamat();
    const dup = await addRestaurant('deliveroo', '99998', KAMAT_NAME, { city: 'dubai', area: 'Dubai Business Bay', address: KAMAT_ADDRESS });
    await backfillRestaurantIdentity(repos, { now });
    const review = (await repos.mappings.findActiveByRestaurant(dup._id))!;
    assert.equal(review.matchStatus, 'REVIEW');
    await rejectRestaurantMapping(repos, { restaurantId: dup._id, note: 'separate listing' }, now);

    const after = await backfillRestaurantIdentity(repos, { now });
    const current = (await repos.mappings.findActiveByRestaurant(dup._id))!;
    assert.equal(current.matchStatus, 'MATCHED');
    assert.ok(!current.canonicalRestaurantGroupId!.equals(review.canonicalRestaurantGroupId!));
    assert.equal(after.groupsCreated, 1);
  });

  describe('manual same-branch assignment (assignToAnchorGroup)', () => {
    const PALM_NOTE = 'Same branch: Deliveroo info-panel phone +97145528606 = Kamat Palm Jumeirah (Golden Mile Galleria, Building 8)';

    // Mirrors the live state: Talabat-only backfill applied, Deliveroo listings not yet mapped.
    async function seedPalm() {
      const businessBay = await seedKamat();
      const palm = await addRestaurant('talabat', '773429', 'Kamat Vegetarian, The Palm Jumeirah',
        { city: 'Dubai', area: 'The Palm Jumeirah', lat: 25.111222348578067, lng: 55.141854912966906 }, { brandName: { en: 'Kamat Vegetarian' } });
      const goldenMile = await addRestaurant('deliveroo', '735078', 'Kamat Vegetarian - Golden Mile Galleria',
        { city: 'dubai', area: 'The Palm', address: 'The Palm, Dubai', lat: 25.11087931092437, lng: 55.14177102521007 });
      await backfillRestaurantIdentity(repos, { platform: 'talabat', now });
      const groupId = (await repos.mappings.findActiveByRestaurant(palm._id))!.canonicalRestaurantGroupId!;
      return { businessBay, palm, goldenMile, groupId };
    }

    const snapshot = async () => ({
      groups: await c.restaurantGroups.find().sort({ _id: 1 }).toArray(),
      mappings: await c.restaurantMappings.find().sort({ _id: 1 }).toArray(),
    });

    const refused = (code: string) => (e: unknown) => e instanceof DiningManualAssignmentError && e.code === code;

    test('dry run (default): Golden Mile → Talabat Palm group as MANUAL, confidence 1, auditable evidence; nothing written', async () => {
      const { palm, goldenMile, groupId } = await seedPalm();
      const before = await snapshot();
      const report = await assignToAnchorGroup(repos, { restaurantId: goldenMile._id, anchorRestaurantId: palm._id, note: PALM_NOTE, now });

      assert.equal(report.dryRun, true);
      assert.equal(report.groupId, groupId.toHexString());
      assert.deepEqual(report.membersBefore.map(m => `${m.platform}:${m.platformRestaurantId}`), ['talabat:773429']);
      assert.deepEqual(report.evidence, { signals: ['CITY_EQUAL', 'AREA_COMPATIBLE', 'LOCATION_NEAR'], conflicts: [], distanceMeters: 39 });
      assert.equal(report.result.status, 'created');
      const m = report.result.mapping;
      assert.equal(m._id, undefined);
      assert.ok(m.canonicalRestaurantGroupId!.equals(groupId));
      assert.ok(m.restaurantId.equals(goldenMile._id));
      assert.deepEqual([m.platform, m.platformRestaurantId, m.matchStatus, m.matchMethod, m.confidence, m.decidedBy, m.isActive], ['deliveroo', '735078', 'MATCHED', 'MANUAL', 1, 'manual', true]);
      assert.equal(m.evidence.reason, 'MANUAL_ASSIGNMENT');
      assert.equal(m.evidence.distanceMeters, 39);
      assert.equal(m.evidence.note, `${PALM_NOTE} | computed: deliveroo:735078 vs talabat:773429: 39 m apart; CITY_EQUAL, AREA_COMPATIBLE, LOCATION_NEAR`);
      assert.deepEqual(await snapshot(), before);
    });

    test('apply needs the reviewed group ID; then writes once and is idempotent; Business Bay stays out', async () => {
      const { businessBay, palm, goldenMile, groupId } = await seedPalm();
      const base = { restaurantId: goldenMile._id, anchorRestaurantId: palm._id, note: PALM_NOTE, dryRun: false, now };
      await assert.rejects(assignToAnchorGroup(repos, base), refused('GROUP_MISMATCH'));
      await assert.rejects(assignToAnchorGroup(repos, { ...base, expectedGroupId: new ObjectId() }), refused('GROUP_MISMATCH'));
      assert.deepEqual(await counts(), { groups: 1, mappings: 1, active: 1 });

      const applied = await assignToAnchorGroup(repos, { ...base, expectedGroupId: groupId });
      assert.equal(applied.result.status, 'created');
      assert.ok(applied.result.mapping._id);
      const again = await assignToAnchorGroup(repos, { ...base, expectedGroupId: groupId });
      assert.equal(again.result.status, 'unchanged');
      assert.deepEqual(await counts(), { groups: 1, mappings: 2, active: 2 });

      const members = await repos.mappings.findActiveByGroup(groupId);
      assert.deepEqual(members.map(x => `${x.platform}:${x.platformRestaurantId}:${x.matchMethod}`), ['deliveroo:735078:MANUAL', 'talabat:773429:SEED']);
      assert.equal((await repos.groups.findById(groupId))!.identityStatus, 'verified');
      assert.equal(await repos.mappings.findActiveByRestaurant(businessBay._id), null);

      // The full backfill afterwards leaves both Palm listings alone and gives Business Bay its own group.
      const full = await backfillRestaurantIdentity(repos, { now });
      const bb = (await repos.mappings.findActiveByRestaurant(businessBay._id))!;
      assert.equal(full.groupsCreated, 1);
      assert.ok(!bb.canonicalRestaurantGroupId!.equals(groupId));
      assert.deepEqual(await counts(), { groups: 2, mappings: 3, active: 3 });
    });

    test('Business Bay is refused as a different branch (area and distance), dry run or apply', async () => {
      const { businessBay, palm, goldenMile, groupId } = await seedPalm();
      await assignToAnchorGroup(repos, { restaurantId: goldenMile._id, anchorRestaurantId: palm._id, note: PALM_NOTE, dryRun: false, expectedGroupId: groupId, now });
      const before = await snapshot();
      for (const anchor of [palm, goldenMile]) {
        for (const dryRun of [true, false]) {
          await assert.rejects(
            assignToAnchorGroup(repos, { restaurantId: businessBay._id, anchorRestaurantId: anchor._id, note: 'test', dryRun, expectedGroupId: groupId, now }),
            (e: unknown) => refused('BRANCH_CONFLICT')(e) && /AREA_MISMATCH/.test((e as Error).message) && /LOCATION_FAR/.test((e as Error).message)
          );
        }
      }
      assert.deepEqual(await snapshot(), before);
    });

    test('an existing active mapping is never replaced implicitly, and never duplicated', async () => {
      const { palm, goldenMile, groupId } = await seedPalm();
      await backfillRestaurantIdentity(repos, { restaurantIds: [goldenMile._id], now });
      const own = (await repos.mappings.findActiveByRestaurant(goldenMile._id))!;
      assert.ok(!own.canonicalRestaurantGroupId!.equals(groupId));
      const before = await snapshot();

      const input = { restaurantId: goldenMile._id, anchorRestaurantId: palm._id, note: PALM_NOTE, now };
      await assert.rejects(assignToAnchorGroup(repos, input), (e: unknown) => e instanceof DiningIdentityConflictError && e.code === 'RESTAURANT_ALREADY_MAPPED');
      await assert.rejects(assignToAnchorGroup(repos, { ...input, dryRun: false, expectedGroupId: groupId }), DiningIdentityConflictError);
      const planned = await assignToAnchorGroup(repos, { ...input, replaceExisting: true });
      assert.equal(planned.result.status, 'created');
      assert.ok(planned.result.previousGroupId!.equals(own.canonicalRestaurantGroupId!));
      assert.deepEqual(await snapshot(), before);

      await assignToAnchorGroup(repos, { ...input, replaceExisting: true, dryRun: false, expectedGroupId: groupId });
      const rows = await c.restaurantMappings.find({ restaurantId: goldenMile._id }).sort({ isActive: 1 }).toArray();
      assert.deepEqual(rows.map(r => [r.matchStatus, r.isActive, r.evidence.reason]), [['REJECTED', false, 'REASSIGNED'], ['MATCHED', true, 'MANUAL_ASSIGNMENT']]);
    });

    test('refusals: weak evidence, second listing of a platform, unmapped anchor, missing or oversized note', async () => {
      const { palm, goldenMile, groupId } = await seedPalm();
      const sameArea = await addRestaurant('deliveroo', '900001', 'Kamat Palm (no coordinates)', { city: 'dubai', area: 'The Palm' });
      await assert.rejects(assignToAnchorGroup(repos, { restaurantId: sameArea._id, anchorRestaurantId: palm._id, note: 'x', now }), refused('WEAK_BRANCH_EVIDENCE'));

      await assignToAnchorGroup(repos, { restaurantId: goldenMile._id, anchorRestaurantId: palm._id, note: PALM_NOTE, dryRun: false, expectedGroupId: groupId, now });
      const twin = await addRestaurant('deliveroo', '900002', 'Kamat twin listing', { city: 'dubai', area: 'The Palm', lat: 25.11088, lng: 55.14177 });
      await assert.rejects(assignToAnchorGroup(repos, { restaurantId: twin._id, anchorRestaurantId: palm._id, note: 'x', now }), refused('SAME_PLATFORM_IN_GROUP'));

      await assert.rejects(assignToAnchorGroup(repos, { restaurantId: palm._id, anchorRestaurantId: twin._id, note: 'x', now }), refused('ANCHOR_NOT_MAPPED'));
      await assert.rejects(assignToAnchorGroup(repos, { restaurantId: palm._id, anchorRestaurantId: palm._id, note: 'x', now }), refused('SAME_RESTAURANT'));
      await assert.rejects(assignToAnchorGroup(repos, { restaurantId: goldenMile._id, anchorRestaurantId: palm._id, note: '  ', now }), refused('NOTE_REQUIRED'));
      await assert.rejects(assignToAnchorGroup(repos, { restaurantId: goldenMile._id, anchorRestaurantId: palm._id, note: 'x'.repeat(450), now }), refused('NOTE_TOO_LONG'));
    });
  });
});
