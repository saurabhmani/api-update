// Admin Dashboard — aggregate system status for acceptance APIs

import { collectReliabilityDashboard } from '@/lib/reliability';
import { evaluateProductionAlerts } from '@/lib/reliability/alertDispatcher';
import { db } from '@/lib/db';
import {
  logAdminAction,
  logApiHealth,
  logSystemHealth,
  listActiveAlerts,
  listAdminActions,
  listApiHealthLogs,
  listCronJobLogs,
  listSystemHealthLogs,
  syncCronLogsFromSources,
  upsertAlert,
  resolveAlertsExcept,
} from '../repository/adminMonitoringRepository';

export async function buildAdminDashboard(actor?: { id: number; email: string }) {
  const dash = await collectReliabilityDashboard();
  const failedJobs = dash.cronJobs.filter((j) => j.lastStatus === 'failed' || j.failureCount24h > 0);
  const dataDelays = dash.dataLoaders.filter((d) => d.circuitOpen || d.failureCount24h > 0);
  const strategyFailures = dash.strategies.staleStrategies;

  // Persist acceptance tables
  await syncCronLogsFromSources(dash.cronJobs);
  await logApiHealth({
    route: '/api/admin/dashboard',
    status: dash.apiHealth.systemStatus === 'HEALTHY' ? 'ok' : dash.apiHealth.systemStatus === 'DEGRADED' ? 'degraded' : 'fail',
    errorRate: dash.metrics.apiErrorRate,
    avgLatencyMs: dash.metrics.apiAvgLatencyMs,
    uptimePct: dash.metrics.apiUptimePct,
    quotaState: dash.apiHealth.quotaState,
    details: dash.apiHealth,
  });
  await logSystemHealth({
    overallStatus: dash.overallStatus,
    metrics: dash.metrics as unknown as Record<string, unknown>,
    dataDelaySec: dash.metrics.dataFreshnessSeconds,
    cronFailures: dash.metrics.cronFailureCount24h,
    strategyFailures,
    alertCount: dash.alerts.critical + dash.alerts.warning,
  });

  const { alerts } = await evaluateProductionAlerts();
  for (const a of alerts) {
    await upsertAlert({
      alertKey: a.id,
      severity: a.severity,
      title: a.title,
      message: a.detail,
      context: a.context,
    });
  }
  await resolveAlertsExcept(alerts.map((a) => a.id));

  if (actor) {
    await logAdminAction({
      actorId: actor.id,
      actorEmail: actor.email,
      action: 'dashboard.view',
      resource: 'admin_dashboard',
      detail: { status: dash.overallStatus },
    });
  }

  const storedAlerts = await listActiveAlerts(50);

  return {
    generatedAt: dash.generatedAt,
    systemStatus: dash.overallStatus,
    summary: {
      apiUptimePct: dash.metrics.apiUptimePct,
      signalLatencyMs: dash.metrics.signalLatencyMs,
      cronFailures24h: dash.metrics.cronFailureCount24h,
      dataFreshnessQuality: dash.metrics.dataFreshnessQuality,
      dataDelaySeconds: dash.metrics.dataFreshnessSeconds,
      brokerFailures24h: dash.metrics.brokerFailureCount24h,
      strategyFailures,
      alertCritical: dash.alerts.critical,
      alertWarning: dash.alerts.warning,
    },
    failedJobs,
    dataDelays,
    strategyFailures: {
      staleSnapshots: strategyFailures,
      activeStrategies: dash.strategies.activeStrategies,
      lastBacktestAt: dash.strategies.lastBacktestAt,
    },
    users: dash.users,
    alerts: storedAlerts,
    recentActions: await listAdminActions(10),
  };
}

export async function getCronMonitor() {
  const dash = await collectReliabilityDashboard();
  await syncCronLogsFromSources(dash.cronJobs);
  const logs = await listCronJobLogs({ limit: 100 });
  const failed = logs.filter((l) => l.status === 'failed');
  const fromDash = dash.cronJobs;

  return {
    jobs: fromDash,
    failedJobs: fromDash.filter((j) => j.lastStatus === 'failed' || j.failureCount24h > 0),
    recentLogs: logs,
    failedLogs: failed.length ? failed : logs.filter((l) => l.status === 'failed'),
    failureCount24h: dash.metrics.cronFailureCount24h,
  };
}

export async function getSignalValidation() {
  const dash = await collectReliabilityDashboard();
  let rejectionCount = 0;
  try {
    const { rows } = await db.query(`SELECT COUNT(*) AS c FROM signal_rejections WHERE created_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR)`);
    rejectionCount = Number((rows[0] as any)?.c ?? 0);
  } catch { /* optional table */ }

  return {
    ...dash.signals,
    rejectionCount24h: rejectionCount,
    alerts: dash.alerts.items.filter((a) => a.id.includes('scan') || a.id.includes('signal') || a.id.includes('elite')),
    engineHealth: dash.signals.engineHealth,
    quality: dash.signals.signalQuality,
  };
}

export async function getSystemHealthMonitor() {
  const dash = await collectReliabilityDashboard();
  await logSystemHealth({
    overallStatus: dash.overallStatus,
    metrics: {
      ...dash.metrics,
      apiHealth: dash.apiHealth,
      dataLoaders: dash.dataLoaders,
      brokers: dash.brokers,
    } as unknown as Record<string, unknown>,
    dataDelaySec: dash.metrics.dataFreshnessSeconds,
    cronFailures: dash.metrics.cronFailureCount24h,
    strategyFailures: dash.strategies.staleStrategies,
    alertCount: dash.alerts.critical + dash.alerts.warning,
  });
  await logApiHealth({
    status: dash.overallStatus === 'healthy' ? 'ok' : dash.overallStatus === 'degraded' ? 'degraded' : 'fail',
    errorRate: dash.metrics.apiErrorRate,
    avgLatencyMs: dash.metrics.apiAvgLatencyMs,
    uptimePct: dash.metrics.apiUptimePct,
    quotaState: dash.apiHealth.quotaState,
    details: { brokers: dash.brokers, dataLoaders: dash.dataLoaders },
  });

  return {
    overallStatus: dash.overallStatus,
    metrics: dash.metrics,
    apiHealth: dash.apiHealth,
    dataLoaders: dash.dataLoaders,
    dataDelays: dash.dataLoaders.filter((d) => d.circuitOpen || !d.lastSuccessAt || d.failureCount24h > 0),
    brokers: dash.brokers,
    history: await listSystemHealthLogs(30),
    apiHistory: await listApiHealthLogs(30),
  };
}

export async function getAlertCenter() {
  const { alerts, summary } = await evaluateProductionAlerts();
  for (const a of alerts) {
    await upsertAlert({
      alertKey: a.id,
      severity: a.severity,
      title: a.title,
      message: a.detail,
      context: a.context,
    });
  }
  await resolveAlertsExcept(alerts.map((a) => a.id));
  const stored = await listActiveAlerts(100);
  return {
    summary,
    liveAlerts: alerts,
    storedAlerts: stored,
    critical: stored.filter((a) => a.severity === 'critical'),
    warning: stored.filter((a) => a.severity === 'warning'),
  };
}
