// ════════════════════════════════════════════════════════════════
//  Trade Plan Builder — Phase 1 + Phase 2 + Phase 3
//
//  Phase-1 stabilization:
//   - Every TradePlan.entry.type now matches the strategy mechanic
//     (pullback_entry, mean_reversion_entry, breakdown_confirmation
//     …) instead of the legacy universal 'breakout_confirmation'.
//     The strategy-specific mapping lives in strategyRegistry.ts;
//     each plan builder below reads it via `entryFor(strategy)`.
//
//   - Phase3TradePlan.entryType is also derived from the registry,
//     keeping the persisted `q365_phase3_signals.entry_type` column
//     consistent with the wire/UI value.
// ════════════════════════════════════════════════════════════════

import type { SignalFeatures, TradePlan, StrategyName, EntryType } from '../types/signalEngine.types';
import { BEARISH_STRATEGIES } from '../types/signalEngine.types';
import type { Phase3TradePlan } from '../types/phase3.types';
import { round, safeDivide } from '../utils/math';
import { STOP_ATR_MULTIPLIER, TARGET1_R_MULTIPLE, TARGET2_R_MULTIPLE } from '../constants/signalEngine.constants';
import { getStrategyEntryType } from '../strategies/strategyRegistry';

// ── Strategy-specific target3 R multiples ──────────────────
const TARGET3_R_MAP: Record<StrategyName, number> = {
  bullish_breakout:       3.5,  // standard
  momentum_continuation:  4.0,  // momentum can run further
  gap_continuation:       4.0,  // gap setups have extended targets
  bullish_pullback:       3.0,  // pullbacks = more conservative
  bearish_breakdown:      3.5,  // standard
  mean_reversion_bounce:  2.5,  // mean reversion = tighter targets
  bullish_divergence:     3.0,  // moderate
  volume_climax_reversal: 2.5,  // conservative — reversal setups
  range_breakout:         3.5,  // breakout from range — standard
  ema_crossover:          4.0,  // trend-following — can run further
  oversold_bounce:        2.5,  // reversal — conservative targets
  overbought_reversal:    2.5,  // mirror of oversold_bounce — conservative mean reversion
  weak_trend_breakdown:   3.0,  // trend continuation (downward) — moderate
  // Phase 4:
  failed_breakout_reversal:    2.5,  // contrarian trap-fade — keep targets tight
  bearish_pullback_rejection:  3.0,  // continuation-short — moderate target
  volatility_squeeze_breakout: 3.5,  // squeeze expansion — standard
  multi_timeframe_alignment:   3.0,  // confirmation only; not used standalone
  vwap_reclaim_long:           2.5,  // intraday — tight
  vwap_rejection_short:        2.5,  // intraday — tight
  opening_range_breakout:      3.0,
  opening_range_breakdown:     3.0,
};

// Strategy → EntryType is now sourced from the registry so we don't
// keep two competing maps in sync. This helper exists so a builder
// can be written with no awareness of where the value comes from.
function entryFor(strategy: StrategyName): EntryType {
  return getStrategyEntryType(strategy);
}

/**
 * Build a full Phase 3 trade plan with strategy-aware target3.
 */
export function buildPhase3TradePlanForStrategy(
  features: SignalFeatures,
  strategy: StrategyName,
): Phase3TradePlan {
  const basePlan = buildTradePlanForStrategy(features, strategy);
  // Use the shared Set so new bearish strategies are picked up
  // automatically — prior bug: hard-coded `=== 'bearish_breakdown'`
  // silently built LONG plans for new bearish strategies, producing
  // upward target3 values for SELL signals.
  const isShort = BEARISH_STRATEGIES.has(strategy);
  const entryRef = basePlan.entry.zoneHigh;
  const riskPerUnit = Math.abs(entryRef - basePlan.stopLoss);
  const t3Multiple = TARGET3_R_MAP[strategy] ?? 3.5;

  const target3 = isShort
    ? round(entryRef - t3Multiple * riskPerUnit)
    : round(entryRef + t3Multiple * riskPerUnit);

  return {
    entryType: entryFor(strategy),
    entryZoneLow: basePlan.entry.zoneLow,
    entryZoneHigh: basePlan.entry.zoneHigh,
    stopLoss: basePlan.stopLoss,
    initialRiskPerUnit: round(riskPerUnit),
    target1: basePlan.targets.target1,
    target2: basePlan.targets.target2,
    target3,
    rrTarget1: basePlan.rewardRiskApprox,
    rrTarget2: riskPerUnit > 0
      ? round(Math.abs(basePlan.targets.target2 - entryRef) / riskPerUnit, 1)
      : 0,
    rrTarget3: riskPerUnit > 0
      ? round(Math.abs(target3 - entryRef) / riskPerUnit, 1)
      : 0,
  };
}

export function buildTradePlanForStrategy(features: SignalFeatures, strategy: StrategyName): TradePlan {
  // Each sub-builder still writes its own geometry (entry zone /
  // stop / targets). The entry-type slot is overwritten from the
  // registry so a bearish/mean-reversion plan can never leak the
  // legacy "breakout_confirmation" label into the wire/UI.
  let plan: TradePlan;
  switch (strategy) {
    case 'bullish_pullback':
      plan = buildPullbackPlan(features); break;
    case 'bearish_breakdown':
      plan = buildBreakdownPlan(features); break;
    case 'mean_reversion_bounce':
    case 'volume_climax_reversal':
      plan = buildBouncePlan(features); break;
    case 'momentum_continuation':
      plan = buildMomentumPlan(features); break;
    case 'bullish_divergence':
      plan = buildDivergencePlan(features); break;
    case 'gap_continuation':
      plan = buildGapPlan(features); break;
    case 'range_breakout':
      plan = buildRangeBreakoutPlan(features); break;
    case 'ema_crossover':
      plan = buildEmaCrossoverPlan(features); break;
    case 'oversold_bounce':
      plan = buildOversoldBouncePlan(features); break;
    case 'overbought_reversal':
      plan = buildOverboughtReversalPlan(features); break;
    case 'weak_trend_breakdown':
      plan = buildWeakTrendBreakdownPlan(features); break;
    // Phase 4A — strategy-specific geometry. SELL plans reuse the
    // breakdown geometry; volatility squeeze reuses range-breakout
    // geometry (both expect an expansion above the prior structure).
    case 'failed_breakout_reversal':
      plan = buildFailedBreakoutReversalPlan(features); break;
    case 'bearish_pullback_rejection':
      plan = buildBearishPullbackRejectionPlan(features); break;
    case 'volatility_squeeze_breakout':
      plan = buildVolatilitySqueezePlan(features); break;
    // Phase 4B — intraday detectors return INSUFFICIENT_DATA so we
    // never actually reach trade-plan generation for them. We still
    // fall back to the generic builder defensively, with the entry-
    // type overwrite below stamping the correct intraday label.
    default:
      plan = buildTradePlan(features); break;
  }
  return { ...plan, entry: { ...plan.entry, type: entryFor(strategy) } };
}

function buildPullbackPlan(f: SignalFeatures): TradePlan {
  const close = f.trend.close;
  const atr = f.volatility.atr14;
  const entryZoneLow = round(f.trend.ema20);
  const entryZoneHigh = round(close);
  const stopLoss = round(Math.min(f.structure.recentSupport20, close - STOP_ATR_MULTIPLIER * atr));
  const risk = Math.max(close - stopLoss, atr * 0.5); // minimum risk = 0.5 ATR
  return {
    entry: { type: 'breakout_confirmation', zoneLow: entryZoneLow, zoneHigh: entryZoneHigh },
    stopLoss,
    targets: { target1: round(close + TARGET1_R_MULTIPLE * risk), target2: round(close + TARGET2_R_MULTIPLE * risk) },
    rewardRiskApprox: round(safeDivide(TARGET1_R_MULTIPLE * risk, risk), 1),
  };
}

function buildBreakdownPlan(f: SignalFeatures): TradePlan {
  const close = f.trend.close;
  const atr = f.volatility.atr14;
  const entryZoneLow = round(close);
  const entryZoneHigh = round(f.structure.recentSupport20);
  const stopLoss = round(Math.max(f.structure.recentResistance20, close + STOP_ATR_MULTIPLIER * atr));
  const risk = Math.max(stopLoss - close, atr * 0.5);
  return {
    entry: { type: 'breakout_confirmation', zoneLow: entryZoneLow, zoneHigh: entryZoneHigh },
    stopLoss,
    targets: { target1: round(close - TARGET1_R_MULTIPLE * risk), target2: round(close - TARGET2_R_MULTIPLE * risk) },
    rewardRiskApprox: round(safeDivide(TARGET1_R_MULTIPLE * risk, risk), 1),
  };
}

function buildBouncePlan(f: SignalFeatures): TradePlan {
  const close = f.trend.close;
  const atr = f.volatility.atr14;
  const entryZoneLow = round(f.structure.recentLow20);
  const entryZoneHigh = round(close);
  const stopLoss = round(f.structure.recentLow20 - 0.5 * atr);
  const risk = Math.max(close - stopLoss, atr * 0.5);
  return {
    entry: { type: 'breakout_confirmation', zoneLow: entryZoneLow, zoneHigh: entryZoneHigh },
    stopLoss,
    targets: { target1: round(close + TARGET1_R_MULTIPLE * risk), target2: round(close + TARGET2_R_MULTIPLE * risk) },
    rewardRiskApprox: round(safeDivide(TARGET1_R_MULTIPLE * risk, risk), 1),
  };
}

function buildMomentumPlan(f: SignalFeatures): TradePlan {
  const close = f.trend.close;
  const atr = f.volatility.atr14;
  // Entry zone: near current price, tight range
  const entryZoneLow = round(close - atr * 0.3);
  const entryZoneHigh = round(close);
  // Tighter stop for momentum (1.2x ATR below EMA20 or current price)
  const stopLoss = round(Math.max(f.trend.ema20 - atr * 0.5, close - 1.2 * atr));
  const risk = Math.max(close - stopLoss, atr * 0.5);
  return {
    entry: { type: 'breakout_confirmation', zoneLow: entryZoneLow, zoneHigh: entryZoneHigh },
    stopLoss,
    targets: { target1: round(close + 2.0 * risk), target2: round(close + 3.0 * risk) },
    rewardRiskApprox: round(safeDivide(2.0 * risk, risk), 1),
  };
}

function buildDivergencePlan(f: SignalFeatures): TradePlan {
  const close = f.trend.close;
  const atr = f.volatility.atr14;
  const entryZoneLow = round(f.structure.recentLow20);
  const entryZoneHigh = round(close + atr * 0.3);
  // Wider stop for divergence trades (below recent low)
  const stopLoss = round(f.structure.recentLow20 - 0.75 * atr);
  const risk = Math.max(close - stopLoss, atr * 0.5);
  return {
    entry: { type: 'breakout_confirmation', zoneLow: entryZoneLow, zoneHigh: entryZoneHigh },
    stopLoss,
    targets: { target1: round(close + TARGET1_R_MULTIPLE * risk), target2: round(close + TARGET2_R_MULTIPLE * risk) },
    rewardRiskApprox: round(safeDivide(TARGET1_R_MULTIPLE * risk, risk), 1),
  };
}

function buildGapPlan(f: SignalFeatures): TradePlan {
  const close = f.trend.close;
  const atr = f.volatility.atr14;
  // Entry zone: near the gap fill level to current
  const entryZoneLow = round(f.structure.recentResistance20);
  const entryZoneHigh = round(close);
  // Stop just below the gap level (previous close / resistance)
  const stopLoss = round(Math.min(f.structure.recentResistance20 - atr * 0.3, close - STOP_ATR_MULTIPLIER * atr));
  const risk = Math.max(close - stopLoss, atr * 0.5);
  return {
    entry: { type: 'breakout_confirmation', zoneLow: entryZoneLow, zoneHigh: entryZoneHigh },
    stopLoss,
    targets: { target1: round(close + 2.0 * risk), target2: round(close + 3.0 * risk) },
    rewardRiskApprox: round(safeDivide(2.0 * risk, risk), 1),
  };
}

function buildRangeBreakoutPlan(f: SignalFeatures): TradePlan {
  const close = f.trend.close;
  const atr = f.volatility.atr14;
  // Entry zone: breakout above range resistance
  const entryZoneLow = round(f.structure.recentResistance20);
  const entryZoneHigh = round(close);
  // Stop just below range resistance (now support)
  const stopLoss = round(Math.min(f.structure.recentResistance20 - atr * 0.3, close - STOP_ATR_MULTIPLIER * atr));
  const risk = Math.max(close - stopLoss, atr * 0.5);
  return {
    entry: { type: 'breakout_confirmation', zoneLow: entryZoneLow, zoneHigh: entryZoneHigh },
    stopLoss,
    targets: { target1: round(close + TARGET1_R_MULTIPLE * risk), target2: round(close + TARGET2_R_MULTIPLE * risk) },
    rewardRiskApprox: round(safeDivide(TARGET1_R_MULTIPLE * risk, risk), 1),
  };
}

function buildEmaCrossoverPlan(f: SignalFeatures): TradePlan {
  const close = f.trend.close;
  const atr = f.volatility.atr14;
  // Entry zone: near current price, tight range around EMA crossover
  const entryZoneLow = round(close - atr * 0.3);
  const entryZoneHigh = round(close);
  // Stop below EMA-21 (the slower EMA that was just crossed)
  const stopLoss = round(Math.max(f.trend.ema21 - atr * 0.5, close - 1.5 * atr));
  const risk = Math.max(close - stopLoss, atr * 0.5);
  return {
    entry: { type: 'breakout_confirmation', zoneLow: entryZoneLow, zoneHigh: entryZoneHigh },
    stopLoss,
    targets: { target1: round(close + 2.0 * risk), target2: round(close + 3.0 * risk) },
    rewardRiskApprox: round(safeDivide(2.0 * risk, risk), 1),
  };
}

function buildOversoldBouncePlan(f: SignalFeatures): TradePlan {
  const close = f.trend.close;
  const atr = f.volatility.atr14;
  // Entry zone: near support to current price
  const entryZoneLow = round(f.structure.recentLow20);
  const entryZoneHigh = round(close);
  // Stop below recent low with tight buffer
  const stopLoss = round(f.structure.recentLow20 - 0.5 * atr);
  const risk = Math.max(close - stopLoss, atr * 0.5);
  return {
    entry: { type: 'breakout_confirmation', zoneLow: entryZoneLow, zoneHigh: entryZoneHigh },
    stopLoss,
    targets: { target1: round(close + TARGET1_R_MULTIPLE * risk), target2: round(close + TARGET2_R_MULTIPLE * risk) },
    rewardRiskApprox: round(safeDivide(TARGET1_R_MULTIPLE * risk, risk), 1),
  };
}

// ── Overbought Reversal (SELL) ──────────────────────────────
// Mirror of buildOversoldBouncePlan — short at resistance, stop
// above recent high with a buffer, targets below (downward). Risk
// and reward distances are computed from the SHORT direction so
// all numeric signs flip.
function buildOverboughtReversalPlan(f: SignalFeatures): TradePlan {
  const close = f.trend.close;
  const atr   = f.volatility.atr14;
  // Entry zone: from current price UP to recent resistance. For
  // SELL, entryHigh > entryLow still — the zone represents the
  // band where a short fill is acceptable.
  const entryZoneLow  = round(close);
  const entryZoneHigh = round(f.structure.recentResistance20);
  // Stop above recent high + 0.5 ATR buffer (short-side stop).
  const stopLoss = round(f.structure.recentResistance20 + 0.5 * atr);
  const risk     = Math.max(stopLoss - close, atr * 0.5);
  return {
    entry: { type: 'breakout_confirmation', zoneLow: entryZoneLow, zoneHigh: entryZoneHigh },
    stopLoss,
    // Targets DOWNWARD (close - k*risk) — this is a SELL plan.
    targets: {
      target1: round(close - TARGET1_R_MULTIPLE * risk),
      target2: round(close - TARGET2_R_MULTIPLE * risk),
    },
    rewardRiskApprox: round(safeDivide(TARGET1_R_MULTIPLE * risk, risk), 1),
  };
}

// ── Weak Trend Breakdown (SELL) ─────────────────────────────
// Short-entry near current price (price is already in the lower
// half of the 20-day range per the strategy's match criteria).
// Stop at recent 20-day high — wider than bearish_breakdown's
// stop because we're not relying on a fresh support break as the
// technical anchor. Targets step down toward the recent low.
function buildWeakTrendBreakdownPlan(f: SignalFeatures): TradePlan {
  const close = f.trend.close;
  const atr   = f.volatility.atr14;
  const entryZoneLow  = round(close - atr * 0.3);
  const entryZoneHigh = round(close);
  // Stop at recent high + 0.5 ATR (room for noise above; won't
  // stop out on a dead-cat bounce to the 20-EMA).
  const stopLoss = round(Math.max(
    f.structure.recentResistance20 + 0.5 * atr,
    close + STOP_ATR_MULTIPLIER * atr,
  ));
  const risk = Math.max(stopLoss - close, atr * 0.5);
  return {
    entry: { type: 'breakout_confirmation', zoneLow: entryZoneLow, zoneHigh: entryZoneHigh },
    stopLoss,
    targets: {
      target1: round(close - TARGET1_R_MULTIPLE * risk),
      target2: round(close - TARGET2_R_MULTIPLE * risk),
    },
    rewardRiskApprox: round(safeDivide(TARGET1_R_MULTIPLE * risk, risk), 1),
  };
}

// ── Phase 4A trade-plan helpers ───────────────────────────────

// Failed Breakout Reversal — SELL. Entry near current close, stop
// above the failed breakout level (recentHigh20) plus ATR cushion.
function buildFailedBreakoutReversalPlan(f: SignalFeatures): TradePlan {
  const close = f.trend.close;
  const atr   = f.volatility.atr14;
  const entryZoneLow  = round(close - atr * 0.3);
  const entryZoneHigh = round(close);
  // Stop above the rejected high — trap reversals fail when the
  // breakout level holds on a second attempt.
  const stopLoss = round(Math.max(f.structure.recentHigh20 + 0.5 * atr, close + STOP_ATR_MULTIPLIER * atr));
  const risk = Math.max(stopLoss - close, atr * 0.5);
  return {
    entry: { type: 'breakout_confirmation', zoneLow: entryZoneLow, zoneHigh: entryZoneHigh },
    stopLoss,
    targets: {
      target1: round(close - TARGET1_R_MULTIPLE * risk),
      target2: round(close - TARGET2_R_MULTIPLE * risk),
    },
    rewardRiskApprox: round(safeDivide(TARGET1_R_MULTIPLE * risk, risk), 1),
  };
}

// Bearish Pullback Rejection — SELL into a rallied resistance.
function buildBearishPullbackRejectionPlan(f: SignalFeatures): TradePlan {
  const close = f.trend.close;
  const atr   = f.volatility.atr14;
  const entryZoneLow  = round(close - atr * 0.2);
  const entryZoneHigh = round(close);
  const stopLoss = round(Math.max(f.structure.recentHigh20 + 0.4 * atr, f.trend.ema20 + 0.3 * atr));
  const risk = Math.max(stopLoss - close, atr * 0.5);
  return {
    entry: { type: 'breakout_confirmation', zoneLow: entryZoneLow, zoneHigh: entryZoneHigh },
    stopLoss,
    targets: {
      target1: round(close - TARGET1_R_MULTIPLE * risk),
      target2: round(close - TARGET2_R_MULTIPLE * risk),
    },
    rewardRiskApprox: round(safeDivide(TARGET1_R_MULTIPLE * risk, risk), 1),
  };
}

// Volatility Squeeze Breakout — LONG. Entry near close after the
// expansion, stop below the lower Bollinger band (or ATR floor).
function buildVolatilitySqueezePlan(f: SignalFeatures): TradePlan {
  const close = f.trend.close;
  const atr   = f.volatility.atr14;
  const entryZoneLow  = round(f.volatility.bollingerUpper);
  const entryZoneHigh = round(close + atr * 0.2);
  const stopLoss = round(Math.min(
    f.volatility.bollingerLower,
    close - STOP_ATR_MULTIPLIER * atr,
  ));
  const risk = Math.max(close - stopLoss, atr * 0.5);
  return {
    entry: { type: 'breakout_confirmation', zoneLow: entryZoneLow, zoneHigh: entryZoneHigh },
    stopLoss,
    targets: {
      target1: round(close + TARGET1_R_MULTIPLE * risk),
      target2: round(close + TARGET2_R_MULTIPLE * risk),
    },
    rewardRiskApprox: round(safeDivide(TARGET1_R_MULTIPLE * risk, risk), 1),
  };
}

export function buildTradePlan(features: SignalFeatures): TradePlan {
  const { trend, volatility, structure } = features;
  const close = trend.close;
  const atr = volatility.atr14;

  // Entry zone: band around the breakout level
  const entryZoneLow = round(structure.recentResistance20);
  const entryZoneHigh = round(close + atr * 0.2); // slight buffer above

  // Stop loss: lower of (recent support, close - 1.5 * ATR)
  const atrStop = close - STOP_ATR_MULTIPLIER * atr;
  const stopLoss = round(Math.min(structure.recentSupport20, atrStop));

  // Risk per share (minimum = 0.5 ATR to prevent near-zero risk)
  const riskPerShare = Math.max(close - stopLoss, atr * 0.5);

  // Targets based on R multiples
  const target1 = round(close + TARGET1_R_MULTIPLE * riskPerShare);
  const target2 = round(close + TARGET2_R_MULTIPLE * riskPerShare);

  // Reward/Risk ratio
  const rewardRiskApprox = round(safeDivide(target1 - close, riskPerShare), 1);

  return {
    entry: {
      type: 'breakout_confirmation',
      zoneLow: entryZoneLow,
      zoneHigh: entryZoneHigh,
    },
    stopLoss,
    targets: { target1, target2 },
    rewardRiskApprox,
  };
}
