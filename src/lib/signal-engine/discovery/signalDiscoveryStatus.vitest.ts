import { describe, it, expect } from 'vitest';
import {
  createDiscoveryGateCounters,
  deriveSignalQualityStatus,
  deriveSignalExecutionStatus,
  executionStatusReason,
  recordDiscoveryGateCounters,
  formatDiscoveryGateCounters,
  qualityToPersistedSignalStatus,
  qualityToRowStatus,
  type ExecutionStatusInput,
} from './signalDiscoveryStatus';
import type {
  PortfolioFitResult,
  PositionSizingResult,
  Phase3RiskBreakdown,
} from '../types/phase3.types';

function baseSizing(overrides: Partial<PositionSizingResult> = {}): PositionSizingResult {
  return {
    capitalModel: 'fixed_fractional',
    portfolioCapital: 1_000_000,
    riskBudgetPct: 1,
    riskBudgetAmount: 10_000,
    initialRiskPerUnit: 10,
    positionSizeUnits: 100,
    grossPositionValue: 50_000,
    validationStatus: 'valid',
    warnings: [],
    ...overrides,
  };
}

function basePortfolioFit(overrides: Partial<PortfolioFitResult> = {}): PortfolioFitResult {
  return {
    fitScore: 70,
    sectorExposureImpact: 'acceptable',
    directionImpact: 'acceptable',
    capitalAvailability: 'sufficient',
    correlationCluster: null,
    correlationPenalty: 0,
    portfolioDecision: 'approved',
    penalties: [],
    ...overrides,
  };
}

function baseRisk(overrides: Partial<Phase3RiskBreakdown> = {}): Phase3RiskBreakdown {
  return {
    standaloneRiskScore: 35,
    portfolioRiskScore: 5,
    totalRiskScore: 40,
    riskBand: 'Moderate Risk',
    riskFactors: [],
    ...overrides,
  };
}

function executionInput(
  overrides: Partial<ExecutionStatusInput> & { signalQualityStatus?: ExecutionStatusInput['signalQualityStatus'] } = {},
): ExecutionStatusInput {
  return {
    signalQualityStatus: 'CONFIRMED_SIGNAL',
    sizing: baseSizing(),
    portfolioFit: basePortfolioFit(),
    riskBreakdown: baseRisk(),
    rrTarget1: 2.0,
    minRewardRisk: 1.2,
    technicalRejected: false,
    ...overrides,
  };
}

describe('signalDiscoveryStatus', () => {
  it('maps Phase-4 bands to technical quality without portfolio influence', () => {
    expect(
      deriveSignalQualityStatus({
        phase4Classification: 'VALID_SIGNAL',
        technicalRejected: false,
        finalScore: 72,
      }),
    ).toBe('CONFIRMED_SIGNAL');

    expect(
      deriveSignalQualityStatus({
        phase4Classification: 'DEVELOPING_SETUP',
        technicalRejected: false,
        finalScore: 58,
      }),
    ).toBe('HIGH_POTENTIAL');

    expect(
      deriveSignalQualityStatus({
        phase4Classification: 'DEVELOPING_SETUP',
        technicalRejected: false,
        finalScore: 48,
      }),
    ).toBe('DEVELOPING_SETUP');

    expect(
      deriveSignalQualityStatus({
        phase4Classification: 'VALID_SIGNAL',
        technicalRejected: true,
        finalScore: 80,
      }),
    ).toBe('NO_TRADE');
  });

  it('allows CONFIRMED_SIGNAL + PORTFOLIO_BLOCKED', () => {
    const quality = deriveSignalQualityStatus({
      phase4Classification: 'HIGH_CONVICTION',
      technicalRejected: false,
      finalScore: 78,
    });
    expect(quality).toBe('CONFIRMED_SIGNAL');

    const execution = deriveSignalExecutionStatus(
      executionInput({
        signalQualityStatus: quality,
        portfolioFit: basePortfolioFit({
          portfolioDecision: 'deferred',
          capitalAvailability: 'exhausted',
          penalties: ['Cash exhausted — cannot allocate new positions'],
        }),
      }),
    );
    expect(execution).toBe('PORTFOLIO_BLOCKED');
  });

  it('separates position sizing from technical quality', () => {
    const quality = deriveSignalQualityStatus({
      phase4Classification: 'INSTITUTIONAL_HIGH_CONVICTION',
      technicalRejected: false,
      finalScore: 88,
    });
    const input = executionInput({
      signalQualityStatus: quality,
      sizing: baseSizing({
        validationStatus: 'invalid',
        positionSizeUnits: 0,
        warnings: ['Zero position size after risk cap'],
      }),
    });
    expect(deriveSignalExecutionStatus(input)).toBe('POSITION_SIZE_INVALID');
    expect(quality).toBe('CONFIRMED_SIGNAL');
    expect(executionStatusReason('POSITION_SIZE_INVALID', input)).toContain('Zero position size');
  });

  it('records discovery gate counters', () => {
    const counters = createDiscoveryGateCounters();
    recordDiscoveryGateCounters(counters, 'CONFIRMED_SIGNAL', 'PORTFOLIO_BLOCKED', false);
    recordDiscoveryGateCounters(counters, 'HIGH_POTENTIAL', 'EXECUTABLE', false);
    recordDiscoveryGateCounters(counters, 'DEVELOPING_SETUP', 'RISK_RESTRICTED', false);
    recordDiscoveryGateCounters(counters, 'WATCHLIST_ONLY', 'NOT_APPLICABLE', false);
    recordDiscoveryGateCounters(counters, 'NO_TRADE', 'NOT_APPLICABLE', true);

    expect(counters.confirmedSignals).toBe(1);
    expect(counters.portfolioBlocked).toBe(1);
    expect(counters.highPotential).toBe(1);
    expect(counters.developingSetup).toBe(1);
    expect(counters.watchlistOnly).toBe(1);
    expect(counters.technicalRejected).toBe(1);

    expect(formatDiscoveryGateCounters(counters)).toContain('portfolioBlocked=1');
    expect(formatDiscoveryGateCounters(counters)).toContain('confirmedSignals=1');
  });

  it('maps quality to persisted row status without hiding portfolio blocks', () => {
    expect(qualityToPersistedSignalStatus('CONFIRMED_SIGNAL')).toBe('APPROVED_SIGNAL');
    expect(qualityToRowStatus('CONFIRMED_SIGNAL')).toBe('active');
    expect(qualityToRowStatus('HIGH_POTENTIAL')).toBe('active');
    expect(qualityToRowStatus('DEVELOPING_SETUP')).toBe('watchlist');
  });
});
