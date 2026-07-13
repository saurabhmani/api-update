// ════════════════════════════════════════════════════════════════
//  Strategy Hub — deployment lifecycle service (Phase 1)
// ════════════════════════════════════════════════════════════════

import { getRegistryEntry } from '../registry';
import { assessPaperTradingReadiness } from './paperTradingReadiness';
import { ACTIVE_RUNNER_STRATEGIES } from '../registry';
import {
  normalizeDeploymentLifecycle,
  resolveDeploymentLifecycle,
  type DeploymentEnvironment,
  type DeploymentLifecycle,
} from '../deploymentLifecycle';
import {
  listDeployedStrategiesForUser,
  listDeploymentHistory,
  loadStrategyProfile,
  recordDeploymentHistory,
  upsertStrategyProfile,
} from '../repository/strategyProfiles';
import type { DeploymentHistoryRow, DeployedStrategyRow } from '../types';

export interface DeploymentTransitionResult {
  ok: boolean;
  strategyId: string;
  fromStatus: DeploymentLifecycle;
  toStatus: DeploymentLifecycle;
  profileUpdated: boolean;
}

export interface DeployedStrategySummary extends DeployedStrategyRow {
  displayName: string;
  category: string;
  deploymentLifecycle: DeploymentLifecycle;
}

export interface DeploymentAuditEntry extends DeploymentHistoryRow {
  displayName: string;
  lifecycleLabel: string;
}

export async function getEffectiveLifecycle(strategyId: string): Promise<DeploymentLifecycle> {
  const entry = getRegistryEntry(strategyId);
  const profile = await loadStrategyProfile(strategyId);
  const readiness = assessPaperTradingReadiness(strategyId, {
    hasEvaluator: entry ? ACTIVE_RUNNER_STRATEGIES.has(entry.strategyId) : false,
    isActiveInRunner: entry ? ACTIVE_RUNNER_STRATEGIES.has(entry.strategyId) : false,
    profile,
  });
  return resolveDeploymentLifecycle({
    storedStatus: profile?.deployment_status,
    readinessReady: readiness.ready,
    strategyModeDisabled: entry?.strategyMode === 'DISABLED',
  });
}

export async function transitionDeploymentStatus(opts: {
  strategyId: string;
  userId: number;
  toStatus: DeploymentLifecycle;
  environment: DeploymentEnvironment;
  eventType: 'deploy' | 'promote_live' | 'disable' | 'enable' | 'rollback';
  actor?: string;
  details?: Record<string, unknown>;
  paperTradingEnabled?: boolean;
}): Promise<DeploymentTransitionResult> {
  const profile = await loadStrategyProfile(opts.strategyId);
  const entry = getRegistryEntry(opts.strategyId);
  const readiness = assessPaperTradingReadiness(opts.strategyId, {
    hasEvaluator: entry ? ACTIVE_RUNNER_STRATEGIES.has(entry.strategyId) : false,
    isActiveInRunner: entry ? ACTIVE_RUNNER_STRATEGIES.has(entry.strategyId) : false,
    profile,
  });
  const fromStatus = resolveDeploymentLifecycle({
    storedStatus: profile?.deployment_status,
    readinessReady: readiness.ready,
    strategyModeDisabled: entry?.strategyMode === 'DISABLED',
  });

  await upsertStrategyProfile(opts.strategyId, {
    deployment_status: opts.toStatus,
    paper_trading_enabled: opts.paperTradingEnabled ?? (
      opts.toStatus === 'paper_deployed' || opts.toStatus === 'live'
    ),
    notes: opts.toStatus === 'paper_deployed'
      ? `Paper deployed by ${opts.actor ?? 'system'}`
      : opts.toStatus === 'live'
        ? `Live deployed by ${opts.actor ?? 'system'}`
        : undefined,
  });

  await recordDeploymentHistory({
    strategyId: opts.strategyId,
    userId: opts.userId,
    fromStatus,
    toStatus: opts.toStatus,
    environment: opts.environment,
    eventType: opts.eventType,
    actor: opts.actor ?? null,
    details: opts.details ?? null,
  });

  return {
    ok: true,
    strategyId: opts.strategyId,
    fromStatus,
    toStatus: opts.toStatus,
    profileUpdated: true,
  };
}

export async function markPaperDeployed(
  userId: number,
  strategyId: string,
  actor: string,
  accountId?: string,
): Promise<DeploymentTransitionResult> {
  return transitionDeploymentStatus({
    strategyId,
    userId,
    toStatus: 'paper_deployed',
    environment: 'paper',
    eventType: 'deploy',
    actor,
    paperTradingEnabled: true,
    details: { deployment: 'paper', accountId: accountId ?? null },
  });
}

export async function markLiveDeployed(
  userId: number,
  strategyId: string,
  actor: string,
  accountId?: string,
): Promise<DeploymentTransitionResult> {
  return transitionDeploymentStatus({
    strategyId,
    userId,
    toStatus: 'live',
    environment: 'live',
    eventType: 'promote_live',
    actor,
    paperTradingEnabled: true,
    details: { deployment: 'live', accountId: accountId ?? null },
  });
}

export async function loadDeployedStrategySummaries(
  userId: number,
): Promise<DeployedStrategySummary[]> {
  const rows = await listDeployedStrategiesForUser(userId);
  return rows.map((row) => {
    const entry = getRegistryEntry(row.strategy_id);
    const lifecycle = normalizeDeploymentLifecycle(row.deployment_status);
    return {
      ...row,
      displayName: entry?.displayName ?? row.strategy_id.replace(/_/g, ' '),
      category: entry?.category ?? 'unknown',
      deploymentLifecycle: lifecycle,
    };
  });
}

export async function loadDeploymentAuditLog(opts: {
  userId: number;
  strategyId?: string;
  limit?: number;
}): Promise<DeploymentAuditEntry[]> {
  const rows = await listDeploymentHistory(opts);
  return rows.map((row) => {
    const entry = getRegistryEntry(row.strategy_id);
    const lifecycle = normalizeDeploymentLifecycle(row.to_status);
    return {
      ...row,
      displayName: entry?.displayName ?? row.strategy_id.replace(/_/g, ' '),
      lifecycleLabel: lifecycle.replace(/_/g, ' '),
    };
  });
}

/** Sync profile to validated when readiness passes and not yet deployed. */
export async function ensureValidatedProfile(strategyId: string): Promise<void> {
  const entry = getRegistryEntry(strategyId);
  if (!entry) return;
  const profile = await loadStrategyProfile(strategyId);
  const current = normalizeDeploymentLifecycle(profile?.deployment_status);
  if (current === 'paper_deployed' || current === 'live' || current === 'disabled') return;

  const readiness = assessPaperTradingReadiness(strategyId, {
    hasEvaluator: ACTIVE_RUNNER_STRATEGIES.has(entry.strategyId),
    isActiveInRunner: ACTIVE_RUNNER_STRATEGIES.has(entry.strategyId),
    profile,
  });
  if (!readiness.ready) return;

  if (current !== 'validated') {
    await upsertStrategyProfile(strategyId, {
      deployment_status: 'validated',
      paper_trading_enabled: true,
    });
  }
}
