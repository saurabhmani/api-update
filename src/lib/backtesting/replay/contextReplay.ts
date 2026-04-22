// ════════════════════════════════════════════════════════════════
//  Context Replay — Market Regime & RS at Each Replay Step
//
//  Captures the market environment at each point in the backtest
//  using the same logic as production (detectMarketRegime).
// ════════════════════════════════════════════════════════════════

import type { Candle, MarketRegimeLabel } from '../../signal-engine/types/signalEngine.types';
import type { CandleProvider } from '../../signal-engine/pipeline/generatePhase1Signals';
import { detectMarketRegime, detectEnhancedRegime } from '../../signal-engine/regime/detectMarketRegime';
import { computeRelativeStrength } from '../../signal-engine/context/relativeStrength';
import type { ReplayContext, OpenPosition, PendingSignal } from '../types';

export interface ReplayContextSnapshot {
  date: string;
  regime: MarketRegimeLabel;
  regimeStrength: number;
  volatilityState: string;
  trendSlope: number;
}

/**
 * Capture market context at a specific replay date.
 * Uses the benchmark candles up to that date only (no lookahead).
 */
export async function captureReplayContext(
  provider: CandleProvider,
  benchmarkSymbol: string,
): Promise<ReplayContextSnapshot | null> {
  try {
    const candles = await provider.fetchDailyCandles(benchmarkSymbol);
    if (candles.length < 50) return null;

    const enhanced = detectEnhancedRegime(candles);
    const lastCandle = candles[candles.length - 1];

    return {
      date: lastCandle.ts.split('T')[0],
      regime: enhanced.label,
      regimeStrength: enhanced.strength,
      volatilityState: enhanced.volatilityRegime,
      trendSlope: enhanced.trendSlope,
    };
  } catch {
    return null;
  }
}

/**
 * Compute relative strength of a stock vs benchmark at a given replay date.
 */
export async function captureRelativeStrength(
  provider: CandleProvider,
  symbol: string,
  benchmarkSymbol: string,
): Promise<{ rsVsIndex: number; sectorStrengthScore: number } | null> {
  try {
    const stockCandles = await provider.fetchDailyCandles(symbol);
    const benchCandles = await provider.fetchDailyCandles(benchmarkSymbol);
    if (stockCandles.length < 10 || benchCandles.length < 10) return null;

    const rs = computeRelativeStrength(stockCandles, benchCandles);
    return { rsVsIndex: rs.rsVsIndex, sectorStrengthScore: rs.sectorStrengthScore };
  } catch {
    return null;
  }
}

/**
 * Build a full ReplayContext snapshot for the current simulation state.
 */
export function buildReplayContext(
  currentDate: string,
  barIndex: number,
  totalBars: number,
  equity: number,
  cash: number,
  peakEquity: number,
  openPositions: OpenPosition[],
  pendingSignals: PendingSignal[],
  regime: MarketRegimeLabel | null,
  todaySignals: number,
  todayClosedTrades: number,
  totalSignals: number,
  totalTrades: number,
): ReplayContext {
  const currentDrawdownPct = peakEquity > 0
    ? ((peakEquity - equity) / peakEquity) * 100
    : 0;

  return {
    currentDate,
    barIndex,
    totalBars,
    equity,
    cash,
    peakEquity,
    currentDrawdownPct: Math.round(currentDrawdownPct * 100) / 100,
    openPositions,
    pendingSignals,
    currentRegime: regime,
    todaySignalCount: todaySignals,
    todayTradesClosedCount: todayClosedTrades,
    totalSignalsGenerated: totalSignals,
    totalTradesTaken: totalTrades,
  };
}
