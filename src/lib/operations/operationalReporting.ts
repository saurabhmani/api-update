// ════════════════════════════════════════════════════════════════
//  Phase 5 — Operational Reports (JSON + CSV + Markdown)
// ════════════════════════════════════════════════════════════════

import type { ProductionHealthSummary } from './types';
import type { OperationalAlert } from './types';
import type { DeploymentValidationResult } from './types';
import type { SecurityValidationResult } from './types';
import type { BackupManifest } from './types';
import type { ReleaseManifest } from './types';
import type { OperationalDashboardData } from './types';
import { countAlertsBySeverity } from './operationalAlerts';

export const OPERATIONAL_REPORT_VERSION = '5.0.0';

export interface OperationalReport {
  reportVersion: string;
  generatedAt: string;
  health: ProductionHealthSummary | null;
  dashboard: OperationalDashboardData | null;
  alerts: OperationalAlert[];
  deployment: DeploymentValidationResult | null;
  security: SecurityValidationResult | null;
  backup: BackupManifest | null;
  release: ReleaseManifest | null;
}

export function buildOperationalReport(input: Partial<OperationalReport> & { generatedAt: string }): OperationalReport {
  return {
    reportVersion: OPERATIONAL_REPORT_VERSION,
    generatedAt: input.generatedAt,
    health: input.health ?? null,
    dashboard: input.dashboard ?? null,
    alerts: input.alerts ?? [],
    deployment: input.deployment ?? null,
    security: input.security ?? null,
    backup: input.backup ?? null,
    release: input.release ?? null,
  };
}

export function operationalReportToJson(report: OperationalReport): string {
  return JSON.stringify(report, null, 2);
}

function escapeCsv(v: string): string {
  if (v.includes(',') || v.includes('"')) return `"${v.replace(/"/g, '""')}"`;
  return v;
}

export function operationalReportToCsv(report: OperationalReport): string {
  const rows: string[][] = [
    ['section', 'key', 'value'],
    ['meta', 'generatedAt', report.generatedAt],
    ['meta', 'overallStatus', report.health?.overallStatus ?? ''],
    ['meta', 'alertCount', String(report.alerts.length)],
    ['meta', 'deploymentPassed', String(report.deployment?.passed ?? '')],
    ['meta', 'securityPassed', String(report.security?.passed ?? '')],
  ];
  if (report.health) {
    for (const c of report.health.components) {
      rows.push(['component', c.component, c.status]);
    }
  }
  return rows.map((r) => r.map(escapeCsv).join(',')).join('\n');
}

export function operationalReportToMarkdown(report: OperationalReport): string {
  const lines = [
    '# Product A — Operational Report',
    '',
    `Generated: ${report.generatedAt}`,
    `Report version: ${report.reportVersion}`,
    '',
  ];

  if (report.health) {
    lines.push('## System Health', `- Overall: **${report.health.overallStatus}**`, '');
    for (const c of report.health.components) {
      lines.push(`- ${c.component}: ${c.status}${c.message ? ` — ${c.message}` : ''}`);
    }
    lines.push('');
  }

  if (report.alerts.length > 0) {
    const counts = countAlertsBySeverity(report.alerts);
    lines.push('## Alerts', `- Critical: ${counts.critical}`, `- Warning: ${counts.warning}`, `- Resolved: ${counts.resolved}`, '');
    for (const a of report.alerts) {
      lines.push(`- [${a.severity}] ${a.title}: ${a.detail}`);
    }
    lines.push('');
  }

  if (report.deployment) {
    lines.push('## Deployment Validation', `- Status: **${report.deployment.passed ? 'PASSED' : 'BLOCKED'}**`, '');
  }

  if (report.security) {
    lines.push('## Security Validation', `- Status: **${report.security.passed ? 'PASSED' : 'FAILED'}**`, '');
  }

  if (report.release) {
    lines.push(
      '## Release Readiness',
      `- Build: ${report.release.buildVersion}`,
      `- Git: ${report.release.gitCommit ?? 'unknown'}`,
      `- Validation: ${report.release.validationStatus}`,
      '',
    );
  }

  if (report.dashboard) {
    lines.push(
      '## Operational KPIs',
      `- Signals/day: ${report.dashboard.signalsPerDay}`,
      `- Scheduler: ${report.dashboard.schedulerHealth}`,
      `- Runtime config: ${report.dashboard.runtimeConfigurationVersion}`,
      `- Active adaptive: ${report.dashboard.activeAdaptiveVersion ?? 'none'}`,
      '',
    );
  }

  return lines.join('\n');
}

export function exportOperationalReportBundle(report: OperationalReport): {
  json: string;
  csv: string;
  markdown: string;
} {
  return {
    json: operationalReportToJson(report),
    csv: operationalReportToCsv(report),
    markdown: operationalReportToMarkdown(report),
  };
}
