// ════════════════════════════════════════════════════════════════
//  Phase-11 Pipeline Runner
//
//  Per-signal integration step that runs the four downstream
//  engines (stress / live / sizing / explanation) in production
//  order and returns the unified row block ready to attach to a
//  QuantSignal before saveSignals.
//
//  Order matters:
//
//    1. Risk-budget-sized notional position (no caps yet) — so
//       stress is evaluated on the full proposed trade.
//    2. Phase-7 stress test on that position.
//    3. Phase-8 live validation against the latest tick.
//    4. Phase-9 sizing with portfolio caps. Sizing's `riskGate`
//       is the AND of "Phase-3 approved" + live valid + not fragile,
//       so a fragile or live-invalidated trade gets quantity = 0.
//    5. Phase-10 explanation that ties together the upstream
//       outputs into the seven-section narrative block.
//
//  Pure, synchronous, IO-free. The caller (generatePhase4Signals)
//  decides what live-tick input to feed in — typically the same
//  Yahoo / Kite price the API enrichment uses.
// ════════════════════════════════════════════════════════════════

import { runStressTest }         from '../risk/stressTestEngine';
import { validateLiveSignal }    from '../live/liveValidationEngine';
import { calculatePositionSize } from '../portfolio/positionSizingEngine';
import { explainSignal }         from '../explainability/signalExplainabilityEngine';
import type { ExecutableSignal } from '../types/phase3.types';

// ── Inputs ──────────────────────────────────────────────────────

export interface Phase11RunInput {
  /** Phase-3 output. Provides entry/stop/sizing/portfolio_fit context. */
  signal:                 ExecutableSignal;
  /** Direction as persisted to q365_signals.direction. */
  direction:              'BUY' | 'SELL';
  /** Sector tag — used by sizing's sector cap. */
  sector:                 string;
  /** ATR as a fraction of price (e.g. 0.014). */
  atrPct:                 number;
  /** Latest tick price; defaults to entry zone midpoint when missing. */
  livePrice?:             number;
  /** ISO timestamp of the live tick; null disables tick-staleness. */
  liveTickAt?:            string;
  /** Upstream `live_invalidated` flag from validateAgainstLive. */
  liveInvalidated?:       boolean;
  /** 0-100 liquidity score — drives stress's liquidity_dry_up cost. */
  liquidityScore:         number;
  /** Risk-engine R:R ratio. */
  riskReward:             number;
  /** Risk band drill-down for the explanation engine. */
  risk:                   { risk_score: number; risk_band: string; risk_factors: string[] };
  /** Phase-5 rejection-engine codes/reasons (empty when approved). */
  rejectionCodes:         string[];
  rejectionReasons:       string[];
  /** Phase-3 portfolio-fit decision — feeds the sizing risk gate. */
  portfolioApproved:      boolean;
  portfolioFitScore:      number;
  /** Phase-4 final score / classification / 8-factor block. */
  finalScore:             number;
  classification:         string;
  factorScores: {
    strategy_quality:     number;
    trend_alignment:      number;
    momentum:             number;
    volume_confirmation:  number;
    risk_reward:          number;
    liquidity:            number;
    market_regime:        number;
    portfolio_fit:        number;
  };
  /** Capital + caps. Defaults are tuned to the Phase-9 spec. */
  portfolioCapital:        number;
  riskPerTradePct?:        number;
  maxLiquidityCapital?:    number;
  maxSingleStockPct?:      number;
  maxSectorPct?:           number;
  maxTotalPortfolioRiskPct?: number;
  /** Existing exposure for cap computation (default 0). */
  currentSymbolExposure?:    number;
  currentSectorExposure?:    number;
  currentTotalPortfolioRisk?: number;
}

// ── Output ──────────────────────────────────────────────────────

export interface Phase11RunOutput {
  stress_survival_score:   number;
  stress_fragile:          boolean;
  stress_codes:            string[];
  live_valid:              boolean;
  live_validation_codes:   string[];
  live_validation_reasons: string[];
  recommended_quantity:    number;
  recommended_capital:     number;
  rejection_codes:         string[];      // union across phases (deduped)
  rejection_reasons:       string[];      // parallel reasons array
  explanation: {
    summary_reason:             string;
    factor_score_explanation:   string;
    risk_explanation:           string;
    portfolio_explanation:      string;
    stress_explanation:         string;
    rejection_explanation:      string;
    final_decision_explanation: string;
  };
}

// ── Stress-code → reason mapping ────────────────────────────────
// The stress engine returns codes only. saveSignals wants a
// parallel reasons array for every code so the rejection_reasons
// column is never empty when rejection_codes has entries.

const STRESS_CODE_REASONS: Record<string, string> = {
  stress_survival_below_60:   'Stress survival score below 60 floor — fragile under hostile scenarios',
  gap_breaches_stop:          'Adverse overnight gap would breach stop loss',
  volatility_breaches_stop:   'Volatility spike whipsaws through stop loss',
  market_crash_breaches_stop: 'Stop too tight relative to single-digit market drop',
  liquidity_dry_up_severe:    'Liquidity score below severe-illiquidity floor',
};

// ── Public API ──────────────────────────────────────────────────

export function runPhase11Pipeline(input: Phase11RunInput): Phase11RunOutput {
  const sig = input.signal;

  // Risk-budget-sized notional position — used as the "what we'd
  // trade if there were no caps" baseline for stress.
  const entryPrice = sig.tradePlan.entryZoneHigh;
  const stopLoss   = sig.tradePlan.stopLoss;
  const riskPerUnit = Math.abs(entryPrice - stopLoss);
  const riskBudget  = input.portfolioCapital * ((input.riskPerTradePct ?? 1.0) / 100);
  const baseSize    = riskPerUnit > 0 ? Math.floor(riskBudget / riskPerUnit) : 0;
  const livePrice   = input.livePrice ?? entryPrice;

  // ── 1. Stress (Phase 7) ──────────────────────────────────────
  const stress = runStressTest({
    symbol:         sig.symbol,
    direction:      input.direction,
    entryPrice, stopLoss,
    positionSize:   Math.max(baseSize, 1),
    atrPct:         input.atrPct,
    liquidityScore: input.liquidityScore,
    sector:         input.sector,
    capital:        input.portfolioCapital,
  });
  const stressReasons = stress.stress_rejection_codes.map(
    (code) => STRESS_CODE_REASONS[code] ?? `Stress engine flagged ${code}`,
  );

  // ── 2. Live validation (Phase 8) ─────────────────────────────
  const live = validateLiveSignal({
    symbol:          sig.symbol,
    direction:       input.direction,
    entryPrice, stopLoss,
    generatedAt:     sig.generatedAt,
    liveTickAt:      input.liveTickAt,
    livePrice,
    liveInvalidated: input.liveInvalidated,
  });

  // ── 3. Sizing (Phase 9) ──────────────────────────────────────
  // Sizing-side risk gate is upstream-approved AND live-valid AND
  // stress-not-fragile. Any of those false → quantity 0, sizing
  // method 'gate_blocked'.
  const sizingGatePassed = input.portfolioApproved && live.live_valid && !stress.fragile;
  const sizingGateReasons: string[] = [];
  if (!input.portfolioApproved) sizingGateReasons.push(...input.rejectionCodes);
  if (!live.live_valid)         sizingGateReasons.push(...live.live_validation_codes);
  if (stress.fragile)           sizingGateReasons.push(...stress.stress_rejection_codes);

  const sizing = calculatePositionSize({
    symbol:                    sig.symbol,
    sector:                    input.sector,
    direction:                 input.direction,
    entryPrice, stopLoss,
    portfolioCapital:          input.portfolioCapital,
    riskPerTradePct:           input.riskPerTradePct ?? 1.0,
    maxLiquidityCapital:       input.maxLiquidityCapital,
    maxSingleStockPct:         input.maxSingleStockPct,
    maxSectorPct:              input.maxSectorPct,
    maxTotalPortfolioRiskPct:  input.maxTotalPortfolioRiskPct,
    currentSymbolExposure:     input.currentSymbolExposure     ?? 0,
    currentSectorExposure:     input.currentSectorExposure     ?? 0,
    currentTotalPortfolioRisk: input.currentTotalPortfolioRisk ?? 0,
    riskGatePassed:            sizingGatePassed,
    riskGateReasons:           sizingGateReasons,
  });

  // ── 4. Union of rejection codes/reasons across phases ────────
  const allCodes = Array.from(new Set([
    ...input.rejectionCodes,
    ...stress.stress_rejection_codes,
    ...live.live_validation_codes,
  ]));
  const allReasons = [
    ...input.rejectionReasons,
    ...stressReasons,
    ...live.live_validation_reasons,
  ];

  // ── 5. Explanation (Phase 10) ────────────────────────────────
  const approved = sizing.recommended_quantity > 0;
  const explanation = explainSignal({
    symbol:    sig.symbol,
    direction: input.direction,
    strategy:  sig.signalType,
    finalScore:     input.finalScore,
    classification: input.classification,
    factorScores:   input.factorScores,
    rejection: {
      rejected:          input.rejectionCodes.length > 0,
      rejection_codes:   input.rejectionCodes,
      rejection_reasons: input.rejectionReasons,
    },
    portfolio: { approved: input.portfolioApproved, portfolio_fit_score: input.portfolioFitScore },
    stress: {
      expected_loss:          stress.expected_loss,
      worst_case_loss:        stress.worst_case_loss,
      worst_case_scenario:    stress.worst_case_scenario,
      stress_survival_score:  stress.stress_survival_score,
      fragile:                stress.fragile,
      stress_rejection_codes: stress.stress_rejection_codes,
    },
    liveValidation: {
      live_valid:            live.live_valid,
      live_validation_codes: live.live_validation_codes,
    },
    risk: input.risk,
    approved,
  });

  return {
    stress_survival_score:   stress.stress_survival_score,
    stress_fragile:          stress.fragile,
    stress_codes:            stress.stress_rejection_codes,
    live_valid:              live.live_valid,
    live_validation_codes:   live.live_validation_codes,
    live_validation_reasons: live.live_validation_reasons,
    recommended_quantity:    sizing.recommended_quantity,
    recommended_capital:     sizing.recommended_capital,
    rejection_codes:         allCodes,
    rejection_reasons:       allReasons,
    explanation: {
      summary_reason:             explanation.summary_reason,
      factor_score_explanation:   explanation.factor_score_explanation,
      risk_explanation:           explanation.risk_explanation,
      portfolio_explanation:      explanation.portfolio_explanation,
      stress_explanation:         explanation.stress_explanation,
      rejection_explanation:      explanation.rejection_explanation,
      final_decision_explanation: explanation.final_decision_explanation,
    },
  };
}
