import { describe, expect, it, beforeEach } from 'vitest';
import { clearExperimentRegistry } from '@/lib/research/experimentRegistry';
import { buildSyntheticDataset } from '@/lib/research/datasets/datasetRegistry';
import { runResearchExperiment } from '@/lib/research/experiments/runResearchExperiment';
import { evaluatePromotionRequest } from '@/lib/research/governance/researchGovernance';
import { RESEARCH_FEATURE_CATALOG, computeResearchFeatures } from '@/lib/research/features/researchFeatures';
import { analyzeFeatureImportance } from '@/lib/research/ai/researchAi';
import { assertResearchIsolation } from '@/lib/research/governance/researchGovernance';

describe('research workspace', () => {
  beforeEach(() => clearExperimentRegistry());

  it('asserts production isolation', () => {
    const iso = assertResearchIsolation();
    expect(iso.productionPipelineTouched).toBe(false);
    expect(iso.autoPromotionEnabled).toBe(false);
  });

  it('computes all research feature catalog entries', () => {
    const { candles } = buildSyntheticDataset({ datasetId: 'feat1', symbols: ['X'], barCount: 60 });
    const vectors = computeResearchFeatures('X', candles);
    expect(vectors.length).toBeGreaterThan(0);
    for (const name of RESEARCH_FEATURE_CATALOG) {
      expect(vectors[0].features[name]).toBeTypeOf('number');
    }
  });

  it('blocks promotion without governance requirements', () => {
    const decision = evaluatePromotionRequest({
      experimentId: 'exp_test',
      requestedBy: 'researcher',
      reason: 'test',
      walkForwardPassed: false,
      crossRegimeStable: false,
      peerReviewApproved: false,
      statisticalSignificance: 0.5,
      minimumTrades: 50,
    }, {
      sharpe: 0.2, sortino: 0.2, calmar: 0.1, profitFactor: 1.1,
      winRate: 0.4, maxDrawdown: 0.1, recoveryFactor: 0.5, totalReturn: 0.05,
    }, 30);
    expect(decision.approved).toBe(false);
    expect(decision.requiresPhase4Governance).toBe(true);
  });

  it('runs full research pipeline', () => {
    buildSyntheticDataset({ datasetId: 'full1', symbols: ['X'], barCount: 100 });
    const out = runResearchExperiment({
      author: 'analyst',
      description: 'multi-factor test',
      datasetId: 'full1',
      strategyId: 'exp_multi_factor',
      features: ['market_breadth', 'hurst_exponent'],
      randomSeed: 42,
      createdAt: '2026-01-11T00:00:00Z',
    });
    expect(out.experiment.result?.tradeCount).toBeGreaterThanOrEqual(0);
    const importance = analyzeFeatureImportance(
      computeResearchFeatures('X', buildSyntheticDataset({ datasetId: 'full2', symbols: ['X'], barCount: 60 }).candles),
      Array(40).fill(0.01),
    );
    expect(importance.rankings.length).toBe(RESEARCH_FEATURE_CATALOG.length);
  });
});
