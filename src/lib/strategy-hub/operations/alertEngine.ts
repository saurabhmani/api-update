// ════════════════════════════════════════════════════════════════
//  Strategy Hub alert engine (Phase 6)
// ════════════════════════════════════════════════════════════════

import { getStrategyMeta } from '@strategy-engine';
import { upsertAlert, listAlerts } from '../repository/opsAlerts';
import type { StrategyHealthSnapshot, StrategyAlert } from './types';

export async function generateAlertsFromHealth(
  snapshots: StrategyHealthSnapshot[],
): Promise<number> {
  let created = 0;
  for (const snap of snapshots) {
    if (snap.validationStatus === 'failed') {
      await upsertAlert({
        alertKey: `validation-failed:${snap.strategyId}`,
        severity: 'critical',
        strategyId: snap.strategyId,
        title: `Validation failed — ${snap.strategyName}`,
        description: snap.issues.join(' ') || 'Strategy did not pass validation.',
        suggestedAction: 'Open Validation tab, review failures, fix configuration, and revalidate.',
      });
      created += 1;
    }

    if (snap.performanceDegraded) {
      await upsertAlert({
        alertKey: `perf-degraded:${snap.strategyId}`,
        severity: 'warning',
        strategyId: snap.strategyId,
        title: `Performance degradation — ${snap.strategyName}`,
        description: `Health score ${snap.performanceHealthScore ?? '—'} below operational threshold.`,
        suggestedAction: 'Review Performance & Analytics tab and consider reducing exposure.',
      });
      created += 1;
    }

    if (snap.performanceHealthScore != null && snap.performanceHealthScore < 40) {
      await upsertAlert({
        alertKey: `drawdown-risk:${snap.strategyId}`,
        severity: 'warning',
        strategyId: snap.strategyId,
        title: `Drawdown risk — ${snap.strategyName}`,
        description: 'Strategy performance metrics indicate elevated drawdown risk.',
        suggestedAction: 'Check drawdown in analytics and validate risk parameters.',
      });
      created += 1;
    }

    if (snap.signalGenerationStatus === 'silent' && snap.currentMode === 'CONFIRMED_ENABLED') {
      await upsertAlert({
        alertKey: `missing-signals:${snap.strategyId}`,
        severity: 'warning',
        strategyId: snap.strategyId,
        title: `Missing signal generation — ${snap.strategyName}`,
        description: 'No signals generated in the last 30 days while strategy is enabled.',
        suggestedAction: 'Verify signal engine scan schedule and strategy mode/regime gates.',
      });
      created += 1;
    }

    if (snap.deploymentStatus === 'live' && snap.validationStatus !== 'ready') {
      await upsertAlert({
        alertKey: `deploy-blocked:${snap.strategyId}`,
        severity: 'critical',
        strategyId: snap.strategyId,
        title: `Live deployment risk — ${snap.strategyName}`,
        description: 'Strategy is live without a passing validation record.',
        suggestedAction: 'Run validation and review deployment lifecycle.',
      });
      created += 1;
    }

    if (snap.consecutiveFailures >= 1 && snap.validationStatus === 'failed') {
      await upsertAlert({
        alertKey: `consecutive-fail:${snap.strategyId}`,
        severity: 'critical',
        strategyId: snap.strategyId,
        title: `Execution validation failure — ${snap.strategyName}`,
        description: 'Repeated validation failures detected.',
        suggestedAction: 'Disable strategy or fix configuration before next scan.',
      });
      created += 1;
    }
  }
  return created;
}

export async function loadAlertsWithNames(opts: {
  status?: 'open' | 'acknowledged' | 'resolved' | 'all';
  strategyId?: string;
  limit?: number;
}): Promise<StrategyAlert[]> {
  const alerts = await listAlerts(opts);
  return alerts.map((a) => {
    if (!a.strategyId) return a;
    const meta = getStrategyMeta(a.strategyId);
    return { ...a, strategyName: meta.strategyName };
  });
}
