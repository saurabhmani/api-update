// ════════════════════════════════════════════════════════════════
//  Phase 4 — Adaptive Parameter Store (canonical in-memory + hash)
// ════════════════════════════════════════════════════════════════

import { createHash } from 'node:crypto';
import type {
  AdaptiveParameterRecord,
  AdaptiveParameterValues,
  AdaptiveApprovalStatus,
  ConfidenceInterval,
  ValidationMetrics,
} from './adaptiveParameterTypes';
import {
  ADAPTIVE_LEARNING_VERSION,
  ADAPTIVE_PARAMETER_SCHEMA_VERSION,
} from './adaptiveParameterTypes';

function stableJson(value: unknown): string {
  const normalize = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(normalize);
    if (v && typeof v === 'object') {
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, c]) => [k, normalize(c)]),
      );
    }
    return v;
  };
  return JSON.stringify(normalize(value));
}

export function hashAdaptiveParameterRecord(
  payload: Pick<
    AdaptiveParameterRecord,
    | 'schemaVersion'
    | 'configurationVersion'
    | 'learningVersion'
    | 'effectiveDate'
    | 'expiryDate'
    | 'sourceSnapshotId'
    | 'trainingWindowDays'
    | 'sampleSize'
    | 'confidenceInterval'
    | 'parameters'
    | 'createdAt'
    | 'generatedBy'
  >,
): string {
  return createHash('sha256').update(stableJson(payload)).digest('hex');
}

export function verifyAdaptiveParameterRecord(record: AdaptiveParameterRecord): boolean {
  const hashPayload = {
    schemaVersion: record.schemaVersion,
    configurationVersion: record.configurationVersion,
    learningVersion: record.learningVersion,
    effectiveDate: record.effectiveDate,
    expiryDate: record.expiryDate,
    sourceSnapshotId: record.sourceSnapshotId,
    trainingWindowDays: record.trainingWindowDays,
    sampleSize: record.sampleSize,
    confidenceInterval: record.confidenceInterval,
    parameters: record.parameters,
    createdAt: record.createdAt,
    generatedBy: record.generatedBy,
  };
  return hashAdaptiveParameterRecord(hashPayload) === record.contentHash;
}

export function buildAdaptiveParameterRecord(input: {
  configurationVersion: string;
  sourceSnapshotId: string;
  trainingWindowDays: number;
  sampleSize: number;
  confidenceInterval: ConfidenceInterval;
  parameters: AdaptiveParameterValues;
  validationMetrics?: ValidationMetrics | null;
  approvalStatus?: AdaptiveApprovalStatus;
  rollbackVersion?: string | null;
  createdAt: string;
  effectiveDate: string;
  expiryDate?: string | null;
  generatedBy?: string;
  reason?: string | null;
}): AdaptiveParameterRecord {
  const hashPayload = {
    schemaVersion: ADAPTIVE_PARAMETER_SCHEMA_VERSION,
    configurationVersion: input.configurationVersion,
    learningVersion: ADAPTIVE_LEARNING_VERSION,
    effectiveDate: input.effectiveDate,
    expiryDate: input.expiryDate ?? null,
    sourceSnapshotId: input.sourceSnapshotId,
    trainingWindowDays: input.trainingWindowDays,
    sampleSize: input.sampleSize,
    confidenceInterval: input.confidenceInterval,
    parameters: input.parameters,
    createdAt: input.createdAt,
    generatedBy: input.generatedBy ?? 'learningScheduler',
  };
  const contentHash = hashAdaptiveParameterRecord(hashPayload);
  const payload = {
    ...hashPayload,
    approvalStatus: input.approvalStatus ?? 'candidate',
    rollbackVersion: input.rollbackVersion ?? null,
    validationMetrics: input.validationMetrics ?? null,
    promotedAt: null as string | null,
    reason: input.reason ?? null,
  };
  return {
    parameterId: `adapt_${input.createdAt.slice(0, 10).replaceAll('-', '')}_${contentHash.slice(0, 12)}`,
    contentHash,
    ...payload,
  };
}

/** Process-local canonical store — DB repository mirrors this at rest. */
const records = new Map<string, AdaptiveParameterRecord>();
let activePromotedId: string | null = null;

export function saveAdaptiveParameterRecord(record: AdaptiveParameterRecord): void {
  if (!verifyAdaptiveParameterRecord(record)) {
    throw new Error('Refusing to save adaptive parameter with invalid content hash');
  }
  records.set(record.parameterId, Object.freeze({ ...record }));
}

export function getAdaptiveParameterRecord(parameterId: string): AdaptiveParameterRecord | null {
  return records.get(parameterId) ?? null;
}

export function listAdaptiveParameterRecords(): AdaptiveParameterRecord[] {
  return [...records.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function getActivePromotedParameter(): AdaptiveParameterRecord | null {
  if (!activePromotedId) return null;
  return records.get(activePromotedId) ?? null;
}

export function setActivePromotedParameter(parameterId: string | null): void {
  activePromotedId = parameterId;
}

export function clearAdaptiveParameterStore(): void {
  records.clear();
  activePromotedId = null;
}
