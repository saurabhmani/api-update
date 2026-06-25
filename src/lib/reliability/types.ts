// Platform Reliability — shared types

export type ReliabilityStatus = 'healthy' | 'degraded' | 'critical';
export type AlertChannel = 'slack' | 'email' | 'system';
export type DeliveryStatus = 'sent' | 'failed' | 'skipped';

export interface HealthMetrics {
  apiUptimePct: number;
  apiErrorRate: number;
  apiAvgLatencyMs: number;
  signalLatencyMs: number | null;
  cronFailureCount24h: number;
  cronLastSuccess: string | null;
  dataFreshnessSeconds: number | null;
  dataFreshnessQuality: string;
  brokerFailureCount24h: number;
  brokerDownCount: number;
}

export interface CronJobStatus {
  id: string;
  label: string;
  schedule: string;
  source: string;
  lastRunAt: string | null;
  lastStatus: 'success' | 'failed' | 'running' | 'unknown';
  lastDurationMs: number | null;
  failureCount24h: number;
}

export interface DataLoaderStatus {
  provider: string;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  failureCount24h: number;
  avgLatencyMs: number | null;
  circuitOpen: boolean;
}

export interface BrokerPlatformStatus {
  broker: string;
  status: string;
  connectedAccounts: number;
  failureCount24h: number;
  lastCheckedAt: string | null;
  avgLatencyMs: number | null;
  killSwitchActive: boolean;
}

export interface SignalValidationSummary {
  totalRows: number;
  uniqueSymbols: number;
  duplicatesRemoved: number;
  blankFieldsFixed: number;
  signalQuality: 'CLEAN' | 'NEEDS_CLEANUP';
  engineHealth: string;
  lastScanAt: string | null;
}

export interface StrategyMonitorSummary {
  activeStrategies: number;
  strategiesWithData: number;
  avgWinRate: number | null;
  staleStrategies: number;
  lastBacktestAt: string | null;
}

export interface UserManagementSummary {
  totalUsers: number;
  activeUsers: number;
  adminUsers: number;
  disabledUsers: number;
  recentLogins24h: number;
}

export interface ReliabilityDashboard {
  generatedAt: string;
  overallStatus: ReliabilityStatus;
  metrics: HealthMetrics;
  cronJobs: CronJobStatus[];
  dataLoaders: DataLoaderStatus[];
  brokers: BrokerPlatformStatus[];
  signals: SignalValidationSummary;
  strategies: StrategyMonitorSummary;
  users: UserManagementSummary;
  alerts: {
    worstSeverity: string | null;
    critical: number;
    warning: number;
    info: number;
    items: Array<{
      id: string;
      severity: string;
      title: string;
      detail: string;
      triggered_at: string;
    }>;
  };
  apiHealth: {
    systemStatus: string;
    errorRate: number;
    avgLatencyMs: number;
    quotaState: string;
    marketOpen: boolean;
  };
}

export interface ReliabilityAuditEntry {
  id: number;
  actorId: number | null;
  actorEmail: string | null;
  action: string;
  resource: string | null;
  detail: Record<string, unknown>;
  ipAddress: string | null;
  createdAt: string;
}

export interface AlertDeliveryRecord {
  id: number;
  alertId: string;
  channel: AlertChannel;
  severity: string;
  title: string;
  status: DeliveryStatus;
  errorMessage: string | null;
  createdAt: string;
}
