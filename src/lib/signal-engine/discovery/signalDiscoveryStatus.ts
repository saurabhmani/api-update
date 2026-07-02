// ════════════════════════════════════════════════════════════════
//  Signal Discovery Status — technical quality vs execution fitness
//
//  Separates what the setup IS (signalQualityStatus) from whether
//  the portfolio can act on it today (executionStatus). Portfolio
//  capacity, cash, exposure, and position sizing must not erase a
//  technically valid discovery row.
//
//  Pure module — no I/O.
// ════════════════════════════════════════════════════════════════

import type { FinalScoreBand } from '../scoring/phase4FactorAdapter';
import type {
  PortfolioFitResult,
  PositionSizingResult,
  Phase3RiskBreakdown,
} from '../types/phase3.types';

export type SignalQualityStatus =
  | 'CONFIRMED_SIGNAL'
  | 'HIGH_POTENTIAL'
  | 'DEVELOPING_SETUP'
  | 'WATCHLIST_ONLY'
  | 'NO_TRADE';

export type SignalExecutionStatus =
  | 'EXECUTABLE'
  | 'RISK_RESTRICTED'
  | 'PORTFOLIO_BLOCKED'
  | 'POSITION_SIZE_INVALID'
  | 'DATA_BLOCKED'
  | 'NOT_APPLICABLE';

export interface DiscoveryGateCounters {
  technicalRejected:      number;
  portfolioBlocked:     number;
  positionSizingInvalid:  number;
  confirmedSignals:     number;
  highPotential:        number;
  developingSetup:      number;
  watchlistOnly:          number;
}

export function createDiscoveryGateCounters(): DiscoveryGateCounters {
  return {
    technicalRejected:     0,
    portfolioBlocked:      0,
    positionSizingInvalid: 0,
    confirmedSignals:      0,
    highPotential:         0,
    developingSetup:       0,
    watchlistOnly:         0,
  };
}

export interface SignalQualityInput {
  phase4Classification: FinalScoreBand | string;
  technicalRejected:    boolean;
  finalScore?:          number | null;
}

/**
 * Technical quality band — driven by Phase-4 classification and
 * technical rejection only. Portfolio / sizing never downgrade this.
 */
export function deriveSignalQualityStatus(input: SignalQualityInput): SignalQualityStatus {
  if (input.technicalRejected) return 'NO_TRADE';

  const cls = String(input.phase4Classification).toUpperCase();
  const fs  = Number(input.finalScore ?? 0);

  switch (cls) {
    case 'INSTITUTIONAL_HIGH_CONVICTION':
    case 'HIGH_CONVICTION':
    case 'VALID_SIGNAL':
      return 'CONFIRMED_SIGNAL';
    case 'DEVELOPING_SETUP':
      return fs >= 55 ? 'HIGH_POTENTIAL' : 'DEVELOPING_SETUP';
    case 'WATCHLIST_ONLY':
      return 'WATCHLIST_ONLY';
    case 'NO_TRADE':
    default:
      return 'NO_TRADE';
  }
}

export interface ExecutionStatusInput {
  signalQualityStatus:  SignalQualityStatus;
  sizing:               PositionSizingResult;
  portfolioFit:         PortfolioFitResult;
  riskBreakdown:        Phase3RiskBreakdown;
  rrTarget1:            number;
  minRewardRisk:        number;
  technicalRejected:    boolean;
  dataBlocked?:         boolean;
}

export function deriveSignalExecutionStatus(input: ExecutionStatusInput): SignalExecutionStatus {
  if (input.dataBlocked) return 'DATA_BLOCKED';
  if (input.signalQualityStatus === 'NO_TRADE' || input.technicalRejected) {
    return 'NOT_APPLICABLE';
  }

  if (input.sizing.validationStatus === 'invalid') {
    return 'POSITION_SIZE_INVALID';
  }

  const pf = input.portfolioFit;
  if (
    pf.portfolioDecision === 'rejected'
    || pf.portfolioDecision === 'deferred'
    || pf.capitalAvailability === 'exhausted'
  ) {
    return 'PORTFOLIO_BLOCKED';
  }

  if (input.riskBreakdown.totalRiskScore > 75) {
    return 'RISK_RESTRICTED';
  }

  if (input.rrTarget1 < input.minRewardRisk) {
    return 'RISK_RESTRICTED';
  }

  return 'EXECUTABLE';
}

export function executionStatusReason(
  status: SignalExecutionStatus,
  input: ExecutionStatusInput,
): string | null {
  switch (status) {
    case 'EXECUTABLE':
      return null;
    case 'POSITION_SIZE_INVALID':
      return input.sizing.warnings[0] ?? 'Position sizing invalid — zero or unusable size';
    case 'PORTFOLIO_BLOCKED':
      return input.portfolioFit.penalties[0]
        ?? `Portfolio blocked (decision=${input.portfolioFit.portfolioDecision})`;
    case 'RISK_RESTRICTED':
      if (input.riskBreakdown.totalRiskScore > 75) {
        return `Risk score ${input.riskBreakdown.totalRiskScore} exceeds execution threshold`;
      }
      return `Reward:Risk ${input.rrTarget1.toFixed(2)} below minimum ${input.minRewardRisk}`;
    case 'DATA_BLOCKED':
      return 'Insufficient or invalid market data';
    case 'NOT_APPLICABLE':
      return 'No executable action — technical quality is NO_TRADE';
    default:
      return null;
  }
}

export function recordDiscoveryGateCounters(
  counters: DiscoveryGateCounters,
  quality: SignalQualityStatus,
  execution: SignalExecutionStatus,
  technicalRejected: boolean,
): void {
  if (technicalRejected) counters.technicalRejected++;

  switch (quality) {
    case 'CONFIRMED_SIGNAL':  counters.confirmedSignals++;  break;
    case 'HIGH_POTENTIAL':    counters.highPotential++;     break;
    case 'DEVELOPING_SETUP':  counters.developingSetup++; break;
    case 'WATCHLIST_ONLY':    counters.watchlistOnly++;     break;
    default: break;
  }

  if (execution === 'PORTFOLIO_BLOCKED')     counters.portfolioBlocked++;
  if (execution === 'POSITION_SIZE_INVALID') counters.positionSizingInvalid++;
}

export function formatDiscoveryGateCounters(c: DiscoveryGateCounters): string {
  return (
    `technicalRejected=${c.technicalRejected} ` +
    `portfolioBlocked=${c.portfolioBlocked} ` +
    `positionSizingInvalid=${c.positionSizingInvalid} ` +
    `confirmedSignals=${c.confirmedSignals} ` +
    `highPotential=${c.highPotential} ` +
    `developingSetup=${c.developingSetup} ` +
    `watchlistOnly=${c.watchlistOnly}`
  );
}

/** Map quality status to legacy q365_signals.signal_status tri-state. */
export function qualityToPersistedSignalStatus(
  quality: SignalQualityStatus,
): 'APPROVED_SIGNAL' | 'DEVELOPING_SETUP' | 'NO_TRADE' {
  if (quality === 'CONFIRMED_SIGNAL') return 'APPROVED_SIGNAL';
  if (quality === 'NO_TRADE')         return 'NO_TRADE';
  return 'DEVELOPING_SETUP';
}

/** Lifecycle row status — quality-first; execution blocks do not hide. */
export function qualityToRowStatus(
  quality: SignalQualityStatus,
): 'active' | 'watchlist' {
  if (quality === 'CONFIRMED_SIGNAL' || quality === 'HIGH_POTENTIAL') return 'active';
  return 'watchlist';
}
