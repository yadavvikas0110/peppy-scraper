/*
 * Item matcher configuration — the single place for weights, thresholds and penalties.
 *
 * Confidence is a deterministic ranking/decision score in [0, 1], NOT a probability:
 *
 *   confidence = Σ weight(signal) × score(signal)   (a missing signal contributes 0)
 *              − Σ penalty(conflict)
 *
 * Weights sum to 1, so a perfect name alone yields 0.5 — below matchMin by design: a name
 * nominates a candidate, other signals must corroborate it. Variant (quantity/size/unit) is
 * not weighted; it acts as a gate via conflicts. Price is never an input.
 *
 * Worked examples (no conflicts):
 *   exact name only                              0.50 → REVIEW
 *   exact name + same category                   0.60 → REVIEW
 *   exact name + description ≥ ~0.83 similar     ≥0.67; + same category ≥0.77 → MATCHED
 *   exact name + identical description           0.70 → MATCHED
 *   exact name + same category + same modifiers  0.75 → MATCHED
 *   similar name (token Dice 0.6) only           0.24 → UNMATCHED
 */

export interface ItemMatcherConfig {
  weights: {
    name: number;
    description: number;
    category: number;
    modifiers: number;
    image: number;
  };
  thresholds: {
    // Minimum name score for a canonical item to be considered a candidate at all.
    nameCandidateMin: number;
    // MATCHED requires an exact (1.0) or variant-stripped exact (0.9) name.
    nameMatchMin: number;
    // Below this, a candidate is not plausible (UNMATCHED if nothing else is).
    reviewMin: number;
    // MATCHED requires at least this confidence…
    matchMin: number;
    // …and a lead of at least this much over the next plausible candidate (else ambiguous → REVIEW).
    ambiguityMargin: number;
    // A corroborating (non-name, non-image) signal must reach one of these.
    descriptionSupportMin: number;
    categorySupportMin: number;
    modifierSupportMin: number;
    // Both sides present but below these → recorded as a conflict.
    categoryConflictBelow: number;
    modifierConflictBelow: number;
  };
  // Scale applied to token-overlap name similarity so a partial name never reaches nameMatchMin.
  partialNameScale: number;
  // Score for a name that is exact once portion/size text is removed ("Dosa (2 Pcs)" vs "Dosa 2 pieces").
  coreNameScore: number;
  penalties: Record<string, number>;
  // Conflicts that forbid MATCHED (decision becomes REVIEW).
  reviewConflicts: string[];
  // Conflicts that make a candidate implausible (dropped → may end UNMATCHED).
  excludeConflicts: string[];
  maxCandidates: number;
}

export const ITEM_MATCHER_CONFIG: ItemMatcherConfig = {
  weights: { name: 0.5, description: 0.2, category: 0.1, modifiers: 0.15, image: 0.05 },
  thresholds: {
    nameCandidateMin: 0.5,
    nameMatchMin: 0.9,
    reviewMin: 0.35,
    matchMin: 0.7,
    ambiguityMargin: 0.1,
    descriptionSupportMin: 0.5,
    categorySupportMin: 1,
    modifierSupportMin: 0.6,
    categoryConflictBelow: 0.3,
    modifierConflictBelow: 0.3,
  },
  partialNameScale: 0.8,
  coreNameScore: 0.9,
  penalties: {
    CATEGORY_DIFFERENT: 0.05,
    MODIFIER_OPTIONS_DIFFER: 0.05,
    MODIFIER_REQUIRED_DIFFERS: 0.02,
    MODIFIER_LIMITS_DIFFER: 0.02,
    VARIANT_ONLY_ONE_SIDE: 0.1,
    QUANTITY_MISMATCH: 0.3,
    SIZE_MISMATCH: 0.3,
  },
  reviewConflicts: ['VARIANT_ONLY_ONE_SIDE', 'QUANTITY_MISMATCH', 'SIZE_MISMATCH', 'PLATFORM_ALREADY_MAPPED'],
  excludeConflicts: ['UNIT_MISMATCH'],
  maxCandidates: 10,
};
