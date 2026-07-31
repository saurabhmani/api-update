// ════════════════════════════════════════════════════════════════
//  Resolve calibration for a run — prefer persisted snapshots,
//  fall back to recomputing from backtest_trades when missing.
// ════════════════════════════════════════════════════════════════

import type { CalibrationBucketResult, SimulatedTrade } from '../types';
import { computeFullCalibrationMatrix } from '../metrics/calibrationMetrics';
import { loadBacktestTrades } from './persistence';
import { loadCalibrationSnapshots, saveCalibrationSnapshots } from './metricsPersistence';

/** Map a snake_case backtest_trades row into the fields calibration needs. */
export function tradeRowToCalibrationInput(row: Record<string, unknown>): SimulatedTrade {
  return {
    tradeId: String(row.trade_id ?? ''),
    signalId: String(row.signal_id ?? ''),
    symbol: String(row.symbol ?? ''),
    sector: String(row.sector ?? ''),
    direction: (row.direction as SimulatedTrade['direction']) ?? 'long',
    strategy: row.strategy as SimulatedTrade['strategy'],
    regime: row.regime as SimulatedTrade['regime'],
    confidenceScore: Number(row.confidence_score ?? 0),
    confidenceBand: row.confidence_band as SimulatedTrade['confidenceBand'],
    signalDate: String(row.signal_date ?? ''),
    entryDate: row.entry_date != null ? String(row.entry_date) : null,
    exitDate: row.exit_date != null ? String(row.exit_date) : null,
    barsToEntry: Number(row.bars_to_entry ?? 0),
    barsInTrade: Number(row.bars_in_trade ?? 0),
    entryPrice: Number(row.entry_price ?? 0),
    exitPrice: row.exit_price != null ? Number(row.exit_price) : null,
    stopLoss: Number(row.stop_loss ?? 0),
    target1: Number(row.target1 ?? 0),
    target2: Number(row.target2 ?? 0),
    target3: Number(row.target3 ?? 0),
    positionSize: Number(row.position_size ?? 0),
    positionValue: Number(row.position_value ?? 0),
    riskAmount: Number(row.risk_amount ?? 0),
    slippageCost: Number(row.slippage_cost ?? 0),
    commissionCost: Number(row.commission_cost ?? 0),
    grossPnl: Number(row.gross_pnl ?? 0),
    netPnl: Number(row.net_pnl ?? 0),
    returnPct: Number(row.return_pct ?? 0),
    returnR: Number(row.return_r ?? 0),
    outcome: (row.outcome as SimulatedTrade['outcome']) ?? 'breakeven',
    exitReason: (row.exit_reason as SimulatedTrade['exitReason']) ?? null,
    mfePct: Number(row.mfe_pct ?? 0),
    maePct: Number(row.mae_pct ?? 0),
    mfeR: Number(row.mfe_r ?? 0),
    maeR: Number(row.mae_r ?? 0),
    target1Hit: Boolean(Number(row.target1_hit ?? 0)),
    target2Hit: Boolean(Number(row.target2_hit ?? 0)),
    target3Hit: Boolean(Number(row.target3_hit ?? 0)),
    stopHit: Boolean(Number(row.stop_hit ?? 0)),
    target1HitBar: null,
    target2HitBar: null,
    target3HitBar: null,
    stopHitBar: null,
    barByBarPnl: [],
  };
}

export interface ResolvedCalibration {
  buckets: CalibrationBucketResult[];
  source: 'snapshots' | 'recomputed' | 'empty';
  tradeCount: number;
}

/**
 * Load calibration snapshots; if none exist but trades do, recompute
 * and optionally backfill the snapshots table so subsequent reads are fast.
 */
export async function resolveCalibrationForRun(
  runId: string,
  opts: { backfill?: boolean } = {},
): Promise<ResolvedCalibration> {
  const existing = await loadCalibrationSnapshots(runId);
  if (existing.length > 0) {
    return { buckets: existing, source: 'snapshots', tradeCount: 0 };
  }

  const tradeRows = await loadBacktestTrades(runId);
  if (tradeRows.length === 0) {
    return { buckets: [], source: 'empty', tradeCount: 0 };
  }

  const trades = tradeRows.map((r) => tradeRowToCalibrationInput(r as Record<string, unknown>));
  const buckets = computeFullCalibrationMatrix(trades);

  if (opts.backfill !== false && buckets.length > 0) {
    try {
      await saveCalibrationSnapshots(runId, buckets);
    } catch (err) {
      console.error('[resolveCalibration] backfill failed:', err);
    }
  }

  return { buckets, source: 'recomputed', tradeCount: trades.length };
}
