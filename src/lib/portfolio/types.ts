// ════════════════════════════════════════════════════════════════
//  Phase 8 — Portfolio Intelligence Types
//  Consumes Product A signals — does not modify signal generation.
// ════════════════════════════════════════════════════════════════

export const PORTFOLIO_SCHEMA_VERSION = '8.0.0';

export type AllocationMethod =
  | 'equal_weight'
  | 'risk_parity'
  | 'volatility_targeting'
  | 'sector_balancing'
  | 'market_cap_weighting'
  | 'custom';

export type PortfolioStatus = 'active' | 'archived' | 'draft';

export interface PortfolioPosition {
  symbol: string;
  sector: string;
  country: string;
  currency: string;
  quantity: number;
  avgPrice: number;
  marketValue: number;
  direction: 'long' | 'short';
  unrealizedPnl: number;
  weight: number;
}

export interface PortfolioRecord {
  portfolioId: string;
  name: string;
  owner: string;
  status: PortfolioStatus;
  capital: number;
  cash: number;
  realizedPnl: number;
  unrealizedPnl: number;
  availableBuyingPower: number;
  positions: PortfolioPosition[];
  allocations: Record<string, number>;
  createdAt: string;
  version: string;
}

export interface ConsumableSignal {
  symbol: string;
  direction: 'BUY' | 'SELL' | 'HOLD';
  confidenceScore: number;
  finalScore: number;
  portfolioFitScore: number;
  riskScore: number;
  recommendedQuantity: number;
  recommendedCapital: number;
  sector: string;
  liquidityScore: number;
  signalStatus: string;
  generatedAt: string;
}

export interface AllocationConstraints {
  maxSinglePositionPct: number;
  maxSectorExposurePct: number;
  maxGrossExposurePct: number;
  maxCountryExposurePct: number;
  maxCurrencyExposurePct: number;
  targetVolatilityPct?: number;
  customWeights?: Record<string, number>;
}

export interface AllocationPlan {
  method: AllocationMethod;
  weights: Record<string, number>;
  constraints: AllocationConstraints;
  explanation: string;
}

export interface RiskMetrics {
  portfolioVolatility: number;
  valueAtRisk95: number;
  conditionalVaR95: number;
  maxDrawdown: number;
  beta: number;
  correlationMatrix: Record<string, Record<string, number>>;
  sectorExposure: Record<string, number>;
  countryExposure: Record<string, number>;
  currencyExposure: Record<string, number>;
  concentrationHhi: number;
}

export interface PrioritizedSignal {
  signal: ConsumableSignal;
  priorityScore: number;
  rank: number;
  selected: boolean;
  rejectionReasons: string[];
  explanation: string;
}

export interface ExecutionBatch {
  batchId: string;
  sequence: number;
  symbol: string;
  direction: 'BUY' | 'SELL';
  quantity: number;
  estimatedCapital: number;
  estimatedSlippage: number;
  estimatedFees: number;
}

export interface ExecutionPlan {
  portfolioId: string;
  batches: ExecutionBatch[];
  totalCapitalUsage: number;
  totalEstimatedSlippage: number;
  totalEstimatedFees: number;
  explanation: string;
}

export interface StressScenario {
  scenarioId: string;
  label: string;
  shockPct: number;
  portfolioImpactPct: number;
  sectorImpacts: Record<string, number>;
  explanation: string;
}

export interface AttributionSlice {
  label: string;
  contributionPct: number;
  explanation: string;
}

export interface PortfolioAnalyticsReport {
  portfolioAttribution: AttributionSlice[];
  strategyAttribution: AttributionSlice[];
  sectorAttribution: AttributionSlice[];
  riskAttribution: AttributionSlice[];
  performanceAttribution: AttributionSlice[];
  rollingReturns: Array<{ period: string; returnPct: number }>;
  benchmarkComparison: { benchmark: string; alpha: number; trackingError: number };
}

export interface RecommendationExplanation {
  symbol: string;
  selected: boolean;
  whySelected: string | null;
  whyRejected: string | null;
  capitalImpact: string;
  riskImpact: string;
  diversificationImpact: string;
}

export interface PortfolioRecommendation {
  recommendationId: string;
  portfolioId: string;
  version: string;
  createdAt: string;
  author: string;
  gitCommit: string | null;
  signals: PrioritizedSignal[];
  executionPlan: ExecutionPlan | null;
  explanations: RecommendationExplanation[];
  replaySeed: number;
}

export interface PortfolioGovernanceRecord {
  recommendationId: string;
  version: string;
  auditedAt: string;
  auditor: string;
  replayable: boolean;
  autoExecutionBlocked: true;
}
