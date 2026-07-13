// ════════════════════════════════════════════════════════════════
//  Phase 4 — Promotion Reports (JSON + CSV + Markdown)
// ════════════════════════════════════════════════════════════════

import type { AdaptiveParameterRecord } from './adaptiveParameterTypes';
import type { OfflineAbComparison } from './offlineAbEvaluation';
import type { DriftDetectionReport } from './driftDetection';
import { getAdaptiveAuditTrail } from './learningAudit';

export interface PromotionReport {
  reportVersion: string;
  generatedAt: string;
  parameter: AdaptiveParameterRecord;
  learningSummary: {
    sourceSnapshotId: string;
    trainingWindowDays: number;
    sampleSize: number;
    configurationVersion: string;
    learningVersion: string;
  };
  parameterChanges: Record<string, unknown>;
  validationMetrics: AdaptiveParameterRecord['validationMetrics'];
  promotionDecision: {
    status: AdaptiveParameterRecord['approvalStatus'];
    canPromote: boolean;
    canRollback: boolean;
    rollbackVersion: string | null;
  };
  offlineAb: OfflineAbComparison | null;
  drift: DriftDetectionReport | null;
  auditTrail: ReturnType<typeof getAdaptiveAuditTrail>;
}

export function buildPromotionReport(input: {
  parameter: AdaptiveParameterRecord;
  offlineAb?: OfflineAbComparison | null;
  drift?: DriftDetectionReport | null;
  generatedAt?: string;
}): PromotionReport {
  const { parameter } = input;
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  return {
    reportVersion: '4.0.0',
    generatedAt,
    parameter,
    learningSummary: {
      sourceSnapshotId: parameter.sourceSnapshotId,
      trainingWindowDays: parameter.trainingWindowDays,
      sampleSize: parameter.sampleSize,
      configurationVersion: parameter.configurationVersion,
      learningVersion: parameter.learningVersion,
    },
    parameterChanges: parameter.parameters as unknown as Record<string, unknown>,
    validationMetrics: parameter.validationMetrics,
    promotionDecision: {
      status: parameter.approvalStatus,
      canPromote: parameter.approvalStatus === 'approved',
      canRollback: parameter.approvalStatus === 'promoted' && parameter.rollbackVersion != null,
      rollbackVersion: parameter.rollbackVersion,
    },
    offlineAb: input.offlineAb ?? null,
    drift: input.drift ?? null,
    auditTrail: getAdaptiveAuditTrail(parameter.parameterId),
  };
}

export function promotionReportToJson(report: PromotionReport): string {
  return JSON.stringify(report, null, 2);
}

export function promotionReportToCsv(report: PromotionReport): string {
  const rows = [
    ['field', 'value'],
    ['parameterId', report.parameter.parameterId],
    ['status', report.parameter.approvalStatus],
    ['contentHash', report.parameter.contentHash],
    ['sampleSize', String(report.parameter.sampleSize)],
    ['validationPassed', String(report.validationMetrics?.passed ?? false)],
    ['winRate', String(report.validationMetrics?.winRate ?? '')],
    ['stabilityScore', String(report.validationMetrics?.stabilityScore ?? '')],
    ['rollbackVersion', report.parameter.rollbackVersion ?? ''],
    ['offlineAbRecommendation', report.offlineAb?.recommendation ?? ''],
    ['driftAlertCount', String(report.drift?.alertCount ?? 0)],
  ];
  return rows.map((row) => row.map(escapeCsv).join(',')).join('\n');
}

function escapeCsv(value: string): string {
  if (value.includes(',') || value.includes('"') || value.includes('\n')) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

export function promotionReportToMarkdown(report: PromotionReport): string {
  const v = report.validationMetrics;
  const lines = [
    '# Product A — Adaptive Parameter Promotion Report',
    '',
    `Generated: ${report.generatedAt}`,
    '',
    '## Learning Summary',
    `- Parameter ID: \`${report.parameter.parameterId}\``,
    `- Source snapshot: \`${report.learningSummary.sourceSnapshotId}\``,
    `- Sample size: ${report.learningSummary.sampleSize}`,
    `- Configuration: ${report.learningSummary.configurationVersion}`,
  ];

  lines.push('', '## Parameter Changes', '```json', JSON.stringify(report.parameterChanges, null, 2), '```');

  lines.push('', '## Validation Metrics');
  if (v) {
    lines.push(
      `- Passed: **${v.passed}**`,
      `- Win rate: ${(v.winRate * 100).toFixed(1)}% (${v.winCount}/${v.sampleSize})`,
      `- CI [${v.confidenceInterval.lower}, ${v.confidenceInterval.upper}]`,
      `- Effect size: ${v.effectSize}`,
      `- Stability: ${v.stabilityScore}`,
      `- Outlier rate: ${v.outlierRate}`,
    );
    if (v.rejectionReasons.length > 0) {
      lines.push(`- Rejection reasons: ${v.rejectionReasons.join('; ')}`);
    }
  } else {
    lines.push('- Not yet validated');
  }

  lines.push('', '## Promotion Decision');
  lines.push(
    `- Status: **${report.promotionDecision.status}**`,
    `- Can promote: ${report.promotionDecision.canPromote}`,
    `- Can rollback: ${report.promotionDecision.canRollback}`,
    `- Rollback version: ${report.promotionDecision.rollbackVersion ?? 'none'}`,
  );

  if (report.offlineAb) {
    lines.push('', '## Offline A/B');
    lines.push(
      `- Recommendation: **${report.offlineAb.recommendation}**`,
      `- Win rate delta: ${(report.offlineAb.deltas.winRate * 100).toFixed(2)}pp`,
      `- Return delta: ${report.offlineAb.deltas.avgReturn.toFixed(3)}`,
    );
  }

  if (report.drift && report.drift.alertCount > 0) {
    lines.push('', '## Drift Alerts');
    for (const a of report.drift.alerts) {
      lines.push(`- [${a.severity}] ${a.category}: ${a.message}`);
    }
  }

  lines.push('', '## Rollback Capability');
  lines.push(
    report.promotionDecision.canRollback
      ? `Rollback available to \`${report.promotionDecision.rollbackVersion}\`.`
      : 'No prior promoted version — rollback clears adaptive overlay.',
  );

  return lines.join('\n');
}

export function exportPromotionReportBundle(report: PromotionReport): {
  json: string;
  csv: string;
  markdown: string;
} {
  return {
    json: promotionReportToJson(report),
    csv: promotionReportToCsv(report),
    markdown: promotionReportToMarkdown(report),
  };
}
