// ════════════════════════════════════════════════════════════════
//  Strategy Hub — wire types
// ════════════════════════════════════════════════════════════════

import type { StrategyCategory, StrategyRiskProfile } from '@/lib/signal-engine/types/signalEngine.types';
import type { DeploymentLifecycle } from './deploymentLifecycle';

/** @deprecated Use DeploymentLifecycle — kept for DB backward compatibility. */
export type LegacyDeploymentStatus = 'registered' | 'staging' | 'paper_ready';

export type DeploymentStatus = DeploymentLifecycle | LegacyDeploymentStatus;

export type DeploymentEnvironment = 'paper' | 'live';

export type DeploymentEventType =
  | 'deploy'
  | 'promote_live'
  | 'disable'
  | 'enable'
  | 'rollback';
export type StrategyMarketType = 'Equity' | 'Options';
export type StrategyCardStatus = 'Active' | 'Inactive' | 'Backtested' | 'Premium';

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
  deploymentLifecycle: DeploymentLifecycle;
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
  direction: 'BUY' | 'SELL' | 'BOTH';
  marketType: StrategyMarketType;
  riskProfile: StrategyRiskProfile;
  riskProfileLabel: string;
  timeframe: string;
  timeframeLabel: string;
  explanation: string;
  isFeatured: boolean;
  isActiveInRunner: boolean;
  deploymentStatus: DeploymentStatus;
  /** Phase 1 — normalized lifecycle for badges and filters. */
  deploymentLifecycle: DeploymentLifecycle;
  paperTradingReady: boolean;
  strategyMode: string;
  /** Registry default mode (before admin override). */
  registryStrategyMode?: string;
  /** True when an admin override is stored in the profile. */
  hasModeOverride?: boolean;
  effectiveStrategyMode?: string;
  cardStatus: StrategyCardStatus;
  performance?: StrategyHubPerformanceSummary | null;
}

export interface StrategyHubPerformanceSummary {
  winRate: number;
  totalSignals: number;
  totalTrades: number;
  maxDrawdownPct: number;
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
  updated_at?: string;
  created_at?: string;
}

export interface DeploymentHistoryRow {
  id: number;
  strategy_id: string;
  user_id: number;
  from_status: string | null;
  to_status: string;
  environment: DeploymentEnvironment;
  event_type: DeploymentEventType;
  actor: string | null;
  details_json: Record<string, unknown> | null;
  created_at: string;
}

export interface DeployedStrategyRow {
  strategy_id: string;
  deployment_status: DeploymentStatus;
  paper_trading_enabled: boolean;
  updated_at: string;
  last_deployed_at: string | null;
  last_deployed_by: string | null;
  last_environment: DeploymentEnvironment | null;
}

export type StrategyModeChangeSource = 'ui' | 'api' | 'bulk' | 'system';

export interface StrategyModeHistoryRow {
  id: number;
  strategy_id: string;
  user_id: number;
  from_mode: string | null;
  to_mode: string;
  reason: string | null;
  source: StrategyModeChangeSource;
  actor: string | null;
  details_json: Record<string, unknown> | null;
  created_at: string;
}

export interface StrategyManagementStatus {
  totalRegistered: number;
  activeCount: number;
  watchlistCount: number;
  disabledCount: number;
  experimentalCount: number;
  currentlyRunning: number;
  overrideCount: number;
  lastUpdated: string | null;
}

export type StrategyConfigChangeSource = 'ui' | 'api' | 'restore' | 'reset';

export interface StrategyConfigHistoryRow {
  id: number;
  strategy_id: string;
  user_id: number;
  version_number: number;
  previous_values_json: Record<string, unknown> | null;
  new_values_json: Record<string, unknown> | null;
  change_summary: string;
  reason: string | null;
  actor: string | null;
  source: StrategyConfigChangeSource;
  created_at: string;
}

export interface StrategyConfigFieldView {
  key: string;
  label: string;
  description: string;
  type: string;
  registryDefault: unknown;
  overrideValue: unknown | null;
  effectiveValue: unknown;
  isOverridden: boolean;
  optional?: boolean;
}

export interface StrategyConfigurationView {
  strategyId: string;
  displayName: string;
  version: number;
  fields: StrategyConfigFieldView[];
  overriddenKeys: string[];
  effective: Record<string, unknown>;
  registryDefaults: Record<string, unknown>;
  overrides: Record<string, unknown>;
  lastUpdated: string | null;
  lastUpdatedBy: string | null;
}

export interface StrategyConfigPreviewResult {
  valid: boolean;
  issues: Array<{ key: string; message: string }>;
  changes: Array<{
    key: string;
    label: string;
    previousValue: unknown;
    newValue: unknown;
    impact: string;
  }>;
  summary: string;
  nextOverrides: Record<string, unknown>;
  nextEffective: Record<string, unknown>;
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
