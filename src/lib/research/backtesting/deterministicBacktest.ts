// ════════════════════════════════════════════════════════════════
//  Phase 7 — Deterministic Research Backtesting
//  Parallel environment — does not call production pipeline.
// ════════════════════════════════════════════════════════════════

import type { ResearchCandle, ResearchTrade, BenchmarkMetrics } from '../types';
import type { ExperimentalSignal } from '../strategies/experimentalStrategies';
import { computeBenchmarkMetrics } from '../benchmarks/benchmarkFramework';

export interface ResearchBacktestConfig {
  symbol: string;
  strategyId: string;
  initialCapital: number;
  riskPerTradePct: number;
  slippageBps: number;
  commissionPerTrade: number;
  evaluationHorizon: number;
  randomSeed: number;
  regime?: string;
}

export interface ResearchBacktestResult {
  config: ResearchBacktestConfig;
  trades: ResearchTrade[];
  equityCurve: number[];
  metrics: BenchmarkMetrics;
  deterministic: true;
}

function applySlippage(price: number, direction: 'long' | 'short', bps: number): number {
  const f = bps / 10_000;
  return direction === 'long' ? price * (1 + f) : price * (1 - f);
}

export function runDeterministicBacktest(
  candles: ResearchCandle[],
  signals: ExperimentalSignal[],
  config: ResearchBacktestConfig,
): ResearchBacktestResult {
  const trades: ResearchTrade[] = [];
  let equity = config.initialCapital;
  const equityCurve = [equity];

  for (const signal of signals) {
    if (signal.direction === 'flat') continue;
    const entryIdx = signal.barIndex;
    const exitIdx = Math.min(candles.length - 1, entryIdx + config.evaluationHorizon);
    if (exitIdx <= entryIdx) continue;

    const entryRaw = candles[entryIdx].close;
    const exitRaw = candles[exitIdx].close;
    const direction = signal.direction;
    const entryPrice = applySlippage(entryRaw, direction, config.slippageBps);
    const exitPrice = applySlippage(exitRaw, direction === 'long' ? 'short' : 'long', config.slippageBps);
    const returnPct = direction === 'long'
      ? ((exitPrice - entryPrice) / entryPrice) * 100
      : ((entryPrice - exitPrice) / entryPrice) * 100;
    const fees = config.commissionPerTrade * 2;
    const slippage = Math.abs(entryPrice - entryRaw) + Math.abs(exitPrice - exitRaw);

    trades.push({
      symbol: config.symbol,
      strategyId: config.strategyId,
      entryPrice,
      exitPrice,
      entryBar: entryIdx,
      exitBar: exitIdx,
      returnPct: Math.round((returnPct - (fees / config.initialCapital) * 100) * 100) / 100,
      fees,
      slippage,
      exitReason: returnPct >= 0 ? 'target' : 'stop',
    });
    equity *= 1 + (returnPct / 100);
    equityCurve.push(Math.round(equity * 100) / 100);
  }

  const metrics = computeBenchmarkMetrics(trades, equityCurve);
  return { config, trades, equityCurve, metrics, deterministic: true };
}

export interface WalkForwardFold {
  foldIndex: number;
  isStart: number;
  isEnd: number;
  oosStart: number;
  oosEnd: number;
  metrics: BenchmarkMetrics;
}

export function runWalkForwardResearch(
  candles: ResearchCandle[],
  signals: ExperimentalSignal[],
  config: ResearchBacktestConfig,
  foldSize = 40,
  step = 20,
): WalkForwardFold[] {
  const folds: WalkForwardFold[] = [];
  let foldIndex = 0;
  for (let start = 0; start + foldSize < candles.length; start += step) {
    const oosStart = start + Math.floor(foldSize * 0.7);
    const oosEnd = Math.min(candles.length - 1, start + foldSize);
    const oosSignals = signals.filter((s) => s.barIndex >= oosStart && s.barIndex < oosEnd);
    const slice = candles.slice(oosStart, oosEnd + 1);
    const result = runDeterministicBacktest(slice, oosSignals, { ...config, randomSeed: config.randomSeed + foldIndex });
    folds.push({
      foldIndex,
      isStart: start,
      isEnd: oosStart,
      oosStart,
      oosEnd,
      metrics: result.metrics,
    });
    foldIndex += 1;
  }
  return folds;
}

export function runCrossValidation(
  candles: ResearchCandle[],
  signals: ExperimentalSignal[],
  config: ResearchBacktestConfig,
  folds = 3,
): BenchmarkMetrics[] {
  const chunk = Math.floor(candles.length / folds);
  const results: BenchmarkMetrics[] = [];
  for (let f = 0; f < folds; f += 1) {
    const start = f * chunk;
    const end = f === folds - 1 ? candles.length : (f + 1) * chunk;
    const slice = candles.slice(start, end);
    const foldSignals = signals.filter((s) => s.barIndex >= start && s.barIndex < end);
    const bt = runDeterministicBacktest(slice, foldSignals, { ...config, randomSeed: config.randomSeed + f });
    results.push(bt.metrics);
  }
  return results;
}
