// ════════════════════════════════════════════════════════════════
//  Phase 3 Types — Trade Engine + Risk Engine + Portfolio-Aware
// ════════════════════════════════════════════════════════════════

// ── Entry Types ─────────────────────────────────────────────
export type Phase3EntryType =
  | 'breakout_confirmation'
  | 'pullback_retest'
  | 'momentum_followthrough'
  | 'mean_reversion_confirmation';

// ── Trade Plan ──────────────────────────────────────────────
export interface Phase3TradePlan {
  entryType: Phase3EntryType;
  entryZoneLow: number;
  entryZoneHigh: number;
  stopLoss: number;
  initialRiskPerUnit: number;
  target1: number;
  target2: number;
  target3: number;
  rrTarget1: number;
  rrTarget2: number;
  rrTarget3: number;
}

// ── Position Sizing ─────────────────────────────────────────
export type SizingModel = 'fixed_fractional' | 'volatility_adjusted';
export type SizingValidation = 'valid' | 'invalid' | 'capped';

export interface PositionSizingInput {
  portfolioCapital: number;
  riskPerTradePct: number;
  maxGrossExposurePct: number;
  entryPrice: number;
  stopLoss: number;
  atrPct: number;
  model: SizingModel;
  currentGrossExposure: number;
}

export interface PositionSizingResult {
  capitalModel: SizingModel;
  portfolioCapital: number;
  riskBudgetPct: number;
  riskBudgetAmount: number;
  initialRiskPerUnit: number;
  positionSizeUnits: number;
  grossPositionValue: number;
  validationStatus: SizingValidation;
  warnings: string[];
}

// ── Portfolio Fit ───────────────────────────────────────────
export type ExposureImpact = 'acceptable' | 'moderate' | 'high';
export type DirectionImpact = 'acceptable' | 'crowded' | 'extreme';
export type CapitalAvailability = 'sufficient' | 'tight' | 'exhausted';
export type PortfolioDecision = 'approved' | 'approved_with_penalty' | 'deferred' | 'rejected';

export interface PortfolioSnapshot {
  capital: number;
  cashAvailable: number;
  openPositions: PortfolioPosition[];
  pendingSignals: PendingSignal[];
}

export interface PortfolioPosition {
  symbol: string;
  side: 'long' | 'short';
  sector: string;
  grossValue: number;
  riskAllocated: number;
}

export interface PendingSignal {
  symbol: string;
  direction: string;
  sector: string;
  grossValue: number;
}

export interface PortfolioFitResult {
  fitScore: number;
  sectorExposureImpact: ExposureImpact;
  directionImpact: DirectionImpact;
  capitalAvailability: CapitalAvailability;
  correlationCluster: string | null;
  correlationPenalty: number;
  portfolioDecision: PortfolioDecision;
  penalties: string[];
}

// ── Correlation ─────────────────────────────────────────────
export interface CorrelationSnapshot {
  correlationCluster: string;
  clusterExposureCount: number;
  correlationPenalty: number;
}

// ── Sector Exposure ─────────────────────────────────────────
export interface SectorExposureSnapshot {
  sector: string;
  currentExposurePct: number;
  projectedExposurePct: number;
  sectorSignalCount: number;
  sectorPenalty: number;
}

// ── Direction Exposure ──────────────────────────────────────
export interface DirectionExposureSnapshot {
  longCount: number;
  shortCount: number;
  longExposurePct: number;
  shortExposurePct: number;
  netExposurePct: number;
  directionPenalty: number;
}

// ── Execution Readiness ─────────────────────────────────────
export type ExecutionStatus =
  | 'ready'
  | 'ready_on_confirmation'
  | 'watchlist_only'
  | 'deferred_due_to_portfolio'
  | 'rejected_due_to_risk'
  | 'rejected_due_to_correlation'
  | 'rejected_due_to_reward_risk';

export type ActionTag =
  | 'enter_now'
  | 'enter_on_confirmation'
  | 'wait_for_retest'
  | 'watch_only'
  | 'avoid';

export type ApprovalDecision = 'approved' | 'deferred' | 'rejected';

export interface ExecutionReadiness {
  status: ExecutionStatus;
  actionTag: ActionTag;
  priorityRank: number | null;
  approvalDecision: ApprovalDecision;
  reasons: string[];
}

// ── Risk Phase 3 ────────────────────────────────────────────
export interface Phase3RiskBreakdown {
  standaloneRiskScore: number;
  portfolioRiskScore: number;
  totalRiskScore: number;
  riskBand: 'Low Risk' | 'Moderate Risk' | 'Elevated Risk' | 'High Risk';
  riskFactors: string[];
}

// ── Lifecycle ───────────────────────────────────────────────
export type LifecycleState =
  | 'generated'
  | 'approved'
  | 'ready'
  | 'entered'
  | 'invalidated'
  | 'expired'
  | 'rejected'
  | 'archived';

export interface SignalLifecycle {
  state: LifecycleState;
  reason: string;
  changedAt: string;
}

// ── Executable Signal (Full Phase 3 Output) ─────────────────
export interface ExecutableSignal {
  symbol: string;
  signalType: string;
  signalSubtype: string;
  marketRegime: string;
  confidenceScore: number;
  confidenceBand: string;

  tradePlan: Phase3TradePlan;
  positionSizing: PositionSizingResult;
  portfolioFit: PortfolioFitResult;
  executionReadiness: ExecutionReadiness;
  riskBreakdown: Phase3RiskBreakdown;
  lifecycle: SignalLifecycle;

  // Carried from Phase 1/2 for Phase 4 explanation engine
  features?: import('../types/signalEngine.types').SignalFeatures;
  confidenceBreakdown?: import('../types/signalEngine.types').ConfidenceBreakdown;
  standaloneRisk?: import('../types/signalEngine.types').RiskBreakdown;

  reasons: string[];
  warnings: string[];
  generatedAt: string;
}

// ── Phase 3 Config ──────────────────────────────────────────
export interface Phase3Config {
  defaultCapital: number;
  riskPerTradePct: number;
  maxGrossExposurePct: number;
  maxSectorExposurePct: number;
  maxCorrelationClusterCount: number;
  maxApprovedPerRun: number;
  maxDirectionImbalancePct: number;
  minRewardRisk: number;
  stopMaxWidthPct: number;
  target3RMultiple: number;
}
