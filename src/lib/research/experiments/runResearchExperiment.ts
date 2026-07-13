// ════════════════════════════════════════════════════════════════
//  Phase 7 — Research Experiment Runner
// ════════════════════════════════════════════════════════════════

import { registerExperiment, updateExperiment } from '../experimentRegistry';
import { getDatasetCandles } from '../datasets/datasetRegistry';
import { computeResearchFeatures, discoverSignificantFeatures } from '../features/researchFeatures';
import {
  getExperimentalStrategy,
  evaluateExperimentalStrategy,
} from '../strategies/experimentalStrategies';
import { runDeterministicBacktest, runWalkForwardResearch } from '../backtesting/deterministicBacktest';
import { compareBenchmarks } from '../benchmarks/benchmarkFramework';
import { analyzeFeatureImportance } from '../ai/researchAi';
import { exportResearchReportBundle } from '../reports/researchReporting';
import { SIGNAL_ENGINE_CONFIG_VERSION } from '@/lib/signal-engine/config/signalEnginePhase2Config';

export interface RunResearchExperimentInput {
  author: string;
  description: string;
  datasetId: string;
  strategyId: string;
  features: string[];
  parameters?: Record<string, unknown>;
  randomSeed: number;
  gitCommit?: string | null;
  createdAt?: string;
}

export function runResearchExperiment(input: RunResearchExperimentInput) {
  const createdAt = input.createdAt ?? new Date().toISOString();
  const experiment = registerExperiment({
    author: input.author,
    description: input.description,
    datasetId: input.datasetId,
    features: input.features,
    parameters: input.parameters ?? {},
    createdAt,
    gitCommit: input.gitCommit ?? null,
    configurationVersion: SIGNAL_ENGINE_CONFIG_VERSION,
    randomSeed: input.randomSeed,
    status: 'running',
  });

  const candles = getDatasetCandles(input.datasetId);
  const strategy = getExperimentalStrategy(input.strategyId);
  if (!strategy || candles.length === 0) {
    updateExperiment(experiment.experimentId, { status: 'failed' });
    throw new Error('Invalid strategy or empty dataset');
  }

  const featureVectors = computeResearchFeatures('RESEARCH', candles);
  const signals = evaluateExperimentalStrategy(strategy, candles, featureVectors);
  const backtest = runDeterministicBacktest(candles, signals, {
    symbol: 'RESEARCH',
    strategyId: strategy.strategyId,
    initialCapital: 1_000_000,
    riskPerTradePct: 1,
    slippageBps: 10,
    commissionPerTrade: 20,
    evaluationHorizon: 10,
    randomSeed: input.randomSeed,
  });

  const folds = runWalkForwardResearch(candles, signals, {
    symbol: 'RESEARCH',
    strategyId: strategy.strategyId,
    initialCapital: 1_000_000,
    riskPerTradePct: 1,
    slippageBps: 10,
    commissionPerTrade: 20,
    evaluationHorizon: 10,
    randomSeed: input.randomSeed,
  });

  const returnByBar: Record<number, number> = {};
  for (const t of backtest.trades) returnByBar[t.exitBar] = t.returnPct;
  const discovered = discoverSignificantFeatures(featureVectors, returnByBar);
  const importance = analyzeFeatureImportance(
    featureVectors,
    featureVectors.map((_, i) => returnByBar[featureVectors[i]?.barIndex] ?? 0),
  );

  const baseline = {
    sharpe: 0.5,
    sortino: 0.6,
    calmar: 0.4,
    profitFactor: 1.2,
    winRate: 0.45,
    maxDrawdown: 0.12,
    recoveryFactor: 1.0,
    totalReturn: 0.08,
  };
  const benchmark = compareBenchmarks(baseline, backtest.metrics);

  const completed = updateExperiment(experiment.experimentId, {
    status: 'completed',
    result: {
      metrics: backtest.metrics,
      tradeCount: backtest.trades.length,
      notes: `Walk-forward folds: ${folds.length}; discovered features: ${discovered.length}`,
    },
  });

  const report = exportResearchReportBundle({
    experiment: completed,
    benchmark,
    featureImportance: importance,
    parameterSensitivity: Object.entries(strategy.parameters).map(([parameter, value]) => ({
      parameter,
      value,
      score: backtest.metrics.sharpe,
    })),
  });

  return {
    experiment: completed,
    backtest,
    walkForwardFolds: folds,
    discoveredFeatures: discovered,
    report,
  };
}
