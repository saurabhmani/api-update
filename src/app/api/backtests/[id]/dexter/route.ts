// ════════════════════════════════════════════════════════════════
//  GET /api/backtests/:id/dexter — Dexter AI structured payload
//
//  Uses canonical loaders that return camelCase typed objects.
//  No more snake_case ↔ camelCase mismatches.
//
//  Returns:
//    - meta (run id, name, status, range, counts)
//    - verdict (profitable, edge, calibrated, recommendation)
//    - strategyInsights (per-strategy with verdict + modifier)
//    - regimeInsights (per-regime with verdict)
//    - calibrationWarnings (over/underconfident bands with severity)
//    - executionQuality (edge ratio, hit rates, assessment)
//    - sectorRanking
//    - keyMetrics
// ════════════════════════════════════════════════════════════════

import { NextRequest, NextResponse } from 'next/server';
import { loadBacktestRun, loadBacktestTrades } from '@/lib/backtesting/repository/persistence';
import { loadBacktestMetrics, loadCalibrationSnapshots } from '@/lib/backtesting/repository/metricsPersistence';
import { ensureBacktestTables } from '@/lib/backtesting/repository/migrate';
import type { CalibrationBucketResult } from '@/lib/backtesting/types';

interface DexterCalibrationWarning {
  bucket: string;
  strategy: string;
  regime: string;
  severity: 'info' | 'warning' | 'critical';
  state: string;
  expectedHitRate: number;
  actualHitRate: number;
  sampleSize: number;
  suggestedModifier: number;
  message: string;
}

function buildCalibrationWarnings(calibration: CalibrationBucketResult[]): DexterCalibrationWarning[] {
  const warnings: DexterCalibrationWarning[] = [];

  for (const c of calibration) {
    // Skip well-calibrated and insufficient-data buckets
    if (!c.calibrationState) continue;
    if (c.calibrationState === 'well_calibrated') continue;
    if (c.calibrationState === 'insufficient_data') continue;

    const severity: DexterCalibrationWarning['severity'] =
      c.calibrationState === 'overconfident' ? 'critical'
      : c.calibrationState === 'slightly_overconfident' ? 'warning'
      : 'info';

    const expectedPct = (c.expectedHitRate * 100).toFixed(0);
    const actualPct = (c.actualHitRate * 100).toFixed(0);
    let message: string;

    if (c.calibrationState === 'overconfident') {
      message = `Confidence band ${c.bucket} is overconfident: expected ${expectedPct}% hit rate, actual ${actualPct}%. Reduce confidence by ${Math.abs(c.confidenceModifierSuggestion)} points.`;
    } else if (c.calibrationState === 'slightly_overconfident') {
      message = `Confidence band ${c.bucket} is slightly overconfident: actual ${actualPct}% vs expected ${expectedPct}%.`;
    } else {
      message = `Confidence band ${c.bucket} is underconfident: actual ${actualPct}% exceeds expected ${expectedPct}%. Could boost confidence by ${c.confidenceModifierSuggestion} points.`;
    }

    warnings.push({
      bucket: c.bucket,
      strategy: c.strategy,
      regime: c.regime,
      severity,
      state: c.calibrationState,
      expectedHitRate: c.expectedHitRate,
      actualHitRate: c.actualHitRate,
      sampleSize: c.sampleSize,
      suggestedModifier: c.confidenceModifierSuggestion,
      message,
    });
  }

  return warnings;
}

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    await ensureBacktestTables();
    const run = await loadBacktestRun(params.id);
    if (!run) {
      return NextResponse.json({ error: 'Backtest run not found' }, { status: 404 });
    }

    const [trades, metrics, calibration] = await Promise.all([
      loadBacktestTrades(params.id),
      loadBacktestMetrics(params.id),
      loadCalibrationSnapshots(params.id),
    ]);

    const summary = run.summary_json
      ? (typeof run.summary_json === 'string' ? JSON.parse(run.summary_json) : run.summary_json)
      : null;

    // Key metrics map (canonical camelCase from loadBacktestMetrics)
    const keyMetrics: Record<string, number> = {};
    for (const m of metrics) {
      keyMetrics[m.metricKey] = m.metricValue;
    }

    // Calibration warnings — uses normalized loader output
    const calibrationWarnings = buildCalibrationWarnings(calibration);

    // Identify weak/strong bands
    const weakBands = calibration.filter(c => c.calibrationState === 'overconfident').map(c => c.bucket);
    const strongBands = calibration.filter(c => c.calibrationState === 'underconfident').map(c => c.bucket);

    // Strategy performance from trades — DB returns snake_case rows
    const strategyMap: Record<string, { wins: number; total: number; pnl: number; expectancyR: number; }> = {};
    for (const t of trades) {
      const s = (t as any).strategy;
      if (!s) continue;
      if (!strategyMap[s]) strategyMap[s] = { wins: 0, total: 0, pnl: 0, expectancyR: 0 };
      strategyMap[s].total++;
      if ((t as any).outcome === 'win') strategyMap[s].wins++;
      strategyMap[s].pnl += Number((t as any).net_pnl ?? 0);
      strategyMap[s].expectancyR += Number((t as any).return_r ?? 0);
    }

    const strategyInsights = Object.entries(strategyMap).map(([strategy, data]) => {
      const winRate = data.total > 0 ? data.wins / data.total : 0;
      const avgR = data.total > 0 ? data.expectancyR / data.total : 0;
      const verdict: 'strong' | 'acceptable' | 'weak' | 'avoid' =
        avgR >= 0.3 && winRate >= 0.55 ? 'strong'
        : avgR >= 0 && winRate >= 0.45 ? 'acceptable'
        : avgR >= -0.1 ? 'weak'
        : 'avoid';
      return {
        strategy,
        trades: data.total,
        winRate: Math.round(winRate * 10000) / 10000,
        expectancyR: Math.round(avgR * 100) / 100,
        totalPnl: Math.round(data.pnl * 100) / 100,
        verdict,
        confidenceModifier: verdict === 'strong' ? 3 : verdict === 'acceptable' ? 0 : verdict === 'weak' ? -3 : -5,
      };
    });

    // Regime performance from trades
    const regimeMap: Record<string, { wins: number; total: number; expectancyR: number; }> = {};
    for (const t of trades) {
      const r = (t as any).regime;
      if (!r) continue;
      if (!regimeMap[r]) regimeMap[r] = { wins: 0, total: 0, expectancyR: 0 };
      regimeMap[r].total++;
      if ((t as any).outcome === 'win') regimeMap[r].wins++;
      regimeMap[r].expectancyR += Number((t as any).return_r ?? 0);
    }

    const regimeInsights = Object.entries(regimeMap).map(([regime, data]) => {
      const winRate = data.total > 0 ? data.wins / data.total : 0;
      const avgR = data.total > 0 ? data.expectancyR / data.total : 0;
      const verdict: 'favorable' | 'neutral' | 'unfavorable' =
        avgR >= 0.2 ? 'favorable' : avgR >= -0.1 ? 'neutral' : 'unfavorable';
      return {
        regime,
        trades: data.total,
        winRate: Math.round(winRate * 10000) / 10000,
        expectancyR: Math.round(avgR * 100) / 100,
        verdict,
      };
    });

    // Verdict
    const totalReturn = Number(summary?.totalReturnPct ?? 0);
    const winRate = Number(summary?.winRate ?? 0);
    const profitFactor = Number(summary?.profitFactor ?? 0);
    const profitable = totalReturn > 0;
    const edgeExists = profitFactor > 1;
    const verdict = {
      profitable,
      edgeExists,
      hasOverconfidentBands: weakBands.length > 0,
      hasUnderconfidentBands: strongBands.length > 0,
      recommendation: !profitable
        ? 'System is unprofitable over this period — review filters and rules.'
        : !edgeExists
        ? 'System shows no statistical edge — wins may be drift-driven.'
        : weakBands.length > 0
        ? `Profitable but ${weakBands.length} confidence band(s) are overconfident — recalibrate before scaling.`
        : `Profitable with ${profitFactor.toFixed(2)} PF and ${(winRate * 100).toFixed(0)}% win rate.`,
    };

    return NextResponse.json({
      runId: params.id,
      runName: run.name,
      status: run.status,
      meta: {
        runId: params.id,
        runName: run.name,
        startedAt: run.started_at,
        completedAt: run.completed_at,
        totalSignals: Number(run.signal_count ?? 0),
        totalTrades: Number(run.trade_count ?? 0),
      },
      verdict,
      summary,
      keyMetrics,
      strategyInsights,
      regimeInsights,
      calibrationWarnings,
      weakBands,
      strongBands,
      tradeCount: trades.length,
    });
  } catch (err) {
    return NextResponse.json(
      { error: 'Failed to load Dexter output', details: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
