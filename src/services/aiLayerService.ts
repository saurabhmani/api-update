// ════════════════════════════════════════════════════════════════
//  Controlled AI Layer — Phase 12
//
//  AI makes the platform easier to understand, but never becomes
//  the final authority on approvals or policy.
//
//  Valid: explain, summarize, narrate, draft PM notes
//  Invalid: override limits, bypass governance, approve trades
//
//  Services:
//    - aiExplanationService   (explain opportunity / risk)
//    - aiSummarizationService (summarize scenario results)
//    - aiInsightFormatter     (format for display)
// ════════════════════════════════════════════════════════════════

import { db } from '@/lib/db';
import { logger } from '@/lib/logger';
import { computeExposure, computeConcentration, computeDrawdown, type RiskMetric } from './riskCoreService';
import { runScenario, type ScenarioResult } from './scenarioStressService';
import { listDecisionTraces, getDecisionTraceById, type DecisionTrace } from './decisionTraceBuilder';
import { sanitizeAIOutput, type AIOperation, type SanitizedAIOutput } from './aiBoundary';

const log = logger.child({ service: 'aiLayer' });

// ── Types ───────────────────────────────────────────────────────

export interface AIExplanation {
  subject: string;
  summary: string;
  sections: { heading: string; body: string }[];
  confidenceTone: 'high' | 'moderate' | 'low';
  disclaimer: string;
  generatedAt: string;
}

// Every AI return funnels through this wrapper. The boundary strips
// any forbidden fields (decision/risk/governance) before exposure.
function enforceBoundary(operation: AIOperation, payload: AIExplanation): SanitizedAIOutput {
  return sanitizeAIOutput({ operation, ...payload }, { strict: false });
}

// ── AI Explanation Service ──────────────────────────────────────
//
// PRD RULE: Explainability MUST be derived from decision trace only.
// No dependency on q365_signals, signal_rejections, or signal_explanations.
// Every explanation is grounded in the institutional decision trace
// which includes all 7 gate dimensions.

export async function explainOpportunity(ticker: string): Promise<SanitizedAIOutput> {
  // Look up the most recent decision trace for this ticker
  const { traces } = await listDecisionTraces({ ticker: ticker.toUpperCase(), limit: 1 });

  if (!traces.length) {
    return enforceBoundary('explain', {
      subject: `Opportunity: ${ticker}`,
      summary: `No institutional decision has been evaluated for ${ticker}. Run a decision evaluation first.`,
      sections: [{
        heading: 'No Decision Trace',
        body: 'Explanations are derived from institutional decision traces. No trace exists for this instrument. Use the decision orchestrator to evaluate a trade proposal.',
      }],
      confidenceTone: 'low',
      disclaimer: 'AI explanations are grounded in institutional decision traces, not signal tables.',
      generatedAt: new Date().toISOString(),
    });
  }

  // Fetch the full decision trace
  const trace = await getDecisionTraceById(traces[0].decisionId);
  if (!trace) {
    return enforceBoundary('explain', {
      subject: `Opportunity: ${ticker}`,
      summary: `Decision trace ${traces[0].decisionId} exists but could not be loaded.`,
      sections: [],
      confidenceTone: 'low',
      disclaimer: 'AI explanations are grounded in institutional decision traces.',
      generatedAt: new Date().toISOString(),
    });
  }

  // Build explanation sections from the decision trace's 7 dimensions
  const sections: { heading: string; body: string }[] = [];

  // 1. Decision Summary
  sections.push({
    heading: 'Decision Summary',
    body: trace.summary,
  });

  // 2. Portfolio Context (from trace)
  sections.push({
    heading: 'Portfolio Context',
    body: `Portfolio has ${trace.portfolioContext.positionsCount} positions with ₹${(trace.portfolioContext.totalAum / 100000).toFixed(1)}L AUM. Unrealized P&L: ${trace.portfolioContext.unrealizedPnlPct >= 0 ? '+' : ''}${trace.portfolioContext.unrealizedPnlPct.toFixed(2)}%.`,
  });

  // 3. Fit Analysis (from trace)
  if (trace.fitAnalysis) {
    const fit = trace.fitAnalysis;
    sections.push({
      heading: 'Portfolio Fit',
      body: `Fit score: ${fit.fitScore}/100 (${fit.sizingMethod}). Suggested quantity: ${fit.suggestedQuantity} shares (₹${(fit.suggestedNotional / 1000).toFixed(0)}K). Concentration impact: HHI +${fit.concentration.hhiDelta}. Diversification: ${fit.diversification.effect}. Liquidity stress: ${fit.liquidity.stress}.${fit.warnings.length > 0 ? ` Warnings: ${fit.warnings.join('; ')}.` : ''}`,
    });
  }

  // 4. Risk Findings (from trace)
  if (trace.riskFindings) {
    const risk = trace.riskFindings;
    sections.push({
      heading: 'Risk Assessment',
      body: `Overall: ${risk.overallStatus} (score ${risk.riskScore}/100). ${risk.breaches.length > 0 ? `Breaches: ${risk.breaches.map(b => b.message).join('; ')}.` : 'No risk breaches.'} Recommended quantity: ${risk.recommendedQuantity}.${risk.warnings.length > 0 ? ` Warnings: ${risk.warnings.join('; ')}.` : ''}`,
    });
  }

  // 5. Governance Findings (from trace)
  if (trace.governanceFindings) {
    const gov = trace.governanceFindings;
    sections.push({
      heading: 'Governance',
      body: `Governance status: ${gov.overallStatus}. ${gov.rules.filter(r => r.status !== 'pass').length > 0 ? `Issues: ${gov.rules.filter(r => r.status !== 'pass').map(r => `${r.policyName}: ${r.reason}`).join('; ')}.` : 'All governance policies passed.'}`,
    });
  }

  // 5b. Active Monitoring Breaches (from trace)
  if (trace.monitoringBreaches && trace.monitoringBreaches.count > 0) {
    sections.push({
      heading: 'Active Monitoring Alerts',
      body: `${trace.monitoringBreaches.count} active breach(es) on portfolio (${trace.monitoringBreaches.critical} critical, ${trace.monitoringBreaches.warning} warnings). Impact: ${trace.monitoringBreaches.impact}. ${trace.monitoringBreaches.breaches.map(b => `[${b.severity}] ${b.message}`).join('; ')}.`,
    });
  }

  // 6. Scenario Impact (from trace)
  if (trace.scenarioImpact) {
    const sc = trace.scenarioImpact;
    sections.push({
      heading: 'Scenario Impact',
      body: `Under "${sc.scenarioName}": portfolio loss goes from ${sc.portfolioLossWithout.toFixed(1)}% → ${sc.portfolioLossWith.toFixed(1)}% (marginal: +${sc.marginalImpactPct.toFixed(1)}%). Threshold: ${sc.threshold}%. ${sc.acceptable ? 'Acceptable.' : 'Exceeds threshold — caution advised.'}`,
    });
  }

  // 7. Final Reason (from trace)
  sections.push({
    heading: 'Decision Rationale',
    body: `${trace.finalReason.reason} (${trace.finalReason.passedGates}/${trace.finalReason.totalGates} gates passed${trace.finalReason.stoppedAtGate ? `, stopped at: ${trace.finalReason.stoppedAtGate}` : ''}).`,
  });

  // Decisive factors
  if (trace.decisiveFactors.length > 0) {
    sections.push({
      heading: 'Decisive Factors',
      body: trace.decisiveFactors.map(f => `${f.factor}: ${f.value} (${f.impact}, weight: ${f.weight})`).join('. '),
    });
  }

  const isApproved = trace.decision === 'approved' || trace.decision === 'approved_with_conditions';
  const confidenceTone: AIExplanation['confidenceTone'] =
    isApproved ? 'high' : trace.decision === 'manual_review' ? 'moderate' : 'low';

  return enforceBoundary('explain', {
    subject: `Decision: ${trace.proposal.ticker} ${trace.proposal.side.toUpperCase()} ${trace.proposal.requestedQuantity}@₹${trace.proposal.price}`,
    summary: trace.summary,
    sections,
    confidenceTone,
    disclaimer: 'This explanation is derived from the institutional decision trace. It reflects the deterministic output of the 7-gate decision pipeline — no signal tables or legacy logic are used.',
    generatedAt: new Date().toISOString(),
  });
}

// ── AI Risk Explanation ─────────────────────────────────────────

export async function explainRisk(portfolioId: number): Promise<SanitizedAIOutput> {
  const [exposure, concentration, drawdown] = await Promise.all([
    computeExposure(portfolioId),
    computeConcentration(portfolioId),
    computeDrawdown(portfolioId),
  ]);

  const allMetrics = [...exposure.metrics, ...concentration.metrics, ...drawdown.metrics];
  const criticals = allMetrics.filter((m) => m.severity === 'critical');
  const warnings = allMetrics.filter((m) => m.severity === 'warning');

  const sections: { heading: string; body: string }[] = [];

  // Exposure summary
  sections.push({
    heading: 'Exposure Overview',
    body: `Gross exposure: ₹${(exposure.grossExposure / 100000).toFixed(1)}L across ${exposure.instrumentExposures.length} positions. Largest sector: ${exposure.sectorExposures[0]?.sector ?? 'N/A'} at ${exposure.sectorExposures[0]?.weight ?? 0}%.`,
  });

  // Concentration
  sections.push({
    heading: 'Concentration Analysis',
    body: `Top holding is ${concentration.singleNameConcentration}% of portfolio. Top 5 holdings represent ${concentration.top5Concentration}%. Sector HHI: ${concentration.sectorConcentration}. ${concentration.sectorConcentration > 25 ? 'Diversification is needed.' : 'Diversification is adequate.'}`,
  });

  // Drawdown
  sections.push({
    heading: 'Drawdown Status',
    body: drawdown.currentDrawdown > 0
      ? `Portfolio is ${drawdown.currentDrawdown}% below cost basis. ${drawdown.worstContributors.length > 0 ? `Worst contributor: ${drawdown.worstContributors[0].ticker} at ${drawdown.worstContributors[0].pnlPct}%.` : ''}`
      : 'Portfolio is above cost basis — no drawdown currently.',
  });

  // Active issues
  if (criticals.length > 0 || warnings.length > 0) {
    sections.push({
      heading: 'Active Risk Issues',
      body: [
        ...criticals.map((m) => `CRITICAL: ${m.explanation}`),
        ...warnings.map((m) => `WARNING: ${m.explanation}`),
      ].join(' '),
    });
  }

  const summary = criticals.length > 0
    ? `Portfolio has ${criticals.length} critical risk issues requiring attention.`
    : warnings.length > 0
      ? `Portfolio has ${warnings.length} risk warnings to monitor.`
      : 'Portfolio risk profile is within acceptable limits.';

  return enforceBoundary('explain', {
    subject: 'Portfolio Risk Summary',
    summary,
    sections,
    confidenceTone: 'high',
    disclaimer: 'Risk explanations are computed from current portfolio state and deterministic engines. They do not predict future market movements.',
    generatedAt: new Date().toISOString(),
  });
}

// ── AI Scenario Summarization ───────────────────────────────────

export async function summarizeScenario(
  portfolioId: number,
  scenarioId: string,
): Promise<SanitizedAIOutput> {
  const result = await runScenario(portfolioId, scenarioId);

  const sections: { heading: string; body: string }[] = [];

  sections.push({
    heading: 'Scenario Description',
    body: result.scenario.description,
  });

  sections.push({
    heading: 'Portfolio Impact',
    body: `Under "${result.scenario.name}", the portfolio would experience an estimated ${Math.abs(result.projectedPortfolioLossPct).toFixed(1)}% ${result.projectedPortfolioLoss > 0 ? 'loss' : 'change'} (₹${Math.abs(result.projectedPortfolioLoss / 100000).toFixed(1)}L). Severity: ${result.severity}.`,
  });

  if (result.worstContributors.length > 0) {
    sections.push({
      heading: 'Worst Contributors',
      body: result.worstContributors.map((c) =>
        `${c.ticker}: ₹${(c.projectedLoss / 1000).toFixed(0)}K loss (${c.projectedLossPct.toFixed(1)}%)`,
      ).join('. '),
    });
  }

  sections.push({
    heading: 'Recommended Action',
    body: result.actionHint,
  });

  return enforceBoundary('summarize', {
    subject: `Scenario Analysis: ${result.scenario.name}`,
    summary: `${result.scenario.name} would cause a ${result.severity} impact of ${Math.abs(result.projectedPortfolioLossPct).toFixed(1)}% portfolio loss.`,
    sections,
    confidenceTone: 'moderate',
    disclaimer: 'Scenario analysis uses simplified shock models. Actual market events may differ significantly from modeled outcomes. Use as a risk awareness tool, not a prediction.',
    generatedAt: new Date().toISOString(),
  });
}
