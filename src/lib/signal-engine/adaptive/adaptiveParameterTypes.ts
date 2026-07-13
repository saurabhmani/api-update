// ════════════════════════════════════════════════════════════════
//  Phase 4 — Adaptive Parameter Types
// ════════════════════════════════════════════════════════════════

import type {
  Phase2FeatureThresholds,
  Phase2RejectionThresholds,
} from '../config/signalEnginePhase2Config';

export const ADAPTIVE_PARAMETER_SCHEMA_VERSION = '1.0.0';
export const ADAPTIVE_LEARNING_VERSION = '4.0.0';

export type AdaptiveApprovalStatus =
  | 'candidate'
  | 'validated'
  | 'approved'
  | 'promoted'
  | 'rolled_back'
  | 'archived'
  | 'rejected';

export interface ConfidenceInterval {
  level: number;
  lower: number;
  upper: number;
}

export interface FeatureNormalizationLimits {
  min: number;
  max: number;
}

/** Learned overlay — versioned data only, never code changes. */
export interface AdaptiveParameterValues {
  confidenceOffsets: Record<string, number>;
  qualityThresholds: Partial<Phase2FeatureThresholds>;
  rejectionThresholds: Partial<Phase2RejectionThresholds>;
  minLiquidity: number;
  minAtrPct: number;
  minRewardRisk: number;
  featureNormalizationLimits: FeatureNormalizationLimits;
}

export interface ValidationMetrics {
  sampleSize: number;
  winCount: number;
  winRate: number;
  confidenceInterval: ConfidenceInterval;
  effectSize: number;
  stabilityScore: number;
  outlierRate: number;
  passed: boolean;
  rejectionReasons: string[];
}

export interface AdaptiveParameterRecord {
  parameterId: string;
  schemaVersion: string;
  configurationVersion: string;
  learningVersion: string;
  effectiveDate: string;
  expiryDate: string | null;
  sourceSnapshotId: string;
  trainingWindowDays: number;
  sampleSize: number;
  confidenceInterval: ConfidenceInterval;
  approvalStatus: AdaptiveApprovalStatus;
  rollbackVersion: string | null;
  contentHash: string;
  parameters: AdaptiveParameterValues;
  validationMetrics: ValidationMetrics | null;
  createdAt: string;
  promotedAt: string | null;
  generatedBy: string;
  reason: string | null;
}

export interface AdaptiveAuditEntry {
  auditId: string;
  parameterId: string;
  action:
    | 'generated'
    | 'validated'
    | 'approved'
    | 'promoted'
    | 'rolled_back'
    | 'archived'
    | 'rejected'
    | 'drift_alert';
  actor: string;
  reason: string;
  snapshotId: string | null;
  metrics: Record<string, unknown> | null;
  createdAt: string;
}
