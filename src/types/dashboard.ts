/** Canonical signal-engine health statuses used by the Command Center. */
export type EngineHealthStatus =
  | 'HEALTHY'
  | 'WARNING'
  | 'PARTIAL'
  | 'DEGRADED'
  | 'TIMEOUT'
  | 'BROKEN'
  | 'AUTH_REQUIRED'
  | 'UNKNOWN'
  | 'PENDING';

/** Operator-facing intelligence mode surfaced in the dashboard header. */
export type IntelligenceMode =
  | 'MONITORING'
  | 'OPERATIONAL'
  | 'PARTIAL'
  | 'RECOVERY'
  | 'PENDING';

export type IntelligenceModeLabel =
  | 'Monitoring Mode'
  | 'Full Intelligence Mode'
  | 'Partial Intelligence Mode'
  | 'Recovery Mode'
  | 'Standby';

export const INTELLIGENCE_MODE_LABELS: Record<IntelligenceMode, IntelligenceModeLabel> = {
  MONITORING:  'Monitoring Mode',
  OPERATIONAL: 'Full Intelligence Mode',
  PARTIAL:     'Partial Intelligence Mode',
  RECOVERY:    'Recovery Mode',
  PENDING:     'Standby',
};

/** Wire-level fusion statuses emitted by /api/dashboard modules. */
export type FusionStatus =
  | 'HEALTHY'
  | 'WARNING'
  | 'PARTIAL'
  | 'STALE'
  | 'DEGRADED'
  | 'TIMEOUT'
  | 'BROKEN'
  | 'AUTH_REQUIRED'
  | 'NOT_CONFIGURED'
  | 'INSUFFICIENT_DATA'
  | 'RUNNING'
  | 'UNKNOWN';

const ENGINE_HEALTH_STATUSES = new Set<EngineHealthStatus>([
  'HEALTHY',
  'WARNING',
  'PARTIAL',
  'DEGRADED',
  'TIMEOUT',
  'BROKEN',
  'AUTH_REQUIRED',
  'UNKNOWN',
  'PENDING',
]);

/** Map aggregator fusion status into the strict engine-health union. */
export function normalizeEngineHealthStatus(
  status: FusionStatus | EngineHealthStatus | string,
): EngineHealthStatus {
  if (ENGINE_HEALTH_STATUSES.has(status as EngineHealthStatus)) {
    return status as EngineHealthStatus;
  }
  return 'UNKNOWN';
}

/**
 * Derive the operator-facing intelligence mode from market session
 * and engine health. Priority: critical failure → market closed →
 * healthy → degraded → standby.
 */
export function getIntelligenceMode(
  marketOpen: boolean,
  status: EngineHealthStatus,
): IntelligenceMode {
  // 1. Critical engine failure
  if (status === 'BROKEN' || status === 'AUTH_REQUIRED') {
    return 'RECOVERY';
  }

  // 2. Market closed
  if (!marketOpen) {
    return 'MONITORING';
  }

  // 3. Healthy engine during market open
  if (status === 'HEALTHY') {
    return 'OPERATIONAL';
  }

  // 4. Non-critical degraded engine states
  if (
    status === 'WARNING'
    || status === 'PARTIAL'
    || status === 'DEGRADED'
    || status === 'TIMEOUT'
  ) {
    return 'PARTIAL';
  }

  // 5. Unknown / initializing / any other status
  return 'PENDING';
}

export interface EngineHealthCheckResult {
  healthy: boolean;
  message?: string;
  status:  EngineHealthStatus;
  mode:    IntelligenceMode;
}

/** Map probe status + market session to a simple healthy / message pair. */
export function resolveEngineHealthCheck(
  marketOpen: boolean,
  status: EngineHealthStatus,
  detail?: string | null,
): EngineHealthCheckResult {
  const mode = getIntelligenceMode(marketOpen, status);
  const healthy = mode === 'OPERATIONAL' || mode === 'MONITORING';

  if (healthy) {
    return { healthy: true, status, mode };
  }

  const trimmed = detail?.trim();
  return {
    healthy: false,
    message: trimmed || INTELLIGENCE_MODE_LABELS[mode],
    status,
    mode,
  };
}
