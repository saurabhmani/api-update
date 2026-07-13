import { describe, expect, it, beforeEach } from 'vitest';
import {
  clearAdaptiveParameterStore,
  saveAdaptiveParameterRecord,
  setActivePromotedParameter,
} from '@/lib/signal-engine/adaptive/adaptiveParameterStore';
import {
  getRuntimeSignalEngineConfig,
  invalidateRuntimeConfigCache,
  mergeAdaptiveOverlay,
  resetRuntimeConfiguration,
} from '@/lib/signal-engine/adaptive/runtimeConfiguration';
import { buildAdaptiveParameterRecord } from '@/lib/signal-engine/adaptive/adaptiveParameterStore';
import { getSignalEngineConfig, resetSignalEngineConfigCache } from '@/lib/signal-engine/config/signalEnginePhase2Config';

const PARAMS = {
  confidenceOffsets: { _global: -1 },
  qualityThresholds: {},
  rejectionThresholds: { minRewardRisk: 1.4 },
  minLiquidity: 60_000,
  minAtrPct: 2.0,
  minRewardRisk: 1.4,
  featureNormalizationLimits: { min: 0, max: 100 },
};

describe('runtime configuration', () => {
  beforeEach(() => {
    clearAdaptiveParameterStore();
    resetRuntimeConfiguration();
    resetSignalEngineConfigCache();
    process.env.SIGNAL_ADAPTIVE_RUNTIME_ENABLED = 'true';
  });

  it('returns base config when no promoted parameters exist', () => {
    const base = getSignalEngineConfig();
    const runtime = getRuntimeSignalEngineConfig('2026-01-11T00:00:00Z');
    expect(runtime.config.rejection.minRewardRisk).toBe(base.rejection.minRewardRisk);
    expect(runtime.manifest.adaptiveParameterId).toBeNull();
    expect(Object.isFrozen(runtime.config)).toBe(true);
  });

  it('merges promoted adaptive overlay immutably', () => {
    const record = buildAdaptiveParameterRecord({
      configurationVersion: '2.0.0',
      sourceSnapshotId: 'learn_test',
      trainingWindowDays: 90,
      sampleSize: 200,
      confidenceInterval: { level: 0.95, lower: 0.4, upper: 0.5 },
      parameters: PARAMS,
      createdAt: '2026-01-11T00:00:00Z',
      effectiveDate: '2026-01-11T00:00:00Z',
      approvalStatus: 'promoted',
    });
    saveAdaptiveParameterRecord({ ...record, approvalStatus: 'promoted', promotedAt: '2026-01-11T01:00:00Z' });
    setActivePromotedParameter(record.parameterId);
    invalidateRuntimeConfigCache();
    const runtime = getRuntimeSignalEngineConfig('2026-01-11T00:00:00Z');
    expect(runtime.config.rejection.minRewardRisk).toBe(1.4);
    expect(runtime.manifest.adaptiveParameterId).toBe(record.parameterId);
    expect(runtime.manifest.replayable).toBe(true);
  });

  it('mergeAdaptiveOverlay is deterministic', () => {
    const base = getSignalEngineConfig();
    const a = mergeAdaptiveOverlay(base, PARAMS);
    const b = mergeAdaptiveOverlay(base, PARAMS);
    expect(a).toEqual(b);
    expect(a.rejection.minRewardRisk).toBe(1.4);
  });
});
