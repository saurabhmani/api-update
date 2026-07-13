// ════════════════════════════════════════════════════════════════
//  Phase 4 — Safe Runtime Configuration Loading
//  Base config → versioned adaptive overlay → immutable merged config
// ════════════════════════════════════════════════════════════════

import {
  getSignalEngineConfig,
  type SignalEnginePhase2Config,
} from '../config/signalEnginePhase2Config';
import type { AdaptiveParameterValues } from './adaptiveParameterTypes';
import { getActivePromotedParameter } from './adaptiveParameterStore';

export interface RuntimeConfigurationManifest {
  baseConfigVersion: string;
  adaptiveParameterId: string | null;
  adaptiveLearningVersion: string | null;
  adaptiveContentHash: string | null;
  mergedAt: string;
  replayable: boolean;
}

export interface ImmutableRuntimeConfiguration {
  config: SignalEnginePhase2Config;
  manifest: RuntimeConfigurationManifest;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function envBool(name: string, fallback: boolean): boolean {
  const raw = (process.env[name] ?? '').trim().toLowerCase();
  if (raw === '') return fallback;
  return raw === 'true' || raw === '1' || raw === 'yes' || raw === 'on';
}

export function mergeAdaptiveOverlay(
  base: SignalEnginePhase2Config,
  overlay: AdaptiveParameterValues,
): SignalEnginePhase2Config {
  const globalOffset = overlay.confidenceOffsets._global ?? 0;
  const mergedMaxAdj = clamp(base.confidence.maxAdjustment + globalOffset, 0, 15);

  return {
    ...base,
    configVersionLabel: `${base.configVersionLabel}+adaptive`,
    features: {
      ...base.features,
      ...overlay.qualityThresholds,
    },
    rejection: {
      ...base.rejection,
      ...overlay.rejectionThresholds,
      minRewardRisk: overlay.minRewardRisk ?? base.rejection.minRewardRisk,
      minLiquidityQuality: overlay.rejectionThresholds.minLiquidityQuality
        ?? overlay.qualityThresholds.minLiquidityQuality
        ?? base.rejection.minLiquidityQuality,
      maxAbnormalAtrPct: overlay.minAtrPct > 0
        ? Math.max(base.rejection.maxAbnormalAtrPct, overlay.minAtrPct)
        : base.rejection.maxAbnormalAtrPct,
    },
    confidence: {
      ...base.confidence,
      maxAdjustment: mergedMaxAdj,
    },
  };
}

let cachedRuntime: ImmutableRuntimeConfiguration | null = null;
let cachedVersionKey: string | null = null;

function buildVersionKey(base: SignalEnginePhase2Config, adaptiveId: string | null, hash: string | null): string {
  return `${base.configVersionLabel}|${adaptiveId ?? 'none'}|${hash ?? 'none'}`;
}

/**
 * Synchronous, cached, immutable runtime configuration.
 * Without promoted adaptive params, returns base config unchanged (replay-safe).
 */
export function getRuntimeSignalEngineConfig(now = new Date().toISOString()): ImmutableRuntimeConfiguration {
  const base = getSignalEngineConfig();
  const adaptiveEnabled = envBool('SIGNAL_ADAPTIVE_RUNTIME_ENABLED', true);
  const active = adaptiveEnabled ? getActivePromotedParameter() : null;
  const versionKey = buildVersionKey(base, active?.parameterId ?? null, active?.contentHash ?? null);

  if (cachedRuntime && cachedVersionKey === versionKey) return cachedRuntime;

  const merged = active?.approvalStatus === 'promoted' && active.parameters
    ? mergeAdaptiveOverlay(base, active.parameters)
    : base;

  const runtime: ImmutableRuntimeConfiguration = {
    config: deepFreeze({ ...merged }),
    manifest: deepFreeze({
      baseConfigVersion: base.configVersionLabel,
      adaptiveParameterId: active?.parameterId ?? null,
      adaptiveLearningVersion: active?.learningVersion ?? null,
      adaptiveContentHash: active?.contentHash ?? null,
      mergedAt: now,
      replayable: true,
    }),
  };

  cachedRuntime = runtime;
  cachedVersionKey = versionKey;
  return runtime;
}

/** Resolve config for a specific adaptive parameter — offline replay / A/B. */
export function getRuntimeConfigForParameter(
  parameterId: string,
  lookup: (id: string) => import('./adaptiveParameterTypes').AdaptiveParameterRecord | null,
  now = new Date().toISOString(),
): ImmutableRuntimeConfiguration {
  const base = getSignalEngineConfig();
  const record = lookup(parameterId);
  const merged = record?.parameters ? mergeAdaptiveOverlay(base, record.parameters) : base;
  return {
    config: deepFreeze({ ...merged }),
    manifest: deepFreeze({
      baseConfigVersion: base.configVersionLabel,
      adaptiveParameterId: record?.parameterId ?? null,
      adaptiveLearningVersion: record?.learningVersion ?? null,
      adaptiveContentHash: record?.contentHash ?? null,
      mergedAt: now,
      replayable: true,
    }),
  };
}

export function invalidateRuntimeConfigCache(): void {
  cachedRuntime = null;
  cachedVersionKey = null;
}

export function resetRuntimeConfiguration(): void {
  invalidateRuntimeConfigCache();
}
