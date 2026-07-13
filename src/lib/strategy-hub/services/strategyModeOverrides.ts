// ════════════════════════════════════════════════════════════════
//  Strategy Mode Overrides — runtime admin overrides over registry
//  defaults. Cached in-process; invalidated on write; refreshed
//  before Signal Engine scans so mode changes take effect without
//  process restart.
// ════════════════════════════════════════════════════════════════

import type { StrategyMode } from '@/lib/signal-engine/types/signalEngine.types';
import { loadAllStrategyProfiles } from '@/lib/strategy-hub/repository/strategyProfiles';
import {
  setStrategyModeOverrideResolver,
  clearStrategyModeOverrideResolver,
} from '@/lib/signal-engine/strategies/strategyModePolicy';

const VALID_MODES = new Set<StrategyMode>([
  'CONFIRMED_ENABLED',
  'WATCHLIST_ONLY',
  'EXPERIMENTAL',
  'DISABLED',
]);

const CACHE_TTL_MS = 30_000;

let _cache: Map<string, StrategyMode> | null = null;
let _loadedAt = 0;
let _wired = false;

export function isValidStrategyMode(value: unknown): value is StrategyMode {
  return typeof value === 'string' && VALID_MODES.has(value as StrategyMode);
}

/** Extract override from profile metadata_json if present and valid. */
export function extractModeOverride(
  metadata: Record<string, unknown> | null | undefined,
): StrategyMode | null {
  if (!metadata) return null;
  const raw = metadata.strategyModeOverride;
  return isValidStrategyMode(raw) ? raw : null;
}

export function getCachedModeOverride(strategyId: string): StrategyMode | null {
  if (!_cache) return null;
  return _cache.get(strategyId) ?? null;
}

export function invalidateStrategyModeOverrides(): void {
  _cache = null;
  _loadedAt = 0;
}

/** Load overrides from strategy_hub_profiles into the in-process cache. */
export async function loadStrategyModeOverrides(force = false): Promise<Map<string, StrategyMode>> {
  const now = Date.now();
  if (!force && _cache && now - _loadedAt < CACHE_TTL_MS) {
    return _cache;
  }

  const profiles = await loadAllStrategyProfiles();
  const next = new Map<string, StrategyMode>();
  for (const [id, profile] of profiles) {
    const override = extractModeOverride(profile.metadata_json);
    if (override) next.set(id, override);
  }
  _cache = next;
  _loadedAt = now;
  wireOverrideResolver();
  return next;
}

function wireOverrideResolver(): void {
  if (_wired) return;
  setStrategyModeOverrideResolver((strategyId) => getCachedModeOverride(strategyId));
  _wired = true;
}

/** Ensure resolver is wired and cache is fresh (call before scans). */
export async function syncStrategyModesForSignalEngine(): Promise<{
  overrideCount: number;
  syncedAt: string;
}> {
  const map = await loadStrategyModeOverrides(true);
  return {
    overrideCount: map.size,
    syncedAt: new Date().toISOString(),
  };
}

/** Test helper — clear cache and resolver. */
export function _resetStrategyModeOverrideCache(): void {
  invalidateStrategyModeOverrides();
  clearStrategyModeOverrideResolver();
  _wired = false;
}
