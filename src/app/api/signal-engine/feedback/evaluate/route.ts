// ════════════════════════════════════════════════════════════════
//  POST /api/signal-engine/feedback/evaluate
//
//  Feedback loop orchestrator — Phase 4 §8.
//
//  Walks signals that are eligible for outcome evaluation, fetches
//  their post-signal candles from market_data_daily, computes
//  SignalOutcome via the existing evaluateOutcome() helper, persists
//  to q365_signal_outcomes, then rebuilds strategy performance and
//  confidence calibration snapshots.
//
//  Idempotency:
//    - outcomes: DELETE WHERE signal_id = ? before INSERT, so running
//      the evaluator twice for the same signal produces one row, not two.
//    - performance/calibration: append-only with computed_at timestamp;
//      readers take the latest. Running twice gives two snapshots but
//      no "duplicate" in the dedup sense — analysts can see drift.
//
//  Triggers supported:
//    - manual POST (default) with optional body { signalId, maxAgeDays,
//      limit, minBarsSinceEntry }
//    - cron: any scheduler can hit the same POST with no body
//
//  Request body (all optional):
//    {
//      signalId?: number,          // evaluate only this signal
//      maxAgeDays?: number,        // only consider signals generated
//                                  //   within the last N days (default 30)
//      minBarsSinceEntry?: number, // minimum post-signal candles required
//                                  //   to evaluate (default 5)
//      limit?: number,             // max signals to process (default 200)
//    }
//
//  Response:
//    {
//      processed_count: number,   // how many signals we looked at
//      updated_count: number,     // how many outcomes we wrote
//      skipped_count: number,     // insufficient data / already current
//      strategy_snapshots: number,
//      calibration_snapshots: number,
//      duration_ms: number,
//    }
// ════════════════════════════════════════════════════════════════

import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/lib/session';
import { db } from '@/lib/db';
import { ensureSignalEngineSchemas } from '@/lib/signal-engine/repository/ensureSchemas';
import {
  evaluateOutcome,
  aggregatePerformance,
  calibrateConfidence,
} from '@/lib/signal-engine/feedback/outcomeTracker';
import type { SignalOutcome } from '@/lib/signal-engine/types/phase4.types';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

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
  high: string | number;
  low: string | number;
  close: string | number;
}

// MySQL strict mode rejects ISO 8601 timestamps with 'T'/'Z'/fractional
// seconds (error 1292 Incorrect datetime value). Normalize at the write
// boundary so a Date or ISO string both end up as 'YYYY-MM-DD HH:MM:SS'.
function toMysqlDateTime(input: string | Date | null | undefined): string | null {
  if (input == null || input === '') return null;
  const iso = input instanceof Date ? input.toISOString() : String(input);
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(iso)) return iso;
  return iso.slice(0, 19).replace('T', ' ');
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

export async function POST(req: NextRequest) {
  try {
    await requireSession();
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const start = Date.now();

  // Parse body safely — accept empty/missing JSON.
  let body: Record<string, unknown> = {};
  try {
    body = (await req.json()) ?? {};
  } catch {
    body = {};
  }

  const signalId = typeof body.signalId === 'number' ? body.signalId : undefined;
  const maxAgeDays = typeof body.maxAgeDays === 'number' ? body.maxAgeDays : 30;
  const minBarsSinceEntry =
    typeof body.minBarsSinceEntry === 'number' ? body.minBarsSinceEntry : 5;
  const limit = typeof body.limit === 'number' ? Math.min(body.limit, 1000) : 200;

  try {
    await ensureSignalEngineSchemas();

    // ── Step 1: Load eligible signals ────────────────────────
    //
    // Eligibility:
    //   - Either the specific signalId requested, or all signals
    //     generated within maxAgeDays that are active/watchlist/expired
    //     (we still want outcomes for expired rows — that's the whole
    //     point of the feedback loop).
    //   - We DO NOT filter by whether an outcome already exists. The
    //     outcome writer below is idempotent (DELETE-before-INSERT), so
    //     re-evaluation is safe and handles signals where more candles
    //     have accumulated since the last run.
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
    const freshOutcomes: SignalOutcome[] = [];
    // Carry strategy/regime/volatility/sector alongside outcome for
    // performance rollup — outcomeTracker.aggregatePerformance needs
    // those keys but SignalOutcome itself doesn't carry them.
    //
    // Bucket key now includes volatility_state and sector so the
    // strategy performance snapshot table is dimensioned by all four
    // factors. This replaces the earlier 'unknown'/null placeholders
    // that blocked meaningful analytics grouping.
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
      // proxy (2× the entry→target1 leg). Feedback math only uses it to
      // detect "good_followthrough" beyond target2, so an underestimate
      // just means some signals land as partial_success instead of
      // good_followthrough. Acceptable.
      const target3 = entryPrice + 2 * (target1 - entryPrice);
      const isBearish = sig.direction === 'SELL';

      // Fetch post-signal candles strictly AFTER generated_at, capped
      // at the evaluation horizon (15 bars — matches
      // DEFAULT_BACKTEST_CONFIG.evaluationHorizon).
      const genAt =
        typeof sig.generated_at === 'string'
          ? sig.generated_at
          : sig.generated_at.toISOString();
      const { rows: candleRows } = await db.query<PostCandleRow>(
        `SELECT high, low, close
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
      );

      // Idempotent write: remove any prior outcome row for this signal
      // before inserting the freshly computed one. This lets the
      // evaluator run on a schedule without accumulating duplicates.
      await db.query(
        `DELETE FROM q365_signal_outcomes WHERE signal_id = ?`,
        [sig.id],
      );
      await db.query(
        `INSERT INTO q365_signal_outcomes
          (signal_id, entry_triggered, bars_to_entry,
           target1_hit, target2_hit, target3_hit, stop_hit,
           max_fav_excursion_pct, max_adv_excursion_pct,
           pnl_r, return_bar5_pct, return_bar10_pct,
           outcome_label, evaluated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          outcome.signalId,
          outcome.entryTriggered ? 1 : 0,
          outcome.barsToEntry,
          outcome.target1Hit ? 1 : 0,
          outcome.target2Hit ? 1 : 0,
          outcome.target3Hit ? 1 : 0,
          outcome.stopHit ? 1 : 0,
          outcome.maxFavorableExcursionPct,
          outcome.maxAdverseExcursionPct,
          outcome.pnlR,
          outcome.returnAtBar5Pct,
          outcome.returnAtBar10Pct,
          outcome.outcomeLabel,
          toMysqlDateTime(outcome.evaluatedAt),
        ],
      );

      updated_count++;
      freshOutcomes.push(outcome);

      // Bucket for performance rollup — keyed by the four factors
      // that actually move strategy performance: strategy, regime,
      // volatility state, and sector. Null sector and 'unknown'
      // volatility still get their own bucket so nothing is silently
      // dropped, but analytics can filter them out with a simple
      // WHERE clause.
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

      // Bucket for calibration
      const bucket = confidenceBucket(Number(sig.confidence_score) || 0);
      if (!calibBuckets.has(bucket)) calibBuckets.set(bucket, []);
      calibBuckets.get(bucket)!.push(outcome);
    }

    // ── Step 3: Strategy performance snapshots ───────────────
    //
    // Append-only. Analytics readers should take the most recent
    // snapshot per (strategy, regime) by computed_at.
    let strategy_snapshots = 0;
    for (const bucket of Array.from(perfBuckets.values())) {
      const perf = aggregatePerformance(
        bucket.strategy,
        bucket.regime,
        bucket.volatilityState,
        bucket.outcomes,
        bucket.sector,
      );
      // aggregatePerformance returns environment_fit='insufficient_data'
      // for samples under 5 — still useful to persist so analysts can see
      // which buckets are under-sampled.
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

    return NextResponse.json({
      processed_count,
      updated_count,
      skipped_count,
      strategy_snapshots,
      calibration_snapshots,
      duration_ms: Date.now() - start,
    });
  } catch (err) {
    console.error('[feedback/evaluate]', err);
    return NextResponse.json(
      {
        error: 'Feedback evaluation failed',
        details: err instanceof Error ? err.message : String(err),
      },
      { status: 500 },
    );
  }
}
