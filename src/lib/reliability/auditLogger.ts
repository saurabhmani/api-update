// Platform Reliability — audit logging for SRE actions

import { writeReliabilityAudit, listReliabilityAudit } from './repository/reliabilityRepository';
import type { ReliabilityAuditEntry } from './types';

export async function logReliabilityAction(input: {
  actorId?: number | null;
  actorEmail?: string | null;
  action: string;
  resource?: string | null;
  detail?: Record<string, unknown>;
  ipAddress?: string | null;
}): Promise<void> {
  await writeReliabilityAudit(input);
}

export async function getReliabilityAuditLog(limit = 100): Promise<ReliabilityAuditEntry[]> {
  return listReliabilityAudit(limit);
}
