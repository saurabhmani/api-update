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
  const outcomes = dedupeOutcomesBySignal([...direct, ...observed, ...backtests]);

  // Priority-2 snapshot override is applied inside buildPerformanceReport:
  // when a strategy has fewer live evaluated signals than the snapshot
  // (and the snapshot is < 26h old), the snapshot's metrics replace the
  // live ones and performanceSource flips to 'strategy_snapshot' /
  // 'mixed'. Honest disclosure — operator sees the source flip.
  const { report } = buildPerformanceReport(outcomes, window, snapshotsByStrategy);

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
    ...(Object.keys(detail).length > 0 ? { detail } : {}),
    ...(selectedStrategy !== undefined ? { selectedStrategy } : {}),
  };

  return NextResponse.json(envelope, {
    headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate' },
  });
}

function avgIgnoreZero(xs: number[]): number {
  const filtered = xs.filter((v) => v > 0);
  if (filtered.length === 0) return 0;
  return filtered.reduce((a, b) => a + b, 0) / filtered.length;
}
