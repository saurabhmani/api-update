// ════════════════════════════════════════════════════════════════
//  GET /api/backtests/:id/signals
//
//  Returns the generated signals for a backtest run, joined with
//  their outcomes (trigger flag, target hits, MFE/MAE, outcome label).
//  Required by Phase 1 spec section 6.
// ════════════════════════════════════════════════════════════════

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { ensureBacktestTables } from '@/lib/backtesting/repository/migrate';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const ROUTE = `/api/backtests/${params.id}/signals`;
  try {
    await ensureBacktestTables();

    const limit = Math.min(parseInt(req.nextUrl.searchParams.get('limit') ?? '500', 10), 5000);
    const status = req.nextUrl.searchParams.get('status');     // pending|triggered|expired|filtered
    const strategy = req.nextUrl.searchParams.get('strategy');
    const symbol = req.nextUrl.searchParams.get('symbol');

    // LEFT JOIN to outcomes — outcome rows may not exist yet but signals always do
    let sql = `
      SELECT
        s.signal_id, s.symbol, s.date, s.bar_index, s.direction, s.strategy,
        s.regime, s.confidence_score, s.confidence_band, s.risk_score, s.sector,
        s.entry_zone_low, s.entry_zone_high, s.stop_loss,
        s.target1, s.target2, s.target3, s.risk_per_unit, s.reward_risk,
        s.status AS signal_status, s.bars_waited, s.reasons_json,
        o.entry_triggered, o.bars_to_entry,
        o.target1_hit, o.target2_hit, o.target3_hit, o.stop_hit,
        o.max_fav_excursion_pct AS mfe_pct,
        o.max_adv_excursion_pct AS mae_pct,
        o.return_bar5_pct, o.return_bar10_pct, o.outcome_label
      FROM backtest_signals s
      LEFT JOIN backtest_signal_outcomes o
        ON o.run_id = s.run_id AND o.signal_id = s.signal_id
      WHERE s.run_id = ?
    `;
    const queryParams: any[] = [params.id];

    if (status)   { sql += ` AND s.status = ?`;   queryParams.push(status); }
    if (strategy) { sql += ` AND s.strategy = ?`; queryParams.push(strategy); }
    if (symbol)   { sql += ` AND s.symbol = ?`;   queryParams.push(symbol); }

    sql += ` ORDER BY s.date ASC, s.bar_index ASC LIMIT ?`;
    queryParams.push(limit);

    const { rows } = await db.query(sql, queryParams);

    // Aggregate counts for the dashboard summary
    const { rows: countRows } = await db.query(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN o.entry_triggered = 1 THEN 1 ELSE 0 END) AS triggered,
         SUM(CASE WHEN o.outcome_label = 'good_followthrough' THEN 1 ELSE 0 END) AS good,
         SUM(CASE WHEN o.outcome_label = 'stopped_out' THEN 1 ELSE 0 END) AS stopped,
         SUM(CASE WHEN o.outcome_label = 'stale_no_trigger' THEN 1 ELSE 0 END) AS stale
       FROM backtest_signals s
       LEFT JOIN backtest_signal_outcomes o
         ON o.run_id = s.run_id AND o.signal_id = s.signal_id
       WHERE s.run_id = ?`,
      [params.id],
    );

    const aggregate = countRows[0] ?? {};

    return NextResponse.json({
      ok: true,
      runId: params.id,
      total: rows.length,
      aggregate: {
        total: Number((aggregate as any).total ?? 0),
        triggered: Number((aggregate as any).triggered ?? 0),
        goodFollowthrough: Number((aggregate as any).good ?? 0),
        stoppedOut: Number((aggregate as any).stopped ?? 0),
        staleNoTrigger: Number((aggregate as any).stale ?? 0),
      },
      signals: rows.map((r: any) => ({
        signalId: r.signal_id,
        symbol: r.symbol,
        date: r.date,
        barIndex: r.bar_index,
        direction: r.direction,
        strategy: r.strategy,
        regime: r.regime,
        confidenceScore: r.confidence_score,
        confidenceBand: r.confidence_band,
        riskScore: r.risk_score,
        sector: r.sector,
        entryZoneLow: Number(r.entry_zone_low),
        entryZoneHigh: Number(r.entry_zone_high),
        stopLoss: Number(r.stop_loss),
        target1: Number(r.target1),
        target2: Number(r.target2),
        target3: Number(r.target3),
        riskPerUnit: Number(r.risk_per_unit),
        rewardRisk: Number(r.reward_risk),
        status: r.signal_status,
        barsWaited: r.bars_waited,
        reasons: typeof r.reasons_json === 'string' ? JSON.parse(r.reasons_json) : (r.reasons_json ?? []),
        outcome: r.entry_triggered != null ? {
          entryTriggered: !!r.entry_triggered,
          barsToEntry: r.bars_to_entry,
          target1Hit: !!r.target1_hit,
          target2Hit: !!r.target2_hit,
          target3Hit: !!r.target3_hit,
          stopHit: !!r.stop_hit,
          mfePct: Number(r.mfe_pct ?? 0),
          maePct: Number(r.mae_pct ?? 0),
          returnBar5Pct: r.return_bar5_pct != null ? Number(r.return_bar5_pct) : null,
          returnBar10Pct: r.return_bar10_pct != null ? Number(r.return_bar10_pct) : null,
          outcomeLabel: r.outcome_label,
        } : null,
      })),
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
        error: err instanceof Error ? err.message : 'Failed to load signals',
        details: err instanceof Error ? err.message : String(err),
        route: ROUTE,
        generatedAt: new Date().toISOString(),
      },
      { status: 500 },
    );
  }
}
