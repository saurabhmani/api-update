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
  loadObservedOutcomes,
  loadBacktestOutcomes,
  VALID_WINDOWS,
  type PerformanceWindow,
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

  const [observed, backtests] = await Promise.all([
    loadObservedOutcomes(window).catch(() => []),
    loadBacktestOutcomes(window).catch(() => []),
  ]);

  const report = buildLearningReport([...observed, ...backtests], window);

  // Optional strategyId filter — keeps the report shape but narrows
  // the reviews / rankings to the requested strategy.
  if (strategyId) {
    report.reviews          = report.reviews.filter((r) => r.strategyId === strategyId);
    report.strategyRankings = report.strategyRankings.filter((r) => r.strategyId === strategyId);
    report.recommendations  = report.recommendations.filter((r) => r.strategyId === strategyId);
  }

  return NextResponse.json({
    ...report,
    automation: {
      autoStrategyControlEnabled: isAutoStrategyControlEnabled(),
      note: 'Learning report is recommendation-only. Set AUTO_STRATEGY_CONTROL_ENABLED=true to allow a downstream worker to act on these recommendations.',
    },
  }, {
    headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate' },
  });
}
