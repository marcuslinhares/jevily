/**
 * Decision policy: every number the pipeline branches on, in one place.
 *
 * The important idea is that thresholds are not the same for a calibrated engine
 * and a non-calibrated one. A native System One noul of 0.45 means roughly 45% of
 * the time. A number written by a chat model in a JSON blob means much less, and
 * treating the two identically is how pipelines end up confidently wrong.
 *
 * So `resolveThresholds(false)` moves every inclusion gate up and every exclusion
 * gate down: with an uncalibrated engine we keep more evidence and ask for more
 * proof before we claim anything, and we lean on lexical + structural signals.
 */

export interface RerankThresholds {
  /** Below this, the candidate is dropped regardless of other signals. */
  dropBelow: number;
  /** Weighted composite required to keep a candidate in the result set. */
  keepAbove: number;
  weights: {
    relevance: number;
    authority: number;
    quality: number;
    directness: number;
    recency: number;
    constraint: number;
  };
  /** The user pinned a constraint: this one becomes near-disqualifying when it fails. */
  constraintHard: boolean;
}

export interface GateThresholds {
  injectionMax: number;
  advertisementMax: number;
  contradictMin: number;
  relevantMin: number;
  evidenceMin: number;
}

export interface SufficiencyThresholds {
  /** Below this the answer is withheld and the evidence returned instead. */
  minSufficiency: number;
  conflictFlag: number;
}

export interface AbstainThresholds {
  /** Top composite rerank score below this: the index simply has nothing good. */
  minTopScore: number;
  /** Few enough accepted passages that a written answer would be speculation. */
  minAccepted: number;
  /** Uncalibrated engines are held to a stricter bar before writing prose. */
  minSufficiencyUncalibrated: number;
}

export interface Policy {
  rerank: RerankThresholds;
  gate: GateThresholds;
  sufficiency: SufficiencyThresholds;
  abstain: AbstainThresholds;
  /** Domain diversity: max results from a single registrable domain. */
  maxPerDomain: number;
  /** Min distinct domains required before the answer stage runs. */
  minDistinctDomains: number;
}

/**
 * `composite` is a weighted average of several probabilities, so it concentrates
 * near the middle of the range rather than spreading across it: a passage that is
 * clearly relevant but only moderately authoritative and slightly stale still lands
 * around 0.45. Thresholds therefore live in the middle of the range too. Setting them
 * high is the tempting move and the wrong one — it silently empties the result set.
 * `pnpm eval` is how these numbers get checked instead of guessed.
 */
const CALIBRATED: Policy = {
  rerank: {
    dropBelow: 0.18,
    keepAbove: 0.34,
    weights: {
      relevance: 0.5,
      authority: 0.14,
      quality: 0.12,
      directness: 0.08,
      recency: 0.1,
      constraint: 0.06,
    },
    constraintHard: false,
  },
  gate: {
    injectionMax: 0.7,
    advertisementMax: 0.85,
    contradictMin: 0.75,
    relevantMin: 0.35,
    evidenceMin: 0.45,
  },
  sufficiency: {
    minSufficiency: 0.55,
    conflictFlag: 0.6,
  },
  abstain: {
    minTopScore: 0.34,
    minAccepted: 2,
    minSufficiencyUncalibrated: 0.65,
  },
  maxPerDomain: 3,
  minDistinctDomains: 1,
};

const UNCALIBRATED: Policy = {
  rerank: {
    dropBelow: 0.24,
    keepAbove: 0.4,
    weights: {
      // Lean harder on the lexical signal we can verify ourselves.
      relevance: 0.56,
      authority: 0.1,
      quality: 0.1,
      directness: 0.06,
      recency: 0.08,
      constraint: 0.1,
    },
    constraintHard: true,
  },
  gate: {
    injectionMax: 0.5,
    advertisementMax: 0.7,
    contradictMin: 0.7,
    relevantMin: 0.45,
    evidenceMin: 0.55,
  },
  sufficiency: {
    minSufficiency: 0.6,
    conflictFlag: 0.55,
  },
  abstain: {
    minTopScore: 0.4,
    minAccepted: 2,
    minSufficiencyUncalibrated: 0.65,
  },
  maxPerDomain: 2,
  minDistinctDomains: 2,
};

export function resolvePolicy(calibrated: boolean): Policy {
  return calibrated ? CALIBRATED : UNCALIBRATED;
}

/** A hard requirement: a candidate that fails this is dropped no matter how good it looks. */
export function constraintPenalty(failed: boolean, policy: Policy): number {
  if (!failed) return 0;
  return policy.rerank.constraintHard ? 0.25 : 0.08;
}
