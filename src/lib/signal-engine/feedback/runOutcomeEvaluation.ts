// ════════════════════════════════════════════════════════════════
//  Outcome evaluation job — feedback loop core (Phase 4 §8)
//
//  Extracted from POST /api/signal-engine/feedback/evaluate so the
//  same logic can run from the worker scheduler (nightly cron) as
//  well as the manual API trigger. Without a scheduled run the
//  q365_signal_outcomes table goes stale and the Strategy
//  Performance page shows "Insufficient data" for recent windows.
//
//  Walks signals eligible for outcome evaluation, fetches their
//  post-signal candles from market_data_daily, computes the outcome
//  via evaluateOutcome(), persists to q365_signal_outcomes, then
//  appends strategy performance and confidence calibration
//  snapshots.
//
//  Idempotent per signal: DELETE-before-INSERT, so re-running for
//  the same signal produces one row, not two.
// ════════════════════════════════════════════════════════════════

import { db } from '@/lib/db';
import { ensureSignalEngineSchemas } from '@/lib/signal-engine/repository/ensureSchemas';
import {
  evaluateOutcome,
  aggregatePerformance,
  calibrateConfidence,
} from '@/lib/signal-engine/feedback/outcomeTracker';
import type { SignalOutcome } from '@/lib/signal-engine/types/phase4.types';
import {
  ensurePhase4Tables,
  saveOutcome,
} from '@/lib/signal-engine/repository/savePhase4Artifacts';

export interface OutcomeEvaluationOptions {
  /** Evaluate only this signal. */
  signalId?: number;
  /** Only consider signals generated within the last N days (default 30). */
  maxAgeDays?: number;
  /** Minimum post-signal daily candles required to evaluate (default 5). */
  minBarsSinceEntry?: number;
  /** Max signals to process per run (default 200, capped at 1000). */
  limit?: number;
  /** When set, skip signals whose outcome row was already evaluated
   *  within the last N hours. Makes scheduled runs incremental: each
   *  nightly tick picks up signals with missing or stale outcomes
   *  instead of re-evaluating the same oldest batch forever. */
  staleHours?: number;
  /** Pagination cursor for incremental mode — only consider signals
   *  with id > afterId. Callers loop with the returned
   *  `last_signal_id` so successive batches always advance, even when
   *  a batch is entirely skipped (e.g. candle data missing). */
  afterId?: number;
}

export interface OutcomeEvaluationResult {
  processed_count: number;
  updated_count: number;
  skipped_count: number;
  strategy_snapshots: number;
  calibration_snapshots: number;
  duration_ms: number;
  /** Highest q365_signals.id seen in this batch — pass back as
   *  `afterId` to advance to the next batch. Null when no rows. */
  last_signal_id: number | null;
}

interface EligibleSignalRow {
  id: number;
  symbol: string;
  direction: string;
  signal_type: string;
  confidence_score: number;
  market_regime: string;
  entry_price: string | number;
  stop_loss: string | number;
  target1: string | number;
  target2: string | number | null;
  generated_at: Date | string;
  sector: string | null;
  volatility_state: string | null;
}

interface PostCandleRow {
  ts: Date | string;
  high: string | number;
  low: string | number;
  close: string | number;
}

function toNum(v: string | number | null | undefined, fallback = 0): number {
  if (v == null) return fallback;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function confidenceBucket(score: number): string {
  if (score >= 85) return '85_100';
  if (score >= 70) return '70_84';
  if (score >= 55) return '55_69';
  return '0_54';
}

export async function runOutcomeEvaluation(
  opts: OutcomeEvaluationOptions = {},
): Promise<OutcomeEvaluationResult> {
  const start = Date.now();
  const signalId = opts.signalId;
  const maxAgeDays = opts.maxAgeDays ?? 30;
  const minBarsSinceEntry = opts.minBarsSinceEntry ?? 5;
  const limit = Math.min(opts.limit ?? 200, 1000);
  const staleHours = opts.staleHours;

  await ensureSignalEngineSchemas();
  await ensurePhase4Tables();

  // ── Step 1: Load eligible signals ────────────────────────
  //
  // We DO NOT filter by whether an outcome already exists. The outcome
  // writer below is idempotent (DELETE-before-INSERT), so re-evaluation
  // is safe and handles signals where more candles have accumulated
  // since the last run.
  let eligible: EligibleSignalRow[];
  if (signalId) {
    const { rows } = await db.query<EligibleSignalRow>(
      `SELECT id, symbol, direction, signal_type, confidence_score,
              market_regime, entry_price, stop_loss, target1, target2,
              generated_at, sector, volatility_state
         FROM q365_signals
        WHERE id = ?`,
      [signalId],
    );
    eligible = rows;
  } else if (staleHours != null && staleHours > 0) {
    // Incremental mode: only signals with no outcome row yet or an
    // outcome older than staleHours. Ordered by id ASC with an
    // `afterId` cursor so multi-batch callers always advance — even
    // when an entire batch is skipped for missing candle data.
    const afterId = opts.afterId ?? 0;
    const { rows } = await db.query<EligibleSignalRow>(
      `SELECT s.id, s.symbol, s.direction, s.signal_type, s.confidence_score,
              s.market_regime, s.entry_price, s.stop_loss, s.target1, s.target2,
              s.generated_at, s.sector, s.volatility_state
         FROM q365_signals s
         LEFT JOIN (
           SELECT signal_id, MAX(evaluated_at) AS evaluated_at
             FROM q365_signal_outcomes
            GROUP BY signal_id
         ) o ON o.signal_id = s.id
        WHERE s.id > ?
          AND s.generated_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
          AND (o.signal_id IS NULL
               OR o.evaluated_at < DATE_SUB(NOW(), INTERVAL ? HOUR))
        ORDER BY s.id ASC
        LIMIT ?`,
      [afterId, maxAgeDays, staleHours, limit],
    );
    eligible = rows;
  } else {
    const { rows } = await db.query<EligibleSignalRow>(
      `SELECT id, symbol, direction, signal_type, confidence_score,
              market_regime, entry_price, stop_loss, target1, target2,
              generated_at, sector, volatility_state
         FROM q365_signals
        WHERE generated_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
        ORDER BY generated_at ASC
        LIMIT ?`,
      [maxAgeDays, limit],
    );
    eligible = rows;
  }

  const processed_count = eligible.length;
  let updated_count = 0;
  let skipped_count = 0;

  // Bucket key includes volatility_state and sector so the strategy
  // performance snapshot table is dimensioned by all four factors.
  const perfBuckets = new Map<
    string,
    {
      strategy: string;
      regime: string;
      volatilityState: string;
      sector: string | null;
      outcomes: SignalOutcome[];
    }
  >();
  const calibBuckets = new Map<string, SignalOutcome[]>();

  // ── Step 2: Evaluate each eligible signal ────────────────
  for (const sig of eligible) {
    const entryPrice = toNum(sig.entry_price);
    const stopLoss = toNum(sig.stop_loss);
    const target1 = toNum(sig.target1);
    const target2 = toNum(sig.target2, target1);
    // We don't persist target3 on q365_signals — derive a conservative
    // proxy (2× the entry→target1 leg).
    const target3 = entryPrice + 2 * (target1 - entryPrice);
    const isBearish = sig.direction === 'SELL';

    // Fetch post-signal candles strictly AFTER generated_at, capped
    // at the evaluation horizon (15 bars).
    const genAt =
      typeof sig.generated_at === 'string'
        ? sig.generated_at
        : sig.generated_at.toISOString();
    const { rows: candleRows } = await db.query<PostCandleRow>(
      `SELECT ts, high, low, close
         FROM market_data_daily
        WHERE symbol = ? AND ts > ?
        ORDER BY ts ASC
        LIMIT 15`,
      [sig.symbol, genAt],
    );

    if (candleRows.length < minBarsSinceEntry) {
      skipped_count++;
      continue;
    }

    const postCandles = candleRows.map((c) => ({
      ts: c.ts,
      high: toNum(c.high),
      low: toNum(c.low),
      close: toNum(c.close),
    }));

    const outcome = evaluateOutcome(
      sig.id,
      entryPrice,
      stopLoss,
      target1,
      target2,
      target3,
      postCandles,
      isBearish,
      {
        expectedRewardRisk: Math.abs(entryPrice - stopLoss) > 0
          ? Math.abs(target1 - entryPrice) / Math.abs(entryPrice - stopLoss)
          : 0,
        evaluatedAt: String(candleRows.at(-1)?.ts ?? genAt),
      },
    );

    // Idempotent write: remove any prior outcome row for this signal
    // before inserting the freshly computed one.
    await db.query(
      `DELETE FROM q365_signal_outcomes WHERE signal_id = ?`,
      [sig.id],
    );
    await saveOutcome(outcome);

    updated_count++;

    const volatilityKey = sig.volatility_state ?? 'unknown';
    const sectorKey = sig.sector ?? 'unknown';
    const perfKey = `${sig.signal_type}::${sig.market_regime}::${volatilityKey}::${sectorKey}`;
    if (!perfBuckets.has(perfKey)) {
      perfBuckets.set(perfKey, {
        strategy: sig.signal_type,
        regime: sig.market_regime,
        volatilityState: volatilityKey,
        sector: sig.sector,
        outcomes: [],
      });
    }
    perfBuckets.get(perfKey)!.outcomes.push(outcome);

    const bucket = confidenceBucket(Number(sig.confidence_score) || 0);
    if (!calibBuckets.has(bucket)) calibBuckets.set(bucket, []);
    calibBuckets.get(bucket)!.push(outcome);
  }

  // ── Step 3: Strategy performance snapshots (append-only) ──
  let strategy_snapshots = 0;
  for (const bucket of Array.from(perfBuckets.values())) {
    const perf = aggregatePerformance(
      bucket.strategy,
      bucket.regime,
      bucket.volatilityState,
      bucket.outcomes,
      bucket.sector,
    );
    await db.query(
      `INSERT INTO q365_strategy_performance_snapshots
        (strategy_name, regime, volatility_state, sector, sample_size,
         win_rate, target1_hit_rate, avg_pnl_r, avg_mfe, avg_mae, environment_fit)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        perf.strategyName,
        perf.regime,
        perf.volatilityState,
        perf.sector,
        perf.sampleSize,
        perf.winRate,
        perf.target1HitRate,
        perf.avgPnlR,
        perf.avgMFE,
        perf.avgMAE,
        perf.environmentFit,
      ],
    );
    strategy_snapshots++;
  }

  // ── Step 4: Confidence calibration snapshots ─────────────
  let calibration_snapshots = 0;
  for (const [bucket, outcomes] of Array.from(calibBuckets.entries())) {
    const calib = calibrateConfidence(bucket, outcomes);
    await db.query(
      `INSERT INTO q365_confidence_calibration
        (bucket, strategy_name, regime, sample_size,
         target1_hit_rate, avg_mfe, calibration_state)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        calib.bucket,
        null, // bucket-level (not strategy-scoped) for the aggregate view
        null,
        calib.sampleSize,
        calib.target1HitRate,
        calib.avgMFE,
        calib.calibrationState,
      ],
    );
    calibration_snapshots++;
  }

  return {
    processed_count,
    updated_count,
    skipped_count,
    strategy_snapshots,
    calibration_snapshots,
    duration_ms: Date.now() - start,
    last_signal_id: eligible.length > 0
      ? Math.max(...eligible.map((s) => Number(s.id)))
      : null,
  };
}
