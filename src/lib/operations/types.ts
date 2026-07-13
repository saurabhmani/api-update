// ════════════════════════════════════════════════════════════════
//  Phase 5 — Operations Types
// ════════════════════════════════════════════════════════════════

export const OPERATIONS_SCHEMA_VERSION = '5.0.0';

export type ComponentStatus = 'healthy' | 'degraded' | 'unhealthy' | 'unknown';

export type AlertSeverity = 'warning' | 'critical' | 'resolved';

export interface ComponentHealth {
  component: string;
  status: ComponentStatus;
  latencyMs: number | null;
  lastSuccessAt: string | null;
  failureCount24h: number;
  message: string | null;
  metadata: Record<string, unknown>;
}

export interface DependencyHealth {
  name: string;
  status: ComponentStatus;
  latencyMs: number | null;
  message: string | null;
}

export interface ProductionHealthSummary {
  schemaVersion: string;
  generatedAt: string;
  overallStatus: ComponentStatus;
  components: ComponentHealth[];
  dependencies: DependencyHealth[];
  responseTimeMs: number;
}

export interface OperationalAlert {
  id: string;
  severity: AlertSeverity;
  category: string;
  title: string;
  detail: string;
  component: string;
  triggeredAt: string;
  resolvedAt: string | null;
  context: Record<string, unknown>;
}

export interface ReleaseManifest {
  manifestVersion: string;
  generatedAt: string;
  gitCommit: string | null;
  buildVersion: string;
  configurationVersion: string;
  learningVersion: string;
  adaptiveVersion: string | null;
  schemaVersion: string;
  benchmarkVersion: string;
  validationStatus: 'passed' | 'failed' | 'pending';
  validationChecks: Array<{ name: string; passed: boolean; message: string }>;
  releaseNotes: string | null;
}

export interface DeploymentValidationResult {
  passed: boolean;
  generatedAt: string;
  checks: Array<{
    name: string;
    category: string;
    passed: boolean;
    blocking: boolean;
    message: string;
  }>;
}

export interface BackupManifest {
  backupId: string;
  generatedAt: string;
  artifacts: Array<{
    category: string;
    path: string;
    recordCount: number | null;
    checksum: string | null;
  }>;
}

export interface SecurityValidationResult {
  passed: boolean;
  generatedAt: string;
  checks: Array<{
    name: string;
    passed: boolean;
    severity: 'info' | 'warning' | 'critical';
    message: string;
  }>;
}

export interface OperationalDashboardData {
  generatedAt: string;
  signalsPerDay: number;
  schedulerHealth: ComponentStatus;
  marketFeedLatencyMs: number | null;
  learningJobs: Array<{ name: string; status: string; lastRunAt: string | null; durationMs: number | null }>;
  promotionHistory: Array<{ parameterId: string; status: string; promotedAt: string | null }>;
  runtimeConfigurationVersion: string;
  activeAdaptiveVersion: string | null;
  pipelineTimingsMs: Record<string, number | null>;
  errorRates: Record<string, number>;
  rejectionDistribution: Record<string, number>;
  confidenceDistribution: Record<string, number>;
}
