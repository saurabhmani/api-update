#!/usr/bin/env tsx
import 'tsconfig-paths/register';
import { clearExperimentRegistry } from '@/lib/research/experimentRegistry';
import { buildSyntheticDataset } from '@/lib/research/datasets/datasetRegistry';
import { runResearchExperiment } from '@/lib/research/experiments/runResearchExperiment';
import { listExperimentalStrategies } from '@/lib/research/strategies/experimentalStrategies';

function main(): void {
  clearExperimentRegistry();
  const started = Date.now();
  buildSyntheticDataset({ datasetId: 'bench_ds', symbols: ['BENCH'], barCount: 150 });
  const strategies = listExperimentalStrategies();
  const results = strategies.map((s) => runResearchExperiment({
    author: 'benchmark@quantorus',
    description: `Benchmark ${s.strategyId}`,
    datasetId: 'bench_ds',
    strategyId: s.strategyId,
    features: ['market_breadth', 'trend_persistence'],
    randomSeed: 42,
    createdAt: '2026-01-11T00:00:00Z',
  }));

  console.log(JSON.stringify({
    benchmark: 'research',
    strategyCount: strategies.length,
    completed: results.filter((r) => r.experiment.status === 'completed').length,
    avgSharpe: results.reduce((s, r) => s + (r.experiment.result?.metrics.sharpe ?? 0), 0) / results.length,
    elapsedMs: Date.now() - started,
  }, null, 2));
}

main();
