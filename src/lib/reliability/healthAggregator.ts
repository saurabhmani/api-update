// Platform Reliability — aggregate health metrics from all subsystems

import { getMonitorSnapshot } from '@/lib/monitor/apiMonitor';
import { getInstitutionalHealthSnapshot } from '@/lib/monitor/institutionalHealth';
import { getMarketStatus } from '@/lib/marketData/marketHours';
import { classifyCandleFreshness, type CandleSource } from '@/lib/marketData/candleFreshness';
import { isGlobalLiveKillSwitchActive } from '@/lib/broker/killSwitch';
import { db } from '@/lib/db';
import { CRON_REGISTRY } from './constants/cronRegistry';
import { evaluateProductionAlerts } from './alertDispatcher';
import {
  countBrokerFailures24h,
  fetchBrokerPlatformStats,
  fetchLearningJobRuns,
  fetchProviderHealthLogs,
  fetchSchedulerRuns,
  fetchSyncLogs,
  fetchUserSummary,
  saveHealthSnapshot,
} from './repository/reliabilityRepository';
import type {
  BrokerPlatformStatus,
  CronJobStatus,
  DataLoaderStatus,
  HealthMetrics,
  ReliabilityDashboard,
  ReliabilityStatus,
  SignalValidationSummary,
  StrategyMonitorSummary,
} from './types';

async function probeLatestCandleMs(): Promise<number | null> {
  try {
    const r = await db.query(`SELECT UNIX_TIMESTAMP(MAX(ts)) AS ts FROM market_data_daily`);
    const ts = (r.rows[0] as { ts?: number | string | null })?.ts;
    if (ts == null) return null;
    const n = Number(ts);
    return Number.isFinite(n) ? n * 1000 : null;
  } catch {
    return null;
  }
}

function matchJobRun(jobName: string, keys: string[]): boolean {
  const lower = jobName.toLowerCase();
  return keys.some((k) => lower.includes(k.toLowerCase()));
}

function buildCronStatuses(
  learningRuns: Awaited<ReturnType<typeof fetchLearningJobRuns>>,
  syncLogs: Awaited<ReturnType<typeof fetchSyncLogs>>,
  schedRuns: Awaited<ReturnType<typeof fetchSchedulerRuns>>,
): CronJobStatus[] {
  const allRuns = [
    ...learningRuns.map((r) => ({ ...r, source: 'learning' })),
    ...syncLogs.map((r) => ({ ...r, source: 'sync' })),
    ...schedRuns.map((r) => ({
      job_name: r.label,
      status: r.failed_count > 0 ? 'failed' : 'success',
      duration_ms: r.elapsed_ms,
      run_at: r.started_at,
      source: 'scheduler',
    })),
  ];

  const cutoff24h = Date.now() - 24 * 60 * 60 * 1000;

  return CRON_REGISTRY.map((def) => {
    const matched = allRuns.filter((r) => matchJobRun(r.job_name, def.matchKeys));
    const sorted = matched.sort(
      (a, b) => new Date(b.run_at).getTime() - new Date(a.run_at).getTime(),
    );
    const latest = sorted[0];
    const failures24h = matched.filter(
      (r) => r.status === 'failed' && new Date(r.run_at).getTime() >= cutoff24h,
    ).length;

    let lastStatus: CronJobStatus['lastStatus'] = 'unknown';
    if (latest) {
      if (latest.status === 'success') lastStatus = 'success';
      else if (latest.status === 'failed') lastStatus = 'failed';
      else if (latest.status === 'running') lastStatus = 'running';
    }

    return {
      id: def.id,
      label: def.label,
      schedule: def.schedule,
      source: def.source,
      lastRunAt: latest ? new Date(latest.run_at).toISOString() : null,
      lastStatus,
      lastDurationMs: latest?.duration_ms != null ? Number(latest.duration_ms) : null,
      failureCount24h: failures24h,
    };
  });
}

function buildDataLoaderStatus(
  providerLogs: Awaited<ReturnType<typeof fetchProviderHealthLogs>>,
  snap: ReturnType<typeof getMonitorSnapshot>,
): DataLoaderStatus[] {
  const providers = ['kite', 'nse', 'yahoo', 'snapshot'];
  const cutoff24h = Date.now() - 24 * 60 * 60 * 1000;

  return providers.map((provider) => {
    const logs = providerLogs.filter((l) => l.provider.toLowerCase().includes(provider));
    const successes = logs.filter((l) => l.event === 'success');
    const failures = logs.filter((l) => l.event === 'failure' || l.event === 'circuit_open');
    const failures24h = failures.filter((l) => new Date(l.created_at).getTime() >= cutoff24h).length;
    const monitorRow = snap.providers.find((p) => p.provider === provider);

    return {
      provider,
      lastSuccessAt: successes[0]?.created_at ?? monitorRow?.lastCallAt ?? null,
      lastFailureAt: failures[0]?.created_at ?? null,
      failureCount24h: failures24h || (monitorRow?.errors ?? 0),
      avgLatencyMs: monitorRow?.avgLatencyMs ?? null,
      circuitOpen: failures.some((l) => l.event === 'circuit_open'),
    };
  });
}

async function buildSignalValidation(): Promise<SignalValidationSummary> {
  let totalRows = 0;
  let uniqueSymbols = 0;
  let duplicatesRemoved = 0;
  let blankFieldsFixed = 0;

  try {
    const count = async (sql: string) => {
      const { rows } = await db.query(sql);
      return Number((rows[0] as any)?.c ?? 0);
    };
    totalRows = await count('SELECT COUNT(*) AS c FROM q365_signals');
    uniqueSymbols = await count('SELECT COUNT(DISTINCT symbol) AS c FROM q365_signals');
    const distinctPairs = await count(
      `SELECT COUNT(*) AS c FROM (SELECT symbol, direction FROM q365_signals GROUP BY symbol, direction) g`,
    );
    duplicatesRemoved = Math.max(0, totalRows - distinctPairs);
    blankFieldsFixed = await count(
      `SELECT COUNT(*) AS c FROM q365_signals
        WHERE risk_score IS NULL OR portfolio_fit_score IS NULL OR stress_survival_score IS NULL`,
    );
  } catch { /* schema optional */ }

  let lastScanAt: string | null = null;
  try {
    const { rows } = await db.query(`SELECT MAX(created_at) AS ts FROM q365_signals`);
    const ts = (rows[0] as any)?.ts;
    if (ts) lastScanAt = new Date(ts).toISOString();
  } catch { /* optional */ }

  const inst = getInstitutionalHealthSnapshot();
  const engineHealth = inst.elite?.last_run_at ? 'ACTIVE' : 'IDLE';

  return {
    totalRows,
    uniqueSymbols,
    duplicatesRemoved,
    blankFieldsFixed,
    signalQuality: duplicatesRemoved === 0 ? 'CLEAN' : 'NEEDS_CLEANUP',
    engineHealth,
    lastScanAt,
  };
}

async function buildStrategyMonitor(): Promise<StrategyMonitorSummary> {
  let activeStrategies = 0;
  let strategiesWithData = 0;
  let staleStrategies = 0;
  let lastBacktestAt: string | null = null;

  try {
    const { rows } = await db.query(
      `SELECT COUNT(DISTINCT strategy_id) AS c FROM strategy_performance_snapshots`,
    );
    strategiesWithData = Number((rows[0] as any)?.c ?? 0);
  } catch { /* optional */ }

  try {
    const { rows } = await db.query(`SELECT COUNT(*) AS c FROM q365_strategies WHERE is_active = 1`);
    activeStrategies = Number((rows[0] as any)?.c ?? 0);
  } catch {
    activeStrategies = strategiesWithData;
  }

  try {
    const { rows } = await db.query(
      `SELECT COUNT(*) AS c FROM strategy_performance_snapshots
        WHERE snapshot_at < DATE_SUB(NOW(), INTERVAL 7 DAY)`,
    );
    staleStrategies = Number((rows[0] as any)?.c ?? 0);
  } catch { /* optional */ }

  try {
    const { rows } = await db.query(`SELECT MAX(completed_at) AS ts FROM backtest_runs WHERE status = 'completed'`);
    const ts = (rows[0] as any)?.ts;
    if (ts) lastBacktestAt = new Date(ts).toISOString();
  } catch { /* optional */ }

  return {
    activeStrategies,
    strategiesWithData,
    avgWinRate: null,
    staleStrategies,
    lastBacktestAt,
  };
}

/** Warnings that reflect real platform impairment. Informational rules
 *  (scan coverage off-hours, maturity-layer approval ratios) stay in
 *  the alerts panel but do not downgrade overall status. */
const DEGRADING_WARNING_IDS = new Set([
  'breaker_open',
  'no_full_scan',
  'invalid_payload_spike',
]);

function resolveDashboardCandleSource(): CandleSource {
  const env = (process.env.CANDLE_FEED_SOURCE ?? '').trim().toLowerCase();
  if (
    env === 'daily' || env === 'fallback_daily' || env === 'cached_daily'
    || env === 'live_tick' || env === 'intraday'
  ) {
    return env as CandleSource;
  }
  // market_data_daily stores session bars — use daily-tolerant thresholds
  // so yesterday's close is "aging", not "stale", when the market is closed.
  return 'daily';
}

function deriveOverallStatus(
  metrics: HealthMetrics,
  alerts: Array<{ id: string; severity: string }>,
  apiSystemStatus: string,
  marketOpen: boolean,
): ReliabilityStatus {
  const criticalCount = alerts.filter((a) => a.severity === 'critical').length;
  if (criticalCount > 0 || metrics.brokerDownCount > 0 || apiSystemStatus === 'CRITICAL') {
    return 'critical';
  }

  const degradingWarnings = alerts.filter(
    (a) => a.severity === 'warning' && DEGRADING_WARNING_IDS.has(a.id),
  ).length;

  const candleDegraded =
    metrics.dataFreshnessQuality === 'frozen'
    || (metrics.dataFreshnessQuality === 'stale' && marketOpen);

  if (
    degradingWarnings > 0
    || metrics.cronFailureCount24h > 0
    || candleDegraded
    || apiSystemStatus === 'DEGRADED'
  ) {
    return 'degraded';
  }
  return 'healthy';
}

export async function collectReliabilityDashboard(): Promise<ReliabilityDashboard> {
  const snap = getMonitorSnapshot();
  const quota = {
    daily: { used: 0, limit: 0, remaining: 0, percent: 0 },
    monthly: {
      used: 0, safe_limit: 0, hard_limit: 0,
      remaining_safe: 0, remaining_hard: 0, percent: 0, percent_safe: 0,
    },
    state: 'SAFE' as 'SAFE' | 'WARNING' | 'CRITICAL' | 'BLOCKED',
    limit_near: false,
    reduce_polling: false,
    block_non_essential: false,
    block_all: false,
    resets: { daily_at: '', monthly_at: '' },
  };
  const market = getMarketStatus();
  const inst = getInstitutionalHealthSnapshot();
  const latestMs = await probeLatestCandleMs();
  const candle = classifyCandleFreshness({
    latest_candle_ms: latestMs,
    market_open: market.isOpen,
    candle_source: resolveDashboardCandleSource(),
  });

  const [
    learningRuns,
    syncLogs,
    schedRuns,
    providerLogs,
    brokerStats,
    brokerFailures24h,
    users,
    alertEval,
  ] = await Promise.all([
    fetchLearningJobRuns(7),
    fetchSyncLogs(7),
    fetchSchedulerRuns(50),
    fetchProviderHealthLogs(24),
    fetchBrokerPlatformStats(),
    countBrokerFailures24h(),
    fetchUserSummary(),
    evaluateProductionAlerts(),
  ]);

  const cronJobs = buildCronStatuses(learningRuns, syncLogs, schedRuns);
  const cronFailureCount24h = cronJobs.reduce((s, j) => s + j.failureCount24h, 0);
  const lastCronSuccess = cronJobs
    .filter((j) => j.lastStatus === 'success' && j.lastRunAt)
    .map((j) => j.lastRunAt!)
    .sort()
    .pop() ?? null;

  const apiUptimePct = snap.totalRequests > 0
    ? Number((((snap.totalRequests - snap.totalErrors) / snap.totalRequests) * 100).toFixed(2))
    : 100;

  const signalRoutes = snap.routes.filter((r) => r.route.includes('signal'));
  const signalLatencyMs = signalRoutes.length
    ? Math.round(signalRoutes.reduce((s, r) => s + r.avgLatencyMs, 0) / signalRoutes.length)
    : inst.elite?.last_run_at ? 0 : null;

  const killSwitch = isGlobalLiveKillSwitchActive();
  const brokers: BrokerPlatformStatus[] = brokerStats.length
    ? brokerStats.map((b) => ({
        broker: b.broker,
        status: b.status,
        connectedAccounts: 1,
        failureCount24h: brokerFailures24h,
        lastCheckedAt: b.checked_at,
        avgLatencyMs: b.latency_ms,
        killSwitchActive: killSwitch,
      }))
    : [{ broker: 'none', status: 'unknown', connectedAccounts: 0, failureCount24h: brokerFailures24h, lastCheckedAt: null, avgLatencyMs: null, killSwitchActive: killSwitch }];

  const brokerDownCount = brokers.filter((b) => b.status === 'down').length;

  const metrics: HealthMetrics = {
    apiUptimePct,
    apiErrorRate: Number(snap.errorRate.toFixed(4)),
    apiAvgLatencyMs: snap.avgLatencyMs,
    signalLatencyMs,
    cronFailureCount24h,
    cronLastSuccess: lastCronSuccess,
    dataFreshnessSeconds: candle.candle_age_seconds,
    dataFreshnessQuality: candle.freshness_quality,
    brokerFailureCount24h: brokerFailures24h,
    brokerDownCount,
  };

  let systemStatus = 'HEALTHY';
  if (snap.errorRate >= 0.20 || quota.state === 'BLOCKED' || quota.state === 'CRITICAL') {
    systemStatus = 'CRITICAL';
  } else if (snap.errorRate >= 0.05 || quota.state === 'WARNING') {
    systemStatus = 'DEGRADED';
  }

  const overallStatus = deriveOverallStatus(
    metrics,
    alertEval.alerts,
    systemStatus,
    market.isOpen,
  );

  const dashboard: ReliabilityDashboard = {
    generatedAt: new Date().toISOString(),
    overallStatus,
    metrics,
    cronJobs,
    dataLoaders: buildDataLoaderStatus(providerLogs, snap),
    brokers,
    signals: await buildSignalValidation(),
    strategies: await buildStrategyMonitor(),
    users,
    alerts: {
      worstSeverity: alertEval.summary.worst_severity,
      critical: alertEval.summary.critical,
      warning: alertEval.summary.warning,
      info: alertEval.summary.info,
      items: alertEval.alerts.map((a) => ({
        id: a.id,
        severity: a.severity,
        title: a.title,
        detail: a.detail,
        triggered_at: a.triggered_at,
      })),
    },
    apiHealth: {
      systemStatus,
      errorRate: metrics.apiErrorRate,
      avgLatencyMs: metrics.apiAvgLatencyMs,
      quotaState: quota.state,
      marketOpen: market.isOpen,
    },
  };

  // Persist snapshot (fire-and-forget)
  saveHealthSnapshot(overallStatus, metrics as unknown as Record<string, unknown>, alertEval.alerts).catch(() => {});

  return dashboard;
}
