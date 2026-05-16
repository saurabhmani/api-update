// ════════════════════════════════════════════════════════════════
//  GET /api/backtests/:id/analytics — Full grouped analytics
//
//  Returns (per Phase 3 spec §6):
//    - summary
//    - metric groups (organized by category)
//    - equity curve
//    - strategy analytics
//    - regime analytics
//    - sector analytics
//    - confidence bucket analytics
//    - risk band analytics
//    - holding period analytics
// ════════════════════════════════════════════════════════════════

import { NextRequest, NextResponse } from 'next/server';
import { loadBacktestRun, loadEquityCurve, loadBacktestTrades } from '@/lib/backtesting/repository/persistence';
import { loadBacktestMetrics } from '@/lib/backtesting/repository/metricsPersistence';
import { ensureBacktestTables } from '@/lib/backtesting/repository/migrate';
import { analyzeByStrategy } from '@/lib/backtesting/analytics/byStrategy';
import { analyzeByRegime } from '@/lib/backtesting/analytics/byRegime';
import { analyzeBySector } from '@/lib/backtesting/analytics/bySector';
import { analyzeByConfidenceBucket } from '@/lib/backtesting/analytics/byConfidenceBucket';
import { analyzeByRiskBand } from '@/lib/backtesting/analytics/byRiskBand';
import { analyzeByHoldingPeriod } from '@/lib/backtesting/analytics/byHoldingPeriod';
import { analyzeByNewsImpact } from '@/lib/backtesting/analytics/byNewsImpact';
import { db } from '@/lib/db';
import type { SimulatedTrade } from '@/lib/backtesting/types';

export const dynamic = 'force-dynamic';

/**
 * Map a raw DB trade row to the SimulatedTrade shape expected by analytics
 * functions. This is the boundary where snake_case becomes camelCase.
 */
function rowToTrade(r: any): SimulatedTrade {
  return {
    tradeId: r.trade_id,
    signalId: r.signal_id,
    symbol: r.symbol,
    sector: r.sector,
    direction: r.direction,
    strategy: r.strategy,
    regime: r.regime,
    confidenceScore: Number(r.confidence_score ?? 0),
    confidenceBand: r.confidence_band,
    signalDate: r.signal_date,
    entryDate: r.entry_date,
    exitDate: r.exit_date,
    barsToEntry: Number(r.bars_to_entry ?? 0),
    barsInTrade: Number(r.bars_in_trade ?? 0),
    entryPrice: Number(r.entry_price ?? 0),
    exitPrice: r.exit_price != null ? Number(r.exit_price) : null,
    stopLoss: Number(r.stop_loss ?? 0),
    target1: Number(r.target1 ?? 0),
    target2: Number(r.target2 ?? 0),
    target3: Number(r.target3 ?? 0),
    positionSize: Number(r.position_size ?? 0),
    positionValue: Number(r.position_value ?? 0),
    riskAmount: Number(r.risk_amount ?? 0),
    slippageCost: Number(r.slippage_cost ?? 0),
    commissionCost: Number(r.commission_cost ?? 0),
    grossPnl: Number(r.gross_pnl ?? 0),
    netPnl: Number(r.net_pnl ?? 0),
    returnPct: Number(r.return_pct ?? 0),
    returnR: Number(r.return_r ?? 0),
    outcome: r.outcome,
    exitReason: r.exit_reason,
    mfePct: Number(r.mfe_pct ?? 0),
    maePct: Number(r.mae_pct ?? 0),
    mfeR: Number(r.mfe_r ?? 0),
    maeR: Number(r.mae_r ?? 0),
    target1Hit: !!r.target1_hit,
    target2Hit: !!r.target2_hit,
    target3Hit: !!r.target3_hit,
    stopHit: !!r.stop_hit,
    target1HitBar: r.target1_hit_bar ?? null,
    target2HitBar: r.target2_hit_bar ?? null,
    target3HitBar: r.target3_hit_bar ?? null,
    stopHitBar: r.stop_hit_bar ?? null,
    barByBarPnl: [],
  };
}

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const ROUTE = `/api/backtests/${params.id}/analytics`;
  try {
    await ensureBacktestTables();
    const run = await loadBacktestRun(params.id);
    if (!run) {
      return NextResponse.json(
        {
          ok: false,
          error: 'Backtest run not found',
          route: ROUTE,
          generatedAt: new Date().toISOString(),
        },
        { status: 404 },
      );
    }

    const [equityCurve, metrics, rawTrades] = await Promise.all([
      loadEquityCurve(params.id),
      loadBacktestMetrics(params.id),
      loadBacktestTrades(params.id),
    ]);

    // Map raw DB rows to typed SimulatedTrade objects so analytics work
    const trades: SimulatedTrade[] = (rawTrades as any[]).map(rowToTrade);

    // Group metrics by category for cleaner consumption
    const metricGroups: Record<string, typeof metrics> = {};
    for (const m of metrics) {
      const cat = m.category || 'other';
      if (!metricGroups[cat]) metricGroups[cat] = [];
      metricGroups[cat].push(m);
    }

    // Parse JSON columns
    const summary = run.summary_json
      ? (typeof run.summary_json === 'string' ? JSON.parse(run.summary_json) : run.summary_json)
      : null;
    const strategyBreakdown = run.strategy_breakdown_json
      ? (typeof run.strategy_breakdown_json === 'string' ? JSON.parse(run.strategy_breakdown_json) : run.strategy_breakdown_json)
      : [];
    const regimeBreakdown = run.regime_breakdown_json
      ? (typeof run.regime_breakdown_json === 'string' ? JSON.parse(run.regime_breakdown_json) : run.regime_breakdown_json)
      : [];

    // Compute fresh analytics from persisted trades — Phase 3 spec §5/§6
    let strategyAnalytics: any[] = [];
    let regimeAnalytics: any[] = [];
    let sectorAnalytics: any[] = [];
    let confidenceAnalytics: any[] = [];
    let riskBandAnalytics: any[] = [];
    let holdingPeriodAnalytics: any[] = [];
    let newsImpactAnalytics: any[] = [];
    try {
      strategyAnalytics = analyzeByStrategy(trades);
      regimeAnalytics = analyzeByRegime(trades);
      sectorAnalytics = analyzeBySector(trades);
      confidenceAnalytics = analyzeByConfidenceBucket(trades);
      riskBandAnalytics = analyzeByRiskBand(trades);
      holdingPeriodAnalytics = analyzeByHoldingPeriod(trades);
      newsImpactAnalytics = analyzeByNewsImpact(trades as any);
    } catch (err) {
      console.error('[analytics] computation error:', err);
    }

    // Load persisted news effectiveness comparison
    let newsEffectiveness: any = null;
    try {
      const { rows: nfRows } = await db.query(
        `SELECT * FROM backtest_news_effectiveness WHERE run_id = ?`,
        [params.id],
      );
      if ((nfRows as any[]).length > 0) newsEffectiveness = (nfRows as any[])[0];
    } catch { /* table may not exist yet */ }

    return NextResponse.json({
      runId: params.id,
      runName: run.name,
      status: run.status,
      summary,
      // Original breakdowns from run record (JSON columns)
      strategyBreakdown,
      regimeBreakdown,
      // Equity curve + metric groups
      equityCurve,
      metrics,
      metricGroups,
      // Full grouped analytics (Phase 3 spec §6)
      analytics: {
        strategy: strategyAnalytics,
        regime: regimeAnalytics,
        sector: sectorAnalytics,
        confidenceBucket: confidenceAnalytics,
        riskBand: riskBandAnalytics,
        holdingPeriod: holdingPeriodAnalytics,
        newsImpact: newsImpactAnalytics,
      },
      newsEffectiveness,
    });
  } catch (err) {
    console.error('[Backtesting API] Route failed', {
      route: ROUTE,
      runId: params.id,
      error: err instanceof Error ? { message: err.message, stack: err.stack } : err,
      timestamp: new Date().toISOString(),
    });
    return NextResponse.json(
      {
        ok: false,
        error: err instanceof Error ? err.message : 'Failed to load analytics',
        details: err instanceof Error ? err.message : String(err),
        route: ROUTE,
        generatedAt: new Date().toISOString(),
      },
      { status: 500 },
    );
  }
}
