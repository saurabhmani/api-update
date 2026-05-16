// ════════════════════════════════════════════════════════════════
//  Signal Replay Adapter
//
//  Calls the REAL signal engine with historical candle data.
//  This is NOT a fake backtest-only strategy — it uses the exact
//  same code path that runs in production (generatePhase1Signals).
// ════════════════════════════════════════════════════════════════

import type { QuantSignal, StrategyName } from '../../signal-engine/types/signalEngine.types';
import type { CandleProvider } from '../../signal-engine/pipeline/generatePhase1Signals';
import { generatePhase1Signals } from '../../signal-engine/pipeline/generatePhase1Signals';
import type { BacktestRunConfig, SimulatedSignal, TradeDirection } from '../types';
import { getSector } from '../../signal-engine/constants/phase3.constants';

/**
 * Generate signals using the REAL signal engine for a given replay date.
 *
 * This adapter:
 * 1. Calls the production signal engine with a historical CandleProvider
 * 2. Converts QuantSignal[] → SimulatedSignal[]
 * 3. Applies backtest-specific filters (strategies, confidence, R:R)
 * 4. Returns only signals that pass all filters
 */
export async function replaySignals(
  provider: CandleProvider,
  config: BacktestRunConfig,
  date: string,
  barIndex: number,
): Promise<{ signals: SimulatedSignal[]; regime: string; generated: number; filtered: number }> {
  const p1Config = {
    universe: config.universe,
    benchmarkSymbol: config.benchmarkSymbol,
    timeframe: 'daily' as const,
    minCandleCount: Math.min(config.warmupBars, 220),
    breakoutBuffer: 1.002,
    minAvgVolume: 100_000,
    minPrice: 50,
    minConfidenceToSave: config.minConfidence,
  };

  let result;
  try {
    result = await generatePhase1Signals(provider, p1Config);
  } catch (err: any) {
    console.error(`[signalReplay] generatePhase1Signals threw at bar ${barIndex} (${date}):`, err?.message ?? err);
    return { signals: [], regime: 'Sideways', generated: 0, filtered: 0 };
  }

  const regime = result.regime.label;
  const generated = result.signals.length;
  let filtered = 0;

  const simulatedSignals: SimulatedSignal[] = [];

  for (const sig of result.signals) {
    const strategy = sig.signalType as StrategyName;

    // Filter: strategies whitelist
    if (config.strategies && !config.strategies.includes(strategy)) {
      filtered++;
      continue;
    }

    // Filter: minimum R:R
    if (sig.rewardRiskApprox < config.minRewardRisk) {
      filtered++;
      continue;
    }

    // Filter: stop width
    const stopWidth = sig.entry.zoneHigh > 0
      ? (Math.abs(sig.entry.zoneHigh - sig.stopLoss) / sig.entry.zoneHigh) * 100
      : 0;
    if (stopWidth > config.maxStopWidthPct) {
      filtered++;
      continue;
    }

    const riskPerUnit = Math.abs(sig.entry.zoneHigh - sig.stopLoss);
    const isShort = strategy === 'bearish_breakdown';
    const t3 = isShort
      ? sig.entry.zoneHigh - 3.5 * riskPerUnit
      : sig.entry.zoneHigh + 3.5 * riskPerUnit;

    simulatedSignals.push({
      signalId: `bt-${barIndex}-${sig.symbol}`,
      symbol: sig.symbol,
      date,
      barIndex,
      direction: (isShort ? 'short' : 'long') as TradeDirection,
      strategy,
      regime: sig.marketRegime,
      confidenceScore: sig.confidenceScore,
      confidenceBand: sig.confidenceBand,
      riskScore: sig.riskScore,
      sector: getSector(sig.symbol),
      entryZoneLow: sig.entry.zoneLow,
      entryZoneHigh: sig.entry.zoneHigh,
      stopLoss: sig.stopLoss,
      target1: sig.targets.target1,
      target2: sig.targets.target2,
      target3: Math.round(t3 * 100) / 100,
      riskPerUnit,
      rewardRiskApprox: sig.rewardRiskApprox,
      reasons: sig.reasons,
      warnings: sig.warnings,
      status: 'pending',
      barsWaited: 0,
      expiryDate: null,
      featuresSnapshot: sig.features,
      confidenceBreakdown: sig.confidenceBreakdown,
    });
  }

  return { signals: simulatedSignals, regime, generated, filtered };
}

/**
 * Convert a SimulatedSignal to a PendingSignal for the trade simulator.
 */
export function toPendingSignal(sig: SimulatedSignal): import('../types').PendingSignal {
  return {
    signalId: sig.signalId,
    symbol: sig.symbol,
    direction: sig.direction,
    strategy: sig.strategy,
    regime: sig.regime,
    confidenceScore: sig.confidenceScore,
    confidenceBand: sig.confidenceBand,
    sector: sig.sector,
    entryZoneLow: sig.entryZoneLow,
    entryZoneHigh: sig.entryZoneHigh,
    stopLoss: sig.stopLoss,
    target1: sig.target1,
    target2: sig.target2,
    target3: sig.target3,
    riskPerUnit: sig.riskPerUnit,
    signalDate: sig.date,
    signalBarIndex: sig.barIndex,
    barsWaited: 0,
  };
}
