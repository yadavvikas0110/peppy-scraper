/// <reference types="node" />
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';
import { resolveAvailabilityStatus } from '../../src/dining/dining.availability';
import type { DiningMenuItem } from '../../src/dining/dining.types';
import { validateMenuItem } from '../../src/dining/dining.validator';
import type { DiningMenuItemDto } from '../../src/dining/platforms/platform.mapper';
import { applyUpdate, upsertStatus } from '../../src/dining/repositories/document-update';
import { buildItemUpdate } from '../../src/dining/repositories/menu-item.repository';
import type { DiningWriteContext, RestaurantRef } from '../../src/dining/repositories/repository.types';
import { makeMenuItem, paths } from './fixtures';
import { fixtureHtml, mappedMenu, THALI, withoutNextData } from './helpers';

// Availability contract: available / unavailable / unknown, without changing legacy (Deliveroo) documents.

const NOW = new Date('2026-10-09T12:00:00.000Z');
const ctx: DiningWriteContext = { locale: 'en', runId: 'run_availability', now: NOW };

describe('resolveAvailabilityStatus', () => {
  test('legacy documents keep their meaning; missing or contradictory data is unknown, never available', () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ isAvailable: true }, 'available'],
      [{ isAvailable: false }, 'unavailable'],
      [{}, 'unknown'],
      [{ isAvailable: null }, 'unknown'],
      [{ isAvailable: 'yes' }, 'unknown'],
      [{ availabilityStatus: 'unknown' }, 'unknown'],
      [{ availabilityStatus: 'unknown', isAvailable: true }, 'unknown'],
      [{ availabilityStatus: 'available', isAvailable: true }, 'available'],
      [{ availabilityStatus: 'unavailable', isAvailable: false }, 'unavailable'],
      [{ availabilityStatus: 'available', isAvailable: false }, 'unknown'],
      [{ availabilityStatus: 'unavailable', isAvailable: true }, 'unknown'],
      [{ availabilityStatus: 'available' }, 'unknown'],
      [{ availabilityStatus: 'sold-out', isAvailable: true }, 'unknown'],
    ];
    for (const [doc, expected] of cases) assert.equal(resolveAvailabilityStatus(doc), expected, JSON.stringify(doc));
  });
});

describe('buildItemUpdate availability', () => {
  const deliveroo = mappedMenu('en');
  const ref: RestaurantRef = { _id: new ObjectId(), platform: 'deliveroo', sourceKey: deliveroo.restaurant.sourceKey, platformRestaurantId: deliveroo.restaurant.platformRestaurantId, persisted: true };
  const thali = deliveroo.items.find(i => i.platformItemId === THALI)!;
  const store = (dto: DiningMenuItemDto, existing: DiningMenuItem | null = null) => applyUpdate<DiningMenuItem>(existing, buildItemUpdate(ref, dto, undefined, existing, ctx));

  test('Deliveroo (observed booleans): stored exactly as before, without availabilityStatus or hasModifiers', () => {
    assert.ok(deliveroo.items.every(i => typeof i.isAvailable === 'boolean' && i.availabilityStatus === undefined && i.hasModifiers === undefined));
    for (const dto of deliveroo.items) {
      const u = buildItemUpdate(ref, dto, undefined, null, ctx);
      assert.equal(u.set.isAvailable, dto.isAvailable);
      for (const part of [u.set, u.setOnInsert]) assert.ok(!('availabilityStatus' in part) && !('hasModifiers' in part));
      assert.ok(!u.unset.includes('availabilityStatus') && !u.unset.includes('isAvailable'));
    }
    const stored = store(thali);
    assert.equal(stored.isAvailable, true);
    assert.equal(resolveAvailabilityStatus(stored), 'available');
    assert.equal(upsertStatus(stored, store(thali, stored)), 'unchanged');
    const soldOut = store({ ...thali, isAvailable: false }, stored);
    assert.deepEqual([soldOut.isAvailable, 'availabilityStatus' in soldOut, resolveAvailabilityStatus(soldOut)], [false, false, 'unavailable']);
  });

  test('Deliveroo DOM fallback (no observation): new items still default to available; stored values are kept', () => {
    const dom = mappedMenu('en', withoutNextData(fixtureHtml('en')));
    const dto = dom.items[0];
    assert.equal(dto.isAvailable, undefined);
    const u = buildItemUpdate(ref, dto, undefined, null, ctx);
    assert.equal(u.setOnInsert.isAvailable, true);
    assert.ok(!('availabilityStatus' in u.set));
    const existing = { ...store(dto), isAvailable: false };
    assert.equal(store(dto, existing).isAvailable, false);
  });

  test('explicit unknown: no isAvailable is written, and a stale one is removed', () => {
    const unknown = { ...thali, isAvailable: undefined, availabilityStatus: 'unknown' as const };
    const u = buildItemUpdate(ref, unknown, undefined, null, ctx);
    assert.ok(!('isAvailable' in u.set) && !('isAvailable' in u.setOnInsert));
    const created = store(unknown);
    assert.deepEqual([created.availabilityStatus, 'isAvailable' in created], ['unknown', false]);
    assert.ok(validateMenuItem(created).valid);

    const wasAvailable = store(thali);
    const corrected = store(unknown, wasAvailable);
    assert.deepEqual([corrected.availabilityStatus, 'isAvailable' in corrected, resolveAvailabilityStatus(corrected)], ['unknown', false, 'unknown']);
    assert.equal(upsertStatus(corrected, store(unknown, corrected)), 'unchanged');
  });

  test('explicit available / unavailable store a matching isAvailable', () => {
    for (const status of ['available', 'unavailable'] as const) {
      const doc = store({ ...thali, isAvailable: undefined, availabilityStatus: status });
      assert.deepEqual([doc.availabilityStatus, doc.isAvailable, resolveAvailabilityStatus(doc)], [status, status === 'available', status]);
      assert.ok(validateMenuItem(doc).valid);
    }
  });

  test('an observed boolean after unknown drops the stale status', () => {
    const unknown = store({ ...thali, isAvailable: undefined, availabilityStatus: 'unknown' });
    const observed = store({ ...thali, isAvailable: false }, unknown);
    assert.deepEqual(['availabilityStatus' in observed, observed.isAvailable, resolveAvailabilityStatus(observed)], [false, false, 'unavailable']);
  });

  test('hasModifiers is stored as given, cleared on request, and never creates modifier groups', () => {
    const flagged = store({ ...thali, modifiers: undefined, hasModifiers: true });
    assert.equal(flagged.hasModifiers, true);
    assert.equal(flagged.modifiers, undefined);
    const cleared = store({ ...thali, modifiers: undefined, clear: [...thali.clear, 'hasModifiers'] }, flagged);
    assert.equal('hasModifiers' in cleared, false);
  });
});

describe('validateMenuItem availability', () => {
  test('legacy shape still requires a boolean isAvailable', () => {
    assert.ok(validateMenuItem(makeMenuItem({ isAvailable: true })).valid);
    assert.ok(validateMenuItem(makeMenuItem({ isAvailable: false })).valid);
    assert.ok(paths(validateMenuItem(makeMenuItem({ isAvailable: undefined }))).includes('isAvailable'));
  });

  test('explicit status must be valid and agree with isAvailable; unknown carries none', () => {
    assert.ok(validateMenuItem(makeMenuItem({ isAvailable: undefined, availabilityStatus: 'unknown' })).valid);
    assert.ok(validateMenuItem(makeMenuItem({ isAvailable: true, availabilityStatus: 'available' })).valid);
    assert.ok(validateMenuItem(makeMenuItem({ isAvailable: false, availabilityStatus: 'unavailable' })).valid);
    const bad: Array<[Partial<DiningMenuItem>, string]> = [
      [{ isAvailable: true, availabilityStatus: 'unknown' }, 'isAvailable'],
      [{ isAvailable: false, availabilityStatus: 'available' }, 'isAvailable'],
      [{ isAvailable: undefined, availabilityStatus: 'unavailable' }, 'isAvailable'],
      [{ isAvailable: true, availabilityStatus: 'maybe' as never }, 'availabilityStatus'],
      [{ hasModifiers: 'yes' as never }, 'hasModifiers'],
    ];
    for (const [o, path] of bad) assert.ok(paths(validateMenuItem(makeMenuItem(o))).includes(path), JSON.stringify(o));
  });
});
