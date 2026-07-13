import { createHash } from 'node:crypto';
import type { OutcomeAnalyticsRecord } from '../analytics/outcomeAnalytics';
import {
  buildProductAPerformanceReport,
  type ProductAPerformanceReport,
} from '../analytics/performanceReporting';

export const LEARNING_SNAPSHOT_SCHEMA_VERSION = '1.0.0';

export interface LearningVersionManifest {
  configurationVersion: string;
  featureVersion: string;
  confidenceVersion: string;
  learningVersion: string;
  benchmarkVersion: string;
  outcomeVersion: string;
}

export interface ImmutableLearningSnapshot {
  snapshotId: string;
  schemaVersion: string;
  createdAt: string;
  versions: LearningVersionManifest;
  source: {
    lookbackDays: number;
    sampleCount: number;
    firstSignalAt: string | null;
    lastSignalAt: string | null;
  };
  benchmarkMetrics: ProductAPerformanceReport;
  contentHash: string;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, child]) => [key, stableValue(child)]),
    );
  }
  return value;
}

function stableJson(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

function hash(value: unknown): string {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

export function createLearningSnapshot(input: {
  records: readonly OutcomeAnalyticsRecord[];
  versions: LearningVersionManifest;
  createdAt: string;
  lookbackDays: number;
  baselineRecords?: readonly OutcomeAnalyticsRecord[];
}): ImmutableLearningSnapshot {
  const ordered = [...input.records].sort((a, b) =>
    a.generatedAt.localeCompare(b.generatedAt) || a.signalId - b.signalId,
  );
  const benchmarkMetrics = buildProductAPerformanceReport(ordered, {
    generatedAt: input.createdAt,
    baselineRecords: input.baselineRecords,
  });
  const payload = {
    schemaVersion: LEARNING_SNAPSHOT_SCHEMA_VERSION,
    createdAt: input.createdAt,
    versions: input.versions,
    source: {
      lookbackDays: input.lookbackDays,
      sampleCount: ordered.length,
      firstSignalAt: ordered.at(0)?.generatedAt ?? null,
      lastSignalAt: ordered.at(-1)?.generatedAt ?? null,
    },
    benchmarkMetrics,
  };
  const contentHash = hash(payload);
  return deepFreeze({
    snapshotId: `learn_${input.createdAt.slice(0, 10).replaceAll('-', '')}_${contentHash.slice(0, 12)}`,
    ...payload,
    contentHash,
  });
}

export function verifyLearningSnapshot(snapshot: ImmutableLearningSnapshot): boolean {
  const { snapshotId: _snapshotId, contentHash, ...payload } = snapshot;
  return hash(payload) === contentHash;
}

/**
 * Re-run analytics using the exact version manifest and as-of timestamp
 * captured by a snapshot. Generation/scoring code is never invoked.
 */
export function replayLearningSnapshot(
  snapshot: ImmutableLearningSnapshot,
  records: readonly OutcomeAnalyticsRecord[],
): ProductAPerformanceReport {
  if (!verifyLearningSnapshot(snapshot)) throw new Error('Learning snapshot content hash mismatch');
  return buildProductAPerformanceReport(records, { generatedAt: snapshot.createdAt });
}
