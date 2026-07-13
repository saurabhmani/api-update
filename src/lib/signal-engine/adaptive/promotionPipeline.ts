// ════════════════════════════════════════════════════════════════
//  Phase 4 — Promotion Pipeline
//  Candidate → Validation → Approval → Promotion → Rollback → Archive
// ════════════════════════════════════════════════════════════════

import type { OutcomeAnalyticsRecord } from '../analytics/outcomeAnalytics';
import type { AdaptiveParameterRecord } from './adaptiveParameterTypes';
import {
  buildAdaptiveParameterRecord,
  getAdaptiveParameterRecord,
  saveAdaptiveParameterRecord,
  setActivePromotedParameter,
  getActivePromotedParameter,
} from './adaptiveParameterStore';
import { validateAdaptiveEvidence, type ValidationThresholds } from './statisticalValidation';
import { logAdaptiveAudit } from './learningAudit';
import { invalidateRuntimeConfigCache } from './runtimeConfiguration';

export interface PromotionResult {
  parameterId: string;
  status: AdaptiveParameterRecord['approvalStatus'];
  validationPassed: boolean;
  message: string;
}

function updateRecord(
  parameterId: string,
  patch: Partial<AdaptiveParameterRecord>,
): AdaptiveParameterRecord {
  const existing = getAdaptiveParameterRecord(parameterId);
  if (!existing) throw new Error(`Adaptive parameter not found: ${parameterId}`);
  const merged = { ...existing, ...patch };
  saveAdaptiveParameterRecord(merged);
  return merged;
}

/** Step 1: persist candidate (already built upstream). */
export function registerCandidate(record: AdaptiveParameterRecord): PromotionResult {
  saveAdaptiveParameterRecord(record);
  void logAdaptiveAudit({
    parameterId: record.parameterId,
    action: 'generated',
    actor: record.generatedBy,
    reason: record.reason ?? 'Candidate derived from learning snapshot',
    snapshotId: record.sourceSnapshotId,
    metrics: { sampleSize: record.sampleSize },
  });
  return {
    parameterId: record.parameterId,
    status: 'candidate',
    validationPassed: false,
    message: 'Candidate registered',
  };
}

/** Step 2: statistical validation — reject unstable learning. */
export function runValidation(
  parameterId: string,
  records: readonly OutcomeAnalyticsRecord[],
  thresholds?: ValidationThresholds,
): PromotionResult {
  const existing = getAdaptiveParameterRecord(parameterId);
  if (!existing) throw new Error(`Adaptive parameter not found: ${parameterId}`);
  if (existing.approvalStatus !== 'candidate') {
    return {
      parameterId,
      status: existing.approvalStatus,
      validationPassed: existing.validationMetrics?.passed ?? false,
      message: `Skipped validation — status is ${existing.approvalStatus}`,
    };
  }

  const metrics = validateAdaptiveEvidence(records, thresholds);
  const status = metrics.passed ? 'validated' : 'rejected';
  updateRecord(parameterId, { approvalStatus: status, validationMetrics: metrics });
  void logAdaptiveAudit({
    parameterId,
    action: metrics.passed ? 'validated' : 'rejected',
    actor: 'promotionPipeline',
    reason: metrics.passed
      ? 'Statistical validation passed'
      : metrics.rejectionReasons.join('; '),
    snapshotId: existing.sourceSnapshotId,
    metrics: metrics as unknown as Record<string, unknown>,
  });

  return {
    parameterId,
    status,
    validationPassed: metrics.passed,
    message: metrics.passed ? 'Validation passed' : metrics.rejectionReasons.join('; '),
  };
}

/** Step 3: human or policy approval after validation. */
export function approveParameter(
  parameterId: string,
  actor: string,
  reason: string,
): PromotionResult {
  const existing = getAdaptiveParameterRecord(parameterId);
  if (!existing) throw new Error(`Adaptive parameter not found: ${parameterId}`);
  if (existing.approvalStatus !== 'validated') {
    throw new Error(`Cannot approve parameter in status ${existing.approvalStatus}`);
  }
  updateRecord(parameterId, { approvalStatus: 'approved', reason });
  void logAdaptiveAudit({
    parameterId,
    action: 'approved',
    actor,
    reason,
    snapshotId: existing.sourceSnapshotId,
    metrics: null,
  });
  return { parameterId, status: 'approved', validationPassed: true, message: 'Approved' };
}

/** Step 4: promote — becomes active runtime overlay. */
export function promoteParameter(
  parameterId: string,
  actor: string,
  reason: string,
  promotedAt: string,
): PromotionResult {
  const existing = getAdaptiveParameterRecord(parameterId);
  if (!existing) throw new Error(`Adaptive parameter not found: ${parameterId}`);
  if (existing.approvalStatus !== 'approved') {
    throw new Error(`Cannot promote parameter in status ${existing.approvalStatus}`);
  }
  const prior = getActivePromotedParameter();
  updateRecord(parameterId, {
    approvalStatus: 'promoted',
    promotedAt,
    rollbackVersion: prior?.parameterId ?? null,
  });
  setActivePromotedParameter(parameterId);
  invalidateRuntimeConfigCache();
  void logAdaptiveAudit({
    parameterId,
    action: 'promoted',
    actor,
    reason,
    snapshotId: existing.sourceSnapshotId,
    metrics: { rollbackVersion: prior?.parameterId ?? null },
  });
  return { parameterId, status: 'promoted', validationPassed: true, message: 'Promoted to active' };
}

/** Step 5: rollback to prior promoted version. */
export function rollbackParameter(
  parameterId: string,
  actor: string,
  reason: string,
): PromotionResult {
  const existing = getAdaptiveParameterRecord(parameterId);
  if (!existing) throw new Error(`Adaptive parameter not found: ${parameterId}`);
  if (!existing.rollbackVersion) {
    setActivePromotedParameter(null);
    invalidateRuntimeConfigCache();
    updateRecord(parameterId, { approvalStatus: 'rolled_back', reason });
    void logAdaptiveAudit({
      parameterId,
      action: 'rolled_back',
      actor,
      reason: `${reason} (no prior version — cleared active)`,
      snapshotId: existing.sourceSnapshotId,
      metrics: null,
    });
    return { parameterId, status: 'rolled_back', validationPassed: true, message: 'Rolled back to base config' };
  }

  const prior = getAdaptiveParameterRecord(existing.rollbackVersion);
  if (!prior) throw new Error(`Rollback target not found: ${existing.rollbackVersion}`);
  updateRecord(parameterId, { approvalStatus: 'rolled_back', reason });
  updateRecord(prior.parameterId, { approvalStatus: 'promoted' });
  setActivePromotedParameter(prior.parameterId);
  invalidateRuntimeConfigCache();
  void logAdaptiveAudit({
    parameterId,
    action: 'rolled_back',
    actor,
    reason: `${reason} → ${prior.parameterId}`,
    snapshotId: existing.sourceSnapshotId,
    metrics: { restoredParameterId: prior.parameterId },
  });
  return {
    parameterId,
    status: 'rolled_back',
    validationPassed: true,
    message: `Rolled back to ${prior.parameterId}`,
  };
}

/** Step 6: archive — terminal state, never active. */
export function archiveParameter(
  parameterId: string,
  actor: string,
  reason: string,
): PromotionResult {
  const existing = getAdaptiveParameterRecord(parameterId);
  if (!existing) throw new Error(`Adaptive parameter not found: ${parameterId}`);
  if (existing.approvalStatus === 'promoted' && getActivePromotedParameter()?.parameterId === parameterId) {
    setActivePromotedParameter(null);
    invalidateRuntimeConfigCache();
  }
  updateRecord(parameterId, { approvalStatus: 'archived', reason });
  void logAdaptiveAudit({
    parameterId,
    action: 'archived',
    actor,
    reason,
    snapshotId: existing.sourceSnapshotId,
    metrics: null,
  });
  return { parameterId, status: 'archived', validationPassed: true, message: 'Archived' };
}

export function buildCandidateFromSnapshot(input: {
  configurationVersion: string;
  sourceSnapshotId: string;
  trainingWindowDays: number;
  records: readonly OutcomeAnalyticsRecord[];
  parameters: import('./adaptiveParameterTypes').AdaptiveParameterValues;
  createdAt: string;
  generatedBy?: string;
}): AdaptiveParameterRecord {
  const wins = input.records.filter((r) => r.outcome.target1Hit).length;
  const n = input.records.length;
  const winRate = n === 0 ? 0 : wins / n;
  const margin = n > 0 ? 1.96 * Math.sqrt((winRate * (1 - winRate)) / n) : 0;
  return buildAdaptiveParameterRecord({
    configurationVersion: input.configurationVersion,
    sourceSnapshotId: input.sourceSnapshotId,
    trainingWindowDays: input.trainingWindowDays,
    sampleSize: n,
    confidenceInterval: {
      level: 0.95,
      lower: Math.max(0, winRate - margin),
      upper: Math.min(1, winRate + margin),
    },
    parameters: input.parameters,
    createdAt: input.createdAt,
    effectiveDate: input.createdAt,
    generatedBy: input.generatedBy,
    reason: 'Derived from versioned learning snapshot',
  });
}
