// ════════════════════════════════════════════════════════════════
//  Batch Backtest Runner
//
//  Runs multiple backtests sequentially with different configs.
//  Useful for parameter sweeps, strategy comparisons, and
//  date-range sensitivity analysis.
// ════════════════════════════════════════════════════════════════

import type { BacktestRunConfig, BacktestRunRecord } from '../types';
import { runBacktest, type BacktestRunResult } from './backtestRunner';
import { persistFullRun } from './runOrchestrator';

export interface BatchConfig {
  batchId: string;
  name: string;
  configs: BacktestRunConfig[];
  /** Run in parallel (limited by concurrency) or sequential */
  sequential: boolean;
}

export interface BatchResult {
  batchId: string;
  name: string;
  totalRuns: number;
  completed: number;
  failed: number;
  results: Array<{
    runId: string;
    name: string;
    status: string;
    winRate: number;
    totalReturn: number;
    sharpe: number;
    trades: number;
    error: string | null;
  }>;
  bestRun: string | null;
  startedAt: string;
  completedAt: string;
}

/**
 * Run multiple backtests in sequence.
 * Persists each run independently. Returns comparison summary.
 */
export async function runBatchBacktests(batch: BatchConfig): Promise<BatchResult> {
  const startedAt = new Date().toISOString();
  const results: BatchResult['results'] = [];
  let bestSharpe = -Infinity;
  let bestRunId: string | null = null;

  console.log(`[Batch] Starting "${batch.name}" with ${batch.configs.length} runs`);

  for (let i = 0; i < batch.configs.length; i++) {
    const config = batch.configs[i];
    const label = config.name || `Run ${i + 1}`;
    console.log(`[Batch] Running ${i + 1}/${batch.configs.length}: ${label}`);

    try {
      const result = await runBacktest(config);

      // Persist
      try { await persistFullRun(result); } catch (e) {
        console.error(`[Batch] Persist failed for ${result.runId}:`, e);
      }

      const sharpe = result.summary?.sharpeRatio ?? 0;
      if (sharpe > bestSharpe) { bestSharpe = sharpe; bestRunId = result.runId; }

      results.push({
        runId: result.runId,
        name: label,
        status: result.status,
        winRate: result.summary?.winRate ?? 0,
        totalReturn: result.summary?.totalReturnPct ?? 0,
        sharpe,
        trades: result.tradeCount,
        error: result.error,
      });
    } catch (err) {
      results.push({
        runId: '', name: label, status: 'failed',
        winRate: 0, totalReturn: 0, sharpe: 0, trades: 0,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  console.log(`[Batch] Complete — ${results.filter(r => r.status === 'completed').length}/${results.length} successful`);

  return {
    batchId: batch.batchId,
    name: batch.name,
    totalRuns: batch.configs.length,
    completed: results.filter(r => r.status === 'completed').length,
    failed: results.filter(r => r.status === 'failed').length,
    results,
    bestRun: bestRunId,
    startedAt,
    completedAt: new Date().toISOString(),
  };
}

/**
 * Generate parameter sweep configs.
 * Takes a base config and arrays of values to sweep.
 */
export function generateParameterSweep(
  base: BacktestRunConfig,
  sweeps: Array<{ param: keyof BacktestRunConfig; values: any[] }>,
): BacktestRunConfig[] {
  let configs: BacktestRunConfig[] = [{ ...base }];

  for (const sweep of sweeps) {
    const expanded: BacktestRunConfig[] = [];
    for (const cfg of configs) {
      for (const val of sweep.values) {
        expanded.push({
          ...cfg,
          [sweep.param]: val,
          name: `${cfg.name} [${String(sweep.param)}=${val}]`,
        });
      }
    }
    configs = expanded;
  }

  return configs;
}
