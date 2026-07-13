import { describe, it, expect } from 'vitest';
import { summarizeHealth } from '../operations/healthMonitor';
import { isIndianMarketHours, opsCacheKey, setOpsCache, getOpsCache } from '../operations/opsCache';
import type { StrategyHealthSnapshot } from '../operations/types';

function snap(partial: Partial<StrategyHealthSnapshot> & { strategyId: string }): StrategyHealthSnapshot {
  return {
    strategyId: partial.strategyId,
    strategyName: partial.strategyName ?? partial.strategyId,
    healthStatus: partial.healthStatus ?? 'healthy',
    healthScore: partial.healthScore ?? 80,
    lastSuccessfulExecution: null,
    lastFailedExecution: null,
    consecutiveFailures: 0,
    runtimeErrors: 0,
    signalGenerationStatus: 'active',
    approvalRateTrend: 'flat',
    approvalRate: 60,
    validationStatus: 'ready',
    validationScore: 75,
    lastValidationAt: null,
    deploymentStatus: 'draft',
    currentMode: 'CONFIRMED_ENABLED',
    performanceDegraded: false,
    performanceHealthScore: 70,
    isActiveInRunner: true,
    issues: [],
    ...partial,
  };
}

describe('operations health summary', () => {
  it('summarizes health counts', () => {
    const summary = summarizeHealth([
      snap({ strategyId: 'a', healthStatus: 'healthy' }),
      snap({ strategyId: 'b', healthStatus: 'warning' }),
      snap({ strategyId: 'c', healthStatus: 'critical', currentMode: 'DISABLED', deploymentStatus: 'paper_deployed' }),
    ]);
    expect(summary.healthyStrategies).toBe(1);
    expect(summary.warningStrategies).toBe(1);
    expect(summary.criticalStrategies).toBe(1);
    expect(summary.disabledStrategies).toBe(1);
    expect(summary.paperDeployed).toBe(1);
  });
});

describe('operations cache', () => {
  it('caches and retrieves payloads', () => {
    const key = opsCacheKey({ ns: 'test-ops' });
    setOpsCache(key, { ok: true }, 60_000);
    const hit = getOpsCache<{ ok: boolean }>(key);
    expect(hit?.value.ok).toBe(true);
  });

  it('detects market hours helper', () => {
    expect(typeof isIndianMarketHours()).toBe('boolean');
  });
});
