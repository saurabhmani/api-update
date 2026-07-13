import { describe, expect, it, beforeEach } from 'vitest';
import {
  buildAdaptiveParameterRecord,
  clearAdaptiveParameterStore,
  saveAdaptiveParameterRecord,
  verifyAdaptiveParameterRecord,
} from '@/lib/signal-engine/adaptive/adaptiveParameterStore';
import { ADAPTIVE_PARAMETER_SCHEMA_VERSION } from '@/lib/signal-engine/adaptive/adaptiveParameterTypes';

const PARAMS = {
  confidenceOffsets: { _global: -0.5 },
  qualityThresholds: { minTrendStrength: 38 },
  rejectionThresholds: { minRewardRisk: 1.3 },
  minLiquidity: 55_000,
  minAtrPct: 1.5,
  minRewardRisk: 1.3,
  featureNormalizationLimits: { min: 0, max: 100 },
};

describe('adaptive parameter store', () => {
  beforeEach(() => clearAdaptiveParameterStore());

  it('builds content-addressed immutable records', () => {
    const record = buildAdaptiveParameterRecord({
      configurationVersion: '2.0.0',
      sourceSnapshotId: 'learn_test',
      trainingWindowDays: 90,
      sampleSize: 500,
      confidenceInterval: { level: 0.95, lower: 0.4, upper: 0.5 },
      parameters: PARAMS,
      createdAt: '2026-01-11T00:00:00Z',
      effectiveDate: '2026-01-11T00:00:00Z',
    });
    expect(record.schemaVersion).toBe(ADAPTIVE_PARAMETER_SCHEMA_VERSION);
    expect(record.parameterId).toMatch(/^adapt_/);
    expect(record.contentHash).toHaveLength(64);
    expect(verifyAdaptiveParameterRecord(record)).toBe(true);
    saveAdaptiveParameterRecord(record);
    expect(record.contentHash).toHaveLength(64);
  });

  it('rejects tampered records', () => {
    const record = buildAdaptiveParameterRecord({
      configurationVersion: '2.0.0',
      sourceSnapshotId: 'learn_test',
      trainingWindowDays: 90,
      sampleSize: 500,
      confidenceInterval: { level: 0.95, lower: 0.4, upper: 0.5 },
      parameters: PARAMS,
      createdAt: '2026-01-11T00:00:00Z',
      effectiveDate: '2026-01-11T00:00:00Z',
    });
    const tampered = { ...record, sampleSize: 999 };
    expect(verifyAdaptiveParameterRecord(tampered)).toBe(false);
  });
});
