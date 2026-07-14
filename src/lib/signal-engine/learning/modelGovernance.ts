// ════════════════════════════════════════════════════════════════
//  Phase 8 — Model governance
//
//  observe → recommend → validate OOS → compare → approve →
//  deploy versioned config → monitor
//
//  Nightly learning MUST NOT silently rewrite production weights.
// ════════════════════════════════════════════════════════════════

import type { AdaptiveRecommendation, SignalOutcome } from '../types/phase4.types';
import type { StrategyName } from '../types/signalEngine.types';
import {
  setStrategyHealthManual,
  getLatestStrategyHealth,
  type StrategyHealthSnapshot,
} from '../governance/strategyHealth';
import type { DriftAlert } from '../adaptive/driftDetection';
import {
  getActivePromotedParameter,
  getAdaptiveParameterRecord,
} from '../adaptive/adaptiveParameterStore';
import {
  approveParameter,
  promoteParameter,
  rollbackParameter,
  type PromotionResult,
} from '../adaptive/promotionPipeline';
import { logAdaptiveAudit } from '../adaptive/learningAudit';

export const MODEL_GOVERNANCE_VERSION = '8.0.0';

/** Completeness fields required before calibration may run. */
export const REQUIRED_OUTCOME_LIFECYCLE_FIELDS: Array<keyof SignalOutcome> = [
  'entryTriggered',
  'barsToEntry',
  'timeToTargetBars',
  'timeToStopBars',
  'maxFavorableExcursionPct',
  'maxAdverseExcursionPct',
  'exitReason',
  'holdingDurationBars',
  'entryTimestamp',
  'resolutionTimestamp',
  'signalStateAtResolution',
  'barsUnresolved',
];

export interface OutcomeCompletenessReport {
  modelVersion: string;
  total: number;
  complete: number;
  completenessRate: number;
  /** Default approved threshold. */
  threshold: number;
  passed: boolean;
  missingFieldCounts: Record<string, number>;
}

export function assessOutcomeCompleteness(
  outcomes: readonly SignalOutcome[],
  threshold = 0.85,
): OutcomeCompletenessReport {
  const missingFieldCounts: Record<string, number> = {};
  for (const f of REQUIRED_OUTCOME_LIFECYCLE_FIELDS) missingFieldCounts[String(f)] = 0;

  const isPresent = (v: unknown) => v !== undefined && v !== null && v !== '';

  let complete = 0;
  for (const o of outcomes) {
    const checks: Array<[string, boolean]> = [
      ['entryTriggered', o.entryTriggered !== undefined && o.entryTriggered !== null],
      ['barsToEntry', o.barsToEntry !== undefined], // null allowed if not triggered
      ['timeToTargetBars', true], // nullable when target not hit
      ['timeToStopBars', true],
      ['maxFavorableExcursionPct', isPresent(o.maxFavorableExcursionPct)],
      ['maxAdverseExcursionPct', isPresent(o.maxAdverseExcursionPct)],
      ['exitReason', isPresent(o.exitReason)],
      ['holdingDurationBars', o.holdingDurationBars !== undefined && o.holdingDurationBars !== null],
      ['entryTimestamp', isPresent(o.entryTimestamp)],
      ['resolutionTimestamp', isPresent(o.resolutionTimestamp)],
      ['signalStateAtResolution', isPresent(o.signalStateAtResolution)],
      ['barsUnresolved', o.barsUnresolved !== undefined && o.barsUnresolved !== null],
    ];
    let ok = true;
    for (const [key, passed] of checks) {
      if (!passed) {
        missingFieldCounts[key] = (missingFieldCounts[key] ?? 0) + 1;
        ok = false;
      }
    }
    if (ok) complete++;
  }

  const total = outcomes.length;
  const completenessRate = total === 0 ? 0 : complete / total;
  return {
    modelVersion: MODEL_GOVERNANCE_VERSION,
    total,
    complete,
    completenessRate: Math.round(completenessRate * 1000) / 1000,
    threshold,
    passed: total > 0 && completenessRate >= threshold,
    missingFieldCounts,
  };
}

/** Env policy — auto promote/approve default OFF. */
export function learningMayAutoApprove(): boolean {
  return envBool('SIGNAL_ADAPTIVE_AUTO_APPROVE', false);
}

export function learningMayAutoPromote(): boolean {
  // Even if approve is on, promote stays off unless explicitly enabled.
  return envBool('SIGNAL_ADAPTIVE_AUTO_PROMOTE', false) && learningMayAutoApprove();
}

function envBool(name: string, fallback: boolean): boolean {
  const raw = (process.env[name] ?? '').trim().toLowerCase();
  if (raw === '') return fallback;
  return raw === 'true' || raw === '1' || raw === 'yes' || raw === 'on';
}

export interface VersionedApprovalEvent {
  eventId: string;
  parameterId: string;
  action: 'approve' | 'deploy' | 'rollback' | 'reject';
  actor: string;
  reason: string;
  evidence: Record<string, unknown>;
  comparison: Record<string, unknown> | null;
  rollbackTo: string | null;
  createdAt: string;
  modelVersion: string;
}

const APPROVAL_EVENTS: VersionedApprovalEvent[] = [];

export function recordVersionedApprovalEvent(
  event: Omit<VersionedApprovalEvent, 'eventId' | 'createdAt' | 'modelVersion'>,
): VersionedApprovalEvent {
  const full: VersionedApprovalEvent = {
    ...event,
    eventId: `gov_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    createdAt: new Date().toISOString(),
    modelVersion: MODEL_GOVERNANCE_VERSION,
  };
  APPROVAL_EVENTS.push(full);
  void logAdaptiveAudit({
    parameterId: event.parameterId,
    action: event.action === 'deploy' ? 'promoted' : event.action === 'rollback' ? 'rolled_back' : event.action === 'approve' ? 'approved' : 'rejected',
    actor: event.actor,
    reason: `[governance] ${event.reason}`,
    snapshotId: null,
    metrics: { ...event.evidence, comparison: event.comparison, rollbackTo: event.rollbackTo },
  });
  return full;
}

export function getVersionedApprovalEvents(parameterId?: string): VersionedApprovalEvent[] {
  return parameterId
    ? APPROVAL_EVENTS.filter((e) => e.parameterId === parameterId)
    : [...APPROVAL_EVENTS];
}

/**
 * Deploy only after an explicit versioned approval event.
 * Scheduler must not call this without actor/reason evidence.
 */
export function approveAndDeployVersioned(input: {
  parameterId: string;
  actor: string;
  reason: string;
  evidence: Record<string, unknown>;
  comparison: Record<string, unknown> | null;
  promotedAt?: string;
}): { approval: PromotionResult; deploy: PromotionResult; event: VersionedApprovalEvent } {
  const approval = approveParameter(input.parameterId, input.actor, input.reason);
  recordVersionedApprovalEvent({
    parameterId: input.parameterId,
    action: 'approve',
    actor: input.actor,
    reason: input.reason,
    evidence: input.evidence,
    comparison: input.comparison,
    rollbackTo: null,
  });
  const deploy = promoteParameter(
    input.parameterId,
    input.actor,
    input.reason,
    input.promotedAt ?? new Date().toISOString(),
  );
  const prior = getAdaptiveParameterRecord(input.parameterId)?.rollbackVersion ?? null;
  const event = recordVersionedApprovalEvent({
    parameterId: input.parameterId,
    action: 'deploy',
    actor: input.actor,
    reason: input.reason,
    evidence: input.evidence,
    comparison: input.comparison,
    rollbackTo: prior,
  });
  return { approval, deploy, event };
}

export function rollbackVersioned(input: {
  parameterId: string;
  actor: string;
  reason: string;
}): { result: PromotionResult; event: VersionedApprovalEvent } {
  const existing = getAdaptiveParameterRecord(input.parameterId);
  const result = rollbackParameter(input.parameterId, input.actor, input.reason);
  const event = recordVersionedApprovalEvent({
    parameterId: input.parameterId,
    action: 'rollback',
    actor: input.actor,
    reason: input.reason,
    evidence: { previousStatus: existing?.approvalStatus },
    comparison: null,
    rollbackTo: existing?.rollbackVersion ?? null,
  });
  return { result, event };
}

/** Material drift → restrict strategy / elite — never loosen thresholds. */
export function applyDriftRestrictions(
  alerts: readonly DriftAlert[],
  strategyHints: StrategyName[] = [],
): StrategyHealthSnapshot[] {
  const material = alerts.filter((a) => a.severity === 'high' || a.severity === 'medium');
  if (material.length === 0) return [];

  const snaps: StrategyHealthSnapshot[] = [];
  const targets = strategyHints.length
    ? strategyHints
    : (['bullish_breakout'] as StrategyName[]); // safe default for audit call sites with no strategy list

  for (const strategy of targets) {
    const prev = getLatestStrategyHealth(strategy);
    const snap = setStrategyHealthManual(
      strategy,
      material.some((a) => a.severity === 'high') ? 'Restricted' : 'Watch',
      `Phase 8 drift restriction: ${material.map((a) => a.category).join(', ')} — promotion blocked, thresholds not loosened`,
      prev,
    );
    snaps.push(snap);
  }
  return snaps;
}

/** Recommendations are observational until approved — never applied as live weights here. */
export function assertRecommendationIsObservational(rec: AdaptiveRecommendation): {
  observational: true;
  appliesToProduction: false;
  detail: string;
} {
  return {
    observational: true,
    appliesToProduction: false,
    detail:
      `Recommendation modifier ${rec.recommendedConfidenceModifier} is observational ` +
      `(n=${rec.sampleSize}, strength=${rec.evidenceStrength}). ` +
      `Production requires versioned approval/deploy.`,
  };
}

export function getChampionParameterId(): string | null {
  return getActivePromotedParameter()?.parameterId ?? null;
}

export function __resetGovernanceEventsForTests(): void {
  APPROVAL_EVENTS.length = 0;
}
