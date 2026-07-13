// ════════════════════════════════════════════════════════════════
//  Phase 2 — Trade Plan Enhancements
//
//  Round-price awareness, structure/ATR stop refinement.
//  Does not change strategy-specific geometry — post-processes plans.
// ════════════════════════════════════════════════════════════════

import type { SignalFeatures, TradePlan, StrategyName } from '../types/signalEngine.types';
import type { Phase3TradePlan } from '../types/phase3.types';
import { round } from '../utils/math';
import { getSignalEngineConfig } from '../config/signalEnginePhase2Config';
import { getStrategyEntryType } from '../strategies/strategyRegistry';

/**
 * NSE-aware tick rounding. Higher-priced stocks use coarser ticks.
 */
export function roundToIndianTick(price: number): number {
  if (!Number.isFinite(price) || price <= 0) return price;
  if (price >= 10_000) return round(Math.round(price), 0);
  if (price >= 1_000) return round(Math.round(price * 2) / 2, 2);
  if (price >= 100) return round(Math.round(price * 20) / 20, 2);
  return round(Math.round(price * 100) / 100, 2);
}

function roundPlanPrices(plan: TradePlan): TradePlan {
  return {
    ...plan,
    entry: {
      ...plan.entry,
      zoneLow: roundToIndianTick(plan.entry.zoneLow),
      zoneHigh: roundToIndianTick(plan.entry.zoneHigh),
    },
    stopLoss: roundToIndianTick(plan.stopLoss),
    targets: {
      target1: roundToIndianTick(plan.targets.target1),
      target2: roundToIndianTick(plan.targets.target2),
    },
  };
}

/**
 * Tighten stop using structure + ATR buffer when it improves risk geometry.
 */
function refineStopLoss(
  features: SignalFeatures,
  plan: TradePlan,
  isShort: boolean,
): number {
  const config = getSignalEngineConfig();
  const atr = features.volatility.atr14;
  const buffer = config.tradePlan.structureStopBufferAtr * atr;
  const close = features.trend.close;

  if (isShort) {
    const structStop = features.structure.recentResistance20 + buffer;
    const candidate = Math.min(plan.stopLoss, structStop);
    const risk = candidate - close;
    const minRisk = atr * config.tradePlan.minStopAtrMultiple;
    const maxRisk = atr * config.tradePlan.maxStopAtrMultiple;
    if (risk >= minRisk && risk <= maxRisk) return roundToIndianTick(candidate);
  } else {
    const structStop = features.structure.recentSupport20 - buffer;
    const candidate = Math.max(plan.stopLoss, structStop);
    const risk = close - candidate;
    const minRisk = atr * config.tradePlan.minStopAtrMultiple;
    const maxRisk = atr * config.tradePlan.maxStopAtrMultiple;
    if (risk >= minRisk && risk <= maxRisk) return roundToIndianTick(candidate);
  }

  return plan.stopLoss;
}

/** Post-process a Phase 1 trade plan with Phase 2 enhancements. */
export function enhanceTradePlan(
  plan: TradePlan,
  features: SignalFeatures,
  strategy: StrategyName,
  isShort: boolean,
): TradePlan {
  const config = getSignalEngineConfig();
  if (config.version < 2) return plan;

  let enhanced = { ...plan };
  enhanced.stopLoss = refineStopLoss(features, enhanced, isShort);

  if (config.tradePlan.roundPrices) {
    enhanced = roundPlanPrices(enhanced);
  }

  const entryRef = enhanced.entry.zoneHigh;
  const risk = Math.abs(entryRef - enhanced.stopLoss);
  if (risk > 0) {
    enhanced.rewardRiskApprox = round(
      Math.abs(enhanced.targets.target1 - entryRef) / risk,
      1,
    );
  }

  return enhanced;
}

/** Apply enhancements to a Phase 3 trade plan. */
export function enhancePhase3TradePlan(
  plan: Phase3TradePlan,
  features: SignalFeatures,
  strategy: StrategyName,
  isShort: boolean,
): Phase3TradePlan {
  const base: TradePlan = {
    entry: { type: getStrategyEntryType(strategy), zoneLow: plan.entryZoneLow, zoneHigh: plan.entryZoneHigh },
    stopLoss: plan.stopLoss,
    targets: { target1: plan.target1, target2: plan.target2 },
    rewardRiskApprox: plan.rrTarget1,
  };

  const enhanced = enhanceTradePlan(base, features, strategy, isShort);
  const entryRef = enhanced.entry.zoneHigh;
  const risk = Math.abs(entryRef - enhanced.stopLoss);

  return {
    ...plan,
    entryZoneLow: enhanced.entry.zoneLow,
    entryZoneHigh: enhanced.entry.zoneHigh,
    stopLoss: enhanced.stopLoss,
    target1: enhanced.targets.target1,
    target2: enhanced.targets.target2,
    initialRiskPerUnit: round(risk),
    rrTarget1: enhanced.rewardRiskApprox,
    rrTarget2: risk > 0 ? round(Math.abs(plan.target2 - entryRef) / risk, 1) : plan.rrTarget2,
    rrTarget3: risk > 0 ? round(Math.abs(plan.target3 - entryRef) / risk, 1) : plan.rrTarget3,
  };
}

/** Document trade-plan calculation for explainability. */
export function describeTradePlanCalculation(
  plan: TradePlan,
  features: SignalFeatures,
): string[] {
  const atr = features.volatility.atr14;
  const entryRef = plan.entry.zoneHigh;
  const risk = Math.abs(entryRef - plan.stopLoss);
  return [
    `Entry zone ${plan.entry.zoneLow}–${plan.entry.zoneHigh} (${plan.entry.type})`,
    `Stop ${plan.stopLoss} — ${risk > 0 ? (risk / atr).toFixed(2) : 'n/a'}× ATR from entry`,
    `Target 1 ${plan.targets.target1} (${plan.rewardRiskApprox}R)`,
    `Target 2 ${plan.targets.target2}`,
    `ATR(14) ${round(atr)} (${features.volatility.atrPct.toFixed(2)}% of price)`,
    `Structure support ${features.structure.recentSupport20}, resistance ${features.structure.recentResistance20}`,
  ];
}
