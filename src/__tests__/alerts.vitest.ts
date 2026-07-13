import { describe, expect, it, beforeEach } from 'vitest';
import { evaluateOperationalAlerts, resetAlertCounter, countAlertsBySeverity } from '@/lib/operations/operationalAlerts';
import { buildProductionHealthSummary } from '@/lib/operations/productionHealthService';

describe('operational alerts', () => {
  beforeEach(() => resetAlertCounter());

  it('emits critical alert on database failure', () => {
    const health = buildProductionHealthSummary({
      generatedAt: '2026-01-11T00:00:00Z',
      database: { latencyMs: null, status: 'unhealthy', error: 'down' },
    });
    const alerts = evaluateOperationalAlerts({ health, generatedAt: '2026-01-11T00:00:00Z' });
    expect(alerts.some((a) => a.category === 'database_failure' && a.severity === 'critical')).toBe(true);
  });

  it('emits warning on high rejection spike', () => {
    const health = buildProductionHealthSummary({ generatedAt: '2026-01-11T00:00:00Z' });
    const alerts = evaluateOperationalAlerts({
      health,
      generatedAt: '2026-01-11T00:00:00Z',
      highRejectionRate: 0.6,
    });
    expect(alerts.some((a) => a.category === 'high_rejection_spike')).toBe(true);
  });

  it('counts alerts by severity', () => {
    const counts = countAlertsBySeverity([
      { id: '1', severity: 'critical', category: 'x', title: '', detail: '', component: '', triggeredAt: '', resolvedAt: null, context: {} },
      { id: '2', severity: 'warning', category: 'y', title: '', detail: '', component: '', triggeredAt: '', resolvedAt: null, context: {} },
    ]);
    expect(counts.critical).toBe(1);
    expect(counts.warning).toBe(1);
  });
});
