// ════════════════════════════════════════════════════════════════
//  Strategy Hub — effective configuration resolver (Phase 3)
//  Effective = DB override → registry default
// ════════════════════════════════════════════════════════════════

import { STRATEGY_REGISTRY } from '@/lib/signal-engine/strategies/strategyRegistry';
import type { StrategyName, StrategyRegistryEntry } from '@/lib/signal-engine/types/signalEngine.types';
import {
  CONFIGURABLE_PARAM_KEYS,
  type ConfigurableParamKey,
  type ConfigurableParamValue,
} from './strategyParameterCatalog';

export type EffectiveConfigurableParams = Pick<
  StrategyRegistryEntry,
  | 'idealRsiRange'
  | 'minAdx'
  | 'minVolumeExpansion'
  | 'defaultConfidenceWeight'
  | 'allowedRegimes'
  | 'blockedRegimes'
  | 'idealMarketRegime'
  | 'riskProfile'
  | 'timeframe'
>;

export interface ParamOverridesBlob {
  version: number;
  updatedBy: string;
  updatedAt: string;
  reason?: string | null;
  values: Partial<Record<ConfigurableParamKey, ConfigurableParamValue>>;
}

type ConfigOverrideResolver = (strategyId: string) => Partial<Record<ConfigurableParamKey, ConfigurableParamValue>> | null;

let _overrideResolver: ConfigOverrideResolver | null = null;

export function setConfigOverrideResolver(resolver: ConfigOverrideResolver | null): void {
  _overrideResolver = resolver;
}

export function clearConfigOverrideResolver(): void {
  _overrideResolver = null;
}

export function extractParamOverrides(
  metadata: Record<string, unknown> | null | undefined,
): ParamOverridesBlob | null {
  if (!metadata || typeof metadata !== 'object') return null;
  const raw = metadata.paramOverrides;
  if (!raw || typeof raw !== 'object') return null;
  const blob = raw as Record<string, unknown>;
  const values = blob.values;
  if (!values || typeof values !== 'object') return null;
  return {
    version: Number(blob.version ?? 0),
    updatedBy: String(blob.updatedBy ?? ''),
    updatedAt: String(blob.updatedAt ?? ''),
    reason: blob.reason != null ? String(blob.reason) : null,
    values: values as Partial<Record<ConfigurableParamKey, ConfigurableParamValue>>,
  };
}

function registryDefaults(strategyId: string): EffectiveConfigurableParams | null {
  const entry = STRATEGY_REGISTRY[strategyId as StrategyName];
  if (!entry) return null;
  return {
    idealRsiRange: entry.idealRsiRange,
    minAdx: entry.minAdx,
    minVolumeExpansion: entry.minVolumeExpansion,
    defaultConfidenceWeight: entry.defaultConfidenceWeight,
    allowedRegimes: [...entry.allowedRegimes],
    blockedRegimes: [...entry.blockedRegimes],
    idealMarketRegime: [...entry.idealMarketRegime],
    riskProfile: entry.riskProfile,
    timeframe: entry.timeframe,
  };
}

export function mergeRegistryWithOverrides(
  strategyId: string,
  overrides?: Partial<Record<ConfigurableParamKey, ConfigurableParamValue>> | null,
): EffectiveConfigurableParams | null {
  const defaults = registryDefaults(strategyId);
  if (!defaults) return null;
  if (!overrides) return defaults;

  const merged = { ...defaults };
  for (const key of CONFIGURABLE_PARAM_KEYS) {
    if (overrides[key] !== undefined) {
      const val = overrides[key];
      if (key === 'allowedRegimes' || key === 'blockedRegimes' || key === 'idealMarketRegime') {
        (merged as Record<string, unknown>)[key] = Array.isArray(val) ? [...val] : val;
      } else {
        (merged as Record<string, unknown>)[key] = val;
      }
    }
  }
  return merged;
}

export function getEffectiveConfigurableParams(
  strategyId: string,
  explicitOverrides?: Partial<Record<ConfigurableParamKey, ConfigurableParamValue>> | null,
): EffectiveConfigurableParams | null {
  const overrides =
  explicitOverrides !== undefined
    ? explicitOverrides
    : (_overrideResolver?.(strategyId) ?? null);
  return mergeRegistryWithOverrides(strategyId, overrides);
}

export function getOverriddenKeys(
  overrides?: Partial<Record<ConfigurableParamKey, ConfigurableParamValue>> | null,
): ConfigurableParamKey[] {
  if (!overrides) return [];
  return CONFIGURABLE_PARAM_KEYS.filter((k) => overrides[k] !== undefined);
}

/** Full effective strategy configuration for validation + Signal Engine. */
export async function getEffectiveStrategyConfig(strategyId: string): Promise<{
  strategyId: string;
  effective: EffectiveConfigurableParams | null;
  registryDefaults: EffectiveConfigurableParams | null;
  overrides: Partial<Record<ConfigurableParamKey, ConfigurableParamValue>>;
  configVersion: number;
  overrideCount: number;
} | null> {
  const { loadStrategyConfigOverrides } = await import('./services/strategyConfigOverrides');
  const { loadStrategyProfile } = await import('./repository/strategyProfiles');
  await loadStrategyConfigOverrides();
  const profile = await loadStrategyProfile(strategyId);
  const blob = extractParamOverrides(profile?.metadata_json);
  const overrides = blob?.values ?? {};
  return {
    strategyId,
    effective: getEffectiveConfigurableParams(strategyId, overrides),
    registryDefaults: mergeRegistryWithOverrides(strategyId, null),
    overrides,
    configVersion: blob?.version ?? 0,
    overrideCount: getOverriddenKeys(overrides).length,
  };
}

/** Registry entry fields used by Signal Engine routing — merged with overrides. */
export function getEffectiveStrategyEntryFields(
  strategy: StrategyName | string,
): Pick<
  StrategyRegistryEntry,
  | 'allowedRegimes'
  | 'blockedRegimes'
  | 'defaultConfidenceWeight'
  | 'idealRsiRange'
  | 'minAdx'
  | 'minVolumeExpansion'
  | 'riskProfile'
  | 'timeframe'
  | 'idealMarketRegime'
> | null {
  return getEffectiveConfigurableParams(String(strategy));
}
