// ════════════════════════════════════════════════════════════════
//  Backtesting Persistence Layer
// ════════════════════════════════════════════════════════════════

import { db } from '@/lib/db';
import type { BacktestRunRecord, SimulatedTrade, EquityPoint } from '../types';
import { chunk } from '../utils/concurrencyPool';
import { DEFAULT_PERSIST_CHUNK_SIZE } from './metricsPersistence';
import { logger as baseLogger } from '../utils/logger';

function toMysqlDatetime(value: string | Date | null | undefined): string | null {
  if (value == null) return null;
  const d = typeof value === 'string' ? new Date(value) : value;
  if (isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

/** Save a complete backtest run to the database */
export async function saveBacktestRun(
  run: BacktestRunRecord,
  trades: SimulatedTrade[] = [],
  equityCurve: EquityPoint[] = [],
): Promise<void> {
  // 1. Insert run metadata
  await db.query(
    `INSERT INTO backtest_runs (run_id, name, config_json, status, started_at, completed_at, duration_ms, error, summary_json, strategy_breakdown_json, regime_breakdown_json, signal_count, trade_count)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE status=VALUES(status), completed_at=VALUES(completed_at), error=VALUES(error), summary_json=VALUES(summary_json), strategy_breakdown_json=VALUES(strategy_breakdown_json), regime_breakdown_json=VALUES(regime_breakdown_json)`,
    [
      run.runId, run.config.name, JSON.stringify(run.config),
      run.status, toMysqlDatetime(run.startedAt), toMysqlDatetime(run.completedAt), run.durationMs, run.error,
      JSON.stringify(run.summary),
      JSON.stringify(run.strategyBreakdown),
      JSON.stringify(run.regimeBreakdown),
      run.signalCount, run.tradeCount,
    ],
  );

  // 2. Insert trades — streamed in chunks with in-chunk parallelism (Section 1)
  const log = baseLogger.child({ runId: run.runId, step: 'persist_run' });
  const tradeChunkSize = DEFAULT_PERSIST_CHUNK_SIZE;
  for (const batch of chunk(trades, tradeChunkSize)) {
    await Promise.all(batch.map((trade) =>
      db.query(
        `INSERT INTO backtest_trades (run_id, trade_id, signal_id, symbol, sector, direction, strategy, regime,
          confidence_score, confidence_band, signal_date, entry_date, exit_date, bars_to_entry, bars_in_trade,
          entry_price, exit_price, stop_loss, target1, target2, target3,
          position_size, position_value, risk_amount, slippage_cost, commission_cost,
          gross_pnl, net_pnl, return_pct, return_r, outcome, exit_reason,
          mfe_pct, mae_pct, mfe_r, mae_r, target1_hit, target2_hit, target3_hit, stop_hit)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          run.runId, trade.tradeId, trade.signalId, trade.symbol, trade.sector,
          trade.direction, trade.strategy, trade.regime,
          trade.confidenceScore, trade.confidenceBand,
          trade.signalDate, trade.entryDate, trade.exitDate,
          trade.barsToEntry, trade.barsInTrade,
          trade.entryPrice, trade.exitPrice, trade.stopLoss,
          trade.target1, trade.target2, trade.target3,
          trade.positionSize, trade.positionValue, trade.riskAmount,
          trade.slippageCost, trade.commissionCost,
          trade.grossPnl, trade.netPnl, trade.returnPct, trade.returnR,
          trade.outcome, trade.exitReason,
          trade.mfePct, trade.maePct, trade.mfeR, trade.maeR,
          trade.target1Hit ? 1 : 0, trade.target2Hit ? 1 : 0,
          trade.target3Hit ? 1 : 0, trade.stopHit ? 1 : 0,
        ],
      ),
    ));
    log.debug('trade_batch_persisted', { rows: batch.length });
  }

  // 3. Insert equity curve — streamed in chunks
  for (const batch of chunk(equityCurve, tradeChunkSize)) {
    await Promise.all(batch.map((point) =>
      db.query(
        `INSERT INTO backtest_equity_curve (run_id, date, equity, cash, open_position_value, drawdown_pct, open_positions, day_pnl)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE equity=VALUES(equity), cash=VALUES(cash), open_position_value=VALUES(open_position_value), drawdown_pct=VALUES(drawdown_pct), open_positions=VALUES(open_positions), day_pnl=VALUES(day_pnl)`,
        [run.runId, point.date, point.equity, point.cash, point.openPositionValue, point.drawdownPct, point.openPositions, point.dayPnl],
      ),
    ));
    log.debug('equity_batch_persisted', { rows: batch.length });
  }
}

/** Load a backtest run summary (without full trade list) */
export async function loadBacktestRun(runId: string): Promise<any | null> {
  const result = await db.query(
    `SELECT * FROM backtest_runs WHERE run_id = ?`, [runId],
  );
  return (result.rows ?? [])[0] ?? null;
}

/** List all backtest runs */
export async function listBacktestRuns(): Promise<any[]> {
  const result = await db.query(
    `SELECT run_id, name, status, started_at, completed_at, duration_ms, signal_count, trade_count, summary_json, strategy_breakdown_json, config_json FROM backtest_runs ORDER BY started_at DESC LIMIT 50`,
  );
  return result.rows ?? [];
}

/** Load trades for a specific run */
export async function loadBacktestTrades(runId: string): Promise<any[]> {
  const result = await db.query(
    `SELECT * FROM backtest_trades WHERE run_id = ? ORDER BY signal_date`, [runId],
  );
  return result.rows ?? [];
}

/** Load equity curve for a specific run */
export async function loadEquityCurve(runId: string): Promise<any[]> {
  const result = await db.query(
    `SELECT * FROM backtest_equity_curve WHERE run_id = ? ORDER BY date`, [runId],
  );
  return result.rows ?? [];
}
