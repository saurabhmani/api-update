import { describe, expect, it } from 'vitest';
import { buildOperationalDashboard, bucketConfidenceDistribution, deriveSchedulerHealth } from '@/lib/operations/operationalDashboard';

describe('operational dashboard', () => {
  it('builds dashboard data from health probe input', () => {
    const dashboard = buildOperationalDashboard({
      generatedAt: '2026-01-11T00:00:00Z',
      health: {
        generatedAt: '2026-01-11T00:00:00Z',
        signalGeneration: { lastRunAt: '2026-01-11', signalsToday: 42, status: 'healthy' },
        scheduler: {
          status: 'healthy',
          jobs: [{ name: 'jobA', status: 'success', durationMs: 100, runAt: '2026-01-11' }],
        },
        marketData: { latencyMs: 15, lastCandleAt: '2026-01-10', candleCount: 100, status: 'healthy' },
      },
      promotionHistory: [{ parameterId: 'adapt_1', status: 'promoted', promotedAt: '2026-01-10' }],
    });
    expect(dashboard.signalsPerDay).toBe(42);
    expect(dashboard.learningJobs).toHaveLength(1);
    expect(dashboard.promotionHistory).toHaveLength(1);
  });

  it('buckets confidence scores', () => {
    const buckets = bucketConfidenceDistribution([90, 75, 60, 40]);
    expect(buckets['85-100']).toBe(1);
    expect(buckets['70-84']).toBe(1);
    expect(buckets['55-69']).toBe(1);
    expect(buckets['0-54']).toBe(1);
  });

  it('derives scheduler health from job statuses', () => {
    expect(deriveSchedulerHealth([{ status: 'success' }])).toBe('healthy');
    expect(deriveSchedulerHealth([{ status: 'failed' }])).toBe('degraded');
    expect(deriveSchedulerHealth([])).toBe('unknown');
  });
});
