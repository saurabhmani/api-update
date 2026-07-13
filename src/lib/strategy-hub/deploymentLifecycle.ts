// ════════════════════════════════════════════════════════════════
//  Strategy Hub — deployment lifecycle (Phase 1)
//
//  Lifecycle: Draft → Validated → Paper Deployed → Live → Disabled
//  Legacy DB values (registered, staging, paper_ready) normalize on read.
// ════════════════════════════════════════════════════════════════

/** Canonical deployment lifecycle states for Strategy Hub. */
export type DeploymentLifecycle =
  | 'draft'
  | 'validated'
  | 'paper_deployed'
  | 'live'
  | 'disabled';

/** Values that may appear in strategy_hub_profiles.deployment_status. */
export type DeploymentStatus =
  | DeploymentLifecycle
  | 'registered'
  | 'staging'
  | 'paper_ready';

export const DEPLOYMENT_LIFECYCLE_ORDER: DeploymentLifecycle[] = [
  'draft',
  'validated',
  'paper_deployed',
  'live',
  'disabled',
];

const LEGACY_STATUS_MAP: Record<string, DeploymentLifecycle> = {
  registered:    'draft',
  staging:       'draft',
  paper_ready:   'validated',
  draft:         'draft',
  validated:     'validated',
  paper_deployed: 'paper_deployed',
  live:          'live',
  disabled:      'disabled',
};

/** Normalize any stored or derived status to a lifecycle value. */
export function normalizeDeploymentLifecycle(
  raw: string | null | undefined,
): DeploymentLifecycle {
  const key = String(raw ?? '').trim().toLowerCase();
  return LEGACY_STATUS_MAP[key] ?? 'draft';
}

export function isDeployedLifecycle(status: DeploymentLifecycle): boolean {
  return status === 'paper_deployed' || status === 'live';
}

export function deploymentLifecycleLabel(status: DeploymentLifecycle): string {
  switch (status) {
    case 'draft':          return 'Draft';
    case 'validated':      return 'Validated';
    case 'paper_deployed': return 'Paper Deployed';
    case 'live':           return 'Live';
    case 'disabled':       return 'Disabled';
  }
}

export type DeploymentBadgeTone = 'gray' | 'blue' | 'green' | 'orange' | 'red';

export function deploymentLifecycleTone(status: DeploymentLifecycle): DeploymentBadgeTone {
  switch (status) {
    case 'draft':          return 'gray';
    case 'validated':      return 'blue';
    case 'paper_deployed': return 'green';
    case 'live':           return 'orange';
    case 'disabled':       return 'red';
  }
}

export interface ResolveLifecycleInput {
  storedStatus?: string | null;
  readinessReady?: boolean;
  strategyModeDisabled?: boolean;
}

/**
 * Resolve the effective lifecycle for display.
 * Stored deployed/live/disabled states win; otherwise derive from readiness.
 */
export function resolveDeploymentLifecycle(input: ResolveLifecycleInput): DeploymentLifecycle {
  const normalized = normalizeDeploymentLifecycle(input.storedStatus);
  if (normalized === 'paper_deployed' || normalized === 'live' || normalized === 'disabled') {
    return normalized;
  }
  if (input.strategyModeDisabled) return 'disabled';
  if (normalized === 'validated') return 'validated';
  if (input.readinessReady) return 'validated';
  return 'draft';
}

export type DeploymentEnvironment = 'paper' | 'live';

export type DeploymentEventType =
  | 'deploy'
  | 'promote_live'
  | 'disable'
  | 'enable'
  | 'rollback';

/** Allowed transitions for explicit status updates (Phase 1). */
export function canTransition(
  from: DeploymentLifecycle,
  to: DeploymentLifecycle,
): boolean {
  if (from === to) return true;
  if (to === 'disabled') return from !== 'disabled';
  if (from === 'disabled') return to === 'draft' || to === 'validated';
  const fromIdx = DEPLOYMENT_LIFECYCLE_ORDER.indexOf(from);
  const toIdx = DEPLOYMENT_LIFECYCLE_ORDER.indexOf(to);
  if (fromIdx < 0 || toIdx < 0) return false;
  // Allow forward steps and rollback one step (live → paper_deployed).
  if (toIdx === fromIdx + 1) return true;
  if (from === 'live' && to === 'paper_deployed') return true;
  if (from === 'paper_deployed' && to === 'validated') return true;
  if (from === 'validated' && to === 'draft') return true;
  return false;
}
