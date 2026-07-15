// ════════════════════════════════════════════════════════════════
//  Phase 8 — Portfolio Reporting (JSON + CSV + Markdown)
// ════════════════════════════════════════════════════════════════

import type { PortfolioRecord } from '../types';
import type { PortfolioSnapshot } from '../engine/portfolioEngine';
import type { RiskMetrics, ExecutionPlan, StressScenario, PortfolioAnalyticsReport, PortfolioRecommendation } from '../types';
import type { AllocationPlan } from '../types';
import type { RecommendationExplanation } from '../types';

export interface PortfolioReportBundle {
  portfolio: PortfolioRecord;
  snapshot: PortfolioSnapshot;
  risk: RiskMetrics;
  allocation?: AllocationPlan;
  execution?: ExecutionPlan;
  stress?: StressScenario[];
  analytics?: PortfolioAnalyticsReport;
  recommendation?: PortfolioRecommendation;
  explanations?: RecommendationExplanation[];
}

function escapeCsv(v: string): string {
  if (v.includes(',') || v.includes('"')) return `"${v.replace(/"/g, '""')}"`;
  return v;
}

export function portfolioReportToJson(bundle: PortfolioReportBundle): string {
  return JSON.stringify(bundle, null, 2);
}

export function portfolioReportToCsv(bundle: PortfolioReportBundle): string {
  const rows: string[][] = [
    ['field', 'value'],
    ['portfolioId', bundle.portfolio.portfolioId],
    ['capital', String(bundle.portfolio.capital)],
    ['cash', String(bundle.portfolio.cash)],
    ['realizedPnl', String(bundle.portfolio.realizedPnl)],
    ['unrealizedPnl', String(bundle.portfolio.unrealizedPnl)],
    ['volatility', String(bundle.risk.portfolioVolatility)],
    ['var95', String(bundle.risk.valueAtRisk95)],
    ['maxDrawdown', String(bundle.risk.maxDrawdown)],
  ];
  for (const [k, v] of Object.entries(bundle.snapshot.allocations)) {
    rows.push([`allocation_${k}`, String(v)]);
  }
  return rows.map((r) => r.map(escapeCsv).join(',')).join('\n');
}

export function portfolioReportToMarkdown(bundle: PortfolioReportBundle): string {
  const lines = [
    '# Portfolio Intelligence Report',
    '',
    `**Portfolio:** ${bundle.portfolio.name} (${bundle.portfolio.portfolioId})`,
    `**Owner:** ${bundle.portfolio.owner}`,
    `**Capital:** ${bundle.portfolio.capital.toLocaleString()}`,
    `**Cash:** ${bundle.portfolio.cash.toLocaleString()}`,
    `**Buying Power:** ${bundle.portfolio.availableBuyingPower.toLocaleString()}`,
    '',
    '## Risk Summary',
    `- Volatility: ${(bundle.risk.portfolioVolatility * 100).toFixed(2)}%`,
    `- VaR(95): ${(bundle.risk.valueAtRisk95 * 100).toFixed(2)}%`,
    `- CVaR(95): ${(bundle.risk.conditionalVaR95 * 100).toFixed(2)}%`,
    `- Max drawdown: ${(bundle.risk.maxDrawdown * 100).toFixed(2)}%`,
    `- Beta: ${bundle.risk.beta}`,
    `- Concentration (HHI): ${bundle.risk.concentrationHhi}`,
  ];

  if (bundle.allocation) {
    lines.push('', '## Allocation Plan', `Method: ${bundle.allocation.method}`, bundle.allocation.explanation);
    for (const [sym, w] of Object.entries(bundle.allocation.weights)) {
      lines.push(`- ${sym}: ${(w * 100).toFixed(1)}%`);
    }
  }

  if (bundle.execution) {
    lines.push('', '## Execution Plan', bundle.execution.explanation);
    for (const b of bundle.execution.batches) {
      lines.push(`- [${b.batchId}] ${b.direction} ${b.symbol} x${b.quantity} (~${b.estimatedCapital})`);
    }
  }

  if (bundle.stress?.length) {
    lines.push('', '## Stress Scenarios');
    for (const s of bundle.stress) {
      lines.push(`- ${s.label}: ${s.portfolioImpactPct}% — ${s.explanation}`);
    }
  }

  if (bundle.explanations?.length) {
    lines.push('', '## Recommendations');
    for (const e of bundle.explanations.filter((x) => x.selected)) {
      lines.push(`- **${e.symbol}**: ${e.whySelected}`);
      lines.push(`  - Capital: ${e.capitalImpact}`);
      lines.push(`  - Risk: ${e.riskImpact}`);
    }
    const rejected = bundle.explanations.filter((x) => !x.selected);
    if (rejected.length > 0) {
      lines.push('', '### Rejected');
      for (const e of rejected.slice(0, 5)) {
        lines.push(`- ${e.symbol}: ${e.whyRejected}`);
      }
    }
  }

  lines.push('', '---', '*Portfolio recommendations — not auto-executed.*');
  return lines.join('\n');
}

export function exportPortfolioReportBundle(bundle: PortfolioReportBundle): {
  json: string;
  csv: string;
  markdown: string;
} {
  return {
    json: portfolioReportToJson(bundle),
    csv: portfolioReportToCsv(bundle),
    markdown: portfolioReportToMarkdown(bundle),
  };
}
