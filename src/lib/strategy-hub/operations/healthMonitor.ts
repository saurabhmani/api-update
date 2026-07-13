// ════════════════════════════════════════════════════════════════
//  Per-strategy health monitoring (Phase 6)
// ════════════════════════════════════════════════════════════════

import { db } from '@/lib/db';
import { getStrategyMeta } from '@/lib/signal-engine/strategies/strategyRegistry';
import { resolveEffectiveStrategyMode } from '@/lib/signal-engine/strategies/strategyModePolicy';
import { listRegistryStrategyIds, ACTIVE_RUNNER_STRATEGIES } from '../registry';
import { loadAllStrategyProfiles } from '../repository/strategyProfiles';
import { extractModeOverride } from '../services/strategyModeOverrides';
import { loadAllStrategyMetrics } from '../services/strategyMetricsService';
import { ensureStrategyHubTables } from '../repository/strategyHubSchema';
import type { StrategyHealthSnapshot, StrategyHealthStatus } from './types';

interface SignalActivityRow {
  strategy_id: string;
  last_signal: string;
  signal_count: number;
  approved_count: number;
}

interface LatestValidationRow {
  strategy_id: string;
  overall_status: string;
  validation_score: number;
  created_at: string;
}

async function loadSignalActivity(): Promise<Map<string, SignalActivityRow>> {
  const map = new Map<string, SignalActivityRow>();
  try {
    const { rows } = await db.query<SignalActivityRow>(
      `SELECT signal_type AS strategy_id,
              MAX(generated_at) AS last_signal,
              COUNT(*) AS signal_count,
              SUM(CASE WHEN classification IN ('APPROVED','APPROVED_SIGNAL')
                        OR status = 'APPROVED_SIGNAL' THEN 1 ELSE 0 END) AS approved_count
         FROM q365_signals
        WHERE generated_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)
        GROUP BY signal_type`,
    );
    for (const row of rows ?? []) map.set(row.strategy_id, row);
  } catch { /* table may be absent */ }
  return map;
}

async function loadLatestValidations(): Promise<Map<string, LatestValidationRow>> {
  await ensureStrategyHubTables();
  const map = new Map<string, LatestValidationRow>();
  try {
    const { rows } = await db.query<LatestValidationRow>(
      `SELECT v.strategy_id, v.overall_status, v.validation_score, v.created_at
         FROM strategy_hub_validation_history v
         INNER JOIN (
           SELECT strategy_id, MAX(created_at) AS max_at
             FROM strategy_hub_validation_history
            GROUP BY strategy_id
         ) latest ON latest.strategy_id = v.strategy_id AND latest.max_at = v.created_at`,
    );
    for (const row of rows ?? []) map.set(row.strategy_id, row);
  } catch { /* non-fatal */ }
  return map;
}

function hoursSince(iso: string | null): number | null {
  if (!iso) return null;
  const ms = Date.now() - new Date(iso).getTime();
  return Number.isFinite(ms) ? ms / 3_600_000 : null;
}

function deriveHealthStatus(input: {
  mode: string;
  validationStatus: string | null;
  perfScore: number | null;
  signalAgeH: number | null;
  consecutiveFailures: number;
  deploymentStatus: string;
  isRunner: boolean;
}): StrategyHealthStatus {
  if (input.mode === 'DISABLED') return 'offline';
  if (input.validationStatus === 'failed' || input.consecutiveFailures >= 3) return 'critical';
  if (!input.isRunner && input.mode !== 'CONFIRMED_ENABLED') return 'offline';
  if (
    input.validationStatus === 'warning'
    || (input.perfScore != null && input.perfScore < 45)
    || (input.signalAgeH != null && input.signalAgeH > 168)
    || input.consecutiveFailures >= 1
  ) return 'warning';
  return 'healthy';
}

function computeHealthScore(input: {
  status: StrategyHealthStatus;
  perfScore: number | null;
  validationScore: number | null;
  approvalRate: number;
  signalAgeH: number | null;
}): number {
  let score = 50;
  if (input.status === 'healthy') score += 25;
  else if (input.status === 'warning') score += 5;
  else if (input.status === 'critical') score -= 15;
  else score -= 30;

  if (input.perfScore != null) score += (input.perfScore - 50) * 0.3;
  if (input.validationScore != null) score += (input.validationScore - 60) * 0.2;
  score += Math.min(10, input.approvalRate * 0.1);
  if (input.signalAgeH != null && input.signalAgeH < 48) score += 5;
  if (input.signalAgeH != null && input.signalAgeH > 168) score -= 10;
  return Math.max(0, Math.min(100, Math.round(score)));
}

export async function loadStrategyHealthSnapshots(): Promise<StrategyHealthSnapshot[]> {
  const ids = listRegistryStrategyIds();
  const [profiles, metricsMap, signalActivity, validations] = await Promise.all([
    loadAllStrategyProfiles(),
    loadAllStrategyMetrics('90D'),
    loadSignalActivity(),
    loadLatestValidations(),
  ]);

  const runnerSet = new Set(ACTIVE_RUNNER_STRATEGIES);

  return ids.map((strategyId) => {
    const meta = getStrategyMeta(strategyId);
    const profile = profiles.get(strategyId);
    const metrics = metricsMap.get(strategyId);
    const activity = signalActivity.get(strategyId);
    const validation = validations.get(strategyId);
    const override = extractModeOverride(profile?.metadata_json);
    const mode = resolveEffectiveStrategyMode(strategyId, undefined, override);
    const deploymentStatus = profile?.deployment_status ?? 'draft';
    const isRunner = runnerSet.has(strategyId as never);

    const signalCount = Number(activity?.signal_count ?? 0);
    const approvedCount = Number(activity?.approved_count ?? 0);
    const approvalRate = signalCount > 0 ? Math.round((approvedCount / signalCount) * 100) : 0;
    const signalAgeH = hoursSince(activity?.last_signal ?? null);

    let signalGenerationStatus: StrategyHealthSnapshot['signalGenerationStatus'] = 'silent';
    if (mode === 'DISABLED') signalGenerationStatus = 'offline';
    else if (signalAgeH != null && signalAgeH < 48) signalGenerationStatus = 'active';
    else if (signalAgeH != null && signalAgeH < 168) signalGenerationStatus = 'stale';

    const perfScore = metrics?.healthScore ?? null;
    const validationStatus = validation?.overall_status ?? null;
    const consecutiveFailures = validationStatus === 'failed' ? 1 : 0;
    const performanceDegraded = perfScore != null && perfScore < 50;

    const issues: string[] = [];
    if (validationStatus === 'failed') issues.push('Latest validation failed.');
    if (performanceDegraded) issues.push('Performance health score below threshold.');
    if (signalGenerationStatus === 'stale') issues.push('No recent signal generation.');
    if (signalGenerationStatus === 'silent' && mode !== 'DISABLED') issues.push('Strategy has been silent in the last 30 days.');
    if (deploymentStatus === 'live' && validationStatus !== 'ready') {
      issues.push('Live deployment without passing validation.');
    }

    const healthStatus = deriveHealthStatus({
      mode,
      validationStatus,
      perfScore,
      signalAgeH,
      consecutiveFailures,
      deploymentStatus,
      isRunner,
    });

    return {
      strategyId,
      strategyName: meta.strategyName,
      healthStatus,
      healthScore: computeHealthScore({
        status: healthStatus,
        perfScore,
        validationScore: validation?.validation_score ?? null,
        approvalRate,
        signalAgeH,
      }),
      lastSuccessfulExecution: activity?.last_signal ?? null,
      lastFailedExecution: validationStatus === 'failed' ? validation?.created_at ?? null : null,
      consecutiveFailures,
      runtimeErrors: 0,
      signalGenerationStatus,
      approvalRateTrend: 'flat',
      approvalRate,
      validationStatus,
      validationScore: validation?.validation_score ?? null,
      lastValidationAt: validation?.created_at ?? null,
      deploymentStatus,
      currentMode: mode,
      performanceDegraded,
      performanceHealthScore: perfScore,
      isActiveInRunner: isRunner && mode === 'CONFIRMED_ENABLED',
      issues,
    };
  });
}

export function summarizeHealth(snapshots: StrategyHealthSnapshot[]) {
  return {
    activeStrategies: snapshots.filter((s) => s.currentMode === 'CONFIRMED_ENABLED').length,
    healthyStrategies: snapshots.filter((s) => s.healthStatus === 'healthy').length,
    warningStrategies: snapshots.filter((s) => s.healthStatus === 'warning').length,
    criticalStrategies: snapshots.filter((s) => s.healthStatus === 'critical').length,
    disabledStrategies: snapshots.filter((s) => s.currentMode === 'DISABLED').length,
    paperDeployed: snapshots.filter((s) => s.deploymentStatus === 'paper_deployed').length,
    liveDeployed: snapshots.filter((s) => s.deploymentStatus === 'live').length,
    failedValidations: snapshots.filter((s) => s.validationStatus === 'failed').length,
  };
}
