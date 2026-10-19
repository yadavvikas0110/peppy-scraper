import type { ObjectId } from 'mongodb';
import type { DiningPlatform } from '../dining.types';
import { areasCompatible, distanceMeters, SourceRestaurantSignals } from './identity.signals';
import type {
  DiningRestaurantMatchEvidence,
  MatchConflict,
  MatchMethod,
  MatchSignal,
  RestaurantMatchSignals,
} from './identity.types';

/*
 * Deterministic matcher. Pure: no I/O.
 *
 * A name (or brand) match only nominates a candidate. Auto-MATCHED additionally needs a strong
 * branch signal — identical normalized address or coordinates within LOCATION_MATCH_METERS.
 * Any branch conflict (different city, incompatible area, far-apart coordinates) means a
 * different branch. Everything in between goes to REVIEW; nothing is merged on name alone.
 */

export const LOCATION_MATCH_METERS = 75;
export const LOCATION_CONFLICT_METERS = 500;

export interface MatchCandidate {
  groupId: ObjectId;
  signals: RestaurantMatchSignals;
  // Platforms that already have a MATCHED source restaurant in this group.
  matchedPlatforms: DiningPlatform[];
}

interface PositiveVerdict {
  verdict: 'match' | 'review';
  groupId: ObjectId;
  method: MatchMethod;
  confidence: number;
  evidence: DiningRestaurantMatchEvidence;
}

export type CandidateVerdict = PositiveVerdict | { verdict: 'none'; groupId: ObjectId; evidence: DiningRestaurantMatchEvidence };

export type MatchDecision =
  | { kind: 'match' | 'review'; groupId: ObjectId; method: MatchMethod; confidence: number; evidence: DiningRestaurantMatchEvidence }
  | { kind: 'new'; evidence: DiningRestaurantMatchEvidence };

export const HARD_CONFLICTS: readonly MatchConflict[] = ['CITY_MISMATCH', 'AREA_MISMATCH', 'LOCATION_FAR'];

export interface BranchComparison {
  signals: MatchSignal[];
  conflicts: MatchConflict[];
  distanceMeters?: number;
}

// Branch (location) evidence only: city, area, address and coordinates. Names and brands are not compared.
export function compareBranchLocation(source: RestaurantMatchSignals, target: RestaurantMatchSignals): BranchComparison {
  const out: BranchComparison = { signals: [], conflicts: [] };
  if (source.city && target.city) {
    if (source.city === target.city) out.signals.push('CITY_EQUAL');
    else out.conflicts.push('CITY_MISMATCH');
  }
  if (source.area && target.area) {
    if (areasCompatible(source.area, target.area)) out.signals.push('AREA_COMPATIBLE');
    else out.conflicts.push('AREA_MISMATCH');
  }
  if (source.address && target.address) {
    if (source.address === target.address) out.signals.push('ADDRESS_EXACT');
    else out.conflicts.push('ADDRESS_MISMATCH');
  }
  if (source.lat !== undefined && source.lng !== undefined && target.lat !== undefined && target.lng !== undefined) {
    const d = Math.round(distanceMeters({ lat: source.lat, lng: source.lng }, { lat: target.lat, lng: target.lng }));
    out.distanceMeters = d;
    if (d <= LOCATION_MATCH_METERS) out.signals.push('LOCATION_NEAR');
    else if (d > LOCATION_CONFLICT_METERS) out.conflicts.push('LOCATION_FAR');
  }
  return out;
}

export function evaluateCandidate(source: SourceRestaurantSignals, candidate: MatchCandidate): CandidateVerdict {
  const target = candidate.signals;
  const signals: MatchSignal[] = [];
  const conflicts: MatchConflict[] = [];
  const evidence: DiningRestaurantMatchEvidence = { signals, conflicts };

  const nameMatch = source.names.some(n => target.names.includes(n));
  const brandMatch = source.brands.length > 0 && source.brands.some(b => target.brands.includes(b));
  if (nameMatch) signals.push('NAME_EXACT');
  if (brandMatch) signals.push('BRAND_EXACT');
  if (!nameMatch && !brandMatch) return { verdict: 'none', groupId: candidate.groupId, evidence };

  const branch = compareBranchLocation(source, target);
  signals.push(...branch.signals);
  conflicts.push(...branch.conflicts);
  if (branch.distanceMeters !== undefined) evidence.distanceMeters = branch.distanceMeters;

  if (conflicts.some(c => HARD_CONFLICTS.includes(c))) return { verdict: 'none', groupId: candidate.groupId, evidence };

  const strong: { method: MatchMethod; confidence: number } | undefined =
    nameMatch && signals.includes('ADDRESS_EXACT') ? { method: 'NAME_ADDRESS', confidence: 0.95 }
    : nameMatch && signals.includes('LOCATION_NEAR') ? { method: 'NAME_LOCATION', confidence: 0.9 }
    : brandMatch && signals.includes('ADDRESS_EXACT') ? { method: 'BRAND_NAME_ADDRESS', confidence: 0.85 }
    : undefined;

  if (strong) {
    // A branch has one listing per platform; a second same-platform listing needs a human.
    if (candidate.matchedPlatforms.includes(source.platform)) {
      conflicts.push('SAME_PLATFORM_ALREADY_MAPPED');
      return { verdict: 'review', groupId: candidate.groupId, method: strong.method, confidence: 0.5, evidence };
    }
    return { verdict: 'match', groupId: candidate.groupId, ...strong, evidence };
  }

  const located = signals.includes('AREA_COMPATIBLE') || signals.includes('CITY_EQUAL');
  return {
    verdict: 'review',
    groupId: candidate.groupId,
    method: nameMatch ? 'EXACT_NAME' : 'BRAND_NAME_ADDRESS',
    confidence: located ? 0.5 : 0.3,
    evidence,
  };
}

function best<T extends { confidence: number; groupId: ObjectId }>(items: T[]): T {
  return [...items].sort((a, b) => b.confidence - a.confidence || a.groupId.toHexString().localeCompare(b.groupId.toHexString()))[0];
}

export function decideMatch(source: SourceRestaurantSignals, candidates: MatchCandidate[]): MatchDecision {
  const verdicts = candidates.map(c => evaluateCandidate(source, c));
  const matches = verdicts.filter((v): v is PositiveVerdict => v.verdict === 'match');
  const reviews = verdicts.filter((v): v is PositiveVerdict => v.verdict === 'review');

  if (matches.length === 1) {
    const m = matches[0];
    return { kind: 'match', groupId: m.groupId, method: m.method, confidence: m.confidence, evidence: m.evidence };
  }
  if (matches.length > 1) {
    const top = best(matches);
    return {
      kind: 'review',
      groupId: top.groupId,
      method: top.method,
      confidence: 0.5,
      evidence: { ...top.evidence, conflicts: [...top.evidence.conflicts, 'MULTIPLE_CANDIDATES'], candidateGroupIds: matches.map(m => m.groupId) },
    };
  }
  if (reviews.length > 0) {
    const top = best(reviews);
    const evidence = reviews.length > 1
      ? { ...top.evidence, conflicts: [...top.evidence.conflicts, 'MULTIPLE_CANDIDATES' as const], candidateGroupIds: reviews.map(r => r.groupId) }
      : top.evidence;
    return { kind: 'review', groupId: top.groupId, method: top.method, confidence: top.confidence, evidence };
  }
  return { kind: 'new', evidence: { signals: [], conflicts: [], reason: 'NO_CANDIDATE' } };
}
