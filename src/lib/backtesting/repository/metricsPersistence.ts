// ════════════════════════════════════════════════════════════════
//  Metrics + Calibration + Outcomes Persistence
// ════════════════════════════════════════════════════════════════

import { db } from '@/lib/db';
import type { BacktestMetric, CalibrationBucketResult, SimulatedSignal, SimulatedTrade } from '../types';
import { chunk } from '../utils/concurrencyPool';
import { logger as baseLogger } from '../utils/logger';
import { deriveVolatilityState } from '../../signal-engine/constants/phase3.constants';

/** Default row count per INSERT batch for streaming persistence (Section 1). */
export const DEFAULT_PERSIST_CHUNK_SIZE = 250;

/** Persist flat metrics to backtest_metrics table */
export async function saveBacktestMetrics(
  runId: string,
  metrics: BacktestMetric[],
): Promise<void> {
  if (metrics.length === 0) return;

  for (const m of metrics) {
    await db.query(
      `INSERT INTO backtest_metrics (run_id, metric_key, metric_value, metric_unit, category, description)
       VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE metric_value=VALUES(metric_value)`,
      [runId, m.metricKey, m.metricValue, m.metricUnit, m.category, m.description],
    );
  }
}

/** Persist calibration snapshots */
export async function saveCalibrationSnapshots(
  runId: string,
  buckets: CalibrationBucketResult[],
): Promise<void> {
  if (buckets.length === 0) return;

  for (const b of buckets) {
    await db.query(
      `INSERT INTO calibration_snapshots
        (run_id, bucket, strategy, regime, sample_size, expected_hit_rate,
         actual_hit_rate, avg_mfe_pct, avg_mae_pct, calibration_state, modifier_suggestion)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        runId, b.bucket, b.strategy, b.regime, b.sampleSize,
        b.expectedHitRate, b.actualHitRate, b.avgMfePct, b.avgMaePct,
        b.calibrationState, b.confidenceModifierSuggestion,
      ],
    );
  }
}

/**
 * Persist signal outcomes for all signals in a run.
 * Streaming: processes signals in chunks and inserts each chunk in parallel,
 * so the post-signal-candle fetch and row insert are both pipelined.
 */
export async function saveSignalOutcomes(
  runId: string,
  signals: SimulatedSignal[],
  trades: SimulatedTrade[],
  chunkSize: number = DEFAULT_PERSIST_CHUNK_SIZE,
): Promise<void> {
  if (signals.length === 0) return;
  const log = baseLogger.child({ runId, step: 'persist_outcomes' });

  // Build a trade map for fast lookup
  const tradeBySignal = new Map<string, SimulatedTrade>();
  for (const t of trades) tradeBySignal.set(t.signalId, t);

  // Lazy import to avoid circular deps
  const { getPostSignalCandles } = await import('../data/historicalCandleProvider');

  const processOne = async (sig: SimulatedSignal): Promise<void> => {
    const trade = tradeBySignal.get(sig.signalId);
    const triggered = sig.status === 'triggered' || !!trade;

    // ── Compute return_bar5_pct and return_bar10_pct (Phase 3 spec §2) ──
    // Pull the next 10 bars after the signal date and compute return from
    // signal-date close (or entryZoneHigh as a proxy) to bar+5/+10 close.
    let returnBar5Pct: number | null = null;
    let returnBar10Pct: number | null = null;
    try {
      const postBars = await getPostSignalCandles(sig.symbol, sig.date, 11);
      if (postBars.length > 0) {
        const refPrice = sig.entryZoneHigh; // best proxy for what we'd have paid
        const directionMult = sig.direction === 'short' ? -1 : 1;

        if (postBars.length >= 5) {
          const bar5Close = postBars[4].close;
          returnBar5Pct = refPrice > 0
            ? Math.round(((bar5Close - refPrice) / refPrice) * 100 * directionMult * 10000) / 10000
            : null;
        }
        if (postBars.length >= 10) {
          const bar10Close = postBars[9].close;
          returnBar10Pct = refPrice > 0
            ? Math.round(((bar10Close - refPrice) / refPrice) * 100 * directionMult * 10000) / 10000
            : null;
        }
      }
    } catch {
      // If post-signal candles unavailable, leave nulls — outcome row still
      // captures everything else.
    }

    // ── Outcome label — richer than before (Phase 3 spec §2) ──
    let outcomeLabel: string;
    if (trade) {
      // Trade exists — derive label from exit reason + result
      if (trade.target3Hit) outcomeLabel = 'good_followthrough';
      else if (trade.target2Hit || trade.target1Hit) outcomeLabel = 'partial_success';
      else if (trade.stopHit) outcomeLabel = 'stopped_out';
      else if (trade.outcome === 'win') outcomeLabel = 'good_followthrough';
      else outcomeLabel = 'expired_no_resolution';
    } else if (sig.status === 'filtered') {
      outcomeLabel = 'invalidated_before_entry';
    } else if (sig.status === 'expired') {
      outcomeLabel = 'stale_no_trigger';
    } else {
      outcomeLabel = 'expired_no_resolution';
    }

    await db.query(
      `INSERT INTO backtest_signal_outcomes
        (run_id, signal_id, trade_id, entry_triggered, bars_to_entry,
         target1_hit, target2_hit, target3_hit, stop_hit,
         max_fav_excursion_pct, max_adv_excursion_pct,
         pnl_r, return_bar5_pct, return_bar10_pct, outcome_label)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        runId,
        sig.signalId,
        trade?.tradeId ?? null,
        triggered ? 1 : 0,
        trade?.barsToEntry ?? sig.barsWaited,
        trade?.target1Hit ? 1 : 0,
        trade?.target2Hit ? 1 : 0,
        trade?.target3Hit ? 1 : 0,
        trade?.stopHit ? 1 : 0,
        trade?.mfePct ?? 0,
        trade?.maePct ?? 0,
        trade?.returnR ?? 0,
        returnBar5Pct,
        returnBar10Pct,
        outcomeLabel,
      ],
    );
  };

  for (const batch of chunk(signals, chunkSize)) {
    await Promise.all(batch.map(processOne));
    log.debug('outcome_batch_persisted', { rows: batch.length });
  }
}

/**
 * Persist all signals generated during a backtest.
 * Streaming: signals are inserted in chunks of `chunkSize` rows so very
 * large runs never materialize one huge INSERT or blow the connection.
 */
export async function saveBacktestSignals(
  runId: string,
  signals: SimulatedSignal[],
  chunkSize: number = DEFAULT_PERSIST_CHUNK_SIZE,
): Promise<void> {
  if (signals.length === 0) return;
  const log = baseLogger.child({ runId, step: 'persist_signals' });

  for (const batch of chunk(signals, chunkSize)) {
    await Promise.all(batch.map((sig) => {
      // Derive volatility_state from the feature snapshot captured
      // at signal time, using the same bucketing the live engine uses
      // in saveSignals.ts. Falls back to 'unknown' when the runner
      // wasn't configured to store the snapshot.
      const atrPct = (sig as any).featuresSnapshot?.volatility?.atrPct;
      const volatilityState = deriveVolatilityState(atrPct);
      return db.query(
        `INSERT INTO backtest_signals
          (run_id, signal_id, symbol, date, bar_index, direction, strategy, regime,
           confidence_score, confidence_band, risk_score, sector, volatility_state,
           entry_zone_low, entry_zone_high, stop_loss, target1, target2, target3,
           risk_per_unit, reward_risk, status, bars_waited, reasons_json,
           manipulation_score, manipulation_band, excluded_by_manipulation)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          runId, sig.signalId, sig.symbol, sig.date, sig.barIndex,
          sig.direction, sig.strategy, sig.regime,
          sig.confidenceScore, sig.confidenceBand, sig.riskScore, sig.sector, volatilityState,
          sig.entryZoneLow, sig.entryZoneHigh, sig.stopLoss,
          sig.target1, sig.target2, sig.target3,
          sig.riskPerUnit, sig.rewardRiskApprox,
          sig.status, sig.barsWaited,
          JSON.stringify(sig.reasons),
          sig.manipulationScore ?? null,
          sig.manipulationBand ?? null,
          sig.excludedByManipulationFilter ? 1 : 0,
        ],
      );
    }));
    log.debug('signal_batch_persisted', { rows: batch.length });
  }
}

/** Save performance metrics for a run (Section 1/2 — observability) */
export async function savePerformanceMetrics(
  runId: string,
  perf: {
    totalRuntimeMs: number;
    memoryRssMb: number | null;
    memoryHeapMb: number | null;
    signalsPerSec: number;
    tradesPerSec: number;
    symbolsProcessed: number;
    tradingDays: number;
    msPerTradingDay: number;
    preloadMs?: number;
    simulationMs?: number;
    avgMsPerSymbol?: number;
    maxMsPerSymbol?: number;
    concurrency?: number;
  },
): Promise<void> {
  await db.query(
    `INSERT INTO backtest_performance_metrics
      (run_id, total_runtime_ms, memory_rss_mb, memory_heap_mb,
       signals_per_sec, trades_per_sec, symbols_processed,
       trading_days, ms_per_trading_day,
       preload_ms, simulation_ms, avg_ms_per_symbol, max_ms_per_symbol, concurrency)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       total_runtime_ms=VALUES(total_runtime_ms),
       memory_rss_mb=VALUES(memory_rss_mb),
       memory_heap_mb=VALUES(memory_heap_mb),
       signals_per_sec=VALUES(signals_per_sec),
       trades_per_sec=VALUES(trades_per_sec),
       symbols_processed=VALUES(symbols_processed),
       trading_days=VALUES(trading_days),
       ms_per_trading_day=VALUES(ms_per_trading_day),
       preload_ms=VALUES(preload_ms),
       simulation_ms=VALUES(simulation_ms),
       avg_ms_per_symbol=VALUES(avg_ms_per_symbol),
       max_ms_per_symbol=VALUES(max_ms_per_symbol),
       concurrency=VALUES(concurrency)`,
    [
      runId, perf.totalRuntimeMs, perf.memoryRssMb, perf.memoryHeapMb,
      perf.signalsPerSec, perf.tradesPerSec, perf.symbolsProcessed,
      perf.tradingDays, perf.msPerTradingDay,
      perf.preloadMs ?? null, perf.simulationMs ?? null,
      perf.avgMsPerSymbol ?? null, perf.maxMsPerSymbol ?? null,
      perf.concurrency ?? null,
    ],
  );
}

export async function loadPerformanceMetrics(runId: string): Promise<any | null> {
  const { rows } = await db.query(
    `SELECT * FROM backtest_performance_metrics WHERE run_id = ? LIMIT 1`,
    [runId],
  );
  if (!rows[0]) return null;
  const r = rows[0] as any;
  return {
    runId: r.run_id,
    totalRuntimeMs: Number(r.total_runtime_ms),
    memoryRssMb: r.memory_rss_mb != null ? Number(r.memory_rss_mb) : null,
    memoryHeapMb: r.memory_heap_mb != null ? Number(r.memory_heap_mb) : null,
    signalsPerSec: Number(r.signals_per_sec),
    tradesPerSec: Number(r.trades_per_sec),
    symbolsProcessed: Number(r.symbols_processed),
    tradingDays: Number(r.trading_days),
    msPerTradingDay: Number(r.ms_per_trading_day),
    preloadMs: r.preload_ms != null ? Number(r.preload_ms) : null,
    simulationMs: r.simulation_ms != null ? Number(r.simulation_ms) : null,
    avgMsPerSymbol: r.avg_ms_per_symbol != null ? Number(r.avg_ms_per_symbol) : null,
    maxMsPerSymbol: r.max_ms_per_symbol != null ? Number(r.max_ms_per_symbol) : null,
    concurrency: r.concurrency != null ? Number(r.concurrency) : null,
    createdAt: r.created_at,
  };
}

/** Load metrics for a backtest run */
export async function loadBacktestMetrics(runId: string): Promise<BacktestMetric[]> {
  const result = await db.query(
    `SELECT metric_key, metric_value, metric_unit, category, description
     FROM backtest_metrics WHERE run_id = ? ORDER BY category, metric_key`,
    [runId],
  );
  const rows = result.rows ?? [];
  return rows.map((r: any) => ({
    metricKey: r.metric_key, metricValue: Number(r.metric_value),
    metricUnit: r.metric_unit, category: r.category, description: r.description,
  }));
}

/** Persist news impact analytics per backtest run */
export async function saveNewsAnalytics(
  runId: string,
  analytics: Array<{ bucket: string; trades: number; winRate: number; expectancyR: number; avgMFE: number; avgMAE: number; profitFactor: number; avgConfMod: number; insight: string }>,
): Promise<void> {
  if (analytics.length === 0) return;
  for (const a of analytics) {
    await db.query(
      `INSERT INTO backtest_news_analytics
        (run_id, bucket, trades, win_rate, expectancy_r, avg_mfe, avg_mae, profit_factor, avg_conf_mod, insight)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         trades=VALUES(trades), win_rate=VALUES(win_rate), expectancy_r=VALUES(expectancy_r),
         avg_mfe=VALUES(avg_mfe), avg_mae=VALUES(avg_mae), profit_factor=VALUES(profit_factor),
         avg_conf_mod=VALUES(avg_conf_mod), insight=VALUES(insight)`,
      [runId, a.bucket, a.trades, a.winRate, a.expectancyR, a.avgMFE, a.avgMAE, a.profitFactor, a.avgConfMod, a.insight],
    );
  }
}

/** Persist news effectiveness comparison for a backtest run */
export async function saveNewsEffectiveness(
  runId: string,
  data: {
    baselineWinRate: number; newsAwareWinRate: number; winRateDelta: number;
    baselineExpectancyR: number; newsAwareExpectancyR: number; expectancyDelta: number;
    newsEffectivenessScore: number; newsAddsValue: boolean; summary: string;
  },
): Promise<void> {
  await db.query(
    `INSERT INTO backtest_news_effectiveness
      (run_id, baseline_win_rate, news_aware_win_rate, win_rate_delta,
       baseline_expectancy_r, news_aware_expectancy_r, expectancy_delta,
       news_effectiveness_score, news_adds_value, summary)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       baseline_win_rate=VALUES(baseline_win_rate), news_aware_win_rate=VALUES(news_aware_win_rate),
       win_rate_delta=VALUES(win_rate_delta), baseline_expectancy_r=VALUES(baseline_expectancy_r),
       news_aware_expectancy_r=VALUES(news_aware_expectancy_r), expectancy_delta=VALUES(expectancy_delta),
       news_effectiveness_score=VALUES(news_effectiveness_score),
       news_adds_value=VALUES(news_adds_value), summary=VALUES(summary)`,
    [
      runId, data.baselineWinRate, data.newsAwareWinRate, data.winRateDelta,
      data.baselineExpectancyR, data.newsAwareExpectancyR, data.expectancyDelta,
      data.newsEffectivenessScore, data.newsAddsValue ? 1 : 0, data.summary,
    ],
  );
}

/** Load calibration for a backtest run */
export async function loadCalibrationSnapshots(runId: string): Promise<CalibrationBucketResult[]> {
  const result = await db.query(
    `SELECT * FROM calibration_snapshots WHERE run_id = ? ORDER BY bucket`,
    [runId],
  );
  const rows = result.rows ?? [];
  return rows.map((r: any) => ({
    bucket: r.bucket, strategy: r.strategy, regime: r.regime,
    sampleSize: r.sample_size, expectedHitRate: Number(r.expected_hit_rate),
    actualHitRate: Number(r.actual_hit_rate), avgMfePct: Number(r.avg_mfe_pct),
    avgMaePct: Number(r.avg_mae_pct), calibrationState: r.calibration_state,
    confidenceModifierSuggestion: Number(r.modifier_suggestion),
  }));
}
