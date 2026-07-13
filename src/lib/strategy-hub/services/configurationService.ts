// ════════════════════════════════════════════════════════════════
//  Strategy Hub — configuration service (Phase 3)
// ════════════════════════════════════════════════════════════════

import { getRegistryEntry } from '../registry';
import {
  CONFIGURABLE_PARAM_KEYS,
  PARAM_FIELD_CATALOG,
  summarizeConfigChanges,
  validateConfigurationPatch,
  type ConfigurableParamKey,
  type ConfigurableParamValue,
} from '../strategyParameterCatalog';
import {
  extractParamOverrides,
  getEffectiveConfigurableParams,
  getOverriddenKeys,
  mergeRegistryWithOverrides,
  type ParamOverridesBlob,
} from '../effectiveStrategyConfig';
import {
  loadStrategyProfile,
  upsertStrategyProfile,
} from '../repository/strategyProfiles';
import {
  getLatestConfigVersion,
  listConfigHistory,
  loadConfigHistoryVersion,
  recordConfigHistory,
} from '../repository/configHistory';
import {
  invalidateStrategyConfigOverrides,
  loadStrategyConfigOverrides,
  syncStrategyConfigForSignalEngine,
} from './strategyConfigOverrides';
import type {
  StrategyConfigHistoryRow,
  StrategyConfigPreviewResult,
  StrategyConfigurationView,
} from '../types';

function registryDefaultsRecord(strategyId: string): Record<string, unknown> {
  const merged = mergeRegistryWithOverrides(strategyId, null);
  if (!merged) return {};
  const out: Record<string, unknown> = {};
  for (const key of CONFIGURABLE_PARAM_KEYS) {
    out[key] = merged[key];
  }
  return out;
}

function effectiveRecord(strategyId: string, overrides: ParamOverridesBlob | null): Record<string, unknown> {
  const merged = mergeRegistryWithOverrides(strategyId, overrides?.values ?? null);
  if (!merged) return {};
  const out: Record<string, unknown> = {};
  for (const key of CONFIGURABLE_PARAM_KEYS) {
    out[key] = merged[key];
  }
  return out;
}

function buildFieldViews(strategyId: string, blob: ParamOverridesBlob | null): StrategyConfigurationView['fields'] {
  const defaults = registryDefaultsRecord(strategyId);
  const effective = effectiveRecord(strategyId, blob);
  const overridden = new Set(getOverriddenKeys(blob?.values));

  return PARAM_FIELD_CATALOG.map((meta) => ({
    key: meta.key,
    label: meta.label,
    description: meta.description,
    type: meta.type,
    optional: meta.optional,
    registryDefault: defaults[meta.key],
    overrideValue: overridden.has(meta.key) ? blob?.values[meta.key] ?? null : null,
    effectiveValue: effective[meta.key],
    isOverridden: overridden.has(meta.key),
  }));
}

export async function loadStrategyConfiguration(strategyId: string): Promise<StrategyConfigurationView | null> {
  const entry = getRegistryEntry(strategyId);
  if (!entry) return null;

  await loadStrategyConfigOverrides();
  const profile = await loadStrategyProfile(strategyId);
  const blob = extractParamOverrides(profile?.metadata_json);

  return {
    strategyId,
    displayName: entry.displayName,
    version: blob?.version ?? 0,
    fields: buildFieldViews(strategyId, blob),
    overriddenKeys: getOverriddenKeys(blob?.values),
    effective: effectiveRecord(strategyId, blob),
    registryDefaults: registryDefaultsRecord(strategyId),
    overrides: (blob?.values ?? {}) as Record<string, unknown>,
    lastUpdated: blob?.updatedAt ?? profile?.updated_at ?? null,
    lastUpdatedBy: blob?.updatedBy ?? null,
  };
}

function impactForKey(key: ConfigurableParamKey): string {
  switch (key) {
    case 'idealRsiRange':
      return 'Adjusts RSI eligibility window for strategy quality scoring.';
    case 'minAdx':
      return 'Changes minimum trend-strength gate when ADX filters apply.';
    case 'minVolumeExpansion':
      return 'Tightens or relaxes volume confirmation requirements.';
    case 'defaultConfidenceWeight':
      return 'Affects conflict resolution weighting and relative strategy priority.';
    case 'allowedRegimes':
    case 'blockedRegimes':
      return 'Changes which market regimes may produce signals for this strategy.';
    case 'idealMarketRegime':
      return 'Updates ideal regime metadata shown to operators.';
    case 'riskProfile':
      return 'Updates operator-facing risk label (does not change position sizing directly).';
    case 'timeframe':
      return 'Updates declared evaluation timeframe metadata.';
    default:
      return 'Configuration change will apply on next Signal Engine evaluation.';
  }
}

export function previewConfigurationChange(opts: {
  strategyId: string;
  patch: Record<string, unknown>;
  resetKeys?: string[];
  currentOverrides?: Partial<Record<ConfigurableParamKey, ConfigurableParamValue>>;
}): StrategyConfigPreviewResult {
  const entry = getRegistryEntry(opts.strategyId);
  if (!entry) {
    return {
      valid: false,
      issues: [{ key: 'strategyId', message: 'Unknown strategy' }],
      changes: [],
      summary: 'Unknown strategy',
      nextOverrides: {},
      nextEffective: {},
    };
  }

  const working: Partial<Record<ConfigurableParamKey, ConfigurableParamValue>> = {
    ...(opts.currentOverrides ?? {}),
  };

  if (opts.resetKeys?.length) {
    for (const key of opts.resetKeys) {
      if (CONFIGURABLE_PARAM_KEYS.includes(key as ConfigurableParamKey)) {
        delete working[key as ConfigurableParamKey];
      }
    }
  }

  const validation = validateConfigurationPatch(opts.patch);

  if (!validation.valid) {
    return {
      valid: false,
      issues: validation.issues,
      changes: [],
      summary: 'Validation failed',
      nextOverrides: working as Record<string, unknown>,
      nextEffective: effectiveRecord(opts.strategyId, { version: 0, updatedBy: '', updatedAt: '', values: working }),
    };
  }

  for (const [key, val] of Object.entries(validation.sanitized)) {
    working[key as ConfigurableParamKey] = val;
  }

  const beforeEffective = effectiveRecord(
    opts.strategyId,
    { version: 0, updatedBy: '', updatedAt: '', values: opts.currentOverrides ?? {} },
  );
  const afterEffective = effectiveRecord(
    opts.strategyId,
    { version: 0, updatedBy: '', updatedAt: '', values: working },
  );

  const changes = CONFIGURABLE_PARAM_KEYS
    .filter((key) => JSON.stringify(beforeEffective[key]) !== JSON.stringify(afterEffective[key]))
    .map((key) => {
      const meta = PARAM_FIELD_CATALOG.find((f) => f.key === key)!;
      return {
        key,
        label: meta.label,
        previousValue: beforeEffective[key],
        newValue: afterEffective[key],
        impact: impactForKey(key),
      };
    });

  return {
    valid: true,
    issues: [],
    changes,
    summary: summarizeConfigChanges(
      beforeEffective as Partial<Record<ConfigurableParamKey, ConfigurableParamValue>>,
      afterEffective as Partial<Record<ConfigurableParamKey, ConfigurableParamValue>>,
    ),
    nextOverrides: working as Record<string, unknown>,
    nextEffective: afterEffective,
  };
}

export async function previewConfigurationChangeAsync(opts: {
  strategyId: string;
  patch: Record<string, unknown>;
  resetKeys?: string[];
}): Promise<StrategyConfigPreviewResult> {
  const profile = await loadStrategyProfile(opts.strategyId);
  const blob = extractParamOverrides(profile?.metadata_json);
  return previewConfigurationChange({
    strategyId: opts.strategyId,
    patch: opts.patch,
    resetKeys: opts.resetKeys,
    currentOverrides: blob?.values ?? {},
  });
}

async function persistOverrides(opts: {
  strategyId: string;
  userId: number;
  actor: string;
  reason?: string | null;
  newValues: Partial<Record<ConfigurableParamKey, ConfigurableParamValue>>;
  source: 'ui' | 'api' | 'restore' | 'reset';
  previousValues: Partial<Record<ConfigurableParamKey, ConfigurableParamValue>>;
}): Promise<{ version: number; blob: ParamOverridesBlob }> {
  const profile = await loadStrategyProfile(opts.strategyId);
  const existingMeta = profile?.metadata_json ?? {};
  const latestVersion = Math.max(
    extractParamOverrides(existingMeta)?.version ?? 0,
    await getLatestConfigVersion(opts.strategyId),
  );
  const version = latestVersion + 1;

  const blob: ParamOverridesBlob = {
    version,
    updatedBy: opts.actor,
    updatedAt: new Date().toISOString(),
    reason: opts.reason ?? null,
    values: opts.newValues,
  };

  await upsertStrategyProfile(opts.strategyId, {
    metadata_json: {
      ...existingMeta,
      paramOverrides: blob,
    },
  });

  const summary = summarizeConfigChanges(opts.previousValues, opts.newValues);
  await recordConfigHistory({
    strategyId: opts.strategyId,
    userId: opts.userId,
    versionNumber: version,
    previousValues: opts.previousValues as Record<string, unknown>,
    newValues: opts.newValues as Record<string, unknown>,
    changeSummary: summary || 'Configuration updated',
    reason: opts.reason ?? null,
    actor: opts.actor,
    source: opts.source,
  });

  invalidateStrategyConfigOverrides();
  await loadStrategyConfigOverrides(true);

  return { version, blob };
}

export async function updateStrategyConfiguration(opts: {
  strategyId: string;
  userId: number;
  actor: string;
  values: Record<string, unknown>;
  reason?: string | null;
  source?: 'ui' | 'api';
}): Promise<{ ok: boolean; config?: StrategyConfigurationView; error?: string; preview?: StrategyConfigPreviewResult }> {
  const entry = getRegistryEntry(opts.strategyId);
  if (!entry) return { ok: false, error: 'Unknown strategy' };

  const profile = await loadStrategyProfile(opts.strategyId);
  const blob = extractParamOverrides(profile?.metadata_json);
  const previousValues = { ...(blob?.values ?? {}) };

  const preview = await previewConfigurationChangeAsync({
    strategyId: opts.strategyId,
    patch: opts.values,
  });
  if (!preview.valid) {
    return { ok: false, error: 'Validation failed', preview };
  }

  const { version } = await persistOverrides({
    strategyId: opts.strategyId,
    userId: opts.userId,
    actor: opts.actor,
    reason: opts.reason,
    newValues: preview.nextOverrides as Partial<Record<ConfigurableParamKey, ConfigurableParamValue>>,
    source: opts.source ?? 'ui',
    previousValues,
  });

  await syncStrategyConfigForSignalEngine();
  const config = await loadStrategyConfiguration(opts.strategyId);
  if (config) config.version = version;
  return { ok: true, config: config ?? undefined, preview };
}

export async function resetStrategyConfiguration(opts: {
  strategyId: string;
  userId: number;
  actor: string;
  key?: ConfigurableParamKey;
  reason?: string | null;
}): Promise<{ ok: boolean; config?: StrategyConfigurationView; error?: string }> {
  const entry = getRegistryEntry(opts.strategyId);
  if (!entry) return { ok: false, error: 'Unknown strategy' };

  const profile = await loadStrategyProfile(opts.strategyId);
  const blob = extractParamOverrides(profile?.metadata_json);
  const previousValues = { ...(blob?.values ?? {}) };

  if (!blob?.values || Object.keys(blob.values).length === 0) {
    const config = await loadStrategyConfiguration(opts.strategyId);
    return { ok: true, config: config ?? undefined };
  }

  const nextValues = { ...blob.values };
  if (opts.key) {
    delete nextValues[opts.key];
  } else {
    for (const key of CONFIGURABLE_PARAM_KEYS) {
      delete nextValues[key];
    }
  }

  if (Object.keys(nextValues).length === 0) {
    const existingMeta = profile?.metadata_json ?? {};
    const { paramOverrides: _removed, ...rest } = existingMeta as Record<string, unknown> & { paramOverrides?: unknown };
    void _removed;
    await upsertStrategyProfile(opts.strategyId, { metadata_json: rest });
    await recordConfigHistory({
      strategyId: opts.strategyId,
      userId: opts.userId,
      versionNumber: (blob.version ?? 0) + 1,
      previousValues: previousValues as Record<string, unknown>,
      newValues: {},
      changeSummary: opts.key ? `Reset ${opts.key} to registry default` : 'Reset all parameters to registry defaults',
      reason: opts.reason ?? null,
      actor: opts.actor,
      source: 'reset',
    });
  } else {
    await persistOverrides({
      strategyId: opts.strategyId,
      userId: opts.userId,
      actor: opts.actor,
      reason: opts.reason ?? (opts.key ? `Reset ${opts.key}` : 'Reset configuration'),
      newValues: nextValues,
      source: 'reset',
      previousValues,
    });
  }

  invalidateStrategyConfigOverrides();
  await syncStrategyConfigForSignalEngine();
  const config = await loadStrategyConfiguration(opts.strategyId);
  return { ok: true, config: config ?? undefined };
}

export async function loadConfigurationHistory(
  strategyId: string,
  limit = 30,
): Promise<StrategyConfigHistoryRow[]> {
  return listConfigHistory({ strategyId, limit });
}

export async function restoreConfigurationVersion(opts: {
  strategyId: string;
  versionId: number;
  userId: number;
  actor: string;
  reason?: string | null;
}): Promise<{ ok: boolean; config?: StrategyConfigurationView; error?: string }> {
  const row = await loadConfigHistoryVersion(opts.strategyId, opts.versionId);
  if (!row) return { ok: false, error: 'Version not found' };

  const profile = await loadStrategyProfile(opts.strategyId);
  const blob = extractParamOverrides(profile?.metadata_json);
  const previousValues = { ...(blob?.values ?? {}) };
  const restored = (row.new_values_json ?? {}) as Partial<Record<ConfigurableParamKey, ConfigurableParamValue>>;

  const validation = validateConfigurationPatch(restored as Record<string, unknown>);
  if (!validation.valid) {
    return { ok: false, error: 'Stored version contains invalid configuration' };
  }

  await persistOverrides({
    strategyId: opts.strategyId,
    userId: opts.userId,
    actor: opts.actor,
    reason: opts.reason ?? `Restored version ${row.version_number}`,
    newValues: validation.sanitized,
    source: 'restore',
    previousValues,
  });

  await syncStrategyConfigForSignalEngine();
  const config = await loadStrategyConfiguration(opts.strategyId);
  return { ok: true, config: config ?? undefined };
}

export { syncStrategyConfigForSignalEngine, getEffectiveConfigurableParams };
