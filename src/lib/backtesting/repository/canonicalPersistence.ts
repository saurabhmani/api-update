// ════════════════════════════════════════════════════════════════
//  Canonical backtest tables — strategy_backtests + backtest_summary
//  Synced from backtest_runs on every persist cycle.
// ════════════════════════════════════════════════════════════════

import { db } from '@/lib/db';
import type { BacktestRunConfig, BacktestRunRecord, BacktestSummary } from '../types';

function toMysqlDatetime(value: string | null | undefined): string | null {
  if (!value) return null;
  const d = new Date(value);
  if (isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

function resolveStrategyId(config: BacktestRunConfig): string | null {
  if (config.strategies && config.strategies.length === 1) {
    return config.strategies[0];
  }
  if (config.strategies && config.strategies.length > 1) {
    return 'multi_strategy';
  }
  return null;
}

export async function syncStrategyBacktest(run: BacktestRunRecord): Promise<void> {
  try {
    const strategyId = resolveStrategyId(run.config);
    await db.query(
      `INSERT INTO strategy_backtests
         (backtest_id, strategy_id, name, status, config_json, started_at, completed_at, trade_count, signal_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         strategy_id = VALUES(strategy_id),
         name = VALUES(name),
         status = VALUES(status),
         config_json = VALUES(config_json),
         completed_at = VALUES(completed_at),
         trade_count = VALUES(trade_count),
         signal_count = VALUES(signal_count)`,
      [
        run.runId,
        strategyId,
        run.config.name,
        run.status,
        JSON.stringify(run.config),
        toMysqlDatetime(run.startedAt),
        toMysqlDatetime(run.completedAt),
        run.tradeCount,
        run.signalCount,
      ],
    );
  } catch {
    // Table may not exist before migration
  }
}

export async function syncBacktestSummaryRow(
  backtestId: string,
  summary: BacktestSummary | null,
  signalCount: number,
  tradeCount: number,
): Promise<void> {
  if (!summary) return;
  try {
    await db.query(
      `INSERT INTO backtest_summary
         (backtest_id, total_return_pct, win_rate, sharpe_ratio, sortino_ratio,
          max_drawdown_pct, profit_factor, expectancy_r, total_trades, total_signals,
          initial_capital, final_equity, summary_json, computed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
       ON DUPLICATE KEY UPDATE
         total_return_pct = VALUES(total_return_pct),
         win_rate = VALUES(win_rate),
         sharpe_ratio = VALUES(sharpe_ratio),
         sortino_ratio = VALUES(sortino_ratio),
         max_drawdown_pct = VALUES(max_drawdown_pct),
         profit_factor = VALUES(profit_factor),
         expectancy_r = VALUES(expectancy_r),
         total_trades = VALUES(total_trades),
         total_signals = VALUES(total_signals),
         initial_capital = VALUES(initial_capital),
         final_equity = VALUES(final_equity),
         summary_json = VALUES(summary_json),
         computed_at = NOW()`,
      [
        backtestId,
        summary.totalReturnPct,
        summary.winRate,
        summary.sharpeRatio,
        summary.sortinoRatio,
        summary.maxDrawdownPct,
        summary.profitFactor,
        summary.expectancyR,
        tradeCount,
        signalCount,
        summary.initialCapital,
        summary.finalEquity,
        JSON.stringify(summary),
      ],
    );
  } catch {
    // Table may not exist before migration
  }
}

export async function loadBacktestSummaryRow(backtestId: string): Promise<Record<string, unknown> | null> {
  try {
    const { rows } = await db.query(
      `SELECT * FROM backtest_summary WHERE backtest_id = ? LIMIT 1`,
      [backtestId],
    );
    return rows.length ? (rows[0] as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
