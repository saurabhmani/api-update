import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  isValidationApprovedForDeploy,
  runStrategyValidation,
} from './services/strategyValidationService';
import type { ValidationReport } from './validation/types';

vi.mock('./strategyMetricsService', () => ({
  loadStrategyMetrics: vi.fn().mockResolvedValue({
    detail: {
      winRate: 55,
      evaluatedSignals: 100,
      maxDrawdownPct: 15,
      profitFactor: 1.4,
      expectancy: 0.3,
      strategyHealthScore: 65,
      healthLabel: 'STABLE',
      performanceStatus: 'SUFFICIENT',
      performanceSource: 'signals',
    },
  }),
}));

vi.mock('./repository/strategyProfiles', () => ({
  loadStrategyProfile: vi.fn().mockResolvedValue(null),
  upsertStrategyProfile: vi.fn(),
}));

vi.mock('./services/strategyConfigOverrides', () => ({
  loadStrategyConfigOverrides: vi.fn().mockResolvedValue(new Map()),
}));

describe('strategyValidationService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('approves paper deploy when report passes thresholds', () => {
    const report = {
      overallStatus: 'ready',
      overallScore: 80,
      liveDeployReady: false,
      checks: [{ required: true, status: 'pass' }],
    } as unknown as ValidationReport;
    expect(isValidationApprovedForDeploy(report, 'paper')).toBe(true);
  });

  it('blocks paper deploy on required failures', () => {
    const report = {
      overallStatus: 'failed',
      overallScore: 40,
      liveDeployReady: false,
      checks: [{ required: true, status: 'failure' }],
      blockedReasons: ['Evaluator missing'],
    } as unknown as ValidationReport;
    expect(isValidationApprovedForDeploy(report, 'paper')).toBe(false);
  });

  it('runs validation for a known registry strategy using effective config', async () => {
    const report = await runStrategyValidation({ strategyId: 'bullish_breakout' });
    expect(report.strategyId).toBe('bullish_breakout');
    expect(report.checks.length).toBeGreaterThan(5);
    expect(report.effectiveConfig).toBeDefined();
    expect(report.categoryScores.length).toBe(6);
    expect(report.summary.executionTimeMs).toBeGreaterThanOrEqual(0);
  });

  it('fails validation for unknown strategy', async () => {
    const report = await runStrategyValidation({ strategyId: 'nonexistent_strategy_xyz' });
    expect(report.overallStatus).toBe('failed');
    expect(report.checks.some((c) => c.id === 'int.registry' && c.status === 'failure')).toBe(true);
  });
});
