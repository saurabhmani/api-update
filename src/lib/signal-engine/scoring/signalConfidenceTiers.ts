// ════════════════════════════════════════════════════════════════
//  Signal confidence tiers — Phase 2.6
//
//  Tiers use calibrated probability + evidence strength, not raw
//  score alone. Elite is the only tier measured vs aspirational 78%.
// ════════════════════════════════════════════════════════════════

import type { ConfidenceBand } from '../types/signalEngine.types';

/** Aspirational elite precision target (validation target, not a promise). */
export const ELITE_PRECISION_TARGET = 0.78;

export type SignalConfidenceTier = 'Elite' | 'Actionable' | 'Watchlist' | 'Avoid';

export interface TierAssignment {
  tier: SignalConfidenceTier;
  /** Evidence label for UI — always show sample or insufficient. */
  evidenceLabel: string;
  meetsElitePrecisionHypothesis: boolean;
}

export function assignSignalConfidenceTier(input: {
  calibratedProbability: number | null;
  calibrationSampleSize: number;
  rawBand: ConfidenceBand;
  phase3Rejected?: boolean;
}): TierAssignment {
  if (input.phase3Rejected) {
    return {
      tier: 'Avoid',
      evidenceLabel: 'phase3_rejected',
      meetsElitePrecisionHypothesis: false,
    };
  }

  const n = input.calibrationSampleSize;
  const p = input.calibratedProbability;
  const evidenceLabel =
    n <= 0 || p == null
      ? 'insufficient_evidence'
      : n < 40
        ? `insufficient_evidence (n=${n})`
        : `n=${n}`;

  if (p == null || n < 40) {
    // Fall back to raw band mapping without claiming calibrated Elite
    if (input.rawBand === 'High Conviction' || input.rawBand === 'Actionable') {
      return { tier: 'Watchlist', evidenceLabel, meetsElitePrecisionHypothesis: false };
    }
    if (input.rawBand === 'Watchlist') {
      return { tier: 'Watchlist', evidenceLabel, meetsElitePrecisionHypothesis: false };
    }
    return { tier: 'Avoid', evidenceLabel, meetsElitePrecisionHypothesis: false };
  }

  if (n >= 100 && p >= ELITE_PRECISION_TARGET) {
    return {
      tier: 'Elite',
      evidenceLabel,
      meetsElitePrecisionHypothesis: true,
    };
  }
  if (n >= 40 && p >= 0.55) {
    return { tier: 'Actionable', evidenceLabel, meetsElitePrecisionHypothesis: false };
  }
  if (p >= 0.40) {
    return { tier: 'Watchlist', evidenceLabel, meetsElitePrecisionHypothesis: false };
  }
  return { tier: 'Avoid', evidenceLabel, meetsElitePrecisionHypothesis: false };
}
