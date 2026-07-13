// ════════════════════════════════════════════════════════════════
//  Strategy Hub — mode management service (Phase 2)
// ════════════════════════════════════════════════════════════════

import { STRATEGY_REGISTRY } from '@/lib/signal-engine/strategies/strategyRegistry';
import { resolveEffectiveStrategyMode } from '@/lib/signal-engine/strategies/strategyModePolicy';
import type { StrategyMode, StrategyName } from '@/lib/signal-engine/types/signalEngine.types';
import { ACTIVE_RUNNER_STRATEGIES, getRegistryEntry, listRegistryStrategyIds } from '../registry';
import {
  loadStrategyProfile,
  loadAllStrategyProfiles,
  upsertStrategyProfile,
} from '../repository/strategyProfiles';
import { listModeHistory, recordModeHistory } from '../repository/modeHistory';
import {
  extractModeOverride,
  invalidateStrategyModeOverrides,
  isValidStrategyMode,
  loadStrategyModeOverrides,
  syncStrategyModesForSignalEngine,
} from './strategyModeOverrides';
import type {
  StrategyManagementStatus,
  StrategyModeChangeSource,
  StrategyModeHistoryRow,
} from '../types';

export interface ModeChangeResult {
  ok: boolean;
  strategyId: string;
  fromMode: StrategyMode;
  toMode: StrategyMode;
  effectiveMode: StrategyMode;
  changed: boolean;
  error?: string;
}

export interface BulkModeChangeResult {
  ok: boolean;
  results: ModeChangeResult[];
  updated: number;
  failed: number;
  sync: { overrideCount: number; syncedAt: string };
}

function registryBaseMode(strategyId: string): StrategyMode | null {
  const entry = getRegistryEntry(strategyId);
  return entry?.strategyMode ?? null;
}

function currentStoredOrRegistryMode(
  strategyId: string,
  metadata: Record<string, unknown> | null | undefined,
): StrategyMode {
  const override = extractModeOverride(metadata);
  if (override) return override;
  return registryBaseMode(strategyId) ?? 'CONFIRMED_ENABLED';
}

function mergeModeMetadata(
  existing: Record<string, unknown> | null | undefined,
  toMode: StrategyMode,
  actor: string,
  reason?: string | null,
): Record<string, unknown> {
  return {
    ...(existing ?? {}),
    strategyModeOverride: toMode,
    strategyModeOverrideReason: reason ?? null,
    strategyModeOverriddenBy: actor,
    strategyModeOverriddenAt: new Date().toISOString(),
  };
}

export async function setStrategyMode(opts: {
  strategyId: string;
  mode: StrategyMode;
  userId: number;
  actor: string;
  reason?: string | null;
  source?: StrategyModeChangeSource;
}): Promise<ModeChangeResult> {
  if (!isValidStrategyMode(opts.mode)) {
    return {
      ok: false,
      strategyId: opts.strategyId,
      fromMode: 'CONFIRMED_ENABLED',
      toMode: opts.mode,
      effectiveMode: opts.mode,
      changed: false,
      error: `Invalid strategy mode: ${opts.mode}`,
    };
  }

  const entry = getRegistryEntry(opts.strategyId);
  if (!entry) {
    return {
      ok: false,
      strategyId: opts.strategyId,
      fromMode: 'CONFIRMED_ENABLED',
      toMode: opts.mode,
      effectiveMode: opts.mode,
      changed: false,
      error: `Unknown strategy: ${opts.strategyId}`,
    };
  }

  // EXPERIMENTAL is supported by policy but not exposed as a primary admin target.
  const manageable = opts.mode === 'CONFIRMED_ENABLED'
    || opts.mode === 'WATCHLIST_ONLY'
    || opts.mode === 'DISABLED'
    || opts.mode === 'EXPERIMENTAL';
  if (!manageable) {
    return {
      ok: false,
      strategyId: opts.strategyId,
      fromMode: entry.strategyMode,
      toMode: opts.mode,
      effectiveMode: entry.strategyMode,
      changed: false,
      error: `Mode not manageable: ${opts.mode}`,
    };
  }

  const profile = await loadStrategyProfile(opts.strategyId);
  const fromMode = currentStoredOrRegistryMode(opts.strategyId, profile?.metadata_json);

  if (fromMode === opts.mode) {
    const effectiveMode = resolveEffectiveStrategyMode(opts.strategyId, undefined, opts.mode);
    return {
      ok: true,
      strategyId: opts.strategyId,
      fromMode,
      toMode: opts.mode,
      effectiveMode,
      changed: false,
    };
  }

  const metadata = mergeModeMetadata(
    profile?.metadata_json,
    opts.mode,
    opts.actor,
    opts.reason,
  );

  await upsertStrategyProfile(opts.strategyId, { metadata_json: metadata });

  await recordModeHistory({
    strategyId: opts.strategyId,
    userId: opts.userId,
    fromMode,
    toMode: opts.mode,
    reason: opts.reason ?? null,
    source: opts.source ?? 'ui',
    actor: opts.actor,
    details: {
      registryDefault: entry.strategyMode,
      deploymentStatus: profile?.deployment_status ?? null,
    },
  });

  invalidateStrategyModeOverrides();
  await loadStrategyModeOverrides(true);

  const effectiveMode = resolveEffectiveStrategyMode(opts.strategyId, undefined, opts.mode);
  return {
    ok: true,
    strategyId: opts.strategyId,
    fromMode,
    toMode: opts.mode,
    effectiveMode,
    changed: true,
  };
}

export async function bulkSetStrategyModes(opts: {
  strategyIds: string[];
  mode: StrategyMode;
  userId: number;
  actor: string;
  reason?: string | null;
  source?: StrategyModeChangeSource;
}): Promise<BulkModeChangeResult> {
  const results: ModeChangeResult[] = [];
  for (const strategyId of opts.strategyIds) {
    const result = await setStrategyMode({
      strategyId,
      mode: opts.mode,
      userId: opts.userId,
      actor: opts.actor,
      reason: opts.reason,
      source: opts.source ?? 'bulk',
    });
    results.push(result);
  }

  const sync = await syncStrategyModesForSignalEngine();
  return {
    ok: results.every((r) => r.ok),
    results,
    updated: results.filter((r) => r.changed).length,
    failed: results.filter((r) => !r.ok).length,
    sync,
  };
}

/** Resolve strategy IDs matching bulk selector filters. */
export function resolveBulkStrategyIds(filter: {
  strategyIds?: string[];
  category?: string | null;
  regime?: string | null;
  strategyType?: string | null;
  currentMode?: StrategyMode | null;
}): string[] {
  if (filter.strategyIds && filter.strategyIds.length > 0) {
    return [...new Set(filter.strategyIds)];
  }

  const ids = listRegistryStrategyIds();
  return ids.filter((id) => {
    const entry = STRATEGY_REGISTRY[id];
    if (!entry) return false;
    if (filter.category && entry.category !== filter.category) return false;
    if (filter.regime && !entry.allowedRegimes.includes(filter.regime as never)) return false;
    if (filter.strategyType) {
      const type = filter.strategyType.toLowerCase();
      if (type === 'confirmation' && !entry.isConfirmationOnly) return false;
      if (type === 'entry' && entry.isConfirmationOnly) return false;
      if (type !== 'confirmation' && type !== 'entry' && entry.entryType !== filter.strategyType) {
        return false;
      }
    }
    if (filter.currentMode && entry.strategyMode !== filter.currentMode) return false;
    return true;
  });
}

export async function loadStrategyManagementStatus(): Promise<StrategyManagementStatus> {
  await loadStrategyModeOverrides(true);
  const profiles = await loadAllStrategyProfiles();
  const ids = listRegistryStrategyIds();

  let activeCount = 0;
  let watchlistCount = 0;
  let disabledCount = 0;
  let experimentalCount = 0;
  let overrideCount = 0;
  let lastUpdated: string | null = null;

  for (const id of ids) {
    const profile = profiles.get(id);
    const override = extractModeOverride(profile?.metadata_json);
    if (override) overrideCount += 1;
    const mode = resolveEffectiveStrategyMode(id, undefined, override);
    if (mode === 'CONFIRMED_ENABLED') activeCount += 1;
    else if (mode === 'WATCHLIST_ONLY') watchlistCount += 1;
    else if (mode === 'DISABLED') disabledCount += 1;
    else if (mode === 'EXPERIMENTAL') experimentalCount += 1;

    if (profile?.updated_at) {
      if (!lastUpdated || profile.updated_at > lastUpdated) lastUpdated = profile.updated_at;
    }
  }

  let currentlyRunning = 0;
  for (const id of ACTIVE_RUNNER_STRATEGIES) {
    const profile = profiles.get(id);
    const override = extractModeOverride(profile?.metadata_json);
    const mode = resolveEffectiveStrategyMode(id, undefined, override);
    if (mode === 'CONFIRMED_ENABLED') currentlyRunning += 1;
  }

  return {
    totalRegistered: ids.length,
    activeCount,
    watchlistCount,
    disabledCount,
    experimentalCount,
    currentlyRunning,
    overrideCount,
    lastUpdated,
  };
}

export async function loadModeActivity(opts?: {
  strategyId?: string;
  limit?: number;
}): Promise<Array<StrategyModeHistoryRow & { displayName: string }>> {
  const rows = await listModeHistory(opts ?? {});
  return rows.map((row) => {
    const entry = getRegistryEntry(row.strategy_id);
    return {
      ...row,
      displayName: entry?.displayName ?? row.strategy_id.replace(/_/g, ' '),
    };
  });
}

export { syncStrategyModesForSignalEngine };
