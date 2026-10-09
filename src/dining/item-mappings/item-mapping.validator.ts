import { ObjectId } from 'mongodb';
import { DINING_PLATFORMS } from '../dining.types';
import type { ValidationIssue, ValidationResult } from '../dining.validator';
import { ITEM_MAPPING_DECIDERS, ITEM_MATCH_METHODS, ITEM_MATCH_STATUSES } from './item-mapping.types';

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof Date);
const isDate = (v: unknown) => v instanceof Date && !Number.isNaN(v.getTime());
const inList = (v: unknown, list: readonly string[]) => typeof v === 'string' && list.includes(v);

const SCORE_FIELDS = ['nameScore', 'descriptionScore', 'categoryScore', 'variantScore', 'modifierScore', 'imageScore'];
// Platform data (price etc.) never belongs on a mapping.
const PLATFORM_FIELDS = ['price', 'originalPrice', 'currency', 'imageUrl', 'sourceUrl', 'name', 'description', 'isAvailable', 'availabilityStatus'];

export function validateItemMapping(doc: unknown): ValidationResult {
  const issues: ValidationIssue[] = [];
  const add = (path: string, message: string) => issues.push({ path, message });
  if (!isObj(doc)) return { valid: false, issues: [{ path: '$', message: 'must be an object' }] };

  for (const f of ['restaurantGroupId', 'menuItemId', 'restaurantId']) if (!(doc[f] instanceof ObjectId)) add(f, 'must be an ObjectId');
  if (!inList(doc.platform, DINING_PLATFORMS)) add('platform', 'must be a supported dining platform');
  if (doc.platformItemId !== undefined && (typeof doc.platformItemId !== 'string' || !doc.platformItemId)) add('platformItemId', 'must be a non-empty string');
  if (!inList(doc.matchStatus, ITEM_MATCH_STATUSES)) add('matchStatus', `must be one of: ${ITEM_MATCH_STATUSES.join(', ')}`);
  if (!inList(doc.decidedBy, ITEM_MAPPING_DECIDERS)) add('decidedBy', `must be one of: ${ITEM_MAPPING_DECIDERS.join(', ')}`);

  const unmatched = doc.matchStatus === 'UNMATCHED';
  if (unmatched) {
    if (doc.canonicalItemId !== undefined) add('canonicalItemId', 'must be absent while UNMATCHED');
    if (doc.matchMethod !== undefined) add('matchMethod', 'must be absent while UNMATCHED');
  } else {
    if (!(doc.canonicalItemId instanceof ObjectId)) add('canonicalItemId', `is required when ${String(doc.matchStatus)}`);
    if (!inList(doc.matchMethod, ITEM_MATCH_METHODS)) add('matchMethod', `must be one of: ${ITEM_MATCH_METHODS.join(', ')}`);
  }

  if (typeof doc.isActive !== 'boolean') add('isActive', 'must be a boolean');
  else {
    if (doc.matchStatus === 'REJECTED' && doc.isActive) add('isActive', 'must be false when REJECTED');
    if (doc.isActive && doc.supersededAt !== undefined) add('supersededAt', 'must be absent on an active mapping');
    if (!doc.isActive && doc.matchStatus !== 'REJECTED' && !isDate(doc.supersededAt)) add('supersededAt', 'is required on an inactive (superseded) mapping');
  }
  if (doc.supersedesMappingId !== undefined && !(doc.supersedesMappingId instanceof ObjectId)) add('supersedesMappingId', 'must be an ObjectId');

  if (typeof doc.confidence !== 'number' || !(doc.confidence >= 0 && doc.confidence <= 1)) add('confidence', 'must be between 0 and 1');
  if (doc.matchMethod === 'IMPORT' && doc.confidence !== 1) add('confidence', 'must be 1 for IMPORT');

  const ev = doc.evidence;
  if (!isObj(ev)) add('evidence', 'must be an object');
  else {
    for (const f of SCORE_FIELDS) {
      const v = ev[f];
      if (v !== undefined && (typeof v !== 'number' || v < 0 || v > 1)) add(`evidence.${f}`, 'must be between 0 and 1');
    }
    for (const f of ['reasons', 'conflicts']) {
      const v = ev[f];
      if (!Array.isArray(v) || v.some(s => typeof s !== 'string' || !/^[A-Z0-9_]{2,64}$/.test(s))) add(`evidence.${f}`, 'must be an array of UPPER_SNAKE codes');
    }
    if (ev.candidateCanonicalItemIds !== undefined && (!Array.isArray(ev.candidateCanonicalItemIds) || ev.candidateCanonicalItemIds.some(i => !(i instanceof ObjectId)))) {
      add('evidence.candidateCanonicalItemIds', 'must be an array of ObjectIds');
    }
  }
  if (doc.note !== undefined && (typeof doc.note !== 'string' || !doc.note.trim() || doc.note.length > 500)) add('note', 'must be a non-empty string of at most 500 characters');

  for (const f of PLATFORM_FIELDS) if (f in doc) add(f, 'platform data does not belong on an item mapping');
  for (const f of ['decidedAt', 'createdAt', 'updatedAt']) if (!isDate(doc[f])) add(f, 'must be a valid Date');
  return { valid: issues.length === 0, issues };
}
