// ════════════════════════════════════════════════════════════════
//  Dynamic Ranker — Phase 4
//
//  Implements the ranking formula specified in the Phase 4 brief:
//
//      finalScore = confidenceScore
//                   * contextModifiers
//                   - freshnessPenalty
//                   - overextensionPenalty
//                   - eventRiskPenalty
//
//  Inputs come from layers that already run in the pipeline
//  (confidenceScorer, regime engine, news-engine impact layer,
//   freshnessEngine, postSignalValidator). This module is pure
//   math — no IO, no DB. It is called from:
//
//    - saveSignals.ts          (once per INSERT, freshness.age = 0)
//    - rescoreActiveSignals.ts (once per row per cron tick)
//
//  Contract: output is clamped to [0, 100]. A decimal is returned
//  to give the dashboard stable tiebreaking; persisted as
//  DECIMAL(6,2) in q365_signals.final_score.
// ════════════════════════════════════════════════════════════════

import type { FreshnessReport } from '../freshness/freshnessEngine';
import type { ValidationVerdict } from '../validation/postSignalValidator';

// ── Inputs ──────────────────────────────────────────────────────
//
// Everything here must already exist on the persisted signal row or
// be computable from the freshness + validator. Adding new inputs
// here means adding new DB columns — don't do it without a migration.
export interface RankerInput {
  confidenceScore:  number;           // 0-100 (q365_signals.confidence_score)
  regimeAlignment:  number | null;    // 0-100 (q365_signals.regime_alignment)
  portfolioFit:     number | null;    // 0-100 (q365_signals.portfolio_fit_score)
  marketStance:     string | null;    // 'aggressive' | 'selective' | 'defensive' | 'capital_preservation'
  direction:        'BUY' | 'SELL';
  eventRiskScore:   number | null;    // 0-1 (news engine) — null = unknown, treated as 0
  manipulationPenalty: number | null; // 0-15 (q365_manipulation_penalties.confidence_penalty)
  freshness:        FreshnessReport;
  verdict:          ValidationVerdict;
}

// ── Tunable weights ─────────────────────────────────────────────
export interface RankerConfig {
  // contextModifier = 1 + Σ(signed adjustments). Each adjustment
  // is bounded so the modifier never drifts outside the allowed
  // range even if every input is extreme.
  regimeWeight:          number;      // ±0.15 at extremes
  portfolioFitWeight:    number;      // ±0.10 at extremes
  stanceAdjustments:     Record<string, number>;
  contextModifierMin:    number;
  contextModifierMax:    number;

  // Freshness penalty: confidence * contextModifier sits around
  // 55-95 for a high-conviction signal. Freshness decay alone
  // should be able to push a perfectly-priced signal out of the
  // top 20 in 2-3 days, so the penalty scales to ~40 at
  // freshnessScore = 0.
  freshnessPenaltyWeight: number;     // penalty = (100 - freshness) * weight

  // Overextension penalty: a trade that has run 100% of its
  // reward distance without the user taking the entry is worth
  // ~half what a freshly-valid signal is worth. At 2R (cap) it
  // should be effectively removed from the board.
  overextensionBasePenalty: number;   // applied at overextension = 1.0
  overextensionSlope:       number;   // extra penalty per unit above 1.0

  // Event risk penalty: news-engine finalEventRisk is 0-1.
  // Earnings day or a pending regulatory announcement should
  // meaningfully dock the score, but shouldn't dominate.
  eventRiskPenaltyMax:      number;
}

export const DEFAULT_RANKER_CONFIG: RankerConfig = {
  regimeWeight:          0.0030,       // 100-regime × 0.003 → ±0.15
  portfolioFitWeight:    0.0020,       // 100-pf × 0.002     → ±0.10
  stanceAdjustments: {
    aggressive:            +0.05,
    selective:              0.00,
    defensive:             -0.05,
    capital_preservation:  -0.15,
  },
  contextModifierMin:    0.70,
  contextModifierMax:    1.25,
  freshnessPenaltyWeight: 0.40,        // 40 points lost at freshness = 0
  overextensionBasePenalty: 20,
  overextensionSlope:       15,
  eventRiskPenaltyMax:      15,
};

export interface RankerBreakdown {
  finalScore:              number;
  base:                    number;     // confidence * contextModifier
  contextModifier:         number;
  freshnessPenalty:        number;
  stepAgePenalty:          number;     // stepped penalty on top of linear freshness (rotation spec)
  overextensionPenalty:    number;
  eventRiskPenalty:        number;
  manipulationPenalty:     number;
  verdictMultiplier:       number;
}

export function computeFinalScore(
  input:  RankerInput,
  cfg:    Partial<RankerConfig> = {},
): RankerBreakdown {
  const c = { ...DEFAULT_RANKER_CONFIG, ...cfg };

  // ── Context modifier (multiplicative) ──────────────────────
  let contextModifier = 1.0;

  if (input.regimeAlignment != null) {
    // regime_alignment is 0-100 centred at ~65 (NEUTRAL).
    contextModifier += (input.regimeAlignment - 65) * c.regimeWeight;
  }
  if (input.portfolioFit != null) {
    contextModifier += (input.portfolioFit - 50) * c.portfolioFitWeight;
  }
  if (input.marketStance && c.stanceAdjustments[input.marketStance] != null) {
    contextModifier += c.stanceAdjustments[input.marketStance];
  }
  contextModifier = clamp(contextModifier, c.contextModifierMin, c.contextModifierMax);

  // ── Base score ─────────────────────────────────────────────
  const base = input.confidenceScore * contextModifier;

  // ── Freshness penalty (linear in (100 - freshness)) ────────
  const freshnessPenalty = (100 - input.freshness.freshnessScore)
    * c.freshnessPenaltyWeight;

  // ── Stepped age penalty (rotation spec) ────────────────────
  // Additive — sits on TOP of the linear freshness decay. The
  // stepped thresholds are configured in freshnessEngine; we
  // just consume the pre-computed value here. Infinity means the
  // rotation cap has been hit; the validator will have already
  // returned an invalidate verdict in that case, but we clamp
  // defensively so the ranker never emits a negative finalScore.
  const stepAgePenalty = isFinite(input.freshness.stepAgePenalty)
    ? input.freshness.stepAgePenalty
    : 100; // caps the total penalty — the clamp at the bottom takes it to 0

  // ── Overextension penalty ──────────────────────────────────
  // Piecewise: 0 below ~0.3R of progress (still actionable),
  // ramps to overextensionBasePenalty at 1.0 (target hit-ish),
  // then scales linearly with slope for overshoots.
  const oe = input.freshness.overextensionPct;
  let overextensionPenalty = 0;
  if (oe > 0.3 && oe <= 1.0) {
    overextensionPenalty = ((oe - 0.3) / 0.7) * c.overextensionBasePenalty;
  } else if (oe > 1.0) {
    overextensionPenalty = c.overextensionBasePenalty
      + (oe - 1.0) * c.overextensionSlope;
  }

  // ── Event risk penalty ─────────────────────────────────────
  // eventRiskScore is 0-1 from the news engine. We don't have
  // event risk for every symbol, so null is treated as 0.
  const eventRisk = input.eventRiskScore ?? 0;
  const eventRiskPenalty = clamp(eventRisk * c.eventRiskPenaltyMax, 0, c.eventRiskPenaltyMax);

  // ── Manipulation penalty (already 0-15 scale) ──────────────
  const manipulationPenalty = input.manipulationPenalty ?? 0;

  // ── Compose ────────────────────────────────────────────────
  const rawFinal = base
    - freshnessPenalty
    - stepAgePenalty
    - overextensionPenalty
    - eventRiskPenalty
    - manipulationPenalty;

  // ── Validator multiplier (downgrade / invalidate) ──────────
  const finalScore = clamp(
    rawFinal * input.verdict.scoreMultiplier,
    0,
    100,
  );

  return {
    finalScore:           round2(finalScore),
    base:                 round2(base),
    contextModifier:      round4(contextModifier),
    freshnessPenalty:     round2(freshnessPenalty),
    stepAgePenalty:       round2(stepAgePenalty),
    overextensionPenalty: round2(overextensionPenalty),
    eventRiskPenalty:     round2(eventRiskPenalty),
    manipulationPenalty:  round2(manipulationPenalty),
    verdictMultiplier:    input.verdict.scoreMultiplier,
  };
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}
function round2(n: number): number { return Math.round(n * 100)   / 100;   }
function round4(n: number): number { return Math.round(n * 10000) / 10000; }
