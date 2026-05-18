// ════════════════════════════════════════════════════════════════
//  GET /api/strategies/learning
//
//  Phase 6 — Learning / Review API.
//
//  Reviews matured signals (observed snapshots + backtest trades)
//  and returns per-strategy learning insights, ranking, and
//  recommendations. Recommendation-only — never disables a strategy
//  automatically unless AUTO_STRATEGY_CONTROL_ENABLED=true (which
//  this route does NOT act on; it only reports the flag state).
//
//  Query params:
//    ?window=30D|90D|180D|1Y|ALL  (default 90D)
//    ?strategyId=<snake_case>     (optional — single-strategy review)
//    ?include=reviews,ranking,conflicts,recommendations
//
//  Always 200 with structured payload.
// ════════════════════════════════════════════════════════════════

import { NextRequest, NextResponse } from 'next/server';
import { requireSession }            from '@/lib/session';
import {
  loadDirectSignalOutcomes,
  loadObservedOutcomes,
  loadBacktestOutcomes,
  dedupeOutcomesBySignal,
  SOURCE_PRIORITY,
  VALID_WINDOWS,
  type PerformanceWindow,
  type PerformanceOutcomeRow,
} from '@/lib/strategies/strategyPerformance';
import {
  buildLearningReport,
  isAutoStrategyControlEnabled,
} from '@/lib/learning/signalReviewEngine';

export const dynamic    = 'force-dynamic';
export const revalidate = 0;

function parseWindow(raw: string | null): PerformanceWindow {
  const v = String(raw ?? '90D').toUpperCase() as PerformanceWindow;
  return VALID_WINDOWS.has(v) ? v : '90D';
}

export async function GET(req: NextRequest) {
  try { await requireSession(); }
  catch { return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 }); }

  const url        = new URL(req.url);
  const window     = parseWindow(url.searchParams.get('window'));
  const strategyId = url.searchParams.get('strategyId')?.trim() || null;

  // Source priority chain — direct outcomes are the strongest signal,
  // observed snapshots are the next-best, completed backtests fill
  // remaining coverage. We de-dup later so the same matured signal
  // never gets counted twice when it lands in two sources at once.
  const [direct, observed, backtests] = await Promise.all([
    loadDirectSignalOutcomes(window).catch(() => []),
    loadObservedOutcomes(window).catch(() => []),
    loadBacktestOutcomes(window).catch(() => []),
  ]);

  // De-dup pass 1 — collapse rows that share a signalRef so the same
  // matured snapshot isn't double-counted as both `direct` and
  // `observed`. The direct row always wins (see SOURCE_PRIORITY).
  const byRef = dedupeOutcomesBySignal([...direct, ...observed, ...backtests]);

  // De-dup pass 2 — safety net for rows whose signalRef is null (legacy
  // backtest trades) but which still collide on (strategy, symbol,
  // evaluatedAt). Keep the highest-priority source per tuple.
  const seen = new Map<string, PerformanceOutcomeRow>();
  for (const row of byRef) {
    const key = `${row.strategyId}::${row.symbol}::${row.evaluatedAt ?? 'none'}`;
    const existing = seen.get(key);
    if (!existing
        || (SOURCE_PRIORITY[row.source] ?? -1) > (SOURCE_PRIORITY[existing.source] ?? -1)) {
      seen.set(key, row);
    }
  }
  const outcomes = Array.from(seen.values());

  const report = buildLearningReport(outcomes, window);

  // Optional strategyId filter — keeps the report shape but narrows
  // the reviews / rankings to the requested strategy.
  if (strategyId) {
    report.reviews          = report.reviews.filter((r) => r.strategyId === strategyId);
    report.strategyRankings = report.strategyRankings.filter((r) => r.strategyId === strategyId);
    report.recommendations  = report.recommendations.filter((r) => r.strategyId === strategyId);
  }

  return NextResponse.json({
    ...report,
    sourceStatus: {
      // Per-source row counts BEFORE de-dup. Useful for spotting when
      // a writer is silent (e.g. `directOutcomeRows: 0` means the
      // q365_signal_outcomes table has nothing in the window).
      directOutcomeRows:    direct.length,
      observedSnapshotRows: observed.length,
      backtestTradeRows:    backtests.length,
      deduplicatedRows:     outcomes.length,
      priorityChain: [
        'q365_signal_outcomes',
        'q365_confirmed_signal_snapshots',
        'backtest_trades (completed/success runs only)',
      ],
    },
    automation: {
      autoStrategyControlEnabled: isAutoStrategyControlEnabled(),
      note: 'Learning report is recommendation-only. Set AUTO_STRATEGY_CONTROL_ENABLED=true to allow a downstream worker to act on these recommendations.',
    },
  }, {
    headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate' },
  });
}
