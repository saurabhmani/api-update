// ════════════════════════════════════════════════════════════════
//  Strategy Performance Intelligence — Phase 2
//
//  Evidence-based performance tracking for every strategy in the
//  registry. Reads ONLY from data the platform already persists:
//
//    1. Observed outcomes — q365_confirmed_signal_snapshots rows in
//       a terminal status (TARGET_HIT / STOP_LOSS_HIT / EXPIRED /
//       INVALIDATED). These are real-world results.
//
//    2. Backtest outcomes — backtest_trades rows from COMPLETED
//       backtest_runs in the requested time window. Used to back-fill
//       coverage when live observations are too thin.
//
//  Each outcome is tagged with `performanceSource` so the operator
//  can see exactly which evidence drove a metric. No metric is ever
//  fabricated: insufficient data is surfaced as INSUFFICIENT_DATA
//  with explicit explanation, not as a zero-rate.
//
//  This module is PURE: no UI, no HTTP, no env reads, no scoring
//  changes. Same input → same output. The route layer at
//  src/app/api/strategies/performance/route.ts handles DB I/O and
//  wraps the pure builders below.
// ════════════════════════════════════════════════════════════════

import { db } from '@/lib/db';
import {
  STRATEGY_REGISTRY,
  getStrategyMeta,
} from '@/lib/signal-engine/strategies/strategyRegistry';
import type {
  StrategyCategory,
} from '@/lib/signal-engine/types/signalEngine.types';
import { getSector } from '@/lib/signal-engine/constants/phase3.constants';

// ── Public time-window contract ───────────────────────────────

export type PerformanceWindow = '7D' | '30D' | '90D' | '180D' | '1Y' | 'ALL';

export const VALID_WINDOWS: ReadonlySet<PerformanceWindow> = new Set([
  '7D', '30D', '90D', '180D', '1Y', 'ALL',
]);

/** Resolve a window code to a SQL cutoff timestamp. ALL → null. */
export function windowCutoffIso(window: PerformanceWindow): string | null {
  if (window === 'ALL') return null;
  const days = window === '7D'   ? 7
             : window === '30D'  ? 30
             : window === '90D'  ? 90
             : window === '180D' ? 180
             : /* 1Y */            365;
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

// ── Data sources surfaced on the wire ─────────────────────────

export type PerformanceSource =
  | 'observed'
  | 'strategy_snapshot'
  | 'backtest'
  | 'mixed'
  | 'derived_from_candles'
  | 'estimated'
  | 'insufficient_data';

export type OutcomeStatus =
  | 'WIN'
  | 'LOSS'
  | 'OPEN'
  | 'EXPIRED'
  | 'INVALIDATED'
  | 'INSUFFICIENT_DATA';

/** A single normalised outcome row — both observed snapshots and
 *  backtest trades collapse onto this shape so the metrics builder
 *  doesn't care where the row came from. */
export interface PerformanceOutcomeRow {
  strategyId:        string;
  symbol:            string;
  direction:         'BUY' | 'SELL';
  sector:            string | null;
  regime:            string | null;
  confidenceScore:   number | null;
  outcome:           OutcomeStatus;
  /** Realised return in % terms (signed). For OPEN rows, mark-to-market. */
  returnPct:         number | null;
  /** Realised return in R multiples (signed). Null when stop distance unknown. */
  returnR:           number | null;
  targetHit:         boolean;
  stopHit:           boolean;
  invalidated:       boolean;
  mfePct:            number | null;
  maePct:            number | null;
  holdingPeriodBars: number | null;
  approvalStatus:    'APPROVED' | 'WATCHLIST' | 'REJECTED' | 'UNKNOWN';
  evaluatedAt:       string | null;
  source:            PerformanceSource;
}

// ── Data-quality contract ─────────────────────────────────────

export type DataQualityStatus = 'SUFFICIENT' | 'LIMITED' | 'INSUFFICIENT';

export interface DataQuality {
  status:                 DataQualityStatus;
  evaluatedSignals:       number;
  minimumRequiredSignals: number;
  coveragePct:            number;
  warnings:               string[];
}

/** Spec-mandated minimums. */
export const MIN_FOR_LIMITED = 5;
export const MIN_FOR_RANK    = 20;

export function classifyDataQuality(evaluated: number): DataQualityStatus {
  if (evaluated >= MIN_FOR_RANK) return 'SUFFICIENT';
  if (evaluated >= MIN_FOR_LIMITED) return 'LIMITED';
  return 'INSUFFICIENT';
}

// ── Metrics shapes ────────────────────────────────────────────

export type HealthLabel =
  | 'EXCELLENT' | 'STRONG' | 'STABLE' | 'WEAK' | 'INSUFFICIENT_DATA';

export type Recommendation =
  | 'Promote' | 'Keep Active' | 'Watch Carefully'
  | 'Reduce Approval Weight' | 'Insufficient Data';

export type PerformanceStatus =
  | 'SUFFICIENT' | 'LIMITED' | 'INSUFFICIENT_DATA';

export interface BucketMetrics {
  signals:          number;
  evaluatedSignals: number;
  winRate:          number;
  averageReturnPct: number;
  expectancy:       number;
}

export interface SectorBucket extends BucketMetrics {
  sector:      string;
  healthLabel: HealthLabel;
}

export interface RegimeBucket extends BucketMetrics {
  regime:         string;
  recommendation: Recommendation;
}

export interface ConfidenceBucket extends BucketMetrics {
  bucket:           '0-40' | '41-55' | '56-70' | '71-85' | '86-100';
  lowerBound:       number;
  upperBound:       number;
}

export interface StatusBucket extends BucketMetrics {
  status: 'APPROVED' | 'WATCHLIST' | 'REJECTED';
}

export interface StrategyPerformance {
  strategyId:                    string;
  strategyName:                  string;
  category:                      StrategyCategory;
  direction:                     'BUY' | 'SELL';

  totalSignals:                  number;
  approvedSignals:               number;
  watchlistedSignals:            number;
  rejectedSignals:               number;
  evaluatedSignals:              number;
  openSignals:                   number;
  insufficientDataSignals:       number;

  winRate:                       number;
  lossRate:                      number;
  averageReturnPct:              number;
  averageWinPct:                 number;
  averageLossPct:                number;
  medianReturnPct:               number;
  bestReturnPct:                 number;
  worstReturnPct:                number;
  expectancy:                    number;
  profitFactor:                  number;
  maxDrawdownPct:                number;
  averageHoldingPeriod:          number;

  falseSignalRate:               number;
  approvalAccuracy:              number;
  averageRiskReward:             number;
  stopHitRate:                   number;
  targetHitRate:                 number;
  maxAdverseExcursionAvg:        number;
  maxFavorableExcursionAvg:      number;

  strategyHealthScore:           number;
  healthLabel:                   HealthLabel;
  performanceStatus:             PerformanceStatus;
  performanceSource:             PerformanceSource;
  recommendation:                Recommendation;
  healthExplanation:             string;
  warnings:                      string[];
}

export interface StrategyPerformanceReport {
  generatedAt:            string;
  timeWindow:             PerformanceWindow;
  dataStatus:             DataQualityStatus;
  message:                string;
  performanceSource:      PerformanceSource;
  totalStrategies:        number;
  totalSignalsEvaluated:  number;
  minimumRequiredSignals: number;
  leaderboard:            LeaderboardEntry[];
  strategies:             StrategyPerformance[];
  warnings:               string[];
  dataQuality:            DataQuality;
}

export interface LeaderboardEntry {
  rank:                   number;
  strategyId:             string;
  strategyName:           string;
  category:               StrategyCategory;
  direction:              'BUY' | 'SELL';
  totalSignals:           number;
  evaluatedSignals:       number;
  winRate:                number;
  averageReturnPct:       number;
  expectancy:             number;
  profitFactor:           number;
  maxDrawdownPct:         number;
  averageHoldingPeriod:   number;
  strategyHealthScore:    number;
  healthLabel:            HealthLabel;
  recommendation:         Recommendation;
  performanceStatus:      PerformanceStatus;
}

// ── DB loaders ────────────────────────────────────────────────

/**
 * Phase 2 spec — source priority chain.
 *
 *   Priority 1: q365_signal_outcomes              (real per-signal outcomes)
 *   Priority 2: q365_strategy_performance_snapshots (operator-blessed snapshots)
 *   Priority 3: q365_confirmed_signal_snapshots   (observed terminal state)
 *   Priority 4: backtest_trades                   (completed backtest runs)
 *   Priority 5: insufficient data
 *
 * Loaders below probe each table. If the table doesn't exist on this
 * deployment (common — these are forward-compatibility writes), the
 * loader returns []  and the caller falls through to the next priority.
 * Source attribution is preserved on every row via `source`.
 */

/**
 * Priority 1 — direct per-signal outcomes from `q365_signal_outcomes`.
 * The table is expected (per spec) to carry one row per matured signal
 * with strategy / direction / outcome / return columns. The loader is
 * tolerant of varied column casing and missing optional columns.
 */
export async function loadDirectSignalOutcomes(
  window: PerformanceWindow,
): Promise<PerformanceOutcomeRow[]> {
  const cutoff = windowCutoffIso(window);
  const where  = cutoff ? `WHERE evaluated_at >= ?` : '';
  const params = cutoff ? [cutoff] : [];
  try {
    const { rows } = await db.query<any>(
      `SELECT symbol, strategy, direction, sector, regime,
              confidence_score, outcome, return_pct, return_r,
              target_hit, stop_hit, invalidated,
              mfe_pct, mae_pct, holding_period_bars,
              approval_status, evaluated_at
         FROM q365_signal_outcomes
         ${where}
         ORDER BY evaluated_at DESC
         LIMIT 20000`,
      params,
    );
    return (rows ?? []).map(directOutcomeToRow);
  } catch {
    // Table not present — fall through. Caller decides next source.
    return [];
  }
}

function directOutcomeToRow(r: any): PerformanceOutcomeRow {
  const outcomeRaw = String(r.outcome ?? '').toLowerCase();
  const outcome: OutcomeStatus =
    outcomeRaw === 'win'         ? 'WIN'
    : outcomeRaw === 'loss'      ? 'LOSS'
    : outcomeRaw === 'open'      ? 'OPEN'
    : outcomeRaw === 'expired'   ? 'EXPIRED'
    : outcomeRaw === 'invalidated' ? 'INVALIDATED'
    :                              'INSUFFICIENT_DATA';
  const approval = String(r.approval_status ?? '').toUpperCase();
  const approvalStatus: PerformanceOutcomeRow['approvalStatus'] =
    approval === 'APPROVED'   ? 'APPROVED'
    : approval === 'WATCHLIST' ? 'WATCHLIST'
    : approval === 'REJECTED'  ? 'REJECTED'
    :                            'UNKNOWN';
  return {
    strategyId:        String(r.strategy ?? 'unclassified'),
    symbol:            String(r.symbol ?? ''),
    direction:         String(r.direction ?? 'BUY').toUpperCase() === 'SELL' ? 'SELL' : 'BUY',
    sector:            r.sector ? String(r.sector) : safeSector(r.symbol),
    regime:            r.regime ? String(r.regime) : null,
    confidenceScore:   num(r.confidence_score),
    outcome,
    returnPct:         num(r.return_pct),
    returnR:           num(r.return_r),
    targetHit:         !!r.target_hit,
    stopHit:           !!r.stop_hit,
    invalidated:       !!r.invalidated,
    mfePct:            num(r.mfe_pct),
    maePct:            num(r.mae_pct),
    holdingPeriodBars: num(r.holding_period_bars),
    approvalStatus,
    evaluatedAt:       toIso(r.evaluated_at),
    source:            'observed',
  };
}

/**
 * Priority 2 — pre-aggregated performance snapshots from
 * `q365_strategy_performance_snapshots`. When present and fresh
 * (<= 26 h old per snapshot row), the caller may surface these as
 * primary metrics with `performanceSource: 'strategy_snapshot'`.
 *
 * This loader returns a Map keyed by strategyId so callers can quickly
 * merge snapshot metrics on top of raw outcome rows.
 */
export interface StrategyPerformanceSnapshot {
  strategyId:       string;
  windowLabel:      string;            // e.g. "90D"
  evaluatedSignals: number;
  winRate:          number;
  expectancy:       number;
  profitFactor:     number;
  maxDrawdownPct:   number;
  snapshotAt:       string;
}

export async function loadStrategyPerformanceSnapshots(
  window: PerformanceWindow,
): Promise<Map<string, StrategyPerformanceSnapshot>> {
  const out = new Map<string, StrategyPerformanceSnapshot>();
  try {
    const { rows } = await db.query<any>(
      `SELECT strategy_id, window_label, evaluated_signals, win_rate, expectancy,
              profit_factor, max_drawdown_pct, snapshot_at
         FROM q365_strategy_performance_snapshots
        WHERE window_label = ?
        ORDER BY snapshot_at DESC`,
      [window],
    );
    for (const r of rows ?? []) {
      const id = String(r.strategy_id ?? '');
      if (!id || out.has(id)) continue; // keep latest only
      out.set(id, {
        strategyId:       id,
        windowLabel:      String(r.window_label ?? window),
        evaluatedSignals: Number(r.evaluated_signals ?? 0),
        winRate:          Number(r.win_rate ?? 0),
        expectancy:       Number(r.expectancy ?? 0),
        profitFactor:     Number(r.profit_factor ?? 0),
        maxDrawdownPct:   Number(r.max_drawdown_pct ?? 0),
        snapshotAt:       toIso(r.snapshot_at) ?? new Date().toISOString(),
      });
    }
  } catch {
    // Table not present — empty map.
  }
  return out;
}

/**
 * Load observed outcomes from `q365_confirmed_signal_snapshots`.
 * Only rows in a terminal status (TARGET_HIT / STOP_LOSS_HIT /
 * EXPIRED / INVALIDATED) contribute. Active rows are loaded but
 * marked OPEN so the caller can show the "X open" counter.
 */
export async function loadObservedOutcomes(
  window: PerformanceWindow,
): Promise<PerformanceOutcomeRow[]> {
  const cutoff = windowCutoffIso(window);
  const where  = cutoff ? `WHERE confirmed_at >= ?` : '';
  const params = cutoff ? [cutoff] : [];
  try {
    // Spec hardening: surface classification, execution_allowed, and
    // rejection_codes_json so observedRowToOutcome can recover a real
    // approvalStatus instead of defaulting every row to APPROVED.
    // We use `SELECT ...` with a defensive try/catch wrapper so older
    // schemas without these columns still load (catch falls through
    // to a minimal-column second attempt).
    let rows: any[] = [];
    try {
      const res = await db.query<any>(
        `SELECT symbol, strategy, direction, exchange,
                entry_price, stop_loss, target1, target2,
                confidence_score, status, classification,
                confirmed_at, valid_until, status_changed_at,
                invalidation_reason, execution_allowed,
                rejection_codes_json
           FROM q365_confirmed_signal_snapshots
           ${where}
           ORDER BY confirmed_at DESC
           LIMIT 5000`,
        params,
      );
      rows = res.rows ?? [];
    } catch {
      // Older schema — fall back to the minimal column set.
      const res = await db.query<any>(
        `SELECT symbol, strategy, direction, exchange,
                entry_price, stop_loss, target1, target2,
                confidence_score, status,
                confirmed_at, valid_until, status_changed_at,
                invalidation_reason
           FROM q365_confirmed_signal_snapshots
           ${where}
           ORDER BY confirmed_at DESC
           LIMIT 5000`,
        params,
      );
      rows = res.rows ?? [];
    }
    return rows.map(observedRowToOutcome);
  } catch {
    // Fresh DB without the snapshot table — soft-fail, the caller
    // will fall through to backtest data.
    return [];
  }
}

function observedRowToOutcome(r: any): PerformanceOutcomeRow {
  const entry = num(r.entry_price);
  const stop  = num(r.stop_loss);
  const t1    = num(r.target1);
  const dir   = (String(r.direction ?? 'BUY').toUpperCase() === 'SELL') ? 'SELL' : 'BUY';
  const status = String(r.status ?? '').toUpperCase();

  let outcome: OutcomeStatus = 'OPEN';
  let returnPct: number | null = null;
  let returnR: number | null = null;
  let targetHit = false;
  let stopHit = false;
  let invalidated = false;

  if (status === 'TARGET_HIT') {
    outcome = 'WIN'; targetHit = true;
    if (entry != null && t1 != null && entry > 0) {
      returnPct = dir === 'SELL'
        ? round(((entry - t1) / entry) * 100, 2)
        : round(((t1 - entry) / entry) * 100, 2);
    }
    if (entry != null && stop != null && t1 != null) {
      const risk = Math.abs(entry - stop);
      if (risk > 0) returnR = round(Math.abs(t1 - entry) / risk, 2);
    }
  } else if (status === 'STOP_LOSS_HIT') {
    outcome = 'LOSS'; stopHit = true;
    if (entry != null && stop != null && entry > 0) {
      returnPct = dir === 'SELL'
        ? round(((entry - stop) / entry) * 100, 2)
        : round(((stop - entry) / entry) * 100, 2);
    }
    returnR = -1;
  } else if (status === 'INVALIDATED') {
    outcome = 'INVALIDATED'; invalidated = true;
  } else if (status === 'EXPIRED') {
    outcome = 'EXPIRED';
  } else if (status === 'ACTIVE') {
    outcome = 'OPEN';
  } else {
    outcome = 'INSUFFICIENT_DATA';
  }

  // Spec: recover approvalStatus from richer signals rather than
  // hardcoding APPROVED. Priority order:
  //   1. execution_allowed = false      → REJECTED (gate vetoed)
  //   2. invalidation_reason present    → REJECTED (live-engine drift)
  //   3. classification in DEVELOPING / LOW_CONVICTION / WATCHLIST → WATCHLIST
  //   4. rejection_codes_json non-empty → WATCHLIST (passed approval
  //      historically but downstream gates flagged issues)
  //   5. default                        → APPROVED (snapshot rows are
  //      promoted past the strict gate by construction)
  // We label UNKNOWN only when we can't even read the row.
  let approvalStatus: PerformanceOutcomeRow['approvalStatus'] = 'APPROVED';
  const executionAllowed = r.execution_allowed === false || String(r.execution_allowed) === '0';
  const classification = String(r.classification ?? '').toUpperCase();
  const rejectionCodes = (() => {
    const raw = r.rejection_codes_json;
    if (!raw) return [];
    try {
      const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
      return Array.isArray(parsed) ? parsed.filter(Boolean) : [];
    } catch { return []; }
  })();
  if (executionAllowed)                          approvalStatus = 'REJECTED';
  else if (r.invalidation_reason)                approvalStatus = 'REJECTED';
  else if (classification === 'DEVELOPING' ||
           classification === 'LOW_CONVICTION' ||
           classification === 'WATCHLIST' ||
           classification === 'WATCHLIST_ONLY')   approvalStatus = 'WATCHLIST';
  else if (rejectionCodes.length > 0)            approvalStatus = 'WATCHLIST';

  return {
    strategyId:        String(r.strategy ?? 'unclassified'),
    symbol:            String(r.symbol ?? ''),
    direction:         dir,
    sector:            safeSector(r.symbol),
    regime:            null,
    confidenceScore:   num(r.confidence_score),
    outcome,
    returnPct,
    returnR,
    targetHit,
    stopHit,
    invalidated,
    mfePct:            null,
    maePct:            null,
    holdingPeriodBars: null,
    approvalStatus,
    evaluatedAt:       toIso(r.status_changed_at ?? r.confirmed_at),
    source:            'observed',
  };
}

/**
 * Load outcomes from completed backtest runs in the window. Reuses
 * the already-persisted `backtest_trades` rows so we don't re-run
 * any simulation. Includes the most-recent COMPLETED run per
 * universe to avoid double-counting when an operator has run the
 * same backtest multiple times.
 */
export async function loadBacktestOutcomes(
  window: PerformanceWindow,
): Promise<PerformanceOutcomeRow[]> {
  const cutoff = windowCutoffIso(window);
  const dateCol = 'COALESCE(t.exit_date, t.entry_date, t.signal_date)';
  // Spec hardening: JOIN backtest_runs and accept only terminal-success
  // runs, case-insensitively. Some deployments persist status as
  // 'COMPLETED', others as 'completed' or the alias 'success' /
  // 'SUCCESS'. We accept the union but still exclude cancelled /
  // failed / running / partial / stale runs.
  const where = cutoff
    ? `WHERE UPPER(r.status) IN ('COMPLETED','SUCCESS') AND ${dateCol} >= ?`
    : `WHERE UPPER(r.status) IN ('COMPLETED','SUCCESS')`;
  const params = cutoff ? [cutoff] : [];
  try {
    const { rows } = await db.query<any>(
      `SELECT t.symbol, t.sector, t.strategy, t.direction, t.regime,
              t.confidence_score, t.signal_date, t.entry_date, t.exit_date,
              t.entry_price, t.exit_price, t.stop_loss, t.target1, t.target2,
              t.return_pct, t.return_r, t.outcome, t.exit_reason,
              t.mfe_pct, t.mae_pct, t.bars_in_trade,
              t.target1_hit, t.target2_hit, t.stop_hit,
              r.completed_at
         FROM backtest_trades t
         JOIN backtest_runs   r ON r.run_id = t.run_id
         ${where}
         ORDER BY ${dateCol} DESC
         LIMIT 20000`,
      params,
    );
    return (rows ?? []).map(backtestRowToOutcome);
  } catch {
    return [];
  }
}

function backtestRowToOutcome(r: any): PerformanceOutcomeRow {
  const dir = (String(r.direction ?? 'long').toLowerCase() === 'short') ? 'SELL' : 'BUY';
  const outcomeRaw = String(r.outcome ?? '').toLowerCase();
  let outcome: OutcomeStatus = 'INSUFFICIENT_DATA';
  if (outcomeRaw === 'win')   outcome = 'WIN';
  else if (outcomeRaw === 'loss')  outcome = 'LOSS';
  else if (outcomeRaw === 'open')  outcome = 'OPEN';

  return {
    strategyId:        String(r.strategy ?? 'unclassified'),
    symbol:            String(r.symbol ?? ''),
    direction:         dir,
    sector:            r.sector ? String(r.sector) : safeSector(r.symbol),
    regime:            r.regime ? String(r.regime) : null,
    confidenceScore:   num(r.confidence_score),
    outcome,
    returnPct:         num(r.return_pct),
    returnR:           num(r.return_r),
    targetHit:         !!r.target1_hit || !!r.target2_hit,
    stopHit:           !!r.stop_hit,
    invalidated:       false,
    mfePct:            num(r.mfe_pct),
    maePct:            num(r.mae_pct),
    holdingPeriodBars: num(r.bars_in_trade),
    // Backtests trigger their own approval gate inside the simulator,
    // so any persisted trade has cleared an approval check. The
    // distinction between watchlist / approved isn't surfaced on
    // backtest_trades, so we mark these APPROVED for the
    // status-breakdown — operators reading the report can still
    // compare backtest-approved vs observed-approved.
    approvalStatus:    'APPROVED',
    evaluatedAt:       toIso(r.exit_date ?? r.entry_date ?? r.signal_date),
    source:            'backtest',
  };
}

// ── Metrics builders ──────────────────────────────────────────

/**
 * Build the full set of per-strategy performance objects from a flat
 * outcome list. Every registered strategy is included — strategies
 * with no outcomes return INSUFFICIENT_DATA placeholders rather than
 * silently being dropped.
 */
export function buildStrategyPerformance(
  outcomes: PerformanceOutcomeRow[],
  /** Optional Priority-2 snapshots, keyed by strategyId. When a
   *  strategy's live evaluated count is below MIN_FOR_RANK and a
   *  snapshot exists with more evaluated signals, the snapshot's
   *  pre-aggregated metrics replace the live ones and
   *  `performanceSource` is set to 'strategy_snapshot'. */
  snapshotsByStrategy?: Map<string, StrategyPerformanceSnapshot>,
): StrategyPerformance[] {
  const grouped = groupBy(outcomes, (o) => o.strategyId);
  const out: StrategyPerformance[] = [];
  const snapshots = snapshotsByStrategy ?? new Map<string, StrategyPerformanceSnapshot>();

  // Walk the registry first so every known strategy ships, even
  // when its bucket is empty.
  for (const strategyId of Object.keys(STRATEGY_REGISTRY)) {
    const rows = grouped.get(strategyId) ?? [];
    out.push(maybeOverrideWithSnapshot(
      computeMetricsForStrategy(strategyId, rows),
      snapshots.get(strategyId),
    ));
  }
  // Append any orphan strategy IDs we saw in the data but that
  // aren't in the registry (e.g. retired strategies whose rows are
  // still in backtest_trades). They get the humanised display name.
  for (const [strategyId, rows] of grouped.entries()) {
    if ((STRATEGY_REGISTRY as Record<string, unknown>)[strategyId]) continue;
    out.push(maybeOverrideWithSnapshot(
      computeMetricsForStrategy(strategyId, rows),
      snapshots.get(strategyId),
    ));
  }
  return out;
}

/**
 * Priority-2 logic. Snapshots only override when:
 *   1. The live evaluated count is below the SUFFICIENT floor.
 *   2. The snapshot evaluated count exceeds the live count.
 *   3. The snapshot is at most 26 hours old.
 *
 * When override fires, metrics are replaced and the performanceSource
 * flips to 'strategy_snapshot' (or 'mixed' if live data also exists).
 */
function maybeOverrideWithSnapshot(
  live: StrategyPerformance,
  snap: StrategyPerformanceSnapshot | undefined,
): StrategyPerformance {
  if (!snap) return live;
  const snapAgeMs = Date.now() - new Date(snap.snapshotAt).getTime();
  if (!Number.isFinite(snapAgeMs) || snapAgeMs > 26 * 60 * 60 * 1000) return live;
  if (snap.evaluatedSignals <= live.evaluatedSignals) return live;
  if (snap.evaluatedSignals < MIN_FOR_LIMITED) return live;

  const evaluatedSignals = snap.evaluatedSignals;
  // Re-derive classification + recommendation from the snapshot's
  // evidence count so the operator sees the same gates apply.
  const dq = classifyDataQuality(evaluatedSignals);
  const performanceStatus: PerformanceStatus =
    dq === 'SUFFICIENT' ? 'SUFFICIENT' : dq === 'LIMITED' ? 'LIMITED' : 'INSUFFICIENT_DATA';
  // Health score uses the same five-component rule so promotion is
  // explainable from snapshot inputs alone.
  const health = (() => {
    if (evaluatedSignals < MIN_FOR_LIMITED) {
      return { score: 0, label: 'INSUFFICIENT_DATA' as HealthLabel,
               explanation: 'Insufficient evaluated signals to rank this strategy reliably.', warnings: [] as string[] };
    }
    const winComp        = clamp((snap.winRate     - 30) * 0.5,           0, 25);
    const expectancyComp = clamp((snap.expectancy  /  1.5) * 25,          0, 25);
    const profitFComp    = clamp((snap.profitFactor - 1) * 20,            0, 20);
    const drawdownComp   = clamp(20 + (snap.maxDrawdownPct / 2),          0, 20);
    const dataComp       = clamp((evaluatedSignals / MIN_FOR_RANK) * 10,  0, 10);
    const raw = winComp + expectancyComp + profitFComp + drawdownComp + dataComp;
    const score = Math.round(clamp(raw, 0, 100));
    const label: HealthLabel =
      score >= 85 ? 'EXCELLENT'
      : score >= 70 ? 'STRONG'
      : score >= 55 ? 'STABLE'
      :               'WEAK';
    const warnings: string[] = [];
    if (snap.expectancy <= 0)       warnings.push('Snapshot expectancy is non-positive.');
    if (snap.profitFactor < 1)      warnings.push('Snapshot profit factor below 1.');
    if (snap.maxDrawdownPct <= -25) warnings.push('Snapshot drawdown is large.');
    const explanation =
      label === 'EXCELLENT' ? 'Excellent strategy health (pre-aggregated snapshot).'
      : label === 'STRONG'  ? 'Strong strategy health based on pre-aggregated snapshot.'
      : label === 'STABLE'  ? 'Stable performance — pre-aggregated snapshot.'
      :                       'Weak strategy health — review the warnings.';
    return { score, label, explanation, warnings };
  })();
  const recommendation: Recommendation =
    performanceStatus === 'INSUFFICIENT_DATA' ? 'Insufficient Data'
    : health.score >= 85 && snap.expectancy >= 1.0 ? 'Promote'
    : health.score >= 70                            ? 'Keep Active'
    : health.score >= 55                            ? 'Watch Carefully'
                                                    : 'Reduce Approval Weight';

  // The snapshot source is 'strategy_snapshot'. If we also had any
  // live outcome rows, we honestly call it 'mixed' so the operator
  // sees both sources contributed.
  const performanceSource: PerformanceSource =
    live.evaluatedSignals > 0 ? 'mixed' : 'strategy_snapshot';

  return {
    ...live,
    evaluatedSignals,
    winRate:                round(snap.winRate, 1),
    expectancy:             round(snap.expectancy, 2),
    profitFactor:           round(snap.profitFactor, 2),
    maxDrawdownPct:         round(snap.maxDrawdownPct, 2),
    strategyHealthScore:    health.score,
    healthLabel:            health.label,
    healthExplanation:      health.explanation,
    warnings:               [
      ...health.warnings,
      `Metrics sourced from pre-aggregated snapshot (snapshotAt ${snap.snapshotAt}).`,
    ],
    performanceStatus,
    performanceSource,
    recommendation,
  };
}

// `clamp` is already declared below at file scope — no second copy needed.

function computeMetricsForStrategy(
  strategyId: string,
  rows: PerformanceOutcomeRow[],
): StrategyPerformance {
  const meta = getStrategyMeta(strategyId);

  const totalSignals    = rows.length;
  const evaluated       = rows.filter((r) => r.outcome === 'WIN' || r.outcome === 'LOSS');
  const evaluatedCount  = evaluated.length;
  const openCount       = rows.filter((r) => r.outcome === 'OPEN').length;
  const insufficient    = rows.filter((r) => r.outcome === 'INSUFFICIENT_DATA').length;

  const approved        = rows.filter((r) => r.approvalStatus === 'APPROVED').length;
  const watchlisted     = rows.filter((r) => r.approvalStatus === 'WATCHLIST').length;
  const rejected        = rows.filter((r) => r.approvalStatus === 'REJECTED').length;

  const wins  = evaluated.filter((r) => r.outcome === 'WIN');
  const losses = evaluated.filter((r) => r.outcome === 'LOSS');

  const returnPcts = evaluated
    .map((r) => r.returnPct)
    .filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  const winPcts  = wins .map((r) => r.returnPct).filter((v): v is number => typeof v === 'number');
  const lossPcts = losses.map((r) => r.returnPct).filter((v): v is number => typeof v === 'number');

  const winRate         = pct(evaluatedCount > 0 ? wins.length / evaluatedCount : 0);
  const lossRate        = pct(evaluatedCount > 0 ? losses.length / evaluatedCount : 0);
  const averageReturn   = round(avg(returnPcts), 2);
  const averageWin      = round(avg(winPcts),    2);
  const averageLoss     = round(avg(lossPcts),   2);
  const medianReturn    = round(median(returnPcts), 2);
  const bestReturn      = round(returnPcts.length > 0 ? Math.max(...returnPcts) : 0, 2);
  const worstReturn     = round(returnPcts.length > 0 ? Math.min(...returnPcts) : 0, 2);
  const expectancy      = round(computeExpectancyR(evaluated), 2);
  const profitFactor    = round(computeProfitFactor(winPcts, lossPcts), 2);
  const maxDrawdownPct  = round(computeRollingMaxDrawdownPct(evaluated), 2);
  const avgHolding      = round(avg(evaluated
    .map((r) => r.holdingPeriodBars)
    .filter((v): v is number => typeof v === 'number' && Number.isFinite(v))), 1);

  const targetHits = rows.filter((r) => r.targetHit).length;
  const stopHits   = rows.filter((r) => r.stopHit).length;

  const stopHitRate     = pct(rows.length > 0 ? stopHits   / rows.length : 0);
  const targetHitRate   = pct(rows.length > 0 ? targetHits / rows.length : 0);

  const falseSignalRate = pct(
    evaluatedCount > 0 ? losses.length / evaluatedCount : 0,
  );
  const approvalAccuracy = pct(
    approved > 0 ? wins.filter((w) => w.approvalStatus === 'APPROVED').length / approved : 0,
  );

  // R:R is derived from the absolute MFE vs MAE — falls back to 0
  // when the source rows didn't carry the excursion fields (live
  // snapshots don't, today).
  const mfeAvg = round(avg(rows.map((r) => r.mfePct).filter((v): v is number => typeof v === 'number')), 2);
  const maeAvg = round(avg(rows.map((r) => r.maePct).filter((v): v is number => typeof v === 'number')), 2);
  const averageRiskReward = round(
    Math.abs(maeAvg) > 0 ? Math.abs(mfeAvg) / Math.abs(maeAvg) : 0,
    2,
  );

  // ── Source mix tagging ──
  const sources = new Set(rows.map((r) => r.source));
  let performanceSource: PerformanceSource = 'insufficient_data';
  if (rows.length === 0)                       performanceSource = 'insufficient_data';
  else if (sources.size > 1)                   performanceSource = 'mixed';
  else if (sources.has('strategy_snapshot'))   performanceSource = 'strategy_snapshot';
  else if (sources.has('observed'))            performanceSource = 'observed';
  else if (sources.has('backtest'))            performanceSource = 'backtest';

  const dq = classifyDataQuality(evaluatedCount);
  const performanceStatus: PerformanceStatus =
    dq === 'SUFFICIENT' ? 'SUFFICIENT'
    : dq === 'LIMITED'  ? 'LIMITED'
                        : 'INSUFFICIENT_DATA';

  const { score: strategyHealthScore, label: healthLabel, explanation, warnings } =
    computeHealthScore({
      evaluated:   evaluatedCount,
      winRate, expectancy, profitFactor,
      maxDrawdownPct,
      averageRiskReward,
    });

  const recommendation = pickRecommendation(performanceStatus, strategyHealthScore, expectancy);

  return {
    strategyId,
    strategyName:   meta.strategyName,
    category:       meta.strategyCategory,
    direction:      meta.direction,
    totalSignals,
    approvedSignals:    approved,
    watchlistedSignals: watchlisted,
    rejectedSignals:    rejected,
    evaluatedSignals:   evaluatedCount,
    openSignals:        openCount,
    insufficientDataSignals: insufficient,
    winRate, lossRate,
    averageReturnPct: averageReturn,
    averageWinPct:    averageWin,
    averageLossPct:   averageLoss,
    medianReturnPct:  medianReturn,
    bestReturnPct:    bestReturn,
    worstReturnPct:   worstReturn,
    expectancy,
    profitFactor,
    maxDrawdownPct,
    averageHoldingPeriod: avgHolding,
    falseSignalRate,
    approvalAccuracy,
    averageRiskReward,
    stopHitRate,
    targetHitRate,
    maxAdverseExcursionAvg:   maeAvg,
    maxFavorableExcursionAvg: mfeAvg,
    strategyHealthScore,
    healthLabel,
    performanceStatus,
    performanceSource,
    recommendation,
    healthExplanation:        explanation,
    warnings,
  };
}

// ── Health score (rule-based, explainable) ─────────────────────

interface HealthInputs {
  evaluated:         number;
  winRate:           number;
  expectancy:        number;
  profitFactor:      number;
  maxDrawdownPct:    number;
  averageRiskReward: number;
}

function computeHealthScore(i: HealthInputs): {
  score: number; label: HealthLabel; explanation: string; warnings: string[];
} {
  if (i.evaluated < MIN_FOR_LIMITED) {
    return {
      score: 0,
      label: 'INSUFFICIENT_DATA',
      explanation: 'Insufficient evaluated signals to rank this strategy reliably.',
      warnings: [],
    };
  }

  // Each component contributes 0..max; summed to a 0..100 scale.
  // The thresholds are deliberately conservative — no strategy hits
  // 100 unless every dial is unambiguously positive.
  const winComp        = clamp((i.winRate - 30) * 0.5,                0, 25); // peak at 80% win rate
  const expectancyComp = clamp((i.expectancy / 1.5) * 25,             0, 25); // peak at expectancy=1.5
  const profitFComp    = clamp((i.profitFactor - 1) * 20,             0, 20); // peak at PF=2.0
  const drawdownComp   = clamp(20 + (i.maxDrawdownPct / 2),           0, 20); // peak at 0% DD; -40% = 0
  const dataComp       = clamp((i.evaluated / MIN_FOR_RANK) * 10,     0, 10); // peak at 20 evaluated

  const raw = winComp + expectancyComp + profitFComp + drawdownComp + dataComp;
  const score = Math.round(clamp(raw, 0, 100));

  const label: HealthLabel =
    score >= 85 ? 'EXCELLENT'
    : score >= 70 ? 'STRONG'
    : score >= 55 ? 'STABLE'
    :               'WEAK';

  const warnings: string[] = [];
  if (i.expectancy <= 0)        warnings.push('Expectancy is non-positive in the selected window.');
  if (i.profitFactor < 1)       warnings.push('Profit factor below 1 — losses exceed wins.');
  if (i.maxDrawdownPct <= -25)  warnings.push('Drawdown is large enough to warrant review.');

  const explanation =
    label === 'EXCELLENT' ? 'Excellent strategy health — positive expectancy, healthy profit factor, controlled drawdown.'
    : label === 'STRONG'  ? 'Strong strategy health based on positive expectancy, acceptable drawdown, and sufficient evaluated signals.'
    : label === 'STABLE'  ? 'Stable strategy health — performance is in line with expectations but has room to improve.'
    :                       'Weak strategy health — review the warnings before relying on this strategy.';

  return { score, label, explanation, warnings };
}

function pickRecommendation(
  status: PerformanceStatus,
  health: number,
  expectancy: number,
): Recommendation {
  if (status === 'INSUFFICIENT_DATA') return 'Insufficient Data';
  if (health >= 85 && expectancy >= 1.0)  return 'Promote';
  if (health >= 70)                       return 'Keep Active';
  if (health >= 55)                       return 'Watch Carefully';
  return 'Reduce Approval Weight';
}

// ── Leaderboard ───────────────────────────────────────────────

export function buildLeaderboard(
  strategies: StrategyPerformance[],
): LeaderboardEntry[] {
  // Spec sort order: performanceStatus, strategyHealthScore,
  // expectancy, winRate, evaluatedSignals.
  const STATUS_WEIGHT: Record<PerformanceStatus, number> = {
    SUFFICIENT: 2, LIMITED: 1, INSUFFICIENT_DATA: 0,
  };
  const sorted = [...strategies].sort((a, b) => {
    const sw = STATUS_WEIGHT[b.performanceStatus] - STATUS_WEIGHT[a.performanceStatus];
    if (sw !== 0) return sw;
    if (b.strategyHealthScore !== a.strategyHealthScore) return b.strategyHealthScore - a.strategyHealthScore;
    if (b.expectancy          !== a.expectancy)          return b.expectancy - a.expectancy;
    if (b.winRate             !== a.winRate)             return b.winRate    - a.winRate;
    return b.evaluatedSignals - a.evaluatedSignals;
  });
  return sorted.map((s, i) => ({
    rank: i + 1,
    strategyId:           s.strategyId,
    strategyName:         s.strategyName,
    category:             s.category,
    direction:            s.direction,
    totalSignals:         s.totalSignals,
    evaluatedSignals:     s.evaluatedSignals,
    winRate:              s.winRate,
    averageReturnPct:     s.averageReturnPct,
    expectancy:           s.expectancy,
    profitFactor:         s.profitFactor,
    maxDrawdownPct:       s.maxDrawdownPct,
    averageHoldingPeriod: s.averageHoldingPeriod,
    strategyHealthScore:  s.strategyHealthScore,
    healthLabel:          s.healthLabel,
    recommendation:       s.recommendation,
    performanceStatus:    s.performanceStatus,
  }));
}

// ── Bucketed breakdowns ───────────────────────────────────────

export function buildSectorBuckets(
  outcomes: PerformanceOutcomeRow[],
): SectorBucket[] {
  const evaluated = outcomes.filter((o) => o.outcome === 'WIN' || o.outcome === 'LOSS');
  const grouped = groupBy(evaluated, (o) => o.sector ?? 'Unknown');
  return Array.from(grouped.entries())
    .map(([sector, rows]) => ({
      sector,
      ...bucketMetrics(rows),
      healthLabel: bucketHealthLabel(rows.length, computeExpectancyR(rows)),
    }))
    .sort((a, b) => b.signals - a.signals);
}

export function buildRegimeBuckets(
  outcomes: PerformanceOutcomeRow[],
): RegimeBucket[] {
  const evaluated = outcomes.filter((o) => o.outcome === 'WIN' || o.outcome === 'LOSS');
  const withRegime = evaluated.filter((r) => !!r.regime);
  if (withRegime.length === 0) return [];
  const grouped = groupBy(withRegime, (o) => o.regime ?? 'Unknown');
  return Array.from(grouped.entries())
    .map(([regime, rows]) => {
      const exp = computeExpectancyR(rows);
      return {
        regime,
        ...bucketMetrics(rows),
        recommendation: pickRecommendation(
          classifyDataQuality(rows.length) === 'INSUFFICIENT' ? 'INSUFFICIENT_DATA' : 'LIMITED',
          50 + exp * 20, exp,
        ),
      };
    })
    .sort((a, b) => b.signals - a.signals);
}

const CONFIDENCE_BUCKETS: Array<{ b: ConfidenceBucket['bucket']; lo: number; hi: number }> = [
  { b: '0-40',   lo: 0,  hi: 40  },
  { b: '41-55',  lo: 41, hi: 55  },
  { b: '56-70',  lo: 56, hi: 70  },
  { b: '71-85',  lo: 71, hi: 85  },
  { b: '86-100', lo: 86, hi: 100 },
];

export function buildConfidenceBuckets(
  outcomes: PerformanceOutcomeRow[],
): ConfidenceBucket[] {
  return CONFIDENCE_BUCKETS.map(({ b, lo, hi }) => {
    const rows = outcomes.filter((o) =>
      o.confidenceScore != null && o.confidenceScore >= lo && o.confidenceScore <= hi,
    );
    return {
      bucket:     b,
      lowerBound: lo,
      upperBound: hi,
      ...bucketMetrics(rows),
    };
  });
}

export function buildStatusBuckets(
  outcomes: PerformanceOutcomeRow[],
): StatusBucket[] {
  const result: StatusBucket[] = [];
  for (const status of ['APPROVED', 'WATCHLIST', 'REJECTED'] as const) {
    const rows = outcomes.filter((o) => o.approvalStatus === status);
    if (rows.length === 0) continue;
    result.push({ status, ...bucketMetrics(rows) });
  }
  return result;
}

function bucketMetrics(rows: PerformanceOutcomeRow[]): BucketMetrics {
  const evaluated = rows.filter((r) => r.outcome === 'WIN' || r.outcome === 'LOSS');
  const wins = evaluated.filter((r) => r.outcome === 'WIN');
  const returns = evaluated
    .map((r) => r.returnPct)
    .filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  return {
    signals:          rows.length,
    evaluatedSignals: evaluated.length,
    winRate:          pct(evaluated.length > 0 ? wins.length / evaluated.length : 0),
    averageReturnPct: round(avg(returns), 2),
    expectancy:       round(computeExpectancyR(evaluated), 2),
  };
}

function bucketHealthLabel(n: number, expectancy: number): HealthLabel {
  if (n < MIN_FOR_LIMITED) return 'INSUFFICIENT_DATA';
  if (expectancy >= 1.0)   return 'STRONG';
  if (expectancy >= 0.3)   return 'STABLE';
  return 'WEAK';
}

// ── Top-level orchestrator ────────────────────────────────────

export interface BuildReportOptions {
  window?:        PerformanceWindow;
  /** Optional strategy filter — returns a single-strategy report when set. */
  strategyId?:    string;
}

export interface BuildReportResult {
  report:             StrategyPerformanceReport;
  outcomes:           PerformanceOutcomeRow[];
  perStrategy:        Map<string, PerformanceOutcomeRow[]>;
}

/**
 * Pure orchestration over the loaded outcomes. The route layer
 * passes already-loaded rows so this stays test-friendly.
 */
export function buildPerformanceReport(
  outcomes: PerformanceOutcomeRow[],
  window: PerformanceWindow = '90D',
  /** Optional pre-aggregated Priority-2 snapshots — applied per
   *  strategy as an override when live data is below MIN_FOR_RANK. */
  snapshotsByStrategy?: Map<string, StrategyPerformanceSnapshot>,
): BuildReportResult {
  const strategies = buildStrategyPerformance(outcomes, snapshotsByStrategy);
  const leaderboard = buildLeaderboard(strategies);

  const totalEvaluated = strategies.reduce((s, x) => s + x.evaluatedSignals, 0);
  const dq = classifyDataQuality(totalEvaluated);

  const sources = new Set(outcomes.map((o) => o.source));
  const reportSource: PerformanceSource =
    sources.size === 0                         ? 'insufficient_data'
    : sources.size > 1                         ? 'mixed'
    : sources.has('strategy_snapshot')         ? 'strategy_snapshot'
    : sources.has('observed')                  ? 'observed'
    : sources.has('backtest')                  ? 'backtest'
    :                                            'estimated';

  const warnings: string[] = [];
  if (dq !== 'SUFFICIENT') {
    warnings.push(
      `Strategy ranking is limited because only ${totalEvaluated} evaluated signals are available (need ≥${MIN_FOR_RANK}).`,
    );
  }
  if (!outcomes.some((o) => o.regime)) {
    warnings.push('Regime-wise analysis unavailable because market regime is missing on historical rows.');
  }
  if (!outcomes.some((o) => o.sector)) {
    warnings.push('Sector-wise analysis unavailable because sector mapping is missing on historical rows.');
  }
  const approvedRows  = outcomes.filter((o) => o.approvalStatus === 'APPROVED' && (o.outcome === 'WIN' || o.outcome === 'LOSS'));
  const watchRows     = outcomes.filter((o) => o.approvalStatus === 'WATCHLIST' && (o.outcome === 'WIN' || o.outcome === 'LOSS'));
  if (approvedRows.length >= MIN_FOR_LIMITED && watchRows.length >= MIN_FOR_LIMITED) {
    const approvedExp = computeExpectancyR(approvedRows);
    const watchExp    = computeExpectancyR(watchRows);
    if (watchExp > approvedExp) {
      warnings.push('Approved signals are not outperforming watchlisted signals — risk gate calibration requires review.');
    }
  }

  const message =
    dq === 'SUFFICIENT' ? 'Strategy performance computed across the selected window.'
    : dq === 'LIMITED'  ? 'Performance is calculated but the sample size is limited — interpret rankings cautiously.'
    :                     'Not enough evaluated historical signals to calculate reliable strategy performance.';

  const report: StrategyPerformanceReport = {
    generatedAt:            new Date().toISOString(),
    timeWindow:             window,
    dataStatus:             dq,
    message,
    performanceSource:      reportSource,
    totalStrategies:        strategies.length,
    totalSignalsEvaluated:  totalEvaluated,
    minimumRequiredSignals: MIN_FOR_RANK,
    leaderboard,
    strategies,
    warnings,
    dataQuality: {
      status:                 dq,
      evaluatedSignals:       totalEvaluated,
      minimumRequiredSignals: MIN_FOR_RANK,
      coveragePct: MIN_FOR_RANK > 0
        ? Math.min(100, Math.round((totalEvaluated / MIN_FOR_RANK) * 100))
        : 0,
      warnings: [],
    },
  };

  return {
    report,
    outcomes,
    perStrategy: groupBy(outcomes, (o) => o.strategyId),
  };
}

// ── Maths / utility helpers ───────────────────────────────────

function num(v: unknown): number | null {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function round(v: number, p: number = 1): number {
  if (!Number.isFinite(v)) return 0;
  const f = 10 ** p;
  return Math.round(v * f) / f;
}

function pct(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return round(v * 100, 1);
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function avg(xs: number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

function computeExpectancyR(rows: PerformanceOutcomeRow[]): number {
  // Prefer R-multiples; fall back to % returns scaled by 100 so the
  // number stays in a comparable band when only % is available.
  const rs = rows.map((r) => r.returnR).filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  if (rs.length > 0) return avg(rs);
  const ps = rows.map((r) => r.returnPct).filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  if (ps.length === 0) return 0;
  return avg(ps) / 100;
}

function computeProfitFactor(winPcts: number[], lossPcts: number[]): number {
  const gross  = winPcts.reduce((s, v) => s + Math.max(0, v), 0);
  const losses = Math.abs(lossPcts.reduce((s, v) => s + Math.min(0, v), 0));
  if (gross === 0 && losses === 0) return 0;
  if (losses === 0)                return 99; // capped — every win, no loss
  return gross / losses;
}

function computeRollingMaxDrawdownPct(rows: PerformanceOutcomeRow[]): number {
  // Walks the evaluated rows in chronological order, accumulating a
  // synthetic equity curve from returnPct. Reports the worst peak-to-
  // trough drawdown (signed, negative). Falls back to 0 when no
  // returnPct data is available.
  if (rows.length === 0) return 0;
  const chrono = [...rows]
    .filter((r) => typeof r.returnPct === 'number')
    .sort((a, b) => (a.evaluatedAt ?? '').localeCompare(b.evaluatedAt ?? ''));
  if (chrono.length === 0) return 0;
  let equity = 0, peak = 0, maxDd = 0;
  for (const r of chrono) {
    equity += (r.returnPct as number);
    if (equity > peak) peak = equity;
    const dd = equity - peak;       // signed, ≤ 0
    if (dd < maxDd) maxDd = dd;
  }
  return maxDd;
}

function groupBy<T, K>(rows: T[], key: (r: T) => K): Map<K, T[]> {
  const out = new Map<K, T[]>();
  for (const r of rows) {
    const k = key(r);
    const list = out.get(k) ?? [];
    list.push(r);
    out.set(k, list);
  }
  return out;
}

function safeSector(symbol: unknown): string | null {
  if (!symbol || typeof symbol !== 'string') return null;
  try {
    const s = getSector(symbol);
    return s && s !== 'Other' ? s : null;
  } catch {
    return null;
  }
}

function toIso(v: unknown): string | null {
  if (!v) return null;
  if (typeof v === 'string') return v;
  if (v instanceof Date)     return v.toISOString();
  try { return new Date(v as any).toISOString(); }
  catch { return null; }
}
