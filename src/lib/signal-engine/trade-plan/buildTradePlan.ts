// ════════════════════════════════════════════════════════════════
//  Trade Plan Builder — Phase 1 + Phase 2 + Phase 3
// ════════════════════════════════════════════════════════════════

import type { SignalFeatures, TradePlan, StrategyName } from '../types/signalEngine.types';
import { BEARISH_STRATEGIES } from '../types/signalEngine.types';
import type { Phase3TradePlan, Phase3EntryType } from '../types/phase3.types';
import { round, safeDivide } from '../utils/math';
import { STOP_ATR_MULTIPLIER, TARGET1_R_MULTIPLE, TARGET2_R_MULTIPLE } from '../constants/signalEngine.constants';

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
};

// ── Phase 3 entry type mapping ─────────────────────────────
const ENTRY_TYPE_MAP: Record<StrategyName, Phase3EntryType> = {
  bullish_breakout:       'breakout_confirmation',
  bullish_pullback:       'pullback_retest',
  bearish_breakdown:      'momentum_followthrough',
  mean_reversion_bounce:  'mean_reversion_confirmation',
  momentum_continuation:  'momentum_followthrough',
  bullish_divergence:     'mean_reversion_confirmation',
  volume_climax_reversal: 'mean_reversion_confirmation',
  gap_continuation:       'breakout_confirmation',
  range_breakout:         'breakout_confirmation',
  ema_crossover:          'momentum_followthrough',
  oversold_bounce:        'mean_reversion_confirmation',
  overbought_reversal:    'mean_reversion_confirmation',
  weak_trend_breakdown:   'momentum_followthrough',
};

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
    entryType: ENTRY_TYPE_MAP[strategy] ?? 'breakout_confirmation',
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
  switch (strategy) {
    case 'bullish_pullback':
      return buildPullbackPlan(features);
    case 'bearish_breakdown':
      return buildBreakdownPlan(features);
    case 'mean_reversion_bounce':
    case 'volume_climax_reversal':
      return buildBouncePlan(features);
    case 'momentum_continuation':
      return buildMomentumPlan(features);
    case 'bullish_divergence':
      return buildDivergencePlan(features);
    case 'gap_continuation':
      return buildGapPlan(features);
    case 'range_breakout':
      return buildRangeBreakoutPlan(features);
    case 'ema_crossover':
      return buildEmaCrossoverPlan(features);
    case 'oversold_bounce':
      return buildOversoldBouncePlan(features);
    case 'overbought_reversal':
      return buildOverboughtReversalPlan(features);
    case 'weak_trend_breakdown':
      return buildWeakTrendBreakdownPlan(features);
    default:
      return buildTradePlan(features);
  }
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
