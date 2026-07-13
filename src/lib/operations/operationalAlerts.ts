// ════════════════════════════════════════════════════════════════
//  Phase 5 — Operational Alerts (alerts only — no auto-modify)
// ════════════════════════════════════════════════════════════════

import type { ProductionHealthSummary } from './types';
import type { OperationalAlert, AlertSeverity } from './types';

export interface AlertEvaluationContext {
  health: ProductionHealthSummary;
  previousAlerts?: OperationalAlert[];
  generatedAt: string;
  highRejectionRate?: number;
  confidenceDriftDetected?: boolean;
}

let alertCounter = 0;

function makeAlert(input: Omit<OperationalAlert, 'id' | 'resolvedAt'>): OperationalAlert {
  alertCounter += 1;
  return { ...input, id: `ops_alert_${alertCounter}`, resolvedAt: null };
}

function resolvedAlert(
  prior: OperationalAlert,
  generatedAt: string,
): OperationalAlert {
  return { ...prior, severity: 'resolved', resolvedAt: generatedAt };
}

/** Pure alert evaluation — no side effects, no notifications. */
export function evaluateOperationalAlerts(ctx: AlertEvaluationContext): OperationalAlert[] {
  const alerts: OperationalAlert[] = [];
  const { health, generatedAt } = ctx;

  for (const component of health.components) {
    if (component.component === 'scheduler_jobs' && component.failureCount24h > 0) {
      alerts.push(makeAlert({
        severity: 'critical',
        category: 'scheduler_failure',
        title: 'Scheduler job failure',
        detail: component.message ?? 'One or more scheduler jobs failed in the last 24h',
        component: component.component,
        triggeredAt: generatedAt,
        context: { failureCount24h: component.failureCount24h },
      }));
    }

    if (component.component === 'market_data' && component.status === 'unhealthy') {
      alerts.push(makeAlert({
        severity: 'critical',
        category: 'market_feed_outage',
        title: 'Market feed outage',
        detail: component.message ?? 'Market data unavailable or stale',
        component: component.component,
        triggeredAt: generatedAt,
        context: { lastSuccessAt: component.lastSuccessAt },
      }));
    }

    if (component.component === 'database' && component.status === 'unhealthy') {
      alerts.push(makeAlert({
        severity: 'critical',
        category: 'database_failure',
        title: 'Database connectivity failure',
        detail: component.message ?? 'Database probe failed',
        component: component.component,
        triggeredAt: generatedAt,
        context: {},
      }));
    }

    if (component.component === 'adaptive_pipeline' && component.failureCount24h > 0) {
      alerts.push(makeAlert({
        severity: 'warning',
        category: 'adaptive_promotion_failure',
        title: 'Adaptive pipeline failure',
        detail: 'runAdaptiveLearningPipeline reported failure',
        component: component.component,
        triggeredAt: generatedAt,
        context: component.metadata,
      }));
    }

    if (component.component === 'report_generation' && component.status === 'degraded') {
      alerts.push(makeAlert({
        severity: 'warning',
        category: 'report_generation_failure',
        title: 'Report generation degraded',
        detail: 'Reports directory or generation path unavailable',
        component: component.component,
        triggeredAt: generatedAt,
        context: {},
      }));
    }
  }

  if (ctx.highRejectionRate != null && ctx.highRejectionRate > 0.5) {
    alerts.push(makeAlert({
      severity: 'warning',
      category: 'high_rejection_spike',
      title: 'High rejection rate spike',
      detail: `Rejection rate ${(ctx.highRejectionRate * 100).toFixed(1)}% exceeds threshold`,
      component: 'signal_generation',
      triggeredAt: generatedAt,
      context: { rejectionRate: ctx.highRejectionRate },
    }));
  }

  if (ctx.confidenceDriftDetected) {
    alerts.push(makeAlert({
      severity: 'warning',
      category: 'confidence_drift',
      title: 'Confidence calibration drift',
      detail: 'Confidence drift alert from adaptive monitoring',
      component: 'adaptive_pipeline',
      triggeredAt: generatedAt,
      context: {},
    }));
  }

  const snapshotFailed = health.components.find(
    (c) => c.component === 'scheduler_jobs'
      && (c.metadata as Record<string, unknown>)?.snapshotFailed === true,
  );
  if (snapshotFailed) {
    alerts.push(makeAlert({
      severity: 'warning',
      category: 'snapshot_failure',
      title: 'Learning snapshot failure',
      detail: 'Versioned learning snapshot job failed',
      component: 'scheduler_jobs',
      triggeredAt: generatedAt,
      context: {},
    }));
  }

  if (ctx.previousAlerts?.length) {
    const activeCategories = new Set(alerts.map((a) => a.category));
    for (const prior of ctx.previousAlerts) {
      if (prior.severity !== 'resolved' && !activeCategories.has(prior.category)) {
        alerts.push(resolvedAlert(prior, generatedAt));
      }
    }
  }

  return alerts;
}

export function countAlertsBySeverity(
  alerts: readonly OperationalAlert[],
): Record<AlertSeverity, number> {
  const counts: Record<AlertSeverity, number> = { warning: 0, critical: 0, resolved: 0 };
  for (const a of alerts) counts[a.severity] += 1;
  return counts;
}

export function resetAlertCounter(): void {
  alertCounter = 0;
}
