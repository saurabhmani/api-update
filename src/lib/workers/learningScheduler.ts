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
//    - Phase 8 governance: this scheduler OBSERVES and RECOMMENDS.
//      It MUST NOT silently rewrite production weights. Auto-approve/
//      auto-promote are OFF by default and still emit versioned
//      approval events when explicitly enabled. Learning never bypasses
//      Phase 3 rejection floors (modifiers are capped).
//
//  Triggering:
//    - Manual:  `node -r ts-node/register src/lib/workers/learningScheduler.ts`
//    - Cron:    import { runLearningJobs } and schedule once per day,
//               after 18:30 IST (post-EOD candles landed).
//    - API:     wire runLearningJobs() behind an admin POST endpoint if
//               you need an on-demand "rebuild learning state" button.
// ════════════════════════════════════════════════════════════════

// ── Bootstrap: load project env + path aliases before any @/ import ──
// PM2 launches this worker as a standalone tsx process, so Next.js's
// automatic env loader never runs. Prefers DOTENV_CONFIG_PATH (set by
// ecosystem.config.js) → `.env` on prod → `.env.local` in dev.
import 'tsconfig-paths/register';
import * as fs from 'fs';
import { resolveEnvFilePath } from '@/lib/envPath';
const envPath = resolveEnvFilePath();
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
  learningMayAutoApprove,
  learningMayAutoPromote,
  recordVersionedApprovalEvent,
  assessOutcomeCompleteness,
} from '@/lib/signal-engine/learning/modelGovernance';
import {
  saveOutcome,
  ensurePhase4Tables,
} from '@/lib/signal-engine/repository/savePhase4Artifacts';
import {
  saveConfidenceCalibration,
  saveCalibrationAudit,
  loadLatestCalibrationModifiers,
  saveStrategyPerformance,
  saveAdaptiveRecommendation,
  clearTodaysLearningSnapshots,
  logLearningJobRun,
  ensureLearningTables,
} from '@/lib/signal-engine/repository/saveLearningArtifacts';
import {
  computeEmpiricalBucketMetrics,
  confidenceBucketForScore,
  applyCycleBound,
  setCalibrationCellCache,
  CONFIDENCE_MODEL_VERSION,
  CALIBRATION_MIN_PARTIAL,
  type EmpiricalBucketMetrics,
  type EmpiricalOutcomeRow,
} from '@/lib/signal-engine/scoring/empiricalCalibration';
import { buildConfidenceReliabilityReport } from '@/lib/signal-engine/scoring/confidenceReliabilityReport';
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
import type { OutcomeAnalyticsRecord } from '@/lib/signal-engine/analytics/outcomeAnalytics';
import { createLearningSnapshot } from '@/lib/signal-engine/learning/versionedLearningSnapshots';
import { saveLearningSnapshot } from '@/lib/signal-engine/repository/learningSnapshotRepository';
import { getSignalEngineConfig } from '@/lib/signal-engine/config/signalEnginePhase2Config';
import { PERFORMANCE_REPORT_VERSION } from '@/lib/signal-engine/analytics/performanceReporting';
import { OUTCOME_INTELLIGENCE_VERSION } from '@/lib/signal-engine/feedback/outcomeTracker';
import { loadLatestLearningSnapshot } from '@/lib/signal-engine/repository/learningSnapshotRepository';
import { runAdaptiveLearningPipeline, hydrateAdaptiveRuntimeFromDb } from '@/lib/signal-engine/adaptive/runAdaptiveLearningPipeline';
import { ensureAdaptiveParameterTables } from '@/lib/signal-engine/adaptive/adaptiveParameterRepository';

// ════════════════════════════════════════════════════════════════
//  TUNABLES
// ════════════════════════════════════════════════════════════════

const OUTCOME_LOOKBACK_DAYS      = 30;    // how far back to scan q365_signals
const OUTCOME_MIN_POST_BARS      = 3;     // bar-count gate (authoritative); stop/target can resolve early
const OUTCOME_MIN_AGE_DAYS       = 3;     // coarse calendar prefilter only — must not exceed available history
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

  // Pull recent signals old enough that post-signal EOD bars are likely
  // available. The calendar floor is only a coarse prefilter — the real
  // readiness gate is OUTCOME_MIN_POST_BARS against market_data_daily.
  // Previously `MIN_POST_BARS * 1.4` (≈7 calendar days) permanently
  // excluded young environments whose oldest signals were ~5–6 days old,
  // leaving Trust Strategy Performance empty even with full geometry.
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
    [OUTCOME_LOOKBACK_DAYS, OUTCOME_MIN_AGE_DAYS],
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
      // Post-signal EOD bars only (exclude the signal's own session day).
      // Compare by DATE so midday generated_at values don't depend on
      // whether the warehouse stores midnight vs session timestamps.
      const { rows: cRows } = await db.query(
        `SELECT ts, high, low, close
           FROM market_data_daily
          WHERE symbol = ?
            AND DATE(ts) > DATE(?)
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
        {
          expectedRewardRisk: risk > 0 ? Math.abs(target1 - entry) / risk : 0,
          evaluatedAt: (() => {
            const raw = postCandles.at(-1)?.ts ?? sig.generated_at;
            if (raw instanceof Date) return raw.toISOString();
            return String(raw);
          })(),
          signalGeneratedAt: sig.generated_at instanceof Date
            ? sig.generated_at.toISOString()
            : String(sig.generated_at),
          signalStateAtResolution: 'evaluated',
        },
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
  symbol: string;
  generatedAt: string;
  confidence: number;
  expectedRewardRisk: number;
  strategyName: string;
  regime: string;
  volatilityState: string;
  sector: string | null;
  topContributingFeatures: Array<{ feature: string; score: number }>;
}

export async function loadOutcomesWithMeta(lookbackDays: number): Promise<OutcomeWithMeta[]> {
  const { rows } = await db.query(
    `SELECT o.signal_id, o.entry_triggered, o.bars_to_entry,
            o.target1_hit, o.target2_hit, o.target3_hit, o.stop_hit,
            o.max_fav_excursion_pct, o.max_adv_excursion_pct,
            o.pnl_r,
            o.return_bar5_pct, o.return_bar10_pct,
            o.outcome_label, o.evaluated_at,
            o.outcome_version, o.entry_quality_score,
            o.time_to_target_bars, o.time_to_stop_bars, o.holding_duration_bars,
            o.exit_reason, o.realized_return_pct, o.risk_adjusted_return,
            o.expected_reward_risk, o.realized_reward_risk, o.metadata_version,
            s.symbol, s.generated_at, s.confidence_score, s.risk_reward,
            s.signal_type, s.market_regime, s.volatility_state, s.sector,
            s.factor_scores_json
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
      evaluatedAt:              r.evaluated_at instanceof Date
        ? r.evaluated_at.toISOString()
        : String(r.evaluated_at),
      outcomeVersion:           r.outcome_version ? String(r.outcome_version) : undefined,
      entryQualityScore:        r.entry_quality_score != null ? Number(r.entry_quality_score) : undefined,
      timeToTargetBars:         r.time_to_target_bars != null ? Number(r.time_to_target_bars) : null,
      timeToStopBars:           r.time_to_stop_bars != null ? Number(r.time_to_stop_bars) : null,
      holdingDurationBars:      r.holding_duration_bars != null ? Number(r.holding_duration_bars) : undefined,
      exitReason:               r.exit_reason ?? undefined,
      realizedReturnPct:        r.realized_return_pct != null ? Number(r.realized_return_pct) : undefined,
      riskAdjustedReturn:       r.risk_adjusted_return != null ? Number(r.risk_adjusted_return) : undefined,
      expectedRewardRisk:       r.expected_reward_risk != null ? Number(r.expected_reward_risk) : undefined,
      realizedRewardRisk:       r.realized_reward_risk != null ? Number(r.realized_reward_risk) : undefined,
      metadataVersion:          r.metadata_version ? String(r.metadata_version) : undefined,
    };
    let factors: Record<string, unknown> = {};
    try {
      factors = typeof r.factor_scores_json === 'string'
        ? JSON.parse(r.factor_scores_json)
        : (r.factor_scores_json ?? {});
    } catch { /* malformed legacy JSON contributes no feature analytics */ }
    const topContributingFeatures = Object.entries(factors)
      .filter((entry): entry is [string, number] => Number.isFinite(Number(entry[1])))
      .map(([feature, score]) => ({ feature, score: Number(score) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 5);
    return {
      outcome,
      symbol:          String(r.symbol ?? 'unknown'),
      generatedAt:     r.generated_at instanceof Date ? r.generated_at.toISOString() : String(r.generated_at),
      confidence:      Number(r.confidence_score ?? 0),
      expectedRewardRisk: Number(r.expected_reward_risk ?? r.risk_reward ?? 0),
      strategyName:    String(r.signal_type ?? 'unknown'),
      regime:          String(r.market_regime ?? 'NEUTRAL'),
      volatilityState: String(r.volatility_state ?? 'normal'),
      sector:          r.sector ? String(r.sector) : null,
      topContributingFeatures,
    };
  });
}

function toAnalyticsRecords(rows: readonly OutcomeWithMeta[]): OutcomeAnalyticsRecord[] {
  return rows.map((row) => ({
    signalId: row.outcome.signalId,
    symbol: row.symbol,
    strategy: row.strategyName,
    sector: row.sector,
    marketRegime: row.regime,
    volatilityState: row.volatilityState,
    timeframe: 'daily',
    generatedAt: row.generatedAt,
    predictedConfidence: row.confidence,
    expectedRewardRisk: row.expectedRewardRisk,
    outcome: row.outcome,
    topContributingFeatures: row.topContributingFeatures,
  }));
}

export async function loadOutcomeAnalyticsRecords(
  lookbackDays = CALIBRATION_LOOKBACK_DAYS,
): Promise<OutcomeAnalyticsRecord[]> {
  await ensurePhase4Tables();
  return toAnalyticsRecords(await loadOutcomesWithMeta(lookbackDays));
}

export async function createScheduledLearningSnapshot(
  rows: readonly OutcomeWithMeta[],
): Promise<{ snapshots: number; sampleCount: number; snapshotId: string }> {
  const createdAt = new Date().toISOString();
  const config = getSignalEngineConfig();
  const records = toAnalyticsRecords(rows);
  const snapshot = createLearningSnapshot({
    records,
    createdAt,
    lookbackDays: CALIBRATION_LOOKBACK_DAYS,
    versions: {
      configurationVersion: config.configVersionLabel,
      featureVersion: '2.0.0',
      confidenceVersion: '2.0.0',
      learningVersion: '3.0.0',
      benchmarkVersion: PERFORMANCE_REPORT_VERSION,
      outcomeVersion: OUTCOME_INTELLIGENCE_VERSION,
    },
  });
  await saveLearningSnapshot(snapshot);
  return { snapshots: 1, sampleCount: records.length, snapshotId: snapshot.snapshotId };
}

// ════════════════════════════════════════════════════════════════
//  B. updateConfidenceCalibration
//
//  Empirical hierarchy cells + bounded modifiers. Learning adjusts
//  ranking among eligible signals only — never Phase 3 gates.
// ════════════════════════════════════════════════════════════════

function bucketForConfidence(score: number): string {
  return confidenceBucketForScore(score);
}

function toEmpiricalRow(r: OutcomeWithMeta): EmpiricalOutcomeRow {
  return {
    confidenceScore: r.confidence,
    strategy: r.strategyName,
    regime: r.regime,
    volatilityState: r.volatilityState,
    target1Hit: r.outcome.target1Hit,
    entryTriggered: r.outcome.entryTriggered,
    expired:
      r.outcome.outcomeLabel === 'expired' || r.outcome.outcomeLabel === 'stale_no_trigger',
    maxFavorableExcursionPct: r.outcome.maxFavorableExcursionPct,
    maxAdverseExcursionPct: r.outcome.maxAdverseExcursionPct,
    predictedProbability: Number.isFinite(r.confidence) ? r.confidence / 100 : null,
  };
}

function groupKey(
  bucket: string,
  strategy: string | null,
  regime: string | null,
  vol: string | null,
): string {
  return `${bucket}|${strategy ?? ''}|${regime ?? ''}|${vol ?? ''}`;
}

function buildHierarchyCells(rows: OutcomeWithMeta[]): EmpiricalBucketMetrics[] {
  const cells: EmpiricalBucketMetrics[] = [];
  const empirical = rows.map(toEmpiricalRow);

  type Dim = {
    strategy: string | null;
    regime: string | null;
    volatilityState: string | null;
  };

  const dimsList: Dim[] = [{ strategy: null, regime: null, volatilityState: null }];
  const strategies = new Set(rows.map((r) => r.strategyName));
  const regimes = new Set(rows.map((r) => r.regime));
  const vols = new Set(rows.map((r) => r.volatilityState));

  for (const s of strategies) {
    dimsList.push({ strategy: s, regime: null, volatilityState: null });
    for (const reg of regimes) {
      dimsList.push({ strategy: s, regime: reg, volatilityState: null });
      for (const v of vols) {
        dimsList.push({ strategy: s, regime: reg, volatilityState: v });
      }
    }
  }

  const buckets = new Set(empirical.map((r) => confidenceBucketForScore(r.confidenceScore)));
  for (const bucket of buckets) {
    for (const dims of dimsList) {
      const filtered = empirical.filter((r) => {
        if (confidenceBucketForScore(r.confidenceScore) !== bucket) return false;
        if (dims.strategy != null && r.strategy !== dims.strategy) return false;
        if (dims.regime != null && r.regime !== dims.regime) return false;
        if (dims.volatilityState != null && r.volatilityState !== dims.volatilityState) return false;
        return true;
      });
      if (filtered.length === 0) continue;
      cells.push(computeEmpiricalBucketMetrics(bucket, filtered, dims));
    }
  }
  return cells;
}

export async function updateConfidenceCalibration(
  rows?: OutcomeWithMeta[],
): Promise<{
  loaded: number;
  buckets: number;
  persisted: number;
  cells: number;
  auditRows: number;
  monotonicityOk: boolean;
  productionModifiersUpdated: boolean;
  completenessPassed: boolean;
}> {
  console.log('[learning:B] updateConfidenceCalibration — start');
  const all = rows ?? (await loadOutcomesWithMeta(CALIBRATION_LOOKBACK_DAYS));
  const completeness = assessOutcomeCompleteness(all.map((r) => r.outcome));
  // Phase 8: production weight changes require explicit auto-approve + auto-promote.
  // Default path OBSERVES metrics and records proposed modifiers without deploying them.
  const mayDeploy = learningMayAutoApprove() && learningMayAutoPromote() && completeness.passed;
  const cycleId = `calib_${new Date().toISOString().slice(0, 10)}`;
  const prevMods = await loadLatestCalibrationModifiers();

  // Legacy bucket-only snapshots (compat consumers) — freeze modifiers unless deploy allowed
  const byBucket = new Map<string, SignalOutcome[]>();
  for (const r of all) {
    const b = bucketForConfidence(r.confidence);
    const list = byBucket.get(b) ?? [];
    list.push(r.outcome);
    byBucket.set(b, list);
  }

  let persisted = 0;
  let productionModifiersUpdated = false;
  for (const [bucket, outcomes] of Array.from(byBucket.entries())) {
    const snap = calibrateConfidence(bucket, outcomes);
    const oldMod = prevMods.get(groupKey(bucket, null, null, null)) ?? 0;
    const proposed = snap.suggestedModifier ?? 0;
    const deployed =
      mayDeploy && outcomes.length >= CALIBRATION_MIN_PARTIAL
        ? applyCycleBound(oldMod, proposed)
        : oldMod;
    if (deployed !== oldMod) productionModifiersUpdated = true;
    await saveConfidenceCalibration({ ...snap, suggestedModifier: deployed });
    persisted++;
  }

  // Hierarchy cells: metrics always persisted; modifiers only when mayDeploy
  const cells = buildHierarchyCells(all);
  const appliedCells: EmpiricalBucketMetrics[] = [];
  let auditRows = 0;

  for (const cell of cells) {
    const key = groupKey(cell.bucket, cell.strategy, cell.regime, cell.volatilityState);
    const oldMod = prevMods.get(key) ?? 0;
    const proposed = cell.suggestedModifier;
    const bounded =
      !mayDeploy || cell.sampleSize < CALIBRATION_MIN_PARTIAL
        ? oldMod
        : applyCycleBound(oldMod, proposed);

    if (bounded !== oldMod) productionModifiersUpdated = true;

    const applied: EmpiricalBucketMetrics = {
      ...cell,
      suggestedModifier: bounded,
    };
    appliedCells.push(applied);

    if (bounded !== oldMod || cell.sampleSize >= CALIBRATION_MIN_PARTIAL) {
      await saveConfidenceCalibration(
        {
          bucket: cell.bucket,
          sampleSize: cell.sampleSize,
          target1HitRate: cell.actualPrecision,
          avgMFE: cell.avgMfe,
          calibrationState:
            cell.calibrationState === 'insufficient_data'
              ? 'insufficient_data'
              : cell.calibrationState === 'overconfident'
                ? 'overconfident'
                : cell.calibrationState === 'underconfident'
                  ? 'underconfident'
                  : 'well_calibrated',
          priorHitRate: cell.priorHitRate,
          wilsonLower: cell.wilsonLower,
          wilsonUpper: cell.wilsonUpper,
          brierScore: cell.brierScore,
          expectedCalibrationError: cell.expectedCalibrationError,
          avgMAE: cell.avgMae,
          entryTriggerRate: cell.entryTriggerRate,
          expiryRate: cell.expiryRate,
          suggestedModifier: bounded,
          evidenceWeight: cell.evidenceWeight,
          strategyName: cell.strategy,
          regime: cell.regime,
          volatilityState: cell.volatilityState,
          modelVersion: CONFIDENCE_MODEL_VERSION,
        },
        cell.strategy,
        cell.regime,
      );
      persisted++;

      const approverState = !mayDeploy || cell.sampleSize < CALIBRATION_MIN_PARTIAL || bounded === oldMod
        ? 'pending'
        : 'auto_applied';

      await saveCalibrationAudit({
        bucket: cell.bucket,
        strategyName: cell.strategy,
        regime: cell.regime,
        volatilityState: cell.volatilityState,
        oldModifier: oldMod,
        newModifier: bounded,
        proposedModifier: proposed,
        sampleSize: cell.sampleSize,
        actualPrecision: cell.actualPrecision,
        evidenceJson: {
          wilsonLower: cell.wilsonLower,
          wilsonUpper: cell.wilsonUpper,
          brierScore: cell.brierScore,
          ece: cell.expectedCalibrationError,
          evidenceWeight: cell.evidenceWeight,
          priorHitRate: cell.priorHitRate,
          completenessRate: completeness.completenessRate,
          mayDeploy,
          note: 'Phase 8 — observational by default; production deploy requires versioned approval flags',
        },
        approverState,
        modelVersion: CONFIDENCE_MODEL_VERSION,
        cycleId,
      });
      auditRows++;

      if (mayDeploy && bounded !== oldMod) {
        recordVersionedApprovalEvent({
          parameterId: `calib:${key}`,
          action: 'deploy',
          actor: 'learningScheduler',
          reason: `Auto-deploy calibration modifier ${oldMod}→${bounded} (cycle ${cycleId})`,
          evidence: {
            sampleSize: cell.sampleSize,
            proposed,
            bounded,
            completenessRate: completeness.completenessRate,
          },
          comparison: { oldMod, proposed, bounded },
          rollbackTo: String(oldMod),
        });
      }
    }
  }

  setCalibrationCellCache(appliedCells);
  const report = buildConfidenceReliabilityReport(appliedCells);
  console.log(
    `[learning:B] loaded=${all.length} buckets=${byBucket.size} cells=${cells.length} ` +
      `persisted=${persisted} audit=${auditRows} monotonicityOk=${report.monotonicityOk} ` +
      `mayDeploy=${mayDeploy} productionModifiersUpdated=${productionModifiersUpdated} ` +
      `completeness=${completeness.completenessRate}`,
  );
  return {
    loaded: all.length,
    buckets: byBucket.size,
    persisted,
    cells: cells.length,
    auditRows,
    monotonicityOk: report.monotonicityOk,
    productionModifiersUpdated,
    completenessPassed: completeness.passed,
  };
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
  await ensureAdaptiveParameterTables();
  await hydrateAdaptiveRuntimeFromDb();

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

  // G. Immutable analytics snapshot. This is report-only: it does not
  // write weights, confidence modifiers, rejection thresholds or signals.
  const g = await runJob('createVersionedLearningSnapshot',
    () => createScheduledLearningSnapshot(outcomesForLearning));
  results.push(g.result);

  // H. Adaptive candidate + validation pipeline (Phase 4).
  // Creates versioned parameter candidates from outcomes. Promotion
  // requires validation; auto-promote is opt-in via env flags.
  let priorSnapshot = null;
  try {
    priorSnapshot = await loadLatestLearningSnapshot();
  } catch { /* drift comparison is best-effort */ }
  const h = await runJob('runAdaptiveLearningPipeline', () =>
    runAdaptiveLearningPipeline({
      records: toAnalyticsRecords(outcomesForLearning),
      lookbackDays: CALIBRATION_LOOKBACK_DAYS,
      createdAt: new Date().toISOString(),
      priorSnapshot: priorSnapshot && priorSnapshot.snapshotId !== g.payload?.snapshotId
        ? priorSnapshot
        : null,
    }));
  results.push(h.result);

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
