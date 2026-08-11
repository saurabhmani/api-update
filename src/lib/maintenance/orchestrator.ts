import { logger } from '@/lib/logger';
import type {
  JobRunStore, MaintenanceRunRecord, MaintenanceStage, MaintenanceStageName, StageResult,
} from './types';

const log = logger.child({ component: 'daily-maintenance-orchestrator' });
const DEFAULT_STALE_MS = 45 * 60_000;

export interface OrchestratorOptions {
  store: JobRunStore;
  stages: MaintenanceStage[];
  staleAfterMs?: number;
  retryDelayMs?: number;
  runIdFactory?: () => string;
}

export interface OrchestrationResult {
  tradingDate: string;
  runId: string;
  status: 'succeeded' | 'partial' | 'failed' | 'busy';
  stages: MaintenanceRunRecord[];
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function validateMaintenanceDag(stages: MaintenanceStage[]): void {
  const names = new Set(stages.map((stage) => stage.name));
  if (names.size !== stages.length) throw new Error('Duplicate maintenance stage name');
  const visited = new Set<MaintenanceStageName>();
  for (const stage of stages) {
    for (const dependency of stage.dependencies) {
      if (!names.has(dependency)) throw new Error(`${stage.name}: unknown dependency ${dependency}`);
      if (!visited.has(dependency)) throw new Error(`${stage.name}: dependency ${dependency} must precede it`);
    }
    visited.add(stage.name);
  }
}

export async function runMaintenanceForDate(
  tradingDate: string,
  options: OrchestratorOptions,
): Promise<OrchestrationResult> {
  validateMaintenanceDag(options.stages);
  const runId = options.runIdFactory?.() ?? `maint-${tradingDate}-${Date.now().toString(36)}`;
  const outcomes = new Map<MaintenanceStageName, MaintenanceRunRecord>();
  let sawBusy = false;

  for (const stage of options.stages) {
    const dependencies = stage.dependencies.map((name) => outcomes.get(name)).filter(Boolean) as MaintenanceRunRecord[];
    const blockedBy = dependencies.find((row) => row.status !== 'succeeded');
    if (blockedBy) {
      const reason = `dependency ${blockedBy.jobName} is ${blockedBy.status}`;
      await options.store.skip({ runId, jobName: stage.name, tradingDate, reason,
        dependencyRunIds: dependencies.map((row) => row.runId) });
      outcomes.set(stage.name, { runId, jobName: stage.name, tradingDate, status: 'skipped', retryCount: 0, lastError: reason });
      continue;
    }

    const claim = await options.store.claim({ runId, jobName: stage.name, tradingDate,
      staleAfterMs: options.staleAfterMs ?? DEFAULT_STALE_MS });
    if (claim === 'completed') {
      outcomes.set(stage.name, { runId, jobName: stage.name, tradingDate, status: 'succeeded', retryCount: 0 });
      continue;
    }
    if (claim === 'busy') {
      sawBusy = true;
      outcomes.set(stage.name, { runId, jobName: stage.name, tradingDate, status: 'running', retryCount: 0 });
      break;
    }

    const maxAttempts = Math.max(1, stage.maxAttempts ?? 3);
    let final: StageResult | null = null;
    let error = '';
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const started = Date.now();
      try {
        final = await stage.run({ tradingDate, runId, attempt });
        log.info('maintenance stage complete', { runId, tradingDate, stage: stage.name,
          attempt, status: final.status, durationMs: Date.now() - started, counts: final.counts });
        break;
      } catch (cause) {
        error = cause instanceof Error ? cause.message : String(cause);
        log.warn('maintenance stage attempt failed', { runId, tradingDate, stage: stage.name,
          attempt, maxAttempts, durationMs: Date.now() - started, error });
        if (attempt < maxAttempts) await delay((options.retryDelayMs ?? 1_000) * attempt);
      }
    }

    const dependencyRunIds = dependencies.map((row) => row.runId);
    if (!final) {
      await options.store.fail({ runId, jobName: stage.name, tradingDate, error,
        retryCount: maxAttempts - 1, dependencyRunIds });
      outcomes.set(stage.name, { runId, jobName: stage.name, tradingDate, status: 'failed',
        retryCount: maxAttempts - 1, lastError: error });
      continue;
    }
    await options.store.finish({ runId, jobName: stage.name, tradingDate, result: final, dependencyRunIds });
    outcomes.set(stage.name, { runId, jobName: stage.name, tradingDate, status: final.status,
      retryCount: 0, lastError: final.reason });
  }

  const stages = Array.from(outcomes.values());
  const status = sawBusy ? 'busy'
    : stages.some((stage) => stage.status === 'failed') ? 'failed'
    : stages.some((stage) => stage.status === 'partial' || stage.status === 'skipped') ? 'partial'
    : 'succeeded';
  return { tradingDate, runId, status, stages };
}
