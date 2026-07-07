// ════════════════════════════════════════════════════════════════
//  GET /api/strategies/performance
//
//  Phase 2 — Strategy Performance Intelligence
//
//  Evidence-based per-strategy metrics derived from the data the
//  platform already persists. No new tables, no fabricated outcomes,
//  no scoring changes.
//
//  Query params:
//    ?window=7D|30D|90D|180D|1Y|ALL   (default 90D)
//    ?strategyId=<snake_case>          (optional — single strategy view)
//    ?include=leaderboard,sector,regime,confidence,statusBreakdown
//    ?minSignals=<n>                   (optional — display floor)
//
//  Behaviour:
//    - Always returns 200 with a structured body. Insufficient data
//      is surfaced as `dataStatus: 'INSUFFICIENT'` with explanation,
//      never as a 500.
//    - Per-strategy detail includes sector / regime / confidence /
//      approval-status breakdowns when the data carries those facets.
// ════════════════════════════════════════════════════════════════

import { NextRequest, NextResponse } from 'next/server';
import { requireSession }            from '@/lib/session';
import {
  VALID_WINDOWS,
  loadBacktestOutcomes,
  loadObservedOutcomes,
  loadDirectSignalOutcomes,
  loadStrategyPerformanceSnapshots,
  buildPerformanceReport,
  buildSectorBuckets,
  buildRegimeBuckets,
  buildConfidenceBuckets,
  buildStatusBuckets,
  dedupeOutcomesBySignal,
  MIN_FOR_RANK,
  type PerformanceWindow,
  type StrategyPerformance,
  type StrategyPerformanceReport,
  type PerformanceOutcomeRow,
} from '@/lib/strategies/strategyPerformance';

export const dynamic    = 'force-dynamic';
export const revalidate = 0;

interface PerformanceApiEnvelope extends StrategyPerformanceReport {
  /** Per-strategy detail map (sector / regime / confidence /
   *  approval-status buckets) keyed by strategyId. Only present when
   *  the `include` query param requests one of those facets. */
  detail?: Record<string, StrategyDetailBlock>;
  selectedStrategy?: StrategyPerformance | null;
  /** Audit hint — exposes how many rows each priority source
   *  contributed. Operators can read this to spot stale snapshots
   *  or backtest contamination. */
  sourceStatus?: {
    directOutcomeRows:    number;
    observedSnapshotRows: number;
    backtestTradeRows:    number;
    strategySnapshots:    number;
    priorityChain:        string[];
  };
  overall: OverallPerformanceMetrics;
  charts: PerformanceCharts;
  filters: {
    strategyId: string | null;
    symbol: string | null;
    timeframe: string | null;
    startDate: string | null;
    endDate: string | null;
    marketRegime: string | null;
  };
  filterOptions: {
    strategies: Array<{ id: string; name: string }>;
    symbols: string[];
    regimes: string[];
    timeframes: string[];
  };
}

interface OverallPerformanceMetrics {
  winRate: number;
  totalTrades: number;
  runningTrades: number;
  closedTrades: number;
  averageProfit: number;
  averageLoss: number;
  bestTrade: number;
  worstTrade: number;
  profitFactor: number;
  maxDrawdown: number;
  targetHitRate: number;
  stopLossHitRate: number;
  averageRiskReward: number;
}

interface PerformanceCharts {
  equityCurve: Array<{ date: string; equity: number; pnl: number }>;
  drawdown: Array<{ date: string; drawdown: number }>;
  monthlyReturns: Array<{ month: string; returnPct: number; trades: number }>;
  yearlyReturns: Array<{ year: string; returnPct: number; trades: number }>;
  dailyHeatmap: Array<{ date: string; returnPct: number; trades: number }>;
  winLossDistribution: Array<{ bucket: string; wins: number; losses: number }>;
}

interface StrategyDetailBlock {
  sectorPerformance?:     ReturnType<typeof buildSectorBuckets>;
  sectorPerformanceStatus?: 'AVAILABLE' | 'UNAVAILABLE';
  sectorPerformanceMessage?: string;
  regimePerformance?:     ReturnType<typeof buildRegimeBuckets>;
  regimePerformanceStatus?: 'AVAILABLE' | 'INSUFFICIENT_DATA';
  regimePerformanceMessage?: string;
  confidenceBuckets?:     ReturnType<typeof buildConfidenceBuckets>;
  confidenceCalibrationWarning?: string;
  statusBreakdown?:       ReturnType<typeof buildStatusBuckets>;
}

function parseInclude(raw: string | null): Set<string> {
  if (!raw) return new Set();
  return new Set(raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));
}

function parseWindow(raw: string | null): PerformanceWindow {
  const v = String(raw ?? '90D').toUpperCase() as PerformanceWindow;
  if (VALID_WINDOWS.has(v)) return v;
  return '90D';
}

export async function GET(req: NextRequest) {
  // Session-gated — same contract as the other /api/* signals routes.
  try { await requireSession(); }
  catch { return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 }); }

  const url        = new URL(req.url);
  const window     = parseWindow(url.searchParams.get('window'));
  const strategyId = url.searchParams.get('strategyId')?.trim() || null;
  const symbol = url.searchParams.get('symbol')?.trim().toUpperCase() || null;
  const timeframe = url.searchParams.get('timeframe')?.trim() || null;
  const startDate = url.searchParams.get('startDate')?.trim() || url.searchParams.get('from')?.trim() || null;
  const endDate = url.searchParams.get('endDate')?.trim() || url.searchParams.get('to')?.trim() || null;
  const marketRegime = url.searchParams.get('marketRegime')?.trim() || url.searchParams.get('regime')?.trim() || null;
  const include    = parseInclude(url.searchParams.get('include'));
  const minSignals = (() => {
    const n = Number(url.searchParams.get('minSignals'));
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
  })();

  // ── Source priority chain (Phase 2 spec) ──
  //   1. q365_signal_outcomes              → loadDirectSignalOutcomes
  //   2. q365_strategy_performance_snapshots → loadStrategyPerformanceSnapshots
  //   3. q365_confirmed_signal_snapshots   → loadObservedOutcomes
  //   4. backtest_trades (COMPLETED runs)  → loadBacktestOutcomes
  //   5. insufficient_data                  → empty
  //
  // We load 1, 3, 4 in parallel and merge. Source 2 (pre-aggregated
  // snapshots) is loaded separately and surfaced under `sourceStatus`
  // — it's an audit hint that an upstream writer has already computed
  // numbers for this window, not a replacement for the raw outcome
  // metrics computed here.
  const [direct, observed, backtests, snapshotsByStrategy] = await Promise.all([
    loadDirectSignalOutcomes(window).catch(() => []),
    loadObservedOutcomes(window).catch(() => []),
    loadBacktestOutcomes(window).catch(() => []),
    loadStrategyPerformanceSnapshots(window).catch(() => new Map()),
  ]);
  // De-dup: prefer direct outcomes over snapshot-derived ones for the
  // same underlying snapshot. `direct` rows carry source='direct' and
  // signalRef='snapshot:<id>'; `observed` rows for the same snapshot
  // carry the same signalRef, so dedupeOutcomesBySignal collapses the
  // pair to the higher-priority direct row. Backtest rows have
  // signalRef=null and pass through untouched.
  const unfilteredOutcomes = dedupeOutcomesBySignal([...direct, ...observed, ...backtests]);
  const filterOptions = buildFilterOptions(unfilteredOutcomes);
  const outcomes = applyOutcomeFilters(unfilteredOutcomes, {
    strategyId,
    symbol,
    startDate,
    endDate,
    marketRegime,
  });

  // Priority-2 snapshot override is applied inside buildPerformanceReport:
  // when a strategy has fewer live evaluated signals than the snapshot
  // (and the snapshot is < 26h old), the snapshot's metrics replace the
  // live ones and performanceSource flips to 'strategy_snapshot' /
  // 'mixed'. Honest disclosure — operator sees the source flip.
  const { report } = buildPerformanceReport(outcomes, window, snapshotsByStrategy);
  if (timeframe) {
    report.warnings.push('Timeframe filtering is not applied because persisted strategy outcome rows do not currently store timeframe.');
  }

  // Optional per-strategy floor (display only — never alters the
  // health score or recommendations).
  if (minSignals != null) {
    report.leaderboard = report.leaderboard.filter((e) => e.totalSignals >= minSignals);
  }

  // Optional include= facets.
  const detail: Record<string, StrategyDetailBlock> = {};
  if (include.has('leaderboard')) {
    // Default — already present; no-op.
  }

  const sectorRequested      = include.has('sector');
  const regimeRequested      = include.has('regime');
  const confidenceRequested  = include.has('confidence');
  const statusBreakdownReq   = include.has('statusbreakdown') || include.has('status_breakdown');

  if (sectorRequested || regimeRequested || confidenceRequested || statusBreakdownReq) {
    // Build a per-strategy detail block. If a single strategy was
    // requested, only that one. Otherwise build for every strategy
    // that has at least one outcome.
    const targets = strategyId
      ? [strategyId]
      : Array.from(new Set(outcomes.map((o) => o.strategyId)));

    for (const sid of targets) {
      const rows = outcomes.filter((o) => o.strategyId === sid);
      const block: StrategyDetailBlock = {};

      if (sectorRequested) {
        const sectorRows = rows.filter((r) => !!r.sector);
        if (sectorRows.length === 0) {
          block.sectorPerformanceStatus  = 'UNAVAILABLE';
          block.sectorPerformanceMessage = 'Sector mapping is not available for historical signals.';
          block.sectorPerformance        = [];
        } else {
          block.sectorPerformanceStatus = 'AVAILABLE';
          block.sectorPerformance       = buildSectorBuckets(sectorRows);
        }
      }
      if (regimeRequested) {
        const regimeRows = rows.filter((r) => !!r.regime);
        if (regimeRows.length === 0) {
          block.regimePerformanceStatus  = 'INSUFFICIENT_DATA';
          block.regimePerformanceMessage = 'Market regime not recorded on historical signals — regime-wise analysis unavailable.';
          block.regimePerformance        = [];
        } else {
          block.regimePerformanceStatus = 'AVAILABLE';
          block.regimePerformance       = buildRegimeBuckets(regimeRows);
        }
      }
      if (confidenceRequested) {
        block.confidenceBuckets = buildConfidenceBuckets(rows);
        // Calibration warning — if the top two buckets don't beat the
        // bottom two, flag it. Read-only; we never alter scoring here.
        const high = block.confidenceBuckets.filter((b) => b.bucket === '71-85' || b.bucket === '86-100');
        const low  = block.confidenceBuckets.filter((b) => b.bucket === '0-40'  || b.bucket === '41-55');
        const highWin = avgIgnoreZero(high.map((b) => b.winRate));
        const lowWin  = avgIgnoreZero(low.map((b) => b.winRate));
        if (highWin > 0 && lowWin > 0 && highWin <= lowWin) {
          block.confidenceCalibrationWarning =
            'High-confidence signals are not outperforming lower-confidence signals — confidence calibration requires review.';
        }
      }
      if (statusBreakdownReq) {
        block.statusBreakdown = buildStatusBuckets(rows);
      }

      detail[sid] = block;
    }
  }

  // Single-strategy view — also pull the full StrategyPerformance
  // record so the client doesn't have to scan the array.
  const selectedStrategy = strategyId
    ? report.strategies.find((s) => s.strategyId === strategyId) ?? null
    : undefined;

  const envelope: PerformanceApiEnvelope = {
    ...report,
    minimumRequiredSignals: MIN_FOR_RANK,
    sourceStatus: {
      directOutcomeRows:    direct.length,
      observedSnapshotRows: observed.length,
      backtestTradeRows:    backtests.length,
      strategySnapshots:    snapshotsByStrategy.size,
      priorityChain: [
        'q365_signal_outcomes',
        'q365_strategy_performance_snapshots',
        'q365_confirmed_signal_snapshots',
        'backtest_trades (completed runs only)',
      ],
    },
    overall: buildOverallMetrics(outcomes),
    charts: buildPerformanceCharts(outcomes),
    filters: {
      strategyId,
      symbol,
      timeframe,
      startDate,
      endDate,
      marketRegime,
    },
    filterOptions,
    ...(Object.keys(detail).length > 0 ? { detail } : {}),
    ...(selectedStrategy !== undefined ? { selectedStrategy } : {}),
  };

  return NextResponse.json(envelope, {
    headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate' },
  });
}

function applyOutcomeFilters(
  rows: PerformanceOutcomeRow[],
  filters: {
    strategyId: string | null;
    symbol: string | null;
    startDate: string | null;
    endDate: string | null;
    marketRegime: string | null;
  },
): PerformanceOutcomeRow[] {
  const start = filters.startDate ? new Date(`${filters.startDate}T00:00:00`).getTime() : null;
  const end = filters.endDate ? new Date(`${filters.endDate}T23:59:59`).getTime() : null;
  return rows.filter((row) => {
    if (filters.strategyId && row.strategyId !== filters.strategyId) return false;
    if (filters.symbol && row.symbol.toUpperCase() !== filters.symbol) return false;
    if (filters.marketRegime && String(row.regime ?? '').toLowerCase() !== filters.marketRegime.toLowerCase()) return false;
    if (start != null || end != null) {
      const ts = row.evaluatedAt ? new Date(row.evaluatedAt).getTime() : NaN;
      if (!Number.isFinite(ts)) return false;
      if (start != null && ts < start) return false;
      if (end != null && ts > end) return false;
    }
    return true;
  });
}

function buildFilterOptions(rows: PerformanceOutcomeRow[]) {
  const strategyNames = new Map<string, string>();
  for (const row of rows) {
    if (!strategyNames.has(row.strategyId)) strategyNames.set(row.strategyId, row.strategyId.replace(/_/g, ' '));
  }
  return {
    strategies: Array.from(strategyNames.entries())
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    symbols: Array.from(new Set(rows.map((r) => r.symbol).filter(Boolean))).sort(),
    regimes: Array.from(new Set(rows.map((r) => r.regime).filter(Boolean) as string[])).sort(),
    timeframes: ['intraday', 'swing', 'positional', 'daily'],
  };
}

function buildOverallMetrics(rows: PerformanceOutcomeRow[]): OverallPerformanceMetrics {
  const evaluated = rows.filter((r) => r.outcome === 'WIN' || r.outcome === 'LOSS');
  const tradeRows = rows.filter((r) => r.outcome === 'WIN' || r.outcome === 'LOSS' || r.outcome === 'OPEN');
  const wins = evaluated.filter((r) => r.outcome === 'WIN');
  const losses = evaluated.filter((r) => r.outcome === 'LOSS');
  const winReturns = wins.map((r) => r.returnPct).filter(isFiniteNumber);
  const lossReturns = losses.map((r) => r.returnPct).filter(isFiniteNumber);
  const allReturns = evaluated.map((r) => r.returnPct).filter(isFiniteNumber);
  const grossProfit = winReturns.reduce((sum, value) => sum + Math.max(0, value), 0);
  const grossLoss = Math.abs(lossReturns.reduce((sum, value) => sum + Math.min(0, value), 0));
  const mfeAvg = avg(evaluated.map((r) => r.mfePct).filter(isFiniteNumber));
  const maeAvg = avg(evaluated.map((r) => r.maePct).filter(isFiniteNumber));
  return {
    winRate: pct(evaluated.length ? wins.length / evaluated.length : 0),
    totalTrades: tradeRows.length,
    runningTrades: rows.filter((r) => r.outcome === 'OPEN').length,
    closedTrades: evaluated.length,
    averageProfit: round(avg(winReturns), 2),
    averageLoss: round(avg(lossReturns), 2),
    bestTrade: round(allReturns.length ? Math.max(...allReturns) : 0, 2),
    worstTrade: round(allReturns.length ? Math.min(...allReturns) : 0, 2),
    profitFactor: round(grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? 99 : 0, 2),
    maxDrawdown: round(Math.min(...buildDrawdownSeries(evaluated).map((p) => p.drawdown), 0), 2),
    targetHitRate: pct(evaluated.length ? evaluated.filter((r) => r.targetHit).length / evaluated.length : 0),
    stopLossHitRate: pct(evaluated.length ? evaluated.filter((r) => r.stopHit).length / evaluated.length : 0),
    averageRiskReward: round(Math.abs(maeAvg) > 0 ? Math.abs(mfeAvg) / Math.abs(maeAvg) : 0, 2),
  };
}

function buildPerformanceCharts(rows: PerformanceOutcomeRow[]): PerformanceCharts {
  const evaluated = rows
    .filter((r) => (r.outcome === 'WIN' || r.outcome === 'LOSS') && isFiniteNumber(r.returnPct))
    .sort((a, b) => String(a.evaluatedAt ?? '').localeCompare(String(b.evaluatedAt ?? '')));
  return {
    equityCurve: buildEquityCurve(evaluated),
    drawdown: buildDrawdownSeries(evaluated),
    monthlyReturns: buildMonthlyReturns(evaluated),
    yearlyReturns: buildYearlyReturns(evaluated),
    dailyHeatmap: buildDailyHeatmap(evaluated),
    winLossDistribution: buildWinLossDistribution(evaluated),
  };
}

function buildEquityCurve(rows: PerformanceOutcomeRow[]) {
  let equity = 100;
  return rows.map((row, index) => {
    const pnl = row.returnPct ?? 0;
    equity = round(equity * (1 + pnl / 100), 2);
    return {
      date: row.evaluatedAt?.slice(0, 10) ?? `Trade ${index + 1}`,
      equity,
      pnl: round(pnl, 2),
    };
  });
}

function buildDrawdownSeries(rows: PerformanceOutcomeRow[]) {
  let equity = 100;
  let peak = 100;
  return rows.map((row, index) => {
    equity = round(equity * (1 + (row.returnPct ?? 0) / 100), 2);
    peak = Math.max(peak, equity);
    const drawdownPct = peak > 0 ? ((equity - peak) / peak) * 100 : 0;
    return {
      date: row.evaluatedAt?.slice(0, 10) ?? `Trade ${index + 1}`,
      drawdown: round(drawdownPct, 2),
    };
  });
}

function buildMonthlyReturns(rows: PerformanceOutcomeRow[]): PerformanceCharts['monthlyReturns'] {
  const grouped = new Map<string, { returnPct: number; trades: number }>();
  for (const row of rows) {
    const key = (row.evaluatedAt ?? '').slice(0, 7);
    if (!key) continue;
    const current = grouped.get(key) ?? { returnPct: 0, trades: 0 };
    current.returnPct = round(current.returnPct + (row.returnPct ?? 0), 2);
    current.trades += 1;
    grouped.set(key, current);
  }
  return Array.from(grouped.entries()).map(([month, value]) => ({
    month,
    ...value,
  }));
}

function buildYearlyReturns(rows: PerformanceOutcomeRow[]): PerformanceCharts['yearlyReturns'] {
  const grouped = new Map<string, { returnPct: number; trades: number }>();
  for (const row of rows) {
    const key = (row.evaluatedAt ?? '').slice(0, 4);
    if (!key) continue;
    const current = grouped.get(key) ?? { returnPct: 0, trades: 0 };
    current.returnPct = round(current.returnPct + (row.returnPct ?? 0), 2);
    current.trades += 1;
    grouped.set(key, current);
  }
  return Array.from(grouped.entries()).map(([year, value]) => ({
    year,
    ...value,
  }));
}

function buildDailyHeatmap(rows: PerformanceOutcomeRow[]) {
  const grouped = new Map<string, { returnPct: number; trades: number }>();
  for (const row of rows) {
    const date = (row.evaluatedAt ?? '').slice(0, 10);
    if (!date) continue;
    const current = grouped.get(date) ?? { returnPct: 0, trades: 0 };
    current.returnPct = round(current.returnPct + (row.returnPct ?? 0), 2);
    current.trades += 1;
    grouped.set(date, current);
  }
  return Array.from(grouped.entries()).map(([date, value]) => ({ date, ...value }));
}

function buildWinLossDistribution(rows: PerformanceOutcomeRow[]) {
  const buckets = [
    { bucket: '< -5%', min: -Infinity, max: -5 },
    { bucket: '-5% to -2%', min: -5, max: -2 },
    { bucket: '-2% to 0%', min: -2, max: 0 },
    { bucket: '0% to 2%', min: 0, max: 2 },
    { bucket: '2% to 5%', min: 2, max: 5 },
    { bucket: '> 5%', min: 5, max: Infinity },
  ];
  return buckets.map((bucket) => {
    const matches = rows.filter((row) => {
      const value = row.returnPct ?? 0;
      return value >= bucket.min && value < bucket.max;
    });
    return {
      bucket: bucket.bucket,
      wins: matches.filter((row) => row.outcome === 'WIN').length,
      losses: matches.filter((row) => row.outcome === 'LOSS').length,
    };
  });
}

function avgIgnoreZero(xs: number[]): number {
  const filtered = xs.filter((v) => v > 0);
  if (filtered.length === 0) return 0;
  return filtered.reduce((a, b) => a + b, 0) / filtered.length;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function avg(values: number[]): number {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function round(value: number, precision = 1): number {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** precision;
  return Math.round(value * factor) / factor;
}

function pct(value: number): number {
  return round(value * 100, 1);
}
