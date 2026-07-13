// ════════════════════════════════════════════════════════════════
//  Phase 4 — Adaptive Learning Pipeline (scheduler integration)
// ════════════════════════════════════════════════════════════════

import type { OutcomeAnalyticsRecord } from '../analytics/outcomeAnalytics';
import { OUTCOME_INTELLIGENCE_VERSION } from '../feedback/outcomeTracker';
import { PERFORMANCE_REPORT_VERSION } from '../analytics/performanceReporting';
import { getSignalEngineConfig } from '../config/signalEnginePhase2Config';
import {
  createLearningSnapshot,
  type ImmutableLearningSnapshot,
} from '../learning/versionedLearningSnapshots';
import { deriveCandidateParameters } from './deriveCandidateParameters';
import {
  approveParameter,
  buildCandidateFromSnapshot,
  promoteParameter,
  registerCandidate,
  runValidation,
} from './promotionPipeline';
import { getAdaptiveParameterRecord } from './adaptiveParameterStore';
import { persistAdaptiveParameter, activateAdaptiveParameterPointer, logAdaptiveParameterAuditDb } from './adaptiveParameterRepository';
import { detectDrift, recordDriftAlerts } from './driftDetection';
import { runOfflineAbComparison } from './offlineAbEvaluation';
import { buildPromotionReport, exportPromotionReportBundle } from './promotionReporting';
import { ADAPTIVE_LEARNING_VERSION } from './adaptiveParameterTypes';
import { loadActiveAdaptiveParameterFromDb } from './adaptiveParameterRepository';

function envBool(name: string, fallback: boolean): boolean {
  const raw = (process.env[name] ?? '').trim().toLowerCase();
  if (raw === '') return fallback;
  return raw === 'true' || raw === '1' || raw === 'yes' || raw === 'on';
}

export interface AdaptivePipelineResult {
  candidates: number;
  validated: number;
  rejected: number;
  approved: number;
  promoted: number;
  driftAlerts: number;
  reportWritten: boolean;
}

export async function runAdaptiveLearningPipeline(input: {
  records: readonly OutcomeAnalyticsRecord[];
  lookbackDays: number;
  createdAt: string;
  priorSnapshot?: ImmutableLearningSnapshot | null;
}): Promise<AdaptivePipelineResult> {
  const config = getSignalEngineConfig();
  const snapshot = createLearningSnapshot({
    records: input.records,
    createdAt: input.createdAt,
    lookbackDays: input.lookbackDays,
    versions: {
      configurationVersion: config.configVersionLabel,
      featureVersion: '2.0.0',
      confidenceVersion: '2.0.0',
      learningVersion: ADAPTIVE_LEARNING_VERSION,
      benchmarkVersion: PERFORMANCE_REPORT_VERSION,
      outcomeVersion: OUTCOME_INTELLIGENCE_VERSION,
    },
  });

  let driftAlerts = 0;
  if (input.priorSnapshot) {
    const drift = detectDrift(input.priorSnapshot, snapshot, input.createdAt);
    recordDriftAlerts(drift);
    driftAlerts = drift.alertCount;
  }

  const parameters = deriveCandidateParameters(snapshot);
  const candidate = buildCandidateFromSnapshot({
    configurationVersion: config.configVersionLabel,
    sourceSnapshotId: snapshot.snapshotId,
    trainingWindowDays: input.lookbackDays,
    records: input.records,
    parameters,
    createdAt: input.createdAt,
    generatedBy: 'learningScheduler',
  });

  await persistAdaptiveParameter(candidate);
  registerCandidate(candidate);

  const validation = runValidation(candidate.parameterId, input.records);
  const updated = getAdaptiveParameterRecord(candidate.parameterId) ?? candidate;
  let approved = 0;
  let promoted = 0;

  const offlineAb = runOfflineAbComparison({
    records: input.records,
    candidateOverlay: parameters,
    generatedAt: input.createdAt,
  });

  const drift = input.priorSnapshot
    ? detectDrift(input.priorSnapshot, snapshot, input.createdAt)
    : null;

  if (validation.validationPassed) {
    if (envBool('SIGNAL_ADAPTIVE_AUTO_APPROVE', false)) {
      approveParameter(candidate.parameterId, 'learningScheduler', 'Auto-approved after validation');
      approved = 1;
      if (envBool('SIGNAL_ADAPTIVE_AUTO_PROMOTE', false) && offlineAb.recommendation !== 'base') {
        promoteParameter(candidate.parameterId, 'learningScheduler', 'Auto-promoted after validation + A/B', input.createdAt);
        await activateAdaptiveParameterPointer(candidate.parameterId, 'learningScheduler');
        promoted = 1;
      }
    }
  }

  const report = buildPromotionReport({
    parameter: updated,
    offlineAb,
    drift,
    generatedAt: input.createdAt,
  });
  const bundle = exportPromotionReportBundle(report);

  if (envBool('SIGNAL_ADAPTIVE_WRITE_REPORTS', true)) {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const dir = path.join(process.cwd(), 'reports', 'adaptive-learning');
    await fs.mkdir(dir, { recursive: true });
    const base = path.join(dir, candidate.parameterId);
    await fs.writeFile(`${base}.json`, bundle.json);
    await fs.writeFile(`${base}.csv`, bundle.csv);
    await fs.writeFile(`${base}.md`, bundle.markdown);
  }

  await logAdaptiveParameterAuditDb({
    parameterId: candidate.parameterId,
    action: validation.validationPassed ? 'validated' : 'rejected',
    actor: 'learningScheduler',
    reason: validation.message,
    snapshotId: snapshot.snapshotId,
    metrics: { driftAlerts, offlineAbRecommendation: offlineAb.recommendation },
  });

  return {
    candidates: 1,
    validated: validation.validationPassed ? 1 : 0,
    rejected: validation.validationPassed ? 0 : 1,
    approved,
    promoted,
    driftAlerts,
    reportWritten: envBool('SIGNAL_ADAPTIVE_WRITE_REPORTS', true),
  };
}

/** Hydrate in-memory store from DB at process start. */
export async function hydrateAdaptiveRuntimeFromDb(): Promise<void> {
  await loadActiveAdaptiveParameterFromDb();
}
