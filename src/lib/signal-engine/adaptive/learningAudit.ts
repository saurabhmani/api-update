// ════════════════════════════════════════════════════════════════
//  Phase 4 — Learning Audit Trail
// ════════════════════════════════════════════════════════════════

import type { AdaptiveAuditEntry } from './adaptiveParameterTypes';

const auditLog: AdaptiveAuditEntry[] = [];

export function logAdaptiveAudit(input: {
  parameterId: string;
  action: AdaptiveAuditEntry['action'];
  actor: string;
  reason: string;
  snapshotId: string | null;
  metrics: Record<string, unknown> | null;
  createdAt?: string;
}): AdaptiveAuditEntry {
  const entry: AdaptiveAuditEntry = {
    auditId: `audit_${auditLog.length + 1}_${Date.now()}`,
    parameterId: input.parameterId,
    action: input.action,
    actor: input.actor,
    reason: input.reason,
    snapshotId: input.snapshotId,
    metrics: input.metrics,
    createdAt: input.createdAt ?? new Date().toISOString(),
  };
  auditLog.push(Object.freeze(entry));
  return entry;
}

export function getAdaptiveAuditTrail(parameterId?: string): AdaptiveAuditEntry[] {
  if (!parameterId) return [...auditLog];
  return auditLog.filter((e) => e.parameterId === parameterId);
}

export function clearAdaptiveAuditTrail(): void {
  auditLog.length = 0;
}
