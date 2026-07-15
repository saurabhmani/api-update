// ════════════════════════════════════════════════════════════════
//  Phase 7 — Research Reports (JSON + CSV + Markdown)
// ════════════════════════════════════════════════════════════════

import type { ExperimentRecord } from '../types';
import type { BenchmarkComparison } from '../benchmarks/benchmarkFramework';
import type { FeatureImportanceResult } from '../ai/researchAi';

export interface ResearchReportBundle {
  experiment: ExperimentRecord;
  benchmark: BenchmarkComparison | null;
  featureImportance: FeatureImportanceResult | null;
  parameterSensitivity: Array<{ parameter: string; value: number; score: number }>;
}

export function buildResearchReportBundle(input: ResearchReportBundle): ResearchReportBundle {
  return input;
}

export function researchReportToJson(bundle: ResearchReportBundle): string {
  return JSON.stringify(bundle, null, 2);
}

function escapeCsv(v: string): string {
  if (v.includes(',') || v.includes('"')) return `"${v.replace(/"/g, '""')}"`;
  return v;
}

export function researchReportToCsv(bundle: ResearchReportBundle): string {
  const rows = [
    ['field', 'value'],
    ['experimentId', bundle.experiment.experimentId],
    ['author', bundle.experiment.author],
    ['status', bundle.experiment.status],
    ['datasetId', bundle.experiment.datasetId],
    ['randomSeed', String(bundle.experiment.randomSeed)],
  ];
  if (bundle.experiment.result) {
    for (const [k, v] of Object.entries(bundle.experiment.result.metrics)) {
      rows.push([`metric_${k}`, String(v)]);
    }
  }
  return rows.map((r) => r.map(escapeCsv).join(',')).join('\n');
}

export function researchReportToMarkdown(bundle: ResearchReportBundle): string {
  const exp = bundle.experiment;
  const lines = [
    '# Research Experiment Report',
    '',
    `**ID:** ${exp.experimentId}`,
    `**Author:** ${exp.author}`,
    `**Status:** ${exp.status}`,
    `**Dataset:** ${exp.datasetId}`,
    `**Seed:** ${exp.randomSeed}`,
    `**Git:** ${exp.gitCommit ?? 'n/a'}`,
    `**Config:** ${exp.configurationVersion}`,
    '',
    '## Description',
    exp.description,
    '',
    '## Features',
    ...exp.features.map((f) => `- ${f}`),
  ];

  if (exp.result) {
    lines.push('', '## Metrics');
    for (const [k, v] of Object.entries(exp.result.metrics)) {
      lines.push(`- ${k}: ${v}`);
    }
    lines.push(`- trades: ${exp.result.tradeCount}`);
  }

  if (bundle.benchmark) {
    lines.push('', '## Benchmark Comparison');
    lines.push(`- Recommendation: **${bundle.benchmark.recommendation}**`);
    lines.push(`- Sharpe delta: ${bundle.benchmark.deltas.sharpe.toFixed(3)}`);
    lines.push(`- Max DD delta: ${bundle.benchmark.deltas.maxDrawdown.toFixed(3)}`);
  }

  if (bundle.featureImportance) {
    lines.push('', '## Feature Importance');
    for (const r of bundle.featureImportance.rankings.slice(0, 5)) {
      lines.push(`- ${r.feature}: ${r.importance} — ${r.explanation}`);
    }
  }

  if (bundle.parameterSensitivity.length > 0) {
    lines.push('', '## Parameter Sensitivity');
    for (const p of bundle.parameterSensitivity) {
      lines.push(`- ${p.parameter}=${p.value} → score ${p.score}`);
    }
  }

  lines.push('', '---', '*Research output — not promoted to production automatically.*');
  return lines.join('\n');
}

export function exportResearchReportBundle(bundle: ResearchReportBundle): {
  json: string;
  csv: string;
  markdown: string;
} {
  return {
    json: researchReportToJson(bundle),
    csv: researchReportToCsv(bundle),
    markdown: researchReportToMarkdown(bundle),
  };
}
