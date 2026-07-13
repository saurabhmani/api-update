// ════════════════════════════════════════════════════════════════
//  Phase 7 — Research Platform Types
// ════════════════════════════════════════════════════════════════

export const RESEARCH_SCHEMA_VERSION = '7.0.0';

export type ExperimentStatus =
  | 'draft'
  | 'running'
  | 'completed'
  | 'failed'
  | 'archived';

export interface ResearchDataset {
  datasetId: string;
  name: string;
  symbols: string[];
  startDate: string;
  endDate: string;
  assetClass: string;
  barCount: number;
  source: string;
}

export interface ExperimentRecord {
  experimentId: string;
  author: string;
  description: string;
  datasetId: string;
  features: string[];
  parameters: Record<string, unknown>;
  createdAt: string;
  gitCommit: string | null;
  configurationVersion: string;
  randomSeed: number;
  result: ExperimentResult | null;
  status: ExperimentStatus;
}

export interface ExperimentResult {
  metrics: BenchmarkMetrics;
  tradeCount: number;
  notes: string | null;
}

export interface BenchmarkMetrics {
  sharpe: number;
  sortino: number;
  calmar: number;
  profitFactor: number;
  winRate: number;
  maxDrawdown: number;
  recoveryFactor: number;
  totalReturn: number;
}

export interface ResearchCandle {
  ts: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface ResearchTrade {
  symbol: string;
  strategyId: string;
  entryPrice: number;
  exitPrice: number;
  entryBar: number;
  exitBar: number;
  returnPct: number;
  fees: number;
  slippage: number;
  exitReason: 'target' | 'stop' | 'horizon' | 'partial';
}

export interface PromotionRequest {
  experimentId: string;
  requestedBy: string;
  reason: string;
  walkForwardPassed: boolean;
  crossRegimeStable: boolean;
  peerReviewApproved: boolean;
  statisticalSignificance: number;
  minimumTrades: number;
}

export interface PromotionDecision {
  approved: boolean;
  blockingReasons: string[];
  requiresPhase4Governance: true;
}
