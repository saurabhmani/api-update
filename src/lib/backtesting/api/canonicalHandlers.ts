// ════════════════════════════════════════════════════════════════
//  Canonical /api/backtest handlers — shared by route modules
// ════════════════════════════════════════════════════════════════

import { NextRequest, NextResponse } from 'next/server';
import { runBacktest } from '../runner/backtestRunner';
import { persistFullRun } from '../runner/runOrchestrator';
import { queueBacktestRun } from '../runner/backtestQueue';
import { validateBacktestConfig } from '../utils/validation';
import { DEFAULT_BACKTEST_CONFIG } from '../config/defaults';
import { ensureBacktestTables } from '../repository/migrate';
import {
  loadBacktestRun,
  loadBacktestTrades,
  loadEquityCurve,
  listBacktestRuns,
} from '../repository/persistence';
import { loadBacktestSummaryRow } from '../repository/canonicalPersistence';
import { compareBacktestRuns } from '../comparison/compareRuns';
import { normalizeStatus } from '../runner/backtestQueue';
import type { BacktestRunConfig } from '../types';

function mapCanonicalSummary(
  row: Record<string, unknown>,
  tradeCount: number,
  signalCount: number,
): Record<string, unknown> {
  const embedded = row.summary_json
    ? (typeof row.summary_json === 'string' ? JSON.parse(row.summary_json) : row.summary_json) as Record<string, unknown>
    : {} as Record<string, unknown>;
  return {
    ...embedded,
    totalReturnPct: Number(row.total_return_pct ?? embedded.totalReturnPct ?? 0),
    winRate: Number(row.win_rate ?? embedded.winRate ?? 0),
    sharpeRatio: Number(row.sharpe_ratio ?? embedded.sharpeRatio ?? 0),
    sortinoRatio: Number(row.sortino_ratio ?? embedded.sortinoRatio ?? 0),
    maxDrawdownPct: Number(row.max_drawdown_pct ?? embedded.maxDrawdownPct ?? 0),
    profitFactor: Number(row.profit_factor ?? embedded.profitFactor ?? 0),
    expectancyR: Number(row.expectancy_r ?? embedded.expectancyR ?? 0),
    totalTradesTaken: Number(row.total_trades ?? tradeCount),
    totalSignalsGenerated: Number(row.total_signals ?? signalCount),
    initialCapital: Number(row.initial_capital ?? embedded.initialCapital ?? 0),
    finalEquity: Number(row.final_equity ?? embedded.finalEquity ?? 0),
    totalWins: embedded.totalWins ?? 0,
    totalLosses: embedded.totalLosses ?? 0,
    avgWinPct: embedded.avgWinPct ?? 0,
    avgLossPct: embedded.avgLossPct ?? 0,
    annualizedReturnPct: embedded.annualizedReturnPct ?? 0,
    calmarRatio: embedded.calmarRatio ?? 0,
    avgBarsInTrade: embedded.avgBarsInTrade ?? 0,
    target1HitRate: embedded.target1HitRate ?? 0,
    target2HitRate: embedded.target2HitRate ?? 0,
    target3HitRate: embedded.target3HitRate ?? 0,
  };
}

export async function handlePostBacktest(req: NextRequest) {
  await ensureBacktestTables();
  const body = await req.json().catch(() => ({}));
  const config: BacktestRunConfig = { ...DEFAULT_BACKTEST_CONFIG, ...(body?.config ?? body ?? {}) };

  const validation = validateBacktestConfig(config);
  if (!validation.valid) {
    return NextResponse.json({ ok: false, error: 'Invalid configuration', details: validation.errors }, { status: 400 });
  }

  if (process.env.BACKTEST_SYNC_MODE === 'true') {
    const result = await runBacktest(config);
    await persistFullRun(result).catch(() => null);
    return NextResponse.json({
      ok: true,
      backtestId: result.runId,
      runId: result.runId,
      status: result.status,
      mode: 'sync',
      tradeCount: result.tradeCount,
      signalCount: result.signalCount,
    });
  }

  const queued = await queueBacktestRun(config);
  return NextResponse.json({
    ok: true,
    backtestId: queued.runId,
    runId: queued.runId,
    status: queued.status,
    mode: 'queued',
    message: queued.message,
  }, { status: 202 });
}

export async function handleListBacktests() {
  await ensureBacktestTables();
  const runs = await listBacktestRuns();
  return NextResponse.json({
    ok: true,
    backtests: runs.map((r) => ({
      id: r.run_id,
      backtestId: r.run_id,
      name: r.name,
      status: r.status,
      tradeCount: r.trade_count,
      signalCount: r.signal_count,
      startedAt: r.started_at,
      completedAt: r.completed_at,
      summary: r.summary_json,
      config: r.config_json,
      progressPercent: r.progress_percent,
      currentStep: r.current_step,
    })),
    runs,
  });
}

export async function handleGetBacktest(id: string, req: NextRequest) {
  await ensureBacktestTables();
  const run = await loadBacktestRun(id);
  if (!run) {
    return NextResponse.json({ ok: false, error: 'Backtest not found' }, { status: 404 });
  }

  const include = req.nextUrl.searchParams.get('include') ?? 'summary,trades,equity';
  const parts = new Set(include.split(',').map((s) => s.trim().toLowerCase()));

  const config = typeof run.config_json === 'string' ? JSON.parse(run.config_json) : run.config_json;
  const summaryJson = run.summary_json
    ? (typeof run.summary_json === 'string' ? JSON.parse(run.summary_json) : run.summary_json)
    : null;

  const [canonicalSummary, trades, equityCurve] = await Promise.all([
    loadBacktestSummaryRow(id),
    parts.has('trades') || parts.has('all') ? loadBacktestTrades(id) : Promise.resolve([]),
    parts.has('equity') || parts.has('all') ? loadEquityCurve(id) : Promise.resolve([]),
  ]);

  const summaryFromCanonical = canonicalSummary
    ? mapCanonicalSummary(canonicalSummary, Number(run.trade_count ?? 0), Number(run.signal_count ?? 0))
    : summaryJson;

  return NextResponse.json({
    ok: true,
    backtestId: id,
    run: {
      id,
      name: run.name,
      status: normalizeStatus(run.status),
      rawStatus: run.status,
      config,
      startedAt: run.started_at,
      completedAt: run.completed_at,
      durationMs: run.duration_ms,
      progressPercent: Number(run.progress_percent ?? 0),
      currentStep: run.current_step ?? null,
      error: run.error ?? null,
      tradeCount: Number(run.trade_count ?? 0),
      signalCount: Number(run.signal_count ?? 0),
    },
    summary: summaryFromCanonical,
    trades: parts.has('trades') || parts.has('all') ? trades : undefined,
    equityCurve: parts.has('equity') || parts.has('all')
      ? equityCurve.map((p: Record<string, unknown>) => ({
          date: p.date,
          equity: Number(p.equity),
          cash: Number(p.cash ?? 0),
          drawdownPct: Number(p.drawdown_pct ?? p.drawdownPct ?? 0),
          openPositions: Number(p.open_positions ?? p.openPositions ?? 0),
          dayPnl: Number(p.day_pnl ?? p.dayPnl ?? 0),
        }))
      : undefined,
  });
}

export async function handleCompareBacktests(req: NextRequest) {
  const raw = req.nextUrl.searchParams.get('ids') ?? '';
  const runIds = raw.split(',').map((s) => s.trim()).filter(Boolean);
  if (runIds.length < 2) {
    return NextResponse.json({ ok: false, error: 'Provide at least 2 ids via ?ids=' }, { status: 400 });
  }
  const comparison = await compareBacktestRuns(runIds);
  return NextResponse.json({ ok: true, ...comparison });
}
