// ════════════════════════════════════════════════════════════════
//  Strategy Lab — wire types
// ════════════════════════════════════════════════════════════════

export type LabMarket = 'equity' | 'options';
export type LabTimeframe = 'intraday' | 'swing' | 'positional' | 'daily';
export type LabDirection = 'long' | 'short';
export type LabSource = 'no_code' | 'ai' | 'import';
export type LabStatus = 'draft' | 'validated' | 'backtested' | 'paper_ready' | 'deployed' | 'rejected';
export type LogicalOperator = 'AND' | 'OR';
export type ConditionOperator = 'gt' | 'lt' | 'gte' | 'lte' | 'eq' | 'between' | 'crosses_above' | 'crosses_below';

export type SupportedIndicator =
  | 'rsi'
  | 'ema_20'
  | 'ema_50'
  | 'adx'
  | 'volume_expansion'
  | 'close_vs_ema20'
  | 'close_vs_ema50'
  | 'fib_pullback_zone'
  | 'atr_pct'
  | 'regime_bullish'
  | 'price_above_ema20';

export interface LabCondition {
  id: string;
  indicator: SupportedIndicator;
  operator: ConditionOperator;
  value: number | [number, number];
  params?: Record<string, number>;
  label?: string;
}

export interface ConditionGroup {
  operator: LogicalOperator;
  conditions: LabCondition[];
}

export interface StopLossRule {
  type: 'percent' | 'atr_multiple' | 'structure';
  value: number;
  description?: string;
}

export interface TargetRule {
  type: 'percent' | 'rr_multiple' | 'structure';
  value: number;
  label?: string;
}

export interface RiskSettings {
  riskPerTradePct: number;
  maxOpenPositions: number;
  maxGrossExposurePct: number;
  minRewardRisk?: number;
}

export interface StrategyDefinition {
  id?: string;
  name: string;
  description?: string;
  market: LabMarket;
  symbolUniverse: string[];
  timeframe: LabTimeframe;
  direction: LabDirection;
  marketRegimeFilter: string[];
  source: LabSource;
  entry: ConditionGroup;
  exit: ConditionGroup;
  stopLoss: StopLossRule;
  targets: TargetRule[];
  risk: RiskSettings;
  metadata?: {
    aiPrompt?: string;
    parentStrategyId?: string;
  };
}

export interface ValidationIssue {
  code: string;
  severity: 'error' | 'warning';
  message: string;
  field?: string;
}

export interface ValidationResult {
  valid: boolean;
  issues: ValidationIssue[];
  canSave: boolean;
  canBacktest: boolean;
  canDeploy: boolean;
}

export interface StrategyPreviewResult {
  summary: string;
  entryDescription: string;
  exitDescription: string;
  stopLossDescription: string;
  targetDescriptions: string[];
  riskDescription: string;
  estimatedSignalsPerMonth: string;
  lookaheadSafe: boolean;
  warnings: string[];
}

export interface StrategyLabRecord {
  id: string;
  name: string;
  description: string | null;
  source: LabSource;
  timeframe: LabTimeframe;
  direction: LabDirection;
  definition: StrategyDefinition;
  dsl: string;
  status: LabStatus;
  validated: boolean;
  validation: ValidationResult | null;
  lastBacktestId: string | null;
  backtestPassed: boolean;
  paperDeployed: boolean;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface AuditEntry {
  id: number;
  strategyId: string;
  action: string;
  actor: string | null;
  details: Record<string, unknown> | null;
  createdAt: string;
}

import type { BacktestRunConfig } from '@/lib/backtesting/types';

export interface BacktestReadyConfig {
  name: string;
  labStrategyId: string;
  config: BacktestRunConfig;
}
