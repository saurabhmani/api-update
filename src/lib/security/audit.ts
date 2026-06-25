// Security audit logging

import { writeSecurityAudit, listSecurityAudit } from './repository/securityRepository';

export type SecurityEventType =
  | 'auth'
  | 'mfa'
  | 'session'
  | 'rbac'
  | 'consent'
  | 'secret'
  | 'rate_limit'
  | 'compliance';

export async function logSecurityEvent(input: {
  userId?: number;
  actorEmail?: string;
  eventType: SecurityEventType;
  action: string;
  resource?: string;
  detail?: Record<string, unknown>;
  ipAddress?: string;
}): Promise<void> {
  await writeSecurityAudit(input);
}

export async function getSecurityAuditLog(opts?: {
  userId?: number;
  limit?: number;
}) {
  return listSecurityAudit(opts);
}
