import { describe, expect, it, beforeEach } from 'vitest';
import {
  registerExperiment,
  getExperiment,
  clearExperimentRegistry,
} from '@/lib/research/experimentRegistry';
import { buildSyntheticDataset } from '@/lib/research/datasets/datasetRegistry';
import { runResearchExperiment } from '@/lib/research/experiments/runResearchExperiment';

describe('experiment registry', () => {
  beforeEach(() => clearExperimentRegistry());

  it('requires named author', () => {
    expect(() => registerExperiment({
      author: '',
      description: 'test',
      datasetId: 'ds1',
      features: ['market_breadth'],
      parameters: {},
      createdAt: '2026-01-11T00:00:00Z',
      configurationVersion: '2.0.0',
      randomSeed: 42,
    })).toThrow(/anonymous/i);
  });

  it('stores experiment metadata', () => {
    const exp = registerExperiment({
      author: 'researcher@quantorus',
      description: 'trend experiment',
      datasetId: 'ds1',
      features: ['trend_persistence'],
      parameters: { lookback: 20 },
      createdAt: '2026-01-11T00:00:00Z',
      configurationVersion: '2.0.0',
      randomSeed: 42,
      gitCommit: 'abc123',
    });
    expect(exp.experimentId).toMatch(/^exp_/);
    expect(getExperiment(exp.experimentId)?.author).toBe('researcher@quantorus');
  });

  it('runs end-to-end research experiment', () => {
    buildSyntheticDataset({ datasetId: 'synth_test', symbols: ['TEST'], barCount: 80 });
    const result = runResearchExperiment({
      author: 'researcher@quantorus',
      description: 'breakout research',
      datasetId: 'synth_test',
      strategyId: 'exp_breakout',
      features: ['market_breadth', 'trend_persistence'],
      randomSeed: 123,
      createdAt: '2026-01-11T00:00:00Z',
    });
    expect(result.experiment.status).toBe('completed');
    expect(result.report.markdown).toContain('Research Experiment Report');
  });
});
