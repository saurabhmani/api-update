import { describe, expect, it } from 'vitest';
import { buildSyntheticDataset } from '@/lib/research/datasets/datasetRegistry';
import { getExperimentalStrategy, evaluateExperimentalStrategy } from '@/lib/research/strategies/experimentalStrategies';
import { runDeterministicBacktest, runWalkForwardResearch, runCrossValidation } from '@/lib/research/backtesting/deterministicBacktest';
import { computeResearchFeatures } from '@/lib/research/features/researchFeatures';

describe('research backtesting', () => {
  it('runs deterministic backtest with reproducible seed', () => {
    const { candles } = buildSyntheticDataset({ datasetId: 'bt1', symbols: ['X'], barCount: 100 });
    const strategy = getExperimentalStrategy('exp_trend_follow')!;
    const features = computeResearchFeatures('X', candles);
    const signals = evaluateExperimentalStrategy(strategy, candles, features);
    const config = {
      symbol: 'X',
      strategyId: strategy.strategyId,
      initialCapital: 100_000,
      riskPerTradePct: 1,
      slippageBps: 10,
      commissionPerTrade: 20,
      evaluationHorizon: 8,
      randomSeed: 99,
    };
    const a = runDeterministicBacktest(candles, signals, config);
    const b = runDeterministicBacktest(candles, signals, config);
    expect(a.metrics).toEqual(b.metrics);
    expect(a.deterministic).toBe(true);
  });

  it('supports walk-forward folds', () => {
    const { candles } = buildSyntheticDataset({ datasetId: 'bt2', symbols: ['X'], barCount: 120 });
    const strategy = getExperimentalStrategy('exp_mean_revert')!;
    const signals = evaluateExperimentalStrategy(strategy, candles);
    const folds = runWalkForwardResearch(candles, signals, {
      symbol: 'X', strategyId: strategy.strategyId, initialCapital: 100_000,
      riskPerTradePct: 1, slippageBps: 10, commissionPerTrade: 20, evaluationHorizon: 5, randomSeed: 1,
    });
    expect(folds.length).toBeGreaterThan(0);
  });

  it('supports cross validation', () => {
    const { candles } = buildSyntheticDataset({ datasetId: 'bt3', symbols: ['X'], barCount: 90 });
    const strategy = getExperimentalStrategy('exp_breakout')!;
    const signals = evaluateExperimentalStrategy(strategy, candles);
    const cv = runCrossValidation(candles, signals, {
      symbol: 'X', strategyId: strategy.strategyId, initialCapital: 100_000,
      riskPerTradePct: 1, slippageBps: 10, commissionPerTrade: 20, evaluationHorizon: 5, randomSeed: 7,
    }, 3);
    expect(cv).toHaveLength(3);
  });
});
