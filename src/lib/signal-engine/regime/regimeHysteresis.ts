// ════════════════════════════════════════════════════════════════
//  Regime Hysteresis — Product A Phase 3
//
//  Prevents label oscillation from single-bar threshold crosses.
//  Entry vs exit thresholds + minimum confirmation bars.
// ════════════════════════════════════════════════════════════════

import type {
  MarketRegimeLabel,
  RegimeDimensions,
  RegimeHysteresisState,
  RegimeTrendState,
  RegimeVolatilityState,
} from '../types/signalEngine.types';
import { labelFromTrendAndVol, trendStateFromLabel } from './regimeDimensions';

export const REGIME_HYSTERESIS_VERSION = '1.0.0';

/** Bars a candidate must hold before the published label flips. */
export const REGIME_MIN_CONFIRMATION_BARS = 2;

/** Entry / exit bias for trend (percentage points on EMA distance). */
export const TREND_ENTRY_BUFFER = 0.15;
export const TREND_EXIT_BUFFER = 0.05;

export interface HysteresisInput {
  candidateTrend: RegimeTrendState;
  candidateVol: RegimeVolatilityState;
  previousLabel: MarketRegimeLabel | null;
  previousDimensions: RegimeDimensions | null;
  previousCandidateLabel?: MarketRegimeLabel | null;
  confirmationBarsHeld?: number;
  minConfirmationBars?: number;
}

/**
 * Apply entry/exit hysteresis around the raw candidate classification.
 * Published label only changes after min confirmation bars of the new candidate.
 */
export function applyRegimeHysteresis(input: HysteresisInput): RegimeHysteresisState {
  const minBars = input.minConfirmationBars ?? REGIME_MIN_CONFIRMATION_BARS;
  const rawCandidate = labelFromTrendAndVol(input.candidateTrend, input.candidateVol);
  const previous = input.previousLabel;

  if (previous == null) {
    return {
      previousLabel: null,
      candidateLabel: rawCandidate,
      confirmationBarsHeld: minBars,
      minConfirmationBars: minBars,
      transitionConfidence: 55,
      changed: true,
      changeReason: 'initial_classification',
    };
  }

  // Soften flips: if candidate equals previous, reset / hold
  if (rawCandidate === previous) {
    return {
      previousLabel: previous,
      candidateLabel: rawCandidate,
      confirmationBarsHeld: minBars,
      minConfirmationBars: minBars,
      transitionConfidence: 85,
      changed: false,
      changeReason: null,
    };
  }

  // Exit hysteresis: require clearer disagreement before accepting a flip candidate
  const prevTrend = input.previousDimensions?.trend_state ?? trendStateFromLabel(previous);
  const softened = softenCandidate(prevTrend, input.candidateTrend, previous, rawCandidate);
  const effectiveCandidate = softened ?? rawCandidate;

  if (effectiveCandidate === previous) {
    return {
      previousLabel: previous,
      candidateLabel: previous,
      confirmationBarsHeld: 0,
      minConfirmationBars: minBars,
      transitionConfidence: 70,
      changed: false,
      changeReason: null,
    };
  }

  const sameAsPrevCandidate = input.previousCandidateLabel === effectiveCandidate;
  const held = sameAsPrevCandidate ? (input.confirmationBarsHeld ?? 0) + 1 : 1;

  if (held < minBars) {
    return {
      previousLabel: previous,
      candidateLabel: effectiveCandidate,
      confirmationBarsHeld: held,
      minConfirmationBars: minBars,
      transitionConfidence: Math.round(40 + (held / minBars) * 30),
      changed: false,
      changeReason: `awaiting_confirmation:${held}/${minBars}`,
    };
  }

  return {
    previousLabel: previous,
    candidateLabel: effectiveCandidate,
    confirmationBarsHeld: held,
    minConfirmationBars: minBars,
    transitionConfidence: Math.round(75 + Math.min(20, held)),
    changed: true,
    changeReason: `confirmed_flip:${previous}->${effectiveCandidate}`,
  };
}

function softenCandidate(
  prevTrend: RegimeTrendState,
  candTrend: RegimeTrendState,
  previousLabel: MarketRegimeLabel,
  rawCandidate: MarketRegimeLabel,
): MarketRegimeLabel | null {
  // One-step neighbors stay sticky unless confirmation builds (caller handles bars)
  const order: RegimeTrendState[] = ['strong_bear', 'bear', 'neutral', 'bull', 'strong_bull'];
  const pi = order.indexOf(prevTrend);
  const ci = order.indexOf(candTrend);
  if (pi < 0 || ci < 0) return rawCandidate;
  // Adjacent flips are allowed as candidates; jumps of 2+ softened to adjacent
  if (Math.abs(pi - ci) >= 2) {
    const step = ci > pi ? pi + 1 : pi - 1;
    const softenedTrend = order[step];
    // Preserve vol-extreme label when raw was High Vol
    if (rawCandidate === 'High Volatility Risk') return 'High Volatility Risk';
    return labelFromTrendAndVol(softenedTrend, 'normal');
  }
  void previousLabel;
  return rawCandidate;
}

/** In-memory last published regime for process-local hysteresis continuity. */
let _lastPublished: {
  label: MarketRegimeLabel;
  dimensions: RegimeDimensions;
  confirmationBarsHeld: number;
  candidateLabel: MarketRegimeLabel;
} | null = null;

export function getLastPublishedRegime(): typeof _lastPublished {
  return _lastPublished;
}

export function setLastPublishedRegime(state: NonNullable<typeof _lastPublished>): void {
  _lastPublished = state;
}

export function clearLastPublishedRegime(): void {
  _lastPublished = null;
}
