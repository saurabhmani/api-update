import { describe, expect, it } from 'vitest';
import { buildProductionHealthSummary } from '@/lib/operations/productionHealthService';

describe('operations health', () => {
  it('builds health summary with component latencies', () => {
    const summary = buildProductionHealthSummary({
      generatedAt: '2026-01-11T00:00:00Z',
      marketData: { latencyMs: 20, lastCandleAt: '2026-01-10', candleCount: 500, status: 'healthy' },
      database: { latencyMs: 5, status: 'healthy' },
      scheduler: {
        jobs: [{ name: 'evaluateSignalOutcomes', status: 'success', durationMs: 1200, runAt: '2026-01-11' }],
        status: 'healthy',
      },
    }, 25);
    expect(summary.overallStatus).toBe('healthy');
    expect(summary.components.length).toBe(3);
    expect(summary.dependencies.length).toBe(1);
    expect(summary.responseTimeMs).toBe(25);
  });

  it('marks unhealthy when database fails', () => {
    const summary = buildProductionHealthSummary({
      generatedAt: '2026-01-11T00:00:00Z',
      database: { latencyMs: null, status: 'unhealthy', error: 'connection refused' },
    });
    expect(summary.overallStatus).toBe('unhealthy');
  });
});
