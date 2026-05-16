// ════════════════════════════════════════════════════════════════
//  Walk-Forward Testing — Future Extension Hook
//
//  Walk-forward splits the date range into rolling windows:
//  - In-sample (IS): train/optimize on this period
//  - Out-of-sample (OOS): validate on the next period
//  - Roll forward and repeat
//
//  This prevents overfitting by ensuring every evaluation uses
//  data the model hasn't "seen" during calibration.
// ════════════════════════════════════════════════════════════════

import type { BacktestRunConfig } from '../types';
import { runBacktest, type BacktestRunResult } from './backtestRunner';
import { persistFullRun } from './runOrchestrator';

export interface WalkForwardConfig {
  /** Base config (universe, capital, etc.) */
  baseConfig: BacktestRunConfig;
  /** Total date range start */
  startDate: string;
  /** Total date range end */
  endDate: string;
  /** In-sample window size in trading days */
  inSampleDays: number;
  /** Out-of-sample window size in trading days */
  outOfSampleDays: number;
  /** Step size (how many days to advance each fold) */
  stepDays: number;
}

export interface WalkForwardFold {
  foldIndex: number;
  isStartDate: string;
  isEndDate: string;
  oosStartDate: string;
  oosEndDate: string;
  oosResult: BacktestRunResult | null;
}

export interface WalkForwardResult {
  config: WalkForwardConfig;
  folds: WalkForwardFold[];
  aggregateOosWinRate: number;
  aggregateOosReturn: number;
  aggregateOosSharpe: number;
  totalOosTrades: number;
  consistencyScore: number;
  startedAt: string;
  completedAt: string;
}

/**
 * Generate walk-forward date folds from the config.
 * Each fold defines an in-sample and out-of-sample window.
 */
export function generateWalkForwardFolds(config: WalkForwardConfig): Array<{
  isStart: string; isEnd: string; oosStart: string; oosEnd: string;
}> {
  const folds: Array<{ isStart: string; isEnd: string; oosStart: string; oosEnd: string }> = [];

  // Convert to dates and step through
  let cursor = new Date(config.startDate);
  const end = new Date(config.endDate);

  while (true) {
    const isStart = cursor.toISOString().split('T')[0];
    const isEnd = new Date(cursor.getTime() + config.inSampleDays * 86400000).toISOString().split('T')[0];
    const oosStart = new Date(new Date(isEnd).getTime() + 86400000).toISOString().split('T')[0];
    const oosEnd = new Date(new Date(oosStart).getTime() + config.outOfSampleDays * 86400000).toISOString().split('T')[0];

    if (new Date(oosEnd) > end) break;

    folds.push({ isStart, isEnd, oosStart, oosEnd });
    cursor = new Date(cursor.getTime() + config.stepDays * 86400000);
  }

  return folds;
}

/**
 * Run a full walk-forward test.
 * For each fold, runs a backtest on the OOS window.
 * (IS window used for calibration in future versions.)
 */
export async function runWalkForward(config: WalkForwardConfig): Promise<WalkForwardResult> {
  const startedAt = new Date().toISOString();
  const dateFolds = generateWalkForwardFolds(config);
  const folds: WalkForwardFold[] = [];

  console.log(`[WalkForward] ${dateFolds.length} folds, IS=${config.inSampleDays}d, OOS=${config.outOfSampleDays}d`);

  let totalWins = 0, totalTrades = 0, totalReturn = 0;
  const sharpes: number[] = [];

  for (let i = 0; i < dateFolds.length; i++) {
    const df = dateFolds[i];
    console.log(`[WalkForward] Fold ${i + 1}/${dateFolds.length}: OOS ${df.oosStart} → ${df.oosEnd}`);

    const oosConfig: BacktestRunConfig = {
      ...config.baseConfig,
      name: `WF Fold ${i + 1} OOS`,
      startDate: df.oosStart,
      endDate: df.oosEnd,
    };

    let oosResult: BacktestRunResult | null = null;
    try {
      oosResult = await runBacktest(oosConfig);
      try { await persistFullRun(oosResult); } catch {}

      totalTrades += oosResult.tradeCount;
      totalWins += oosResult.summary?.totalWins ?? 0;
      totalReturn += oosResult.summary?.totalReturnPct ?? 0;
      if (oosResult.summary?.sharpeRatio) sharpes.push(oosResult.summary.sharpeRatio);
    } catch (err) {
      console.error(`[WalkForward] Fold ${i + 1} failed:`, err);
    }

    folds.push({
      foldIndex: i,
      isStartDate: df.isStart, isEndDate: df.isEnd,
      oosStartDate: df.oosStart, oosEndDate: df.oosEnd,
      oosResult,
    });
  }

  // Consistency: % of folds that were profitable
  const profitableFolds = folds.filter(f => f.oosResult && (f.oosResult.summary?.totalReturnPct ?? 0) > 0).length;
  const consistencyScore = folds.length > 0 ? Math.round((profitableFolds / folds.length) * 100) : 0;

  return {
    config,
    folds,
    aggregateOosWinRate: totalTrades > 0 ? Math.round((totalWins / totalTrades) * 100) / 100 : 0,
    aggregateOosReturn: Math.round(totalReturn * 100) / 100,
    aggregateOosSharpe: sharpes.length > 0 ? Math.round((sharpes.reduce((s, v) => s + v, 0) / sharpes.length) * 100) / 100 : 0,
    totalOosTrades: totalTrades,
    consistencyScore,
    startedAt,
    completedAt: new Date().toISOString(),
  };
}
