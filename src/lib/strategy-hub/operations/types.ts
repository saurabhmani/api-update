// ════════════════════════════════════════════════════════════════
//  Strategy Hub — Operational Monitoring types (Phase 6)
// ════════════════════════════════════════════════════════════════

export type StrategyHealthStatus = 'healthy' | 'warning' | 'critical' | 'offline';
export type AlertSeverity = 'info' | 'warning' | 'critical';
export type AlertStatus = 'open' | 'acknowledged' | 'resolved';
export type JobRunStatus = 'success' | 'failed' | 'running' | 'unknown' | 'paused';

export interface StrategyHealthSnapshot {
  strategyId: string;
  strategyName: string;
  healthStatus: StrategyHealthStatus;
  healthScore: number;
  lastSuccessfulExecution: string | null;
  lastFailedExecution: string | null;
  consecutiveFailures: number;
  runtimeErrors: number;
  signalGenerationStatus: 'active' | 'stale' | 'silent' | 'offline';
  approvalRateTrend: 'up' | 'down' | 'flat';
  approvalRate: number;
  validationStatus: string | null;
  validationScore: number | null;
  lastValidationAt: string | null;
  deploymentStatus: string;
  currentMode: string;
  performanceDegraded: boolean;
  performanceHealthScore: number | null;
  isActiveInRunner: boolean;
  issues: string[];
}

export interface OperationsDashboard {
  generatedAt: string;
  summary: {
    activeStrategies: number;
    healthyStrategies: number;
    warningStrategies: number;
    criticalStrategies: number;
    disabledStrategies: number;
    paperDeployed: number;
    liveDeployed: number;
    failedValidations: number;
    openAlerts: number;
  };
  signalEngine: SignalEngineMonitor;
  scheduler: SchedulerMonitorSummary;
  lastValidationTime: string | null;
  lastScanTime: string | null;
  nextScheduledScan: string | null;
  marketHoursActive: boolean;
  cached: boolean;
  cacheAgeMs: number | null;
}

export interface StrategyAlert {
  id: number;
  alertKey: string;
  severity: AlertSeverity;
  strategyId: string | null;
  strategyName: string | null;
  title: string;
  description: string;
  suggestedAction: string;
  status: AlertStatus;
  createdAt: string;
  acknowledgedAt: string | null;
  acknowledgedBy: string | null;
  resolvedAt: string | null;
  resolvedBy: string | null;
}

export interface SchedulerJobStatus {
  id: string;
  name: string;
  schedule: string;
  lastRun: string | null;
  nextRun: string | null;
  durationMs: number | null;
  status: JobRunStatus;
  retryCount: number;
  source: string;
  paused: boolean;
}

export interface SchedulerMonitorSummary {
  jobs: SchedulerJobStatus[];
  lastUpdated: string;
}

export interface SignalEngineMonitor {
  scanStatus: 'idle' | 'running' | 'degraded' | 'error';
  currentStrategy: string | null;
  queueSize: number;
  strategiesProcessed: number;
  signalsGenerated: number;
  signalsApproved: number;
  signalsRejected: number;
  processingTimeMs: number | null;
  throughputPerMin: number;
  memoryUsageMb: number;
  errorCount: number;
  lastScanAt: string | null;
  strategyStats: Array<{
    strategyId: string;
    evaluated: number;
    matched: number;
    confirmed: number;
    rejected: number;
  }>;
}

export interface ActivityTimelineEntry {
  id: string;
  timestamp: string;
  category: 'deployment' | 'configuration' | 'validation' | 'mode' | 'alert' | 'health' | 'scheduler' | 'engine';
  strategyId: string | null;
  strategyName: string | null;
  title: string;
  description: string;
  actor: string | null;
  severity?: AlertSeverity;
}

export interface AutomationSettings {
  revalidateOnConfigChange: boolean;
  scheduledDailyValidation: boolean;
  automaticHealthChecks: boolean;
  automaticCacheRefresh: boolean;
  scheduledPerformanceRecalc: boolean;
  automaticRankingRefresh: boolean;
  automaticLearningRefresh: boolean;
  /** Phase 7 — scheduled AI analysis (read-only; never auto-applies). */
  scheduledDailyAiReview: boolean;
  scheduledWeeklyOptimizationReport: boolean;
  scheduledMonthlyExecutiveSummary: boolean;
  automaticAnomalyDetection: boolean;
  automaticRecommendationRefresh: boolean;
  updatedAt: string;
  updatedBy: string | null;
}

export const DEFAULT_AUTOMATION_SETTINGS: AutomationSettings = {
  revalidateOnConfigChange: false,
  scheduledDailyValidation: true,
  automaticHealthChecks: true,
  automaticCacheRefresh: true,
  scheduledPerformanceRecalc: true,
  automaticRankingRefresh: true,
  automaticLearningRefresh: true,
  scheduledDailyAiReview: true,
  scheduledWeeklyOptimizationReport: true,
  scheduledMonthlyExecutiveSummary: true,
  automaticAnomalyDetection: true,
  automaticRecommendationRefresh: true,
  updatedAt: new Date(0).toISOString(),
  updatedBy: null,
};

export type AutomationJobType =
  | 'health_check'
  | 'daily_validation'
  | 'cache_refresh'
  | 'performance_recalc'
  | 'ranking_refresh'
  | 'learning_refresh'
  | 'ai_daily_review'
  | 'ai_weekly_optimization'
  | 'ai_monthly_executive'
  | 'ai_anomaly_detection'
  | 'ai_recommendation_refresh';
