// ════════════════════════════════════════════════════════════════
//  GET    /api/backtests/:id — Backtest run detail
//  DELETE /api/backtests/:id — Delete a run + all child rows
// ════════════════════════════════════════════════════════════════

import { NextRequest, NextResponse } from 'next/server';
import {
  loadBacktestRun,
  loadBacktestTrades,
} from '@/lib/backtesting/repository/persistence';
import { loadBacktestMetrics } from '@/lib/backtesting/repository/metricsPersistence';
import { ensureBacktestTables } from '@/lib/backtesting/repository/migrate';
import { normalizeStatus } from '@/lib/backtesting/runner/backtestQueue';
import { db } from '@/lib/db';

export const dynamic = 'force-dynamic';

// Phase 3 §4 — consolidated backtest detail.
//
// Default: returns run metadata + execution summary only (small,
// cheap). Opt in to embedded child collections via `?include=`:
//
//   ?include=trades              — embed every trade row
//   ?include=signals             — embed every signal row with outcome
//   ?include=metrics             — embed flat metric rows
//   ?include=trades,signals      — multiple
//   ?include=all                 — trades + signals + metrics
//
// Heavy analytics (strategy/regime/sector breakdowns) stay on the
// dedicated /api/backtests/:id/analytics route because they involve
// per-request computation; embedding them here by default would
// slow list pages that only need the summary.

function parseIncludes(raw: string | null): Set<string> {
  if (!raw) return new Set();
  const parts = raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (parts.includes('all')) return new Set(['trades', 'signals', 'metrics']);
  return new Set(parts);
}

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const ROUTE = `/api/backtests/${params.id}`;
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

    const includes = parseIncludes(req.nextUrl.searchParams.get('include'));

    // ── Signal lifecycle aggregate (Phase 2 spec §5/§6) ──
    // Counts how many signals in this run resolved as triggered, expired,
    // invalidated-before-entry (filtered), missed, etc.
    const { rows: lifecycleRows } = await db.query<{ status: string; cnt: number }>(
      `SELECT status, COUNT(*) AS cnt
       FROM backtest_signals
       WHERE run_id = ?
       GROUP BY status`,
      [params.id],
    );

    const signalLifecycle: Record<string, number> = {
      pending: 0, triggered: 0, expired: 0, filtered: 0,
    };
    for (const row of lifecycleRows as any[]) {
      if (row.status) signalLifecycle[row.status] = Number(row.cnt);
    }

    // ── Outcome distribution from signal_outcomes ──
    const { rows: outcomeRows } = await db.query<{ outcome_label: string; cnt: number }>(
      `SELECT outcome_label, COUNT(*) AS cnt
       FROM backtest_signal_outcomes
       WHERE run_id = ?
       GROUP BY outcome_label`,
      [params.id],
    );

    const outcomeDistribution: Record<string, number> = {};
    for (const row of outcomeRows as any[]) {
      if (row.outcome_label) outcomeDistribution[row.outcome_label] = Number(row.cnt);
    }

    // ── Audit event distribution ──
    const { rows: auditRows } = await db.query<{ action: string; cnt: number }>(
      `SELECT action, COUNT(*) AS cnt
       FROM backtest_audit_logs
       WHERE run_id = ?
       GROUP BY action`,
      [params.id],
    );

    const auditDistribution: Record<string, number> = {};
    for (const row of auditRows as any[]) {
      if (row.action) auditDistribution[row.action] = Number(row.cnt);
    }

    // Parse JSON fields + surface queue-mode columns under camelCase
    // names so the polling UI can read them without doing snake_case
    // conversion. Old rows that pre-date the queue migration have
    // NULL progress_percent / current_step / updated_at — coalesce.
    const parsed = {
      ...run,
      config: typeof run.config_json === 'string' ? JSON.parse(run.config_json) : run.config_json,
      summary: run.summary_json ? (typeof run.summary_json === 'string' ? JSON.parse(run.summary_json) : run.summary_json) : null,
      strategyBreakdown: run.strategy_breakdown_json ? (typeof run.strategy_breakdown_json === 'string' ? JSON.parse(run.strategy_breakdown_json) : run.strategy_breakdown_json) : [],
      regimeBreakdown: run.regime_breakdown_json ? (typeof run.regime_breakdown_json === 'string' ? JSON.parse(run.regime_breakdown_json) : run.regime_breakdown_json) : [],
      // ── Queue surface ────────────────────────────────────────
      status:          normalizeStatus(run.status),
      rawStatus:       run.status,                 // diagnostics — keeps partial_success visible
      progressPercent: Number(run.progress_percent ?? 0),
      currentStep:     run.current_step ?? null,
      errorMessage:    run.error ?? null,
      startedAt:       run.started_at ?? null,
      completedAt:     run.completed_at ?? null,
      updatedAt:       run.updated_at ?? null,
      createdAt:       run.started_at ?? null,     // legacy table has no created_at — started_at is the closest signal
    };

    // ── Optional embedded child collections ──────────────────
    const embedded: {
      trades?: unknown[];
      signals?: unknown[];
      metrics?: unknown[];
    } = {};

    if (includes.has('trades')) {
      embedded.trades = await loadBacktestTrades(params.id);
    }

    if (includes.has('signals')) {
      // Join signals to their outcomes in one query so callers don't
      // have to stitch two collections manually. LEFT JOIN so unresolved
      // signals (status='pending' or 'filtered') still surface.
      const { rows } = await db.query(
        `SELECT s.*,
                o.outcome_label, o.target1_hit, o.stop_hit,
                o.max_fav_excursion_pct, o.max_adv_excursion_pct,
                o.bars_to_entry, o.evaluated_at
           FROM backtest_signals s
           LEFT JOIN backtest_signal_outcomes o
             ON o.run_id = s.run_id AND o.signal_id = s.signal_id
          WHERE s.run_id = ?
          ORDER BY s.signal_date ASC`,
        [params.id],
      );
      embedded.signals = rows;
    }

    if (includes.has('metrics')) {
      embedded.metrics = await loadBacktestMetrics(params.id);
    }

    return NextResponse.json({
      ok: true,
      run: parsed,
      executionSummary: {
        signalCount: Number(run.signal_count ?? 0),
        tradeCount: Number(run.trade_count ?? 0),
        triggeredCount: signalLifecycle.triggered,
        expiredCount: signalLifecycle.expired,
        invalidatedCount: signalLifecycle.filtered,
        missedCount: signalLifecycle.pending + (signalLifecycle.expired - (outcomeDistribution.stale_no_trigger ?? 0)),
        signalLifecycle,
        outcomeDistribution,
        auditDistribution,
      },
      // Only present when the caller opted in via ?include=.
      ...(embedded.trades ? { trades: embedded.trades } : {}),
      ...(embedded.signals ? { signals: embedded.signals } : {}),
      ...(embedded.metrics ? { metrics: embedded.metrics } : {}),
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
        error: err instanceof Error ? err.message : 'Failed to load backtest',
        details: err instanceof Error ? err.message : String(err),
        route: ROUTE,
        generatedAt: new Date().toISOString(),
      },
      { status: 500 },
    );
  }
}

export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  const ROUTE = `/api/backtests/${params.id}`;
  try {
    await ensureBacktestTables();
    const runId = params.id;

    // Delete from all related tables (no cascade defined, so do it manually)
    const tables = [
      'backtest_trades',
      'backtest_signals',
      'backtest_signal_outcomes',
      'backtest_metrics',
      'backtest_equity_curve',
      'backtest_audit_logs',
      'calibration_snapshots',
    ];

    for (const t of tables) {
      await db.query(`DELETE FROM ${t} WHERE run_id = ?`, [runId]).catch(() => {});
    }

    const result = await db.query(`DELETE FROM backtest_runs WHERE run_id = ?`, [runId]);

    return NextResponse.json({
      ok: true,
      success: true,
      runId,
      deleted: result.affectedRows ?? 0,
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
        error: err instanceof Error ? err.message : 'Failed to delete backtest',
        details: err instanceof Error ? err.message : String(err),
        route: ROUTE,
        generatedAt: new Date().toISOString(),
      },
      { status: 500 },
    );
  }
}
