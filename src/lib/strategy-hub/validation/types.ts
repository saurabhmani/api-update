// ════════════════════════════════════════════════════════════════
//  Strategy Validation — shared types (Phase 4)
// ════════════════════════════════════════════════════════════════

export type ValidationCheckStatus = 'pass' | 'warning' | 'failure';
export type ValidationSeverity = 'info' | 'low' | 'medium' | 'high' | 'critical';
export type ValidationCategory =
  | 'configuration'
  | 'integrity'
  | 'signal_engine'
  | 'risk'
  | 'performance'
  | 'deployment';

export type ValidationOverallStatus = 'ready' | 'warning' | 'failed';
export type ValidationTarget = 'paper' | 'live' | 'assessment';

export interface ValidationCheck {
  id: string;
  category: ValidationCategory;
  name: string;
  status: ValidationCheckStatus;
  severity: ValidationSeverity;
  required: boolean;
  message: string;
  recommendation?: string;
}

export interface ValidationCategoryScore {
  category: ValidationCategory;
  score: number;
  passed: number;
  warnings: number;
  failed: number;
  total: number;
}

export interface ValidationReportSummary {
  total: number;
  passed: number;
  warnings: number;
  failed: number;
  executionTimeMs: number;
  validatedAt: string;
}

export interface ValidationReport {
  validationId?: number;
  strategyId: string;
  displayName: string;
  target: ValidationTarget;
  overallStatus: ValidationOverallStatus;
  overallScore: number;
  passPercentage: number;
  categoryScores: ValidationCategoryScore[];
  checks: ValidationCheck[];
  summary: ValidationReportSummary;
  effectiveConfig: Record<string, unknown>;
  registryDefaults: Record<string, unknown>;
  configVersion: number;
  configOverrideCount: number;
  paperDeployReady: boolean;
  liveDeployReady: boolean;
  blockedReasons: string[];
}

export interface StrategyValidationHistoryRow {
  id: number;
  strategy_id: string;
  user_id: number;
  validation_target: ValidationTarget;
  overall_status: ValidationOverallStatus;
  validation_score: number;
  report_json: ValidationReport;
  effective_config_json: Record<string, unknown> | null;
  config_version: number;
  execution_time_ms: number;
  actor: string | null;
  created_at: string;
}

export const VALIDATION_CATEGORIES: ValidationCategory[] = [
  'configuration',
  'integrity',
  'signal_engine',
  'risk',
  'performance',
  'deployment',
];
