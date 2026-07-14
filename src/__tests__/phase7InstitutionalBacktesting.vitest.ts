/**
 * Phase 7 — Institutional backtesting & robustness validation.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import {
  generateWalkForwardFolds,
  runWalkForward,
  WALK_FORWARD_MODEL_VERSION,
} from '@/lib/backtesting/runner/runWalkForward';
import {
  assertProductionParityModulesLoaded,
  getProductionParityChecklist,
  PARITY_CONTRACT_VERSION,
  PRODUCTION_PARITY_MODULES,
} from '@/lib/backtesting/parity/productionParity';
import {
  assertCandlesAsOf,
  assertNewsPrecedsSignal,
  auditUniverseMembership,
  buildLeakageAudit,
  forbidOosOptimisation,
  LEAKAGE_GUARD_VERSION,
} from '@/lib/backtesting/bias/leakageGuards';
import {
  calibrateFromInSample,
  applyFrozenCalibration,
} from '@/lib/backtesting/calibration/inSampleCalibration';
import {
  runRobustnessSuite,
  stressSlippage,
  stressParameterPerturbation,
} from '@/lib/backtesting/robustness/robustnessSuite';
import {
  compareBaselinesAndAblations,
  synthesizeRandomEntryControl,
} from '@/lib/backtesting/robustness/baselineComparison';
import {
  evaluateStrategyVersionApproval,
} from '@/lib/backtesting/approval/strategyVersionApproval';
import {
  __resetStrategyHealthLedgerForTests,
  getLatestStrategyHealth,
} from '@/lib/signal-engine/governance/strategyHealth';
import { DEFAULT_BACKTEST_CONFIG } from '@/lib/backtesting/config/defaults';
import type { BacktestRunConfig, SimulatedTrade } from '@/lib/backtesting/types';
import type { BacktestRunResult } from '@/lib/backtesting/runner/backtestRunner';
import { generatePhase1Signals } from '@/lib/signal-engine/pipeline/generatePhase1Signals';
import { buildTradePlanForStrategy } from '@/lib/signal-engine/trade-plan/buildTradePlan';
import { runRejectionEngine } from '@/lib/signal-engine/core/runRejectionEngine';
import { detectEnhancedRegime } from '@/lib/signal-engine/regime/detectMarketRegime';
import { scoreConfidenceForStrategy } from '@/lib/signal-engine/scoring/confidenceScorer';
import { runAllStrategies } from '@/lib/signal-engine/strategy-engine/runStrategies';
import { buildSignalFeatures } from '@/lib/signal-engine/features/buildSignalFeatures';

function mkTrade(over: Partial<SimulatedTrade> = {}): SimulatedTrade {
  return {
    tradeId: 't1',
    signalId: 's1',
    symbol: 'TCS',
    sector: 'IT',
    direction: 'long',
    strategy: 'bullish_breakout',
    regime: 'Bullish',
    confidenceScore: 70,
    confidenceBand: 'Actionable',
    signalDate: '2024-06-01',
    entryDate: '2024-06-02',
    exitDate: '2024-06-10',
    barsToEntry: 1,
    barsInTrade: 8,
    entryPrice: 100,
    exitPrice: 103,
    stopLoss: 97,
    target1: 104,
    target2: 108,
    target3: 112,
    positionSize: 10,
    positionValue: 1000,
    riskAmount: 30,
    slippageCost: 1,
    commissionCost: 2,
    grossPnl: 30,
    netPnl: 27,
    returnPct: 2.7,
    returnR: 0.9,
    outcome: 'win',
    exitReason: 'target1',
    mfePct: 3,
    maePct: 1,
    mfeR: 1,
    maeR: 0.3,
    target1Hit: true,
    target2Hit: false,
    target3Hit: false,
    stopHit: false,
    target1HitBar: 3,
    target2HitBar: null,
    target3HitBar: null,
    stopHitBar: null,
    barByBarPnl: [1, 2, 2.7],
    ...over,
  };
}

function mockResult(trades: SimulatedTrade[], name: string): BacktestRunResult {
  const wins = trades.filter((t) => t.outcome === 'win').length;
  return {
    runId: `mock_${name}`,
    config: { ...DEFAULT_BACKTEST_CONFIG, name },
    status: 'completed',
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    durationMs: 1,
    error: null,
    summary: {
      totalSignalsGenerated: trades.length,
      totalTradesTaken: trades.length,
      totalWins: wins,
      totalLosses: trades.length - wins,
      winRate: trades.length ? wins / trades.length : 0,
      avgWinPct: 1,
      avgLossPct: 1,
      profitFactor: 1.5,
      expectancyPct: 0.5,
      expectancyR: 0.2,
      totalReturnPct: trades.reduce((s, t) => s + t.returnPct, 0),
      annualizedReturnPct: 10,
      maxDrawdownPct: 5,
      maxDrawdownDuration: 3,
      sharpeRatio: 1.1,
      sortinoRatio: 1.2,
      calmarRatio: 1,
      avgMfePct: 2,
      avgMaePct: 1,
      avgBarsInTrade: 5,
      target1HitRate: 0.4,
      target2HitRate: 0.2,
      target3HitRate: 0.1,
      initialCapital: 1_000_000,
      finalEquity: 1_050_000,
      peakEquity: 1_060_000,
      tradingDays: 20,
    },
    strategyBreakdown: [],
    regimeBreakdown: [],
    signalCount: trades.length,
    tradeCount: trades.length,
    trades,
    equityCurve: [],
    signals: [],
    auditEntries: [],
    performance: {
      totalRuntimeMs: 1,
      memoryRssMb: null,
      memoryHeapMb: null,
      signalsPerSec: 0,
      tradesPerSec: 0,
      symbolsProcessed: 1,
      tradingDays: 1,
      msPerTradingDay: 1,
    },
  };
}

describe('Phase 7 production parity', () => {
  it('binds the same production modules (no copied formula stubs)', () => {
    const check = assertProductionParityModulesLoaded();
    expect(check.ok).toBe(true);
    expect(check.version).toBe(PARITY_CONTRACT_VERSION);
    expect(PRODUCTION_PARITY_MODULES.phase1Pipeline).toBe(generatePhase1Signals);
    expect(PRODUCTION_PARITY_MODULES.featureBuilder).toBe(buildSignalFeatures);
    expect(PRODUCTION_PARITY_MODULES.strategyEvaluators).toBe(runAllStrategies);
    expect(PRODUCTION_PARITY_MODULES.regimeDetector).toBe(detectEnhancedRegime);
    expect(PRODUCTION_PARITY_MODULES.confidenceScorer).toBe(scoreConfidenceForStrategy);
    expect(PRODUCTION_PARITY_MODULES.rejectionEngine).toBe(runRejectionEngine);
    expect(PRODUCTION_PARITY_MODULES.tradePlanBuilder).toBe(buildTradePlanForStrategy);
    expect(getProductionParityChecklist().every((c) => c.required)).toBe(true);
  });
});

describe('Phase 7 leakage / bias guards', () => {
  it('detects candle look-ahead', () => {
    const findings = assertCandlesAsOf(
      [
        { ts: '2024-01-01', open: 1, high: 1, low: 1, close: 1, volume: 1 },
        { ts: '2024-01-03', open: 1, high: 1, low: 1, close: 1, volume: 1 },
      ],
      '2024-01-02',
    );
    expect(findings.some((f) => f.code === 'candle_lookahead')).toBe(true);
  });

  it('requires news to precede signal', () => {
    const bad = assertNewsPrecedsSignal('2024-06-02T10:00:00Z', '2024-06-01T15:30:00Z');
    expect(bad.some((f) => f.code === 'news_lookahead')).toBe(true);
    const good = assertNewsPrecedsSignal('2024-06-01T09:00:00Z', '2024-06-01T15:30:00Z');
    expect(good.length).toBe(0);
  });

  it('errors when current-list universe is unlabelled', () => {
    const audit = buildLeakageAudit(
      auditUniverseMembership({ mode: 'current_list_biased', biasLabel: null, universeSize: 500 }),
    );
    expect(audit.clean).toBe(false);
  });

  it('forbids OOS optimisation', () => {
    expect(forbidOosOptimisation('oos')[0].severity).toBe('error');
    expect(forbidOosOptimisation('is').length).toBe(0);
  });

  it(`guard version is ${LEAKAGE_GUARD_VERSION}`, () => {
    expect(LEAKAGE_GUARD_VERSION).toBe('7.0.0');
  });
});

describe('Phase 7 walk-forward IS → freeze → OOS', () => {
  it('generates non-overlapping IS/OOS folds', () => {
    const folds = generateWalkForwardFolds({
      baseConfig: DEFAULT_BACKTEST_CONFIG,
      startDate: '2024-01-01',
      endDate: '2024-12-31',
      inSampleDays: 60,
      outOfSampleDays: 20,
      stepDays: 40,
    });
    expect(folds.length).toBeGreaterThan(0);
    for (const f of folds) {
      expect(f.isEnd < f.oosStart).toBe(true);
      expect(f.oosStart <= f.oosEnd).toBe(true);
    }
  });

  it('headline metrics are OOS-only and freeze IS calibration', async () => {
    const isTrades = Array.from({ length: 25 }, (_, i) =>
      mkTrade({
        tradeId: `is_${i}`,
        returnR: 0.2,
        returnPct: 1,
        outcome: 'win',
        netPnl: 20,
      }),
    );
    const oosTrades = Array.from({ length: 15 }, (_, i) =>
      mkTrade({
        tradeId: `oos_${i}`,
        returnR: i % 3 === 0 ? -0.5 : 0.4,
        returnPct: i % 3 === 0 ? -1 : 1.2,
        outcome: i % 3 === 0 ? 'loss' : 'win',
        netPnl: i % 3 === 0 ? -15 : 25,
        confidenceScore: 65,
      }),
    );

    const result = await runWalkForward({
      baseConfig: {
        ...DEFAULT_BACKTEST_CONFIG,
        universeMembershipMode: 'point_in_time_proxy',
        universeBiasLabel: null,
      },
      startDate: '2024-01-01',
      endDate: '2024-06-30',
      inSampleDays: 40,
      outOfSampleDays: 20,
      stepDays: 30,
      persist: false,
      runWindow: async (cfg, window) => {
        if (window === 'in_sample') return mockResult(isTrades, cfg.name);
        return mockResult(oosTrades, cfg.name);
      },
    });

    expect(result.modelVersion).toBe(WALK_FORWARD_MODEL_VERSION);
    expect(result.headline.source).toBe('out_of_sample_only');
    expect(result.frozenArtifacts.length).toBe(result.folds.length);
    expect(result.folds.every((f) => f.frozenCalibration != null)).toBe(true);
    expect(result.totalOosTrades).toBe(result.headline.totalOosTrades);
    // IS audit retained but not in headline expectancy source
    expect(result.folds.some((f) => f.isAuditOnly != null)).toBe(true);
  });

  it('calibrateFromInSample rejects non-IS window via type + empty-safe freeze', () => {
    const art = calibrateFromInSample({
      foldIndex: 0,
      inSampleStart: '2024-01-01',
      inSampleEnd: '2024-02-01',
      baseConfig: DEFAULT_BACKTEST_CONFIG,
      inSampleTrades: [],
      window: 'in_sample',
    });
    const applied = applyFrozenCalibration(DEFAULT_BACKTEST_CONFIG, art);
    expect(applied.frozenCalibration?.artifactHash).toBe(art.artifactHash);
    expect(applied.minConfidence).toBe(art.minConfidence);
  });
});

describe('Phase 7 robustness + baselines + approval', () => {
  beforeEach(() => {
    __resetStrategyHealthLedgerForTests();
  });

  it('runs stress suite with bootstrap CI', () => {
    const trades = Array.from({ length: 40 }, (_, i) =>
      mkTrade({
        tradeId: `r_${i}`,
        returnR: i % 4 === 0 ? -0.6 : 0.35,
        returnPct: i % 4 === 0 ? -1.5 : 1.2,
        outcome: i % 4 === 0 ? 'loss' : 'win',
        netPnl: i % 4 === 0 ? -20 : 30,
        entryDate: `2024-${String((i % 9) + 1).padStart(2, '0')}-15`,
      }),
    );
    const report = runRobustnessSuite(trades, { strategy: 'bullish_breakout' });
    expect(report.stresses.length).toBeGreaterThanOrEqual(4);
    expect(report.bootstrapCi.nBootstrap).toBeGreaterThan(0);
    expect(report.monteCarloMaxDd.nShuffles).toBeGreaterThan(0);
    expect(stressSlippage(trades, 20).length).toBe(trades.length);
    expect(stressParameterPerturbation(trades, 10).every((t) => t.confidenceScore >= 65)).toBe(true);
  });

  it('compares baselines and ablations', () => {
    const candidate = Array.from({ length: 30 }, (_, i) =>
      mkTrade({ tradeId: `c_${i}`, returnR: 0.25, outcome: 'win', netPnl: 20 }),
    );
    const random = synthesizeRandomEntryControl(candidate);
    const report = compareBaselinesAndAblations({
      candidate,
      previousProduction: candidate.map((t) => ({ ...t, returnR: 0.05, tradeId: `p_${t.tradeId}` })),
      randomEntry: random,
      ablationNoConsensus: candidate.map((t) => ({ ...t, returnR: 0.1, tradeId: `a_${t.tradeId}` })),
      buyAndHoldReturnPct: 8,
    });
    expect(report.candidateBeatsRandom).not.toBeNull();
    expect(report.ablationDeltas.length).toBeGreaterThanOrEqual(1);
  });

  it('approves only on OOS multi-gate criteria (not win-rate alone) and auto-restricts failures', () => {
    const trades = Array.from({ length: 10 }, (_, i) =>
      mkTrade({
        tradeId: `bad_${i}`,
        returnR: -0.4,
        returnPct: -1,
        outcome: 'loss',
        netPnl: -20,
      }),
    );
    const robustness = runRobustnessSuite(trades);
    const approval = evaluateStrategyVersionApproval({
      strategy: 'bullish_breakout',
      strategyVersion: '7.0.0-test',
      oosExpectancyR: -0.3,
      oosProfitFactor: 0.6,
      oosMaxDrawdownPct: 40,
      oosSampleSize: 10,
      oosWinRate: 0.9, // high win rate must NOT cause approval
      walkForwardConsistencyScore: 10,
      maxConcentrationShare: 0.9,
      calibrationAcceptable: false,
      leakageAudit: buildLeakageAudit([]),
      robustness,
      frozenConfigs: [],
      reproducibility: { codeVersion: '7', configVersion: '7', dataVersion: '7' },
      elitePrecision: {
        hitRate: 0.9,
        sampleSize: 10,
        ciLow: 0.7,
        ciHigh: 0.95,
      },
    });
    expect(approval.approved).toBe(false);
    expect(approval.gates.some((g) => g.id === 'not_winrate_only' && g.passed)).toBe(true);
    expect(approval.eliteReporting.reported).toBe(true);
    expect(approval.eliteReporting.sampleSize).toBe(10);
    expect(['restricted', 'restrict_elite']).toContain(approval.healthAction);
    expect(getLatestStrategyHealth('bullish_breakout')?.state).toMatch(/Restricted|Watch/);
  });
});
