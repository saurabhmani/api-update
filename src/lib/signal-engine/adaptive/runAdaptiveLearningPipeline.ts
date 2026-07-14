// ════════════════════════════════════════════════════════════════
//  Adaptive Learning Pipeline — Phase 4 + Phase 8 governance
//
//  observe → recommend/candidate → validate → (optional approve) →
//  deploy ONLY via versioned approval. Scheduler never silently
//  rewrites production weights (defaults: auto-approve/promote OFF).
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
  buildCandidateFromSnapshot,
  registerCandidate,
  runValidation,
} from './promotionPipeline';
import { getAdaptiveParameterRecord } from './adaptiveParameterStore';
import { persistAdaptiveParameter, logAdaptiveParameterAuditDb } from './adaptiveParameterRepository';
import { detectDrift, recordDriftAlerts } from './driftDetection';
import { buildPromotionReport, exportPromotionReportBundle } from './promotionReporting';
import { ADAPTIVE_LEARNING_VERSION } from './adaptiveParameterTypes';
import { loadActiveAdaptiveParameterFromDb } from './adaptiveParameterRepository';
import {
  assessOutcomeCompleteness,
  learningMayAutoApprove,
  learningMayAutoPromote,
  applyDriftRestrictions,
  approveAndDeployVersioned,
  recordVersionedApprovalEvent,
  MODEL_GOVERNANCE_VERSION,
} from '../learning/modelGovernance';
import { evaluateChampionChallenger } from '../learning/championChallenger';
import type { StrategyName } from '../types/signalEngine.types';

export interface AdaptivePipelineResult {
  candidates: number;
  validated: number;
  rejected: number;
  approved: number;
  promoted: number;
  driftAlerts: number;
  reportWritten: boolean;
  /** Phase 8 */
  completenessPassed: boolean;
  completenessRate: number;
  championChallengerPromoteReady: boolean;
  governanceVersion: string;
  skippedReason: string | null;
}

export async function runAdaptiveLearningPipeline(input: {
  records: readonly OutcomeAnalyticsRecord[];
  lookbackDays: number;
  createdAt: string;
  priorSnapshot?: ImmutableLearningSnapshot | null;
}): Promise<AdaptivePipelineResult> {
  const outcomes = input.records.map((r) => r.outcome);
  const completeness = assessOutcomeCompleteness(outcomes);

  if (!completeness.passed) {
    await logAdaptiveParameterAuditDb({
      parameterId: 'governance-gate',
      action: 'rejected',
      actor: 'learningScheduler',
      reason:
        `Phase 8 outcome completeness ${completeness.completenessRate} ` +
        `< threshold ${completeness.threshold} — calibration skipped`,
      snapshotId: null,
      metrics: completeness as unknown as Record<string, unknown>,
    });
    return {
      candidates: 0,
      validated: 0,
      rejected: 1,
      approved: 0,
      promoted: 0,
      driftAlerts: 0,
      reportWritten: false,
      completenessPassed: false,
      completenessRate: completeness.completenessRate,
      championChallengerPromoteReady: false,
      governanceVersion: MODEL_GOVERNANCE_VERSION,
      skippedReason: 'outcome_completeness_below_threshold',
    };
  }

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
  let driftReport = input.priorSnapshot
    ? detectDrift(input.priorSnapshot, snapshot, input.createdAt)
    : null;

  if (driftReport) {
    recordDriftAlerts(driftReport);
    driftAlerts = driftReport.alertCount;
    const strategies = Array.from(
      new Set(input.records.map((r) => r.strategy as StrategyName)),
    ).slice(0, 5);
    applyDriftRestrictions(driftReport.alerts, strategies);
  }

  // Material high drift blocks promotion (does not loosen thresholds)
  const highDrift = driftReport?.alerts.some((a) => a.severity === 'high') ?? false;

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

  const cc = evaluateChampionChallenger({
    records: input.records,
    challengerId: candidate.parameterId,
    challengerOverlay: parameters,
    generatedAt: input.createdAt,
  });

  // Observational path: never auto-promote unless BOTH env flags AND
  // versioned approval recording via approveAndDeployVersioned.
  if (validation.validationPassed && !highDrift && cc.promoteReady) {
    if (learningMayAutoApprove() && learningMayAutoPromote()) {
      const { event } = approveAndDeployVersioned({
        parameterId: candidate.parameterId,
        actor: 'learningScheduler',
        reason: 'Explicit env auto-approve+promote with versioned governance event',
        evidence: {
          sampleSize: input.records.length,
          championChallenger: cc.reasons,
          completeness,
        },
        comparison: cc.comparison as unknown as Record<string, unknown>,
        promotedAt: input.createdAt,
      });
      void event;
      approved = 1;
      promoted = 1;
    } else if (learningMayAutoApprove()) {
      // Approve only — still requires separate deploy approval event
      const { approveParameter } = await import('./promotionPipeline');
      approveParameter(
        candidate.parameterId,
        'learningScheduler',
        'Auto-approved (observational) — deploy still requires versioned approval',
      );
      recordVersionedApprovalEvent({
        parameterId: candidate.parameterId,
        action: 'approve',
        actor: 'learningScheduler',
        reason: 'Auto-approved without deploy',
        evidence: { promoteReady: cc.promoteReady },
        comparison: null,
        rollbackTo: null,
      });
      approved = 1;
    }
  }

  const report = buildPromotionReport({
    parameter: updated,
    offlineAb: cc.comparison,
    drift: driftReport,
    generatedAt: input.createdAt,
  });
  const bundle = exportPromotionReportBundle(report);

  const writeReports = (process.env.SIGNAL_ADAPTIVE_WRITE_REPORTS ?? 'true').toLowerCase();
  const shouldWrite = writeReports === '' || writeReports === 'true' || writeReports === '1';

  if (shouldWrite) {
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
    metrics: {
      driftAlerts,
      championChallengerPromoteReady: cc.promoteReady,
      userVisibleArm: cc.userVisibleArm,
      completenessRate: completeness.completenessRate,
      highDriftBlocked: highDrift,
      autoApprove: learningMayAutoApprove(),
      autoPromote: learningMayAutoPromote(),
    },
  });

  return {
    candidates: 1,
    validated: validation.validationPassed ? 1 : 0,
    rejected: validation.validationPassed ? 0 : 1,
    approved,
    promoted,
    driftAlerts,
    reportWritten: shouldWrite,
    completenessPassed: true,
    completenessRate: completeness.completenessRate,
    championChallengerPromoteReady: cc.promoteReady,
    governanceVersion: MODEL_GOVERNANCE_VERSION,
    skippedReason: null,
  };
}

/** Hydrate in-memory store from DB at process start. */
export async function hydrateAdaptiveRuntimeFromDb(): Promise<void> {
  await loadActiveAdaptiveParameterFromDb();
}
