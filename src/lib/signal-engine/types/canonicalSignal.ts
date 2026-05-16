// ════════════════════════════════════════════════════════════════
//  Canonical Signal Type — Single Source of Truth
//
//  All signal writers and readers should depend on this type.
//  Defines:
//    - CanonicalSignalRecord (DB persistence)
//    - CanonicalSignalApiResponse (API output)
//    - CanonicalSignalDecisionTrace (audit trail)
// ════════════════════════════════════════════════════════════════

import type { StrategyName, MarketRegimeLabel, ConfidenceBand } from './signalEngine.types';
import type { Phase3EntryType, PortfolioDecision } from './phase3.types';
import type { RejectionCode } from '../core/runRejectionEngine';

// ── Canonical Signal Record (DB persistence shape) ─────────────

export interface CanonicalSignalRecord {
  // Identity
  symbol: string;
  instrumentKey: string;
  exchange: string;

  // Classification
  direction: 'BUY' | 'SELL' | 'WATCH';
  strategy: StrategyName;
  signalSubtype: string;
  timeframe: 'daily';

  // Scoring
  confidenceScore: number;
  confidenceBand: ConfidenceBand;
  riskScore: number;
  riskBand: string;

  // Trade Plan
  entryType: Phase3EntryType;
  entryPrice: number;
  entryZoneLow: number;
  entryZoneHigh: number;
  stopLoss: number;
  target1: number;
  target2: number;
  target3: number;
  riskReward: number;

  // Context
  marketRegime: MarketRegimeLabel;
  scenarioTag: string;
  marketStance: string;
  sector: string;
  volatilityState: string;

  // Decision
  approvalDecision: PortfolioDecision | 'rejected';
  rejectionCode: RejectionCode | null;
  rejectionMessage: string | null;

  // Portfolio Fit
  portfolioFitScore: number;
  portfolioFitDecision: string;

  // Manipulation
  manipulationScore: number | null;
  manipulationBand: string | null;
  manipulationPenalty: number;

  // Enrichment
  aiSummary: string | null;

  // Provenance
  enginePhase: number;
  engineVersion: string;
  generationSource: string;
  batchId: string | null;

  // Lifecycle
  status: 'active' | 'watchlist' | 'expired' | 'invalidated';
  generatedAt: string;
}

// ── Canonical API Response ──────────────────────────────────────

export interface CanonicalSignalApiResponse {
  symbol: string;
  direction: 'BUY' | 'SELL' | 'WATCH';
  strategy: string;
  strategyDisplay: string;
  confidenceScore: number;
  confidenceBand: string;
  riskScore: number;
  riskBand: string;
  entryPrice: number;
  stopLoss: number;
  target1: number;
  target2: number;
  riskReward: number;
  marketRegime: string;
  scenarioTag: string;
  marketStance: string;
  sector: string;
  approvalDecision: string;
  portfolioFitScore: number;
  manipulationWarning: string | null;
  aiSummary: string | null;
  reasons: string[];
  warnings: string[];
  generatedAt: string;
}

// ── Decision Trace (full audit) ─────────────────────────────────

export interface CanonicalSignalDecisionTrace {
  signalId: number;
  symbol: string;
  strategy: StrategyName;
  // Each gate result
  gates: Array<{
    gate: string;
    passed: boolean;
    code?: string;
    message?: string;
  }>;
  // Snapshots at decision time
  thresholdSnapshot: Record<string, number>;
  stanceSnapshot: { stance: string; conviction: string } | null;
  scenarioSnapshot: { scenario: string; allowedStrategies: string[] } | null;
  manipulationSnapshot: { score: number; band: string } | null;
  portfolioFitSnapshot: { fitScore: number; decision: string } | null;
  // Final outcome
  finalDecision: 'approved' | 'rejected' | 'deferred';
  rejectionCode: string | null;
  rejectionMessage: string | null;
  decidedAt: string;
}

// ── Helpers ─────────────────────────────────────────────────────

const STRATEGY_DISPLAY: Record<string, string> = {
  bullish_breakout: 'Bullish Breakout',
  bullish_pullback: 'Bullish Pullback',
  bearish_breakdown: 'Bearish Breakdown',
  mean_reversion_bounce: 'Mean Reversion Bounce',
  momentum_continuation: 'Momentum Continuation',
  bullish_divergence: 'Bullish Divergence',
  volume_climax_reversal: 'Volume Climax Reversal',
  gap_continuation: 'Gap Continuation',
};

export function toApiResponse(record: CanonicalSignalRecord, reasons: string[] = [], warnings: string[] = []): CanonicalSignalApiResponse {
  return {
    symbol: record.symbol,
    direction: record.direction,
    strategy: record.strategy,
    strategyDisplay: STRATEGY_DISPLAY[record.strategy] ?? record.strategy,
    confidenceScore: record.confidenceScore,
    confidenceBand: record.confidenceBand,
    riskScore: record.riskScore,
    riskBand: record.riskBand,
    entryPrice: record.entryPrice,
    stopLoss: record.stopLoss,
    target1: record.target1,
    target2: record.target2,
    riskReward: record.riskReward,
    marketRegime: record.marketRegime,
    scenarioTag: record.scenarioTag,
    marketStance: record.marketStance,
    sector: record.sector,
    approvalDecision: record.approvalDecision,
    portfolioFitScore: record.portfolioFitScore,
    manipulationWarning: record.manipulationBand && record.manipulationBand !== 'low'
      ? `Manipulation suspicion: ${record.manipulationBand} (score ${record.manipulationScore})`
      : null,
    aiSummary: record.aiSummary,
    reasons,
    warnings,
    generatedAt: record.generatedAt,
  };
}
