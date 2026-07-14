// ════════════════════════════════════════════════════════════════
//  Walk-Forward Testing — Phase 7 (completed IS → freeze → OOS)
//
//  Headline metrics are AGGREGATED FROM OOS ONLY.
//  In-sample is used solely to estimate/calibrate and freeze config.
// ════════════════════════════════════════════════════════════════

import type { BacktestRunConfig, FrozenCalibrationArtifact, SimulatedTrade } from '../types';
import { runBacktest, type BacktestRunResult } from './backtestRunner';
import { persistFullRun } from './runOrchestrator';
import {
  calibrateFromInSample,
  applyFrozenCalibration,
  IN_SAMPLE_CALIBRATION_VERSION,
} from '../calibration/inSampleCalibration';
import {
  auditUniverseMembership,
  buildLeakageAudit,
  type LeakageAudit,
} from '../bias/leakageGuards';
import { buildParityFingerprint, PARITY_CONTRACT_VERSION } from '../parity/productionParity';
import { computeExpectancy } from '../metrics/expectancyMetrics';
import { runRobustnessSuite, type RobustnessReport } from '../robustness/robustnessSuite';

export const WALK_FORWARD_MODEL_VERSION = '7.0.0';

export interface WalkForwardConfig {
  /** Base config (universe, capital, etc.) */
  baseConfig: BacktestRunConfig;
  /** Total date range start */
  startDate: string;
  /** Total date range end */
  endDate: string;
  /** In-sample window size in calendar days (documented; prefer trading-day scheduling upstream) */
  inSampleDays: number;
  /** Out-of-sample window size in calendar days */
  outOfSampleDays: number;
  /** Step size (how many days to advance each fold) */
  stepDays: number;
  /** Persist each window run (default true). */
  persist?: boolean;
  /**
   * Optional hook: run IS backtest yourself (tests/mocks).
   * When omitted, `runBacktest` is used for both IS and OOS.
   */
  runWindow?: (config: BacktestRunConfig, window: 'in_sample' | 'out_of_sample') => Promise<BacktestRunResult>;
}

export interface WalkForwardFold {
  foldIndex: number;
  isStartDate: string;
  isEndDate: string;
  oosStartDate: string;
  oosEndDate: string;
  frozenCalibration: FrozenCalibrationArtifact | null;
  isResult: BacktestRunResult | null;
  oosResult: BacktestRunResult | null;
  /** IS metrics retained for audit only — NEVER used in headline. */
  isAuditOnly: { tradeCount: number; expectancyR: number } | null;
}

export interface WalkForwardHeadlineMetrics {
  /** Product A headline — OOS only. */
  source: 'out_of_sample_only';
  aggregateOosWinRate: number;
  aggregateOosReturn: number;
  aggregateOosSharpe: number;
  aggregateOosExpectancyR: number;
  aggregateOosProfitFactor: number;
  totalOosTrades: number;
  consistencyScore: number;
}

export interface WalkForwardResult {
  modelVersion: string;
  config: WalkForwardConfig;
  folds: WalkForwardFold[];
  /** @deprecated Use headline.* — kept for back-compat. */
  aggregateOosWinRate: number;
  aggregateOosReturn: number;
  aggregateOosSharpe: number;
  totalOosTrades: number;
  consistencyScore: number;
  headline: WalkForwardHeadlineMetrics;
  leakageAudit: LeakageAudit;
  robustness: RobustnessReport | null;
  frozenArtifacts: FrozenCalibrationArtifact[];
  reproducibility: Record<string, string>;
  startedAt: string;
  completedAt: string;
}

/**
 * Generate walk-forward date folds from the config.
 * Each fold defines an in-sample and out-of-sample window.
 */
export function generateWalkForwardFolds(config: WalkForwardConfig): Array<{
  isStart: string; isEnd: string; oosStart: string; oosEnd: string;
}> {
  const folds: Array<{ isStart: string; isEnd: string; oosStart: string; oosEnd: string }> = [];

  let cursor = new Date(config.startDate);
  const end = new Date(config.endDate);

  while (true) {
    const isStart = cursor.toISOString().split('T')[0];
    const isEnd = new Date(cursor.getTime() + config.inSampleDays * 86400000).toISOString().split('T')[0];
    const oosStart = new Date(new Date(isEnd).getTime() + 86400000).toISOString().split('T')[0];
    const oosEnd = new Date(new Date(oosStart).getTime() + config.outOfSampleDays * 86400000).toISOString().split('T')[0];

    if (new Date(oosEnd) > end) break;

    folds.push({ isStart, isEnd, oosStart, oosEnd });
    cursor = new Date(cursor.getTime() + config.stepDays * 86400000);
  }

  return folds;
}

/**
 * Run a full walk-forward test with completed IS calibration.
 *
 * For each fold:
 * 1. Run in-sample → calibrate → freeze config version
 * 2. Run OOS with frozen config (unchanged)
 * 3. Store both windows + artefacts
 * 4. Aggregate ONLY OOS into headline metrics
 */
export async function runWalkForward(config: WalkForwardConfig): Promise<WalkForwardResult> {
  const startedAt = new Date().toISOString();
  const dateFolds = generateWalkForwardFolds(config);
  const folds: WalkForwardFold[] = [];
  const persist = config.persist !== false;
  const runWindow = config.runWindow ?? ((c: BacktestRunConfig) => runBacktest(c));

  const leakageFindings = [
    ...auditUniverseMembership({
      mode: config.baseConfig.universeMembershipMode,
      biasLabel: config.baseConfig.universeBiasLabel,
      universeSize: config.baseConfig.universe.length,
    }),
  ];

  console.log(
    `[WalkForward] v${WALK_FORWARD_MODEL_VERSION} ${dateFolds.length} folds, ` +
    `IS=${config.inSampleDays}d, OOS=${config.outOfSampleDays}d (headline=OOS only)`,
  );

  const allOosTrades: SimulatedTrade[] = [];
  const frozenArtifacts: FrozenCalibrationArtifact[] = [];
  let totalWins = 0;
  let totalTrades = 0;
  let totalReturn = 0;
  const sharpes: number[] = [];
  const oosExpectancies: number[] = [];
  const oosPFs: number[] = [];

  for (let i = 0; i < dateFolds.length; i++) {
    const df = dateFolds[i];
    console.log(`[WalkForward] Fold ${i + 1}/${dateFolds.length}: IS ${df.isStart}→${df.isEnd} | OOS ${df.oosStart}→${df.oosEnd}`);

    // ── 1. In-sample run (calibration only) ─────────────────
    const isConfig: BacktestRunConfig = {
      ...config.baseConfig,
      name: `WF Fold ${i + 1} IS`,
      startDate: df.isStart,
      endDate: df.isEnd,
      tags: [...(config.baseConfig.tags ?? []), 'walk_forward_is', `fold_${i}`],
      reproducibility: {
        codeVersion: WALK_FORWARD_MODEL_VERSION,
        configVersion: `${PARITY_CONTRACT_VERSION}:${IN_SAMPLE_CALIBRATION_VERSION}`,
        dataVersion: `${df.isStart}_${df.isEnd}`,
        signalEngineVersion: PARITY_CONTRACT_VERSION,
        walkForwardModelVersion: WALK_FORWARD_MODEL_VERSION,
      },
    };

    let isResult: BacktestRunResult | null = null;
    let frozen: FrozenCalibrationArtifact | null = null;
    let isAuditOnly: WalkForwardFold['isAuditOnly'] = null;

    try {
      isResult = await runWindow(isConfig, 'in_sample');
      if (persist) {
        try { await persistFullRun(isResult); } catch { /* non-fatal */ }
      }

      const isTrades = isResult.trades ?? [];
      const isExp = computeExpectancy(isTrades);
      isAuditOnly = { tradeCount: isTrades.length, expectancyR: isExp.expectancyR };

      frozen = calibrateFromInSample({
        foldIndex: i,
        inSampleStart: df.isStart,
        inSampleEnd: df.isEnd,
        baseConfig: config.baseConfig,
        inSampleTrades: isTrades,
        window: 'in_sample',
      });
      frozenArtifacts.push(frozen);
    } catch (err) {
      console.error(`[WalkForward] Fold ${i + 1} IS failed:`, err);
      leakageFindings.push({
        code: 'is_run_failed',
        severity: 'warning',
        message: `IS fold ${i + 1} failed: ${err instanceof Error ? err.message : String(err)}`,
      });
      // Fallback freeze = base (still audit-trail)
      frozen = calibrateFromInSample({
        foldIndex: i,
        inSampleStart: df.isStart,
        inSampleEnd: df.isEnd,
        baseConfig: config.baseConfig,
        inSampleTrades: [],
        window: 'in_sample',
      });
      frozenArtifacts.push(frozen);
    }

    // Hard guard — OOS path must not call calibrateFromInSample
    // (calibrateFromInSample throws / returns only for window: 'in_sample')

    // ── 2. Freeze + OOS unchanged ───────────────────────────
    const oosBase = frozen
      ? applyFrozenCalibration(config.baseConfig, frozen)
      : { ...config.baseConfig };

    const oosConfig: BacktestRunConfig = {
      ...oosBase,
      name: `WF Fold ${i + 1} OOS`,
      startDate: df.oosStart,
      endDate: df.oosEnd,
      tags: [...(oosBase.tags ?? []), 'walk_forward_oos', `fold_${i}`, 'headline_eligible'],
      frozenCalibration: frozen,
      reproducibility: {
        codeVersion: WALK_FORWARD_MODEL_VERSION,
        configVersion: frozen?.artifactHash ?? 'base',
        dataVersion: `${df.oosStart}_${df.oosEnd}`,
        signalEngineVersion: PARITY_CONTRACT_VERSION,
        walkForwardModelVersion: WALK_FORWARD_MODEL_VERSION,
      },
    };

    let oosResult: BacktestRunResult | null = null;
    try {
      oosResult = await runWindow(oosConfig, 'out_of_sample');
      if (persist) {
        try { await persistFullRun(oosResult); } catch { /* non-fatal */ }
      }

      const oosTrades = oosResult.trades ?? [];
      allOosTrades.push(...oosTrades);

      totalTrades += oosResult.tradeCount;
      totalWins += oosResult.summary?.totalWins ?? 0;
      totalReturn += oosResult.summary?.totalReturnPct ?? 0;
      if (oosResult.summary?.sharpeRatio) sharpes.push(oosResult.summary.sharpeRatio);

      const oosExp = computeExpectancy(oosTrades);
      oosExpectancies.push(oosExp.expectancyR);
      oosPFs.push(Number.isFinite(oosExp.profitFactor) ? oosExp.profitFactor : 0);
    } catch (err) {
      console.error(`[WalkForward] Fold ${i + 1} OOS failed:`, err);
    }

    folds.push({
      foldIndex: i,
      isStartDate: df.isStart,
      isEndDate: df.isEnd,
      oosStartDate: df.oosStart,
      oosEndDate: df.oosEnd,
      frozenCalibration: frozen,
      isResult,
      oosResult,
      isAuditOnly,
    });
  }

  const profitableFolds = folds.filter(
    (f) => f.oosResult && (f.oosResult.summary?.totalReturnPct ?? 0) > 0,
  ).length;
  const consistencyScore = folds.length > 0
    ? Math.round((profitableFolds / folds.length) * 100)
    : 0;

  const headline: WalkForwardHeadlineMetrics = {
    source: 'out_of_sample_only',
    aggregateOosWinRate: totalTrades > 0 ? Math.round((totalWins / totalTrades) * 100) / 100 : 0,
    aggregateOosReturn: Math.round(totalReturn * 100) / 100,
    aggregateOosSharpe: sharpes.length > 0
      ? Math.round((sharpes.reduce((s, v) => s + v, 0) / sharpes.length) * 100) / 100
      : 0,
    aggregateOosExpectancyR: oosExpectancies.length
      ? Math.round((oosExpectancies.reduce((a, b) => a + b, 0) / oosExpectancies.length) * 1000) / 1000
      : 0,
    aggregateOosProfitFactor: oosPFs.length
      ? Math.round((oosPFs.reduce((a, b) => a + b, 0) / oosPFs.length) * 1000) / 1000
      : 0,
    totalOosTrades: totalTrades,
    consistencyScore,
  };

  const leakageAudit = buildLeakageAudit(leakageFindings);
  const robustness = allOosTrades.length
    ? runRobustnessSuite(allOosTrades)
    : null;

  return {
    modelVersion: WALK_FORWARD_MODEL_VERSION,
    config,
    folds,
    aggregateOosWinRate: headline.aggregateOosWinRate,
    aggregateOosReturn: headline.aggregateOosReturn,
    aggregateOosSharpe: headline.aggregateOosSharpe,
    totalOosTrades: headline.totalOosTrades,
    consistencyScore: headline.consistencyScore,
    headline,
    leakageAudit,
    robustness,
    frozenArtifacts,
    reproducibility: buildParityFingerprint({
      walkForward: WALK_FORWARD_MODEL_VERSION,
      calibration: IN_SAMPLE_CALIBRATION_VERSION,
    }),
    startedAt,
    completedAt: new Date().toISOString(),
  };
}
