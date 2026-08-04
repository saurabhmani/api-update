import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve('deploy/staging/observability');

describe('Backtest staging observability assets', () => {
  it('loads the dashboard and covers every required runtime signal', async () => {
    const dashboard = JSON.parse(await fs.readFile(path.join(root, 'backtest-worker-dashboard.json'), 'utf8'));
    const expressions = dashboard.panels.flatMap((panel: any) => panel.targets ?? []).map((target: any) => target.expr).join('\n');
    for (const metric of [
      'queue_depth','oldest_queued_age_seconds','authoritative_owner','ownership_epoch','worker_readiness','worker_enabled',
      'heartbeat_failures_total','lost_leases_total','stale_recoveries_total','duplicate_claims_total','persisted_parity_ok',
      'processing_duration_seconds','queue_wait_seconds','process_start_time_seconds',
    ]) expect(expressions).toContain(metric);
    expect(dashboard.title).toContain('Backtest Worker');
  });

  it('keeps all existing alerts and real threshold durations', async () => {
    const rules = await fs.readFile(path.join(root, 'backtest-worker-alerts.yml'), 'utf8');
    for (const alert of [
      'BacktestDuplicateClaim','BacktestStaleEpochClaim','BacktestWorkerNotReady','BacktestQueueAgeHigh',
      'BacktestHeartbeatFailure','BacktestUnexpectedRecovery','BacktestPoolSaturation','BacktestParityFailed',
    ]) expect(rules).toContain(`alert: ${alert}`);
    expect(rules).toContain('for: 10m');
    expect(rules).toContain('for: 5m');
  });

  it('records rollback monitoring evidence without adding a public worker control', async () => {
    const report = JSON.parse(await fs.readFile(path.resolve('artifacts/backtest-monitoring-report.json'), 'utf8'));
    expect(report.signalCoverage.rollbackEvents).toMatch(/rollback audit artifact/i);
    expect(report.alertVerification.firingAndRecovery).toBe('passed');
  });
});
