// ════════════════════════════════════════════════════════════════
//  Strategy Hub — wire types
// ════════════════════════════════════════════════════════════════

import type { StrategyCategory, StrategyRiskProfile } from '@/lib/signal-engine/types/signalEngine.types';

export type DeploymentStatus = 'registered' | 'staging' | 'paper_ready' | 'live';

export interface PaperTradingCheck {
  name: string;
  pass: boolean;
  required: boolean;
}

export interface PaperTradingReadiness {
  ready: boolean;
  score: number;
  checks: PaperTradingCheck[];
  deploymentStatus: DeploymentStatus;
  paperTradingEnabled: boolean;
}

export interface StrategyCategoryInfo {
  id: StrategyCategory;
  label: string;
  description: string;
  strategyCount: number;
}

export interface StrategyHubSummary {
  strategyId: string;
  displayName: string;
  category: StrategyCategory;
  categoryLabel: string;
  direction: 'BUY' | 'SELL';
  riskProfile: StrategyRiskProfile;
  riskProfileLabel: string;
  timeframe: string;
  explanation: string;
  isFeatured: boolean;
  isActiveInRunner: boolean;
  deploymentStatus: DeploymentStatus;
  paperTradingReady: boolean;
  performance?: StrategyHubPerformanceSummary | null;
}

export interface StrategyHubPerformanceSummary {
  winRate: number;
  totalSignals: number;
  expectancy: number;
  healthScore: number;
  healthLabel: string;
  dataStatus: 'SUFFICIENT' | 'LIMITED' | 'INSUFFICIENT' | 'INSUFFICIENT_DATA';
}

export interface StrategyHubDetail extends StrategyHubSummary {
  entryType: string;
  invalidation: string;
  allowedRegimes: string[];
  blockedRegimes: string[];
  idealMarketRegime: string[];
  idealRsiRange: [number, number];
  minAdx?: number;
  minVolumeExpansion?: number;
  defaultConfidenceWeight: number;
  hasEvaluator: boolean;
  paperTrading: PaperTradingReadiness;
  performance: StrategyHubPerformanceSummary | null;
  performanceDetail?: StrategyPerformanceDetail | null;
  conditions?: StrategyConditionRow[];
  profileNotes: string | null;
  version: string;
}

export interface StrategyPerformanceDetail {
  window: string;
  winRate: number;
  lossRate: number;
  totalSignals: number;
  evaluatedSignals: number;
  expectancy: number;
  profitFactor: number;
  maxDrawdownPct: number;
  averageReturnPct: number;
  averageWinPct: number;
  averageLossPct: number;
  targetHitRate: number;
  stopHitRate: number;
  strategyHealthScore: number;
  healthLabel: string;
  recommendation: string;
  performanceStatus: string;
  performanceSource: string;
}

export interface StrategyHubListResponse {
  strategies: StrategyHubSummary[];
  featured: StrategyHubSummary[];
  categories: StrategyCategoryInfo[];
  total: number;
}

export interface StrategyProfileRow {
  strategy_id: string;
  deployment_status: DeploymentStatus;
  paper_trading_enabled: boolean;
  risk_profile: string | null;
  metadata_json: Record<string, unknown> | null;
  version: string;
  notes: string | null;
}

export interface StrategyConditionRow {
  id: number;
  strategy_id: string;
  condition_key: string;
  condition_label: string;
  condition_type: string;
  operator: string | null;
  value_numeric: number | null;
  value_text: string | null;
  is_required: boolean;
  sort_order: number;
}
