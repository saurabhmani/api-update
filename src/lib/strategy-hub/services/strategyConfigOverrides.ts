// ════════════════════════════════════════════════════════════════
//  Strategy Config Overrides — runtime cache (Phase 3)
// ════════════════════════════════════════════════════════════════

import { loadAllStrategyProfiles } from '@/lib/strategy-hub/repository/strategyProfiles';
import {
  extractParamOverrides,
  setConfigOverrideResolver,
  clearConfigOverrideResolver,
  type ParamOverridesBlob,
} from '@/lib/strategy-hub/effectiveStrategyConfig';
import type { ConfigurableParamKey, ConfigurableParamValue } from '@/lib/strategy-hub/strategyParameterCatalog';

const CACHE_TTL_MS = 30_000;

let _cache: Map<string, Partial<Record<ConfigurableParamKey, ConfigurableParamValue>>> | null = null;
let _loadedAt = 0;
let _wired = false;

export function invalidateStrategyConfigOverrides(): void {
  _cache = null;
  _loadedAt = 0;
}

export async function loadStrategyConfigOverrides(force = false): Promise<
  Map<string, Partial<Record<ConfigurableParamKey, ConfigurableParamValue>>>
> {
  const now = Date.now();
  if (!force && _cache && now - _loadedAt < CACHE_TTL_MS) {
    return _cache;
  }

  const profiles = await loadAllStrategyProfiles();
  const next = new Map<string, Partial<Record<ConfigurableParamKey, ConfigurableParamValue>>>();
  for (const [id, profile] of profiles) {
    const blob = extractParamOverrides(profile.metadata_json);
    if (blob?.values && Object.keys(blob.values).length > 0) {
      next.set(id, blob.values);
    }
  }
  _cache = next;
  _loadedAt = now;
  wireResolver();
  return next;
}

function wireResolver(): void {
  if (_wired) return;
  setConfigOverrideResolver((strategyId) => _cache?.get(strategyId) ?? null);
  _wired = true;
}

export async function syncStrategyConfigForSignalEngine(): Promise<{
  overrideCount: number;
  syncedAt: string;
}> {
  const map = await loadStrategyConfigOverrides(true);
  return {
    overrideCount: map.size,
    syncedAt: new Date().toISOString(),
  };
}

export function getCachedParamOverrides(strategyId: string): ParamOverridesBlob | null {
  const values = _cache?.get(strategyId);
  if (!values) return null;
  return { version: 0, updatedBy: '', updatedAt: '', values };
}

export function _resetStrategyConfigOverrideCache(): void {
  invalidateStrategyConfigOverrides();
  clearConfigOverrideResolver();
  _wired = false;
}
