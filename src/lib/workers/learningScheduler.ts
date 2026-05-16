// ════════════════════════════════════════════════════════════════
//  Learning Scheduler — Quantorus365
//
//  Runs the five daily feedback jobs that turn logged signals into
//  measurable learning:
//
//    A. evaluateSignalOutcomes       — walk candles, compute MFE/MAE,
//                                       grade each signal's outcome
//    B. updateConfidenceCalibration  — bucket outcomes by confidence
//                                       band, compare actual vs expected
//    C. updateStrategyPerformance    — perf by (strategy × regime ×
//                                       volatility × sector)
//    D. updateAdaptiveRecommendations— per-cell score modifiers from (C)
//    E. updateManipulationCalibration— refresh 3 suspicion watchlists,
//                                       rebuild detector accuracy snapshots
//
//  Design constraints:
//    - Idempotent: re-runnable on the same day. Outcome writes skip
//      already-graded signals; calibration/perf/adaptive rows for today
//      are cleared before re-insert; manipulation watchlist writes use
//      ON DUPLICATE KEY UPDATE internally.
//    - Fail-isolated: a failing job logs its failure but does NOT halt
//      the rest. A corrupt calibration must not prevent outcome writes.
//    - Every job records a row in q365_learning_job_runs with counts +
//      duration so an operator can inspect the day's learning state at
//      a glance.
//
//  Triggering:
//    - Manual:  `node -r ts-node/register src/lib/workers/learningScheduler.ts`
//    - Cron:    import { runLearningJobs } and schedule once per day,
//               after 18:30 IST (post-EOD candles landed).
//    - API:     wire runLearningJobs() behind an admin POST endpoint if
//               you need an on-demand "rebuild learning state" button.
// ════════════════════════════════════════════════════════════════

// ── Bootstrap: load .env.local + path aliases before any @/ import ──
// PM2 launches this worker as a standalone tsx process, so Next.js's
// automatic env loader never runs. Without this, DATABASE_URL comes up
// undefined and the very first db.query() throws. Prefers the absolute
// DOTENV_CONFIG_PATH (set by ecosystem.config.js) over cwd, because
// PM2's saved cwd can drift from the deploy path after a dump/restore.
import 'tsconfig-paths/register';
import * as fs from 'fs';
import * as path from 'path';
const envPath = process.env.DOTENV_CONFIG_PATH || path.resolve(process.cwd(), '.env.local');
try {
  const envFile = fs.readFileSync(envPath, 'utf-8');
  for (const line of envFile.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq > 0) {
      const k = trimmed.slice(0, eq).trim();
      const v = trimmed.slice(eq + 1).trim().replace(/^['"]|['"]$/g, '');
      if (!process.env[k]) process.env[k] = v;
    }
  }
} catch (err) {
  // Don't swallow — surface the real reason in pm2 logs.
  console.warn(`[learning] env load failed at ${envPath}: ${(err as Error).message}`);
}

import { db } from '@/lib/db';
import {
  evaluateOutcome,
  aggregatePerformance,
  calibrateConfidence,
  computeAdaptiveRecommendation,
} from '@/lib/signal-engine/feedback/outcomeTracker';
import {
  saveOutcome,
  ensurePhase4Tables,
} from '@/lib/signal-engine/repository/savePhase4Artifacts';
import {
  saveConfidenceCalibration,
  saveStrategyPerformance,
  saveAdaptiveRecommendation,
  clearTodaysLearningSnapshots,
  logLearningJobRun,
  ensureLearningTables,
} from '@/lib/signal-engine/repository/saveLearningArtifacts';
import type {
  SignalOutcome,
  StrategyPerformanceSnapshot,
} from '@/lib/signal-engine/types/phase4.types';
import {
  ensureManipulationEngineTables,
  loadSnapshotsByDate,
  loadWatchlistForSymbol,
  evaluateWatchlists,
  diffWatchlistState,
  applyWatchlistChanges,
  buildCalibrationSnapshots,
  persistCalibrationSnapshots,
  type CalibrationInputTrade,
} from '@/lib/manipulation-engine';
import { ensureNewsSchemas } from '@/lib/news-engine/repository/ensureNewsSchemas';
import { runNewsCalibration } from '@/lib/news-engine/feedback/runNewsCalibration';

// ════════════════════════════════════════════════════════════════
//  TUNABLES
// ════════════════════════════════════════════════════════════════

const OUTCOME_LOOKBACK_DAYS      = 30;    // how far back to scan q365_signals
const OUTCOME_MIN_POST_BARS      = 5;     // fewer → signal is too young to grade
const OUTCOME_MAX_POST_BARS      = 12;    // enough to hit target2/target3 or stop
const OUTCOME_BATCH_LOG_EVERY    = 50;    // progress log cadence

const CALIBRATION_LOOKBACK_DAYS  = 90;    // window for bucket/perf aggregation
const PERF_MIN_SAMPLES           = 5;     // aggregatePerformance also enforces this

// ════════════════════════════════════════════════════════════════
//  SHARED TYPES
// ════════════════════════════════════════════════════════════════

interface SignalRow {
  id:            number;
  symbol:        string;
  direction:     string;
  entry_price:   number;
  stop_loss:     number;
  target1:       number;
  target2:       number;
  confidence_score: number;
  market_regime: string | null;
  signal_type:   string | null;
  scenario_tag:  string | null;
  generated_at:  Date | string;
}

interface PostCandle {
  ts:    Date | string;
  high:  number;
  low:   number;
  close: number;
}

// ════════════════════════════════════════════════════════════════
//  A. evaluateSignalOutcomes
// ════════════════════════════════════════════════════════════════

export async function evaluateSignalOutcomes(): Promise<{
  scanned: number; evaluated: number; skippedYoung: number; skippedExisting: number; failed: number;
}> {
  console.log('[learning:A] evaluateSignalOutcomes — start');
  const counts = { scanned: 0, evaluated: 0, skippedYoung: 0, skippedExisting: 0, failed: 0 };

  // Pull recent signals that are old enough for at least OUTCOME_MIN_POST_BARS
  // trading days to have passed. We lean on created_at so backfills don't
  // get re-evaluated unnecessarily.
  const { rows: sigRows } = await db.query(
    `SELECT s.id, s.symbol, s.direction,
            s.entry_price, s.stop_loss, s.target1, s.target2,
            s.confidence_score, s.market_regime, s.signal_type, s.scenario_tag,
            s.generated_at
       FROM q365_signals s
      WHERE s.generated_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
        AND s.generated_at <= DATE_SUB(NOW(), INTERVAL ? DAY)
        AND s.entry_price IS NOT NULL
        AND s.stop_loss   IS NOT NULL
        AND s.target1     IS NOT NULL`,
    [OUTCOME_LOOKBACK_DAYS, Math.max(1, Math.floor(OUTCOME_MIN_POST_BARS * 1.4))],
  );
  const signals = sigRows as unknown as SignalRow[];
  counts.scanned = signals.length;
  console.log(`[learning:A] scanned ${counts.scanned} candidate signals`);

  if (signals.length === 0) return counts;

  // Skip signals that already have an outcome row (idempotency).
  const ids = signals.map((s) => s.id);
  const placeholders = ids.map(() => '?').join(',');
  const { rows: existingRows } = await db.query(
    `SELECT signal_id FROM q365_signal_outcomes WHERE signal_id IN (${placeholders})`,
    ids,
  );
  const graded = new Set<number>((existingRows as any[]).map((r) => Number(r.signal_id)));

  let processed = 0;
  for (const sig of signals) {
    processed++;
    if (graded.has(sig.id)) {
      counts.skippedExisting++;
      continue;
    }

    try {
      // Fetch post-signal candles from market_data_daily (strictly after
      // the signal's generated_at so we're not grading on the signal bar
      // itself).
      const { rows: cRows } = await db.query(
        `SELECT ts, high, low, close
           FROM market_data_daily
          WHERE symbol = ?
            AND ts > ?
          ORDER BY ts ASC
          LIMIT ?`,
        [sig.symbol, sig.generated_at, OUTCOME_MAX_POST_BARS],
      );
      const postCandles = (cRows as any[]).map((r) => ({
        ts:    r.ts,
        high:  Number(r.high),
        low:   Number(r.low),
        close: Number(r.close),
      })) as PostCandle[];

      if (postCandles.length < OUTCOME_MIN_POST_BARS) {
        counts.skippedYoung++;
        continue;
      }

      // The evaluator wants target3. For signals generated by the legacy
      // pipeline there's only target1/target2 in the row, so we extrapolate
      // a 3.5R level the same way the Phase 3 trade-plan builder does.
      const entry    = Number(sig.entry_price);
      const stop     = Number(sig.stop_loss);
      const target1  = Number(sig.target1);
      const target2  = Number(sig.target2 ?? target1);
      const isBearish = (sig.direction || '').toUpperCase() === 'SELL';
      const risk      = Math.abs(entry - stop);
      const target3   = isBearish ? entry - 3.5 * risk : entry + 3.5 * risk;

      const outcome = evaluateOutcome(
        sig.id, entry, stop, target1, target2, target3, postCandles, isBearish,
      );
      await saveOutcome(outcome);
      counts.evaluated++;
    } catch (err) {
      counts.failed++;
      console.error(`[learning:A] signal ${sig.id} (${sig.symbol}) failed:`, (err as Error).message);
    }

    if (processed % OUTCOME_BATCH_LOG_EVERY === 0) {
      console.log(`[learning:A]   progress: ${processed}/${signals.length}`);
    }
  }

  console.log(`[learning:A] evaluated=${counts.evaluated} skippedYoung=${counts.skippedYoung} skippedExisting=${counts.skippedExisting} failed=${counts.failed}`);
  return counts;
}

// ════════════════════════════════════════════════════════════════
//  Shared loader: outcomes joined with signal metadata
// ════════════════════════════════════════════════════════════════

interface OutcomeWithMeta {
  outcome: SignalOutcome;
  confidence: number;
  strategyName: string;
  regime: string;
  volatilityState: string;
  sector: string | null;
}

async function loadOutcomesWithMeta(lookbackDays: number): Promise<OutcomeWithMeta[]> {
  const { rows } = await db.query(
    `SELECT o.signal_id, o.entry_triggered, o.bars_to_entry,
            o.target1_hit, o.target2_hit, o.target3_hit, o.stop_hit,
            o.max_fav_excursion_pct, o.max_adv_excursion_pct,
            o.pnl_r,
            o.return_bar5_pct, o.return_bar10_pct,
            o.outcome_label, o.evaluated_at,
            s.confidence_score, s.signal_type, s.market_regime,
            s.volatility_state, s.sector
       FROM q365_signal_outcomes o
       JOIN q365_signals s ON s.id = o.signal_id
      WHERE o.evaluated_at >= DATE_SUB(NOW(), INTERVAL ? DAY)`,
    [lookbackDays],
  );

  return (rows as any[]).map((r) => {
    const outcome: SignalOutcome = {
      signalId:                 Number(r.signal_id),
      entryTriggered:           Number(r.entry_triggered) === 1,
      barsToEntry:              r.bars_to_entry != null ? Number(r.bars_to_entry) : null,
      target1Hit:               Number(r.target1_hit) === 1,
      target2Hit:               Number(r.target2_hit) === 1,
      target3Hit:               Number(r.target3_hit) === 1,
      stopHit:                  Number(r.stop_hit) === 1,
      maxFavorableExcursionPct: Number(r.max_fav_excursion_pct),
      maxAdverseExcursionPct:   Number(r.max_adv_excursion_pct),
      pnlR:                    Number(r.pnl_r ?? 0),
      returnAtBar5Pct:          r.return_bar5_pct != null ? Number(r.return_bar5_pct) : null,
      returnAtBar10Pct:         r.return_bar10_pct != null ? Number(r.return_bar10_pct) : null,
      outcomeLabel:             r.outcome_label,
      evaluatedAt:              String(r.evaluated_at),
    };
    return {
      outcome,
      confidence:      Number(r.confidence_score ?? 0),
      strategyName:    String(r.signal_type ?? 'unknown'),
      regime:          String(r.market_regime ?? 'NEUTRAL'),
      volatilityState: String(r.volatility_state ?? 'normal'),
      sector:          r.sector ? String(r.sector) : null,
    };
  });
}

// ════════════════════════════════════════════════════════════════
//  B. updateConfidenceCalibration
// ════════════════════════════════════════════════════════════════

function bucketForConfidence(score: number): '85_100' | '70_84' | '55_69' | '0_54' {
  if (score >= 85) return '85_100';
  if (score >= 70) return '70_84';
  if (score >= 55) return '55_69';
  return '0_54';
}

export async function updateConfidenceCalibration(
  rows?: OutcomeWithMeta[],
): Promise<{ loaded: number; buckets: number; persisted: number }> {
  console.log('[learning:B] updateConfidenceCalibration — start');
  const all = rows ?? (await loadOutcomesWithMeta(CALIBRATION_LOOKBACK_DAYS));
  const byBucket = new Map<string, SignalOutcome[]>();
  for (const r of all) {
    const b = bucketForConfidence(r.confidence);
    const list = byBucket.get(b) ?? [];
    list.push(r.outcome);
    byBucket.set(b, list);
  }

  let persisted = 0;
  for (const [bucket, outcomes] of Array.from(byBucket.entries())) {
    const snap = calibrateConfidence(bucket, outcomes);
    await saveConfidenceCalibration(snap);
    persisted++;
  }

  console.log(`[learning:B] loaded=${all.length} buckets=${byBucket.size} persisted=${persisted}`);
  return { loaded: all.length, buckets: byBucket.size, persisted };
}

// ════════════════════════════════════════════════════════════════
//  C. updateStrategyPerformanceSnapshots
// ════════════════════════════════════════════════════════════════

export async function updateStrategyPerformanceSnapshots(
  rows?: OutcomeWithMeta[],
): Promise<{
  loaded: number; cells: number; persisted: number; snapshots: StrategyPerformanceSnapshot[];
}> {
  console.log('[learning:C] updateStrategyPerformance — start');
  const all = rows ?? (await loadOutcomesWithMeta(CALIBRATION_LOOKBACK_DAYS));

  // Bucket by (strategy × regime × volatility × sector).
  type Key = string;
  const groups = new Map<Key, {
    strategyName: string; regime: string; volatilityState: string; sector: string | null;
    outcomes: SignalOutcome[];
  }>();
  const keyFor = (r: OutcomeWithMeta): Key =>
    `${r.strategyName}|${r.regime}|${r.volatilityState}|${r.sector ?? '∅'}`;

  for (const r of all) {
    const k = keyFor(r);
    const g = groups.get(k);
    if (g) g.outcomes.push(r.outcome);
    else groups.set(k, {
      strategyName: r.strategyName, regime: r.regime,
      volatilityState: r.volatilityState, sector: r.sector,
      outcomes: [r.outcome],
    });
  }

  const snapshots: StrategyPerformanceSnapshot[] = [];
  let persisted = 0;
  for (const g of Array.from(groups.values())) {
    if (g.outcomes.length < PERF_MIN_SAMPLES) continue;
    const snap = aggregatePerformance(
      g.strategyName, g.regime, g.volatilityState, g.outcomes, g.sector,
    );
    await saveStrategyPerformance(snap);
    snapshots.push(snap);
    persisted++;
  }

  console.log(`[learning:C] loaded=${all.length} cells=${groups.size} persisted=${persisted}`);
  return { loaded: all.length, cells: groups.size, persisted, snapshots };
}

// ════════════════════════════════════════════════════════════════
//  D. updateAdaptiveRecommendations
// ════════════════════════════════════════════════════════════════

export async function updateAdaptiveRecommendations(
  perfSnapshots: StrategyPerformanceSnapshot[],
): Promise<{ considered: number; persisted: number }> {
  console.log('[learning:D] updateAdaptiveRecommendations — start');
  let persisted = 0;
  for (const perf of perfSnapshots) {
    const rec = computeAdaptiveRecommendation(perf);
    await saveAdaptiveRecommendation(
      rec, perf.strategyName, perf.regime, perf.volatilityState, perf.sector,
    );
    persisted++;
  }
  console.log(`[learning:D] considered=${perfSnapshots.length} persisted=${persisted}`);
  return { considered: perfSnapshots.length, persisted };
}

// ════════════════════════════════════════════════════════════════
//  E. updateManipulationCalibration
// ════════════════════════════════════════════════════════════════

export async function updateManipulationCalibration(): Promise<{
  snapshotsLoaded: number; watchlistChanges: number; calibrationRows: number;
}> {
  console.log('[learning:E] updateManipulationCalibration — start');
  const counts = { snapshotsLoaded: 0, watchlistChanges: 0, calibrationRows: 0 };

  // ── Watchlist refresh ─────────────────────────────────────
  // Use today's snapshots first; if none landed yet (e.g. scheduler runs
  // before the manipulation sweep), fall back to the most recent date.
  const today = new Date().toISOString().slice(0, 10);
  let snaps = await loadSnapshotsByDate(today);
  if (snaps.length === 0) {
    const { rows } = await db.query(
      `SELECT MAX(snapshot_date) AS d FROM q365_manipulation_snapshots`,
    );
    const latest = (rows[0] as any)?.d;
    if (latest) {
      const latestDate = typeof latest === 'string'
        ? latest.slice(0, 10)
        : new Date(latest).toISOString().slice(0, 10);
      snaps = await loadSnapshotsByDate(latestDate);
    }
  }
  counts.snapshotsLoaded = snaps.length;

  for (const snap of snaps) {
    try {
      const current = await loadWatchlistForSymbol(snap.symbol);
      const decisions = evaluateWatchlists(snap);
      const changes   = diffWatchlistState(snap, decisions, current);
      if (changes.length > 0) {
        await applyWatchlistChanges(changes);
        counts.watchlistChanges += changes.length;
      }
    } catch (err) {
      console.error(`[learning:E] watchlist refresh failed for ${snap.symbol}:`, (err as Error).message);
    }
  }

  // ── Detection accuracy calibration ────────────────────────
  // Correlate recent manipulation scores with Phase 4 outcomes: a signal
  // that fired while a symbol was flagged "elevated+" and went on to stop
  // out is a true-ish positive; one that hit target1 suggests the flag
  // didn't actually predict failure. This is a coarse proxy until we have
  // explicit ground-truth labels, but it keeps the calibration table fresh.
  const { rows: tradeRows } = await db.query(
    `SELECT ms.manipulation_score AS score,
            o.outcome_label       AS outcome,
            o.return_bar10_pct    AS pnl
       FROM q365_signal_outcomes o
       JOIN q365_signals s ON s.id = o.signal_id
       JOIN q365_manipulation_snapshots ms
         ON ms.symbol = s.symbol
        AND DATE(ms.snapshot_date) = DATE(s.generated_at)
      WHERE o.evaluated_at >= DATE_SUB(NOW(), INTERVAL ? DAY)`,
    [CALIBRATION_LOOKBACK_DAYS],
  );

  const trades: CalibrationInputTrade[] = (tradeRows as any[]).map((r) => ({
    score: r.score != null ? Number(r.score) : null,
    // evaluateOutcome's label semantics → manipulation calibration outcomes
    outcome: r.outcome === 'good_followthrough' || r.outcome === 'partial_success'
      ? 'win'
      : r.outcome === 'stopped_out'
        ? 'loss'
        : 'breakeven',
    pnlPct: r.pnl != null ? Number(r.pnl) : undefined,
    isFalseBreakout: r.outcome === 'stopped_out',
  }));

  if (trades.length > 0) {
    // Idempotent same-day replace.
    await db.query(
      `DELETE FROM q365_manipulation_calibration_snapshots
        WHERE run_id IS NULL AND DATE(created_at) = CURDATE()`,
    ).catch(() => {});
    const records = buildCalibrationSnapshots(null, today, trades);
    await persistCalibrationSnapshots(records);
    counts.calibrationRows = records.length;
  }

  console.log(`[learning:E] snapshots=${counts.snapshotsLoaded} watchlistChanges=${counts.watchlistChanges} calibrationRows=${counts.calibrationRows}`);
  return counts;
}

// ════════════════════════════════════════════════════════════════
//  ORCHESTRATOR
// ════════════════════════════════════════════════════════════════

interface JobResult {
  name:       string;
  status:     'success' | 'failed' | 'skipped';
  durationMs: number;
  counts:     Record<string, number>;
  error?:     string;
}

async function runJob<T extends Record<string, any>>(
  name: string,
  fn: () => Promise<T>,
): Promise<{ result: JobResult; payload: T | null }> {
  const start = Date.now();
  try {
    const out = await fn();
    const counts: Record<string, number> = {};
    for (const [k, v] of Object.entries(out)) {
      if (typeof v === 'number') counts[k] = v;
    }
    const durationMs = Date.now() - start;
    const result: JobResult = { name, status: 'success', durationMs, counts };
    await logLearningJobRun({ jobName: name, status: 'success', durationMs, counts });
    console.log(`[learning] ✓ ${name} (${durationMs}ms)`, counts);
    return { result, payload: out };
  } catch (err) {
    const durationMs = Date.now() - start;
    const msg = (err as Error).message;
    const result: JobResult = { name, status: 'failed', durationMs, counts: {}, error: msg };
    try {
      await logLearningJobRun({
        jobName: name, status: 'failed', durationMs, counts: {}, errorMsg: msg,
      });
    } catch { /* logging must not mask original failure */ }
    console.error(`[learning] ✗ ${name} failed after ${durationMs}ms:`, msg);
    return { result, payload: null };
  }
}

export async function runLearningJobs(): Promise<JobResult[]> {
  console.log('\n══════════════════════════════════════════════════');
  console.log(`  Learning Scheduler — ${new Date().toISOString()}`);
  console.log('══════════════════════════════════════════════════\n');

  // Ensure all target tables exist before writing.
  await ensurePhase4Tables();
  await ensureLearningTables();
  await ensureManipulationEngineTables();
  await ensureNewsSchemas();

  // Idempotency: clear today's derivative snapshots before recomputing.
  // Outcomes are NOT cleared — they're graded once per signal and the
  // outcome loader explicitly skips signals that already have a row.
  await clearTodaysLearningSnapshots();

  const results: JobResult[] = [];

  // A. Outcomes — must run first; the rest depend on fresh outcome rows.
  const a = await runJob('evaluateSignalOutcomes', evaluateSignalOutcomes);
  results.push(a.result);

  // Load the outcome-with-metadata set once and reuse it across B and C so
  // we don't hit the DB twice for the same 90-day window.
  let outcomesForLearning: OutcomeWithMeta[] = [];
  try {
    outcomesForLearning = await loadOutcomesWithMeta(CALIBRATION_LOOKBACK_DAYS);
  } catch (err) {
    console.error('[learning] outcome meta load failed:', (err as Error).message);
  }

  // B. Confidence calibration
  const b = await runJob('updateConfidenceCalibration',
    () => updateConfidenceCalibration(outcomesForLearning));
  results.push(b.result);

  // C. Strategy performance
  const c = await runJob('updateStrategyPerformanceSnapshots',
    () => updateStrategyPerformanceSnapshots(outcomesForLearning));
  results.push(c.result);

  // D. Adaptive recommendations — consumes C's snapshots.
  const perfSnapshots = c.payload?.snapshots ?? [];
  const d = await runJob('updateAdaptiveRecommendations',
    () => updateAdaptiveRecommendations(perfSnapshots));
  results.push(d.result);

  // E. Manipulation calibration
  const e = await runJob('updateManipulationCalibration', updateManipulationCalibration);
  results.push(e.result);

  // F. News intelligence calibration — links news → signals → outcomes,
  //    calibrates by category/source/sentiment, generates bounded
  //    adaptive recommendations. Depends on A (outcomes) being fresh.
  const f = await runJob('updateNewsCalibration', () => runNewsCalibration(CALIBRATION_LOOKBACK_DAYS));
  results.push(f.result);

  const failures = results.filter((r) => r.status === 'failed').length;
  console.log('\n══════════════════════════════════════════════════');
  console.log(`  Learning run complete — ${results.length - failures}/${results.length} jobs succeeded`);
  console.log('══════════════════════════════════════════════════\n');

  return results;
}

// ════════════════════════════════════════════════════════════════
//  CLI ENTRYPOINT (manual trigger via `node ... learningScheduler.js`)
// ════════════════════════════════════════════════════════════════

// When this module is executed directly (not imported), run the full
// pipeline and exit with a non-zero code on any failure. Safe to invoke
// from cron, systemd, PM2, or a manual shell.
if (require.main === module) {
  runLearningJobs()
    .then((results) => {
      const failed = results.some((r) => r.status === 'failed');
      process.exit(failed ? 1 : 0);
    })
    .catch((err) => {
      console.error('[learning] fatal:', err);
      process.exit(1);
    });
}
