// ════════════════════════════════════════════════════════════════
//  Run Orchestrator — Explicit Truth-Chain Persistence
//
//  Implements the 14-step orchestration order from Phase 1 spec:
//   1. create run record       (in-memory, done by runner)
//   2. load data               (done by runner)
//   3. replay signals          (done by runner)
//   4. simulate trades         (done by runner)
//   5. compute outcomes        ← here
//   6. compute metrics         ← here
//   7. persist run             ← here
//   8. persist generated signals
//   9. persist trades
//  10. persist signal outcomes
//  11. persist metrics
//  12. persist calibration
//  13. persist audit events
//  14. mark run complete       (status already 'completed' on the record)
//
//  EVERY artifact is passed in explicitly via BacktestRunResult.
//  Nothing is reconstructed from disk after the fact.
// ════════════════════════════════════════════════════════════════

import type { BacktestRunResult } from './backtestRunner';
import { createLogger } from '../utils/logger';
import { DEFAULT_PERSIST_CHUNK_SIZE } from '../repository/metricsPersistence';
import { computeFullPerformanceReport } from '../metrics/performanceMetrics';
import { analyzeByStrategy } from '../analytics/byStrategy';
import { analyzeByRegime } from '../analytics/byRegime';
import { analyzeBySector } from '../analytics/bySector';
import { analyzeByConfidenceBucket } from '../analytics/byConfidenceBucket';
import { analyzeByRiskBand } from '../analytics/byRiskBand';
import { analyzeByHoldingPeriod } from '../analytics/byHoldingPeriod';
import { analyzeByNewsImpact, type NewsImpactAnalytics } from '../analytics/byNewsImpact';
import { saveBacktestRun } from '../repository/persistence';
import {
  saveBacktestMetrics, saveCalibrationSnapshots,
  saveSignalOutcomes, saveBacktestSignals, savePerformanceMetrics,
  saveNewsAnalytics, saveNewsEffectiveness,
} from '../repository/metricsPersistence';
import { AuditLogger } from '../repository/auditLogger';
import { buildDexterOutput, type DexterOutput } from '../api/dexterOutput';
import { db } from '@/lib/db';
import type { BacktestStatus } from '../types';

/**
 * Per-table row counts persisted in this orchestration cycle.
 * Returned to the API caller in the POST response (spec section 6).
 */
export interface PersistenceSummary {
  run: number;
  signals: number;
  trades: number;
  signalOutcomes: number;
  metrics: number;
  calibrationBuckets: number;
  equityCurve: number;
  auditEvents: number;
  errors: string[];
}

export interface OrchestratedResult {
  runId: string;
  status: BacktestStatus;
  signalCount: number;
  tradeCount: number;
  durationMs: number | null;
  persistenceSummary: PersistenceSummary;
  // Backwards-compatible aliases for existing API consumers
  persistedMetrics: number;
  persistedCalibrationBuckets: number;
  persistedSignals: number;
  persistedTrades: number;
  dexterOutput: DexterOutput | null;
}

/**
 * Persist a complete backtest result. Single explicit contract: every
 * artifact comes from the in-memory result, no implicit reconstruction.
 */
export async function persistFullRun(result: BacktestRunResult): Promise<OrchestratedResult> {
  const runId = result.runId;
  const errors: string[] = [];
  const log = createLogger(
    { runId, component: 'orchestrator' },
    { debug: result.config.debug === true },
  );
  const chunkSize = Math.max(1, result.config.persistChunkSize ?? DEFAULT_PERSIST_CHUNK_SIZE);
  const summary: PersistenceSummary = {
    run: 0, signals: 0, trades: 0, signalOutcomes: 0,
    metrics: 0, calibrationBuckets: 0, equityCurve: 0, auditEvents: 0,
    errors,
  };

  // ── Step 5: Compute outcomes (already in result.signals + trades) ──
  // ── Step 6: Compute metrics + analytics ────────────────────────────
  // Failed runs may have empty data — compute defensively, never throw.
  let report;
  let strategyAnalytics: any[] = [];
  let regimeAnalytics: any[] = [];
  let sectorAnalytics: any[] = [];
  let confidenceAnalytics: any[] = [];
  let newsAnalytics: NewsImpactAnalytics[] = [];
  try {
    report = computeFullPerformanceReport(result.trades, result.signals, result.equityCurve);
    strategyAnalytics = analyzeByStrategy(result.trades);
    regimeAnalytics = analyzeByRegime(result.trades);
    sectorAnalytics = analyzeBySector(result.trades);
    confidenceAnalytics = analyzeByConfidenceBucket(result.trades);
    analyzeByRiskBand(result.trades);
    analyzeByHoldingPeriod(result.trades);
    // Phase 5: segment trades by news impact level
    newsAnalytics = analyzeByNewsImpact(result.trades as any);
  } catch (err) {
    errors.push(`metrics_computation: ${err instanceof Error ? err.message : String(err)}`);
    report = { flatMetrics: [], calibration: [] } as any;
  }

  // ── Step 7: Persist run record + Step 9: trades + equity curve ────
  // (saveBacktestRun handles run, trades, and equity_curve in one call)
  try {
    await saveBacktestRun(result, result.trades, result.equityCurve);
    summary.run = 1;
    summary.trades = result.trades.length;
    summary.equityCurve = result.equityCurve.length;
  } catch (err) {
    const msg = `saveBacktestRun: ${err instanceof Error ? err.message : String(err)}`;
    errors.push(msg);
    console.error(`[Orchestrator] ${msg}`);
  }

  // ── Step 8: Persist generated signals ──────────────────────────────
  if (result.signals.length > 0) {
    try {
      await saveBacktestSignals(runId, result.signals, chunkSize);
      summary.signals = result.signals.length;
    } catch (err) {
      const msg = `saveBacktestSignals: ${err instanceof Error ? err.message : String(err)}`;
      errors.push(msg);
      console.error(`[Orchestrator] ${msg}`);
    }
  }

  // ── Step 10: Persist signal outcomes ───────────────────────────────
  if (result.signals.length > 0) {
    try {
      await saveSignalOutcomes(runId, result.signals, result.trades, chunkSize);
      summary.signalOutcomes = result.signals.length;
    } catch (err) {
      const msg = `saveSignalOutcomes: ${err instanceof Error ? err.message : String(err)}`;
      errors.push(msg);
      console.error(`[Orchestrator] ${msg}`);
    }
  }

  // ── Step 11: Persist metrics ───────────────────────────────────────
  try {
    await saveBacktestMetrics(runId, report.flatMetrics);
    summary.metrics = report.flatMetrics.length;
  } catch (err) {
    const msg = `saveBacktestMetrics: ${err instanceof Error ? err.message : String(err)}`;
    errors.push(msg);
    console.error(`[Orchestrator] ${msg}`);
  }

  // ── Step 12: Persist calibration ──────────────────────────────────
  try {
    await saveCalibrationSnapshots(runId, report.calibration);
    summary.calibrationBuckets = report.calibration.length;
  } catch (err) {
    const msg = `saveCalibrationSnapshots: ${err instanceof Error ? err.message : String(err)}`;
    errors.push(msg);
    console.error(`[Orchestrator] ${msg}`);
  }

  // ── Step 12.5: Persist performance metrics (Section 2) ────────────
  if (result.performance) {
    try {
      await savePerformanceMetrics(runId, result.performance);
    } catch (err) {
      const msg = `savePerformanceMetrics: ${err instanceof Error ? err.message : String(err)}`;
      errors.push(msg);
      console.error(`[Orchestrator] ${msg}`);
    }
  }

  // ── Step 13: Persist audit events ─────────────────────────────────
  if (result.auditEntries && result.auditEntries.length > 0) {
    try {
      const audit = AuditLogger.fromEntries(runId, result.auditEntries);
      await audit.persist();
      summary.auditEvents = result.auditEntries.length;
    } catch (err) {
      const msg = `audit.persist: ${err instanceof Error ? err.message : String(err)}`;
      errors.push(msg);
      console.error(`[Orchestrator] ${msg}`);
    }
  }

  // ── Step 14: Build Dexter output (run is already marked complete) ──
  // Skip on failed runs — there's nothing to verdict on.
  let dexterOutput: DexterOutput | null = null;
  if (result.status === 'completed' && result.trades.length > 0) {
    try {
      dexterOutput = buildDexterOutput(
        result, report, strategyAnalytics, regimeAnalytics,
        sectorAnalytics, confidenceAnalytics, newsAnalytics,
      );
    } catch (err) {
      errors.push(`buildDexterOutput: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ── Step 15: Persist news analytics + effectiveness ────────────────
  if (newsAnalytics.length > 0) {
    try {
      await saveNewsAnalytics(runId, newsAnalytics);
    } catch (err) {
      errors.push(`saveNewsAnalytics: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Build and persist news effectiveness comparison
    try {
      const baseline = newsAnalytics.find(a => a.bucket === 'no_news');
      const newsAware = newsAnalytics.filter(a => a.bucket !== 'no_news');
      if (baseline && newsAware.length > 0) {
        const totalNewsTrades = newsAware.reduce((s, a) => s + a.trades, 0);
        const weightedWinRate = totalNewsTrades > 0
          ? newsAware.reduce((s, a) => s + a.winRate * a.trades, 0) / totalNewsTrades
          : 0;
        const weightedExpectancy = totalNewsTrades > 0
          ? newsAware.reduce((s, a) => s + a.expectancyR * a.trades, 0) / totalNewsTrades
          : 0;
        const winRateDelta = Math.round((weightedWinRate - baseline.winRate) * 10000) / 10000;
        const expectancyDelta = Math.round((weightedExpectancy - baseline.expectancyR) * 10000) / 10000;
        const newsAddsValue = winRateDelta > 0 && expectancyDelta > 0;
        // Score: -100 to +100 based on combined improvement
        const rawScore = (winRateDelta * 100) + (expectancyDelta * 20);
        const newsEffectivenessScore = Math.round(Math.max(-100, Math.min(100, rawScore)) * 100) / 100;

        const summary = newsAddsValue
          ? `News intelligence adds value: +${(winRateDelta * 100).toFixed(1)}% win rate, +${expectancyDelta.toFixed(2)}R expectancy.`
          : `News intelligence needs recalibration: ${(winRateDelta * 100).toFixed(1)}% win rate delta, ${expectancyDelta.toFixed(2)}R expectancy delta.`;

        await saveNewsEffectiveness(runId, {
          baselineWinRate: baseline.winRate,
          newsAwareWinRate: weightedWinRate,
          winRateDelta,
          baselineExpectancyR: baseline.expectancyR,
          newsAwareExpectancyR: weightedExpectancy,
          expectancyDelta,
          newsEffectivenessScore,
          newsAddsValue,
          summary,
        });
      }
    } catch (err) {
      errors.push(`saveNewsEffectiveness: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ── Final status determination ────────────────────────────────────
  // If the run completed but persistence had any errors, degrade to
  // partial_success so consumers can tell something went wrong while
  // still being able to use the persisted artifacts.
  let finalStatus: BacktestStatus = result.status;
  if (result.status === 'completed' && errors.length > 0) {
    finalStatus = 'partial_success';
    // Update the persisted run record with the degraded status
    try {
      await db.query(
        `UPDATE backtest_runs SET status = ?, error = ? WHERE run_id = ?`,
        ['partial_success', `Persistence errors: ${errors.join(' | ')}`, runId],
      );
    } catch (err) {
      console.error('[Orchestrator] Failed to update status to partial_success:', err);
    }
  }

  console.log(
    `[Orchestrator] ${runId}: status=${finalStatus} ` +
    `run=${summary.run} signals=${summary.signals} trades=${summary.trades} ` +
    `outcomes=${summary.signalOutcomes} metrics=${summary.metrics} ` +
    `calib=${summary.calibrationBuckets} equity=${summary.equityCurve} audit=${summary.auditEvents} ` +
    `errors=${errors.length}`,
  );
  log.info('orchestration_complete', { status: finalStatus, ...summary, errors: errors.length });

  return {
    runId,
    status: finalStatus,
    signalCount: result.signalCount,
    tradeCount: result.tradeCount,
    durationMs: result.durationMs,
    persistenceSummary: summary,
    persistedMetrics: summary.metrics,
    persistedCalibrationBuckets: summary.calibrationBuckets,
    persistedSignals: summary.signals,
    persistedTrades: summary.trades,
    dexterOutput,
  };
}
