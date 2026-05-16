// ════════════════════════════════════════════════════════════════
//  Explain Decision Service — Unified via Decision Trace
//
//  PRD RULE: Explainability MUST be derived from decision trace only.
//
//  This service is a compatibility layer. All explanation logic
//  delegates to decisionTraceBuilder which holds the canonical
//  institutional decision trace. No signal tables are read.
//
//  Previous version read from: q365_signals, signal_rejections,
//  q365_strategy_breakdowns, q365_signal_portfolio_fit,
//  q365_signal_explanations, confidence_logs.
//  ALL of those dependencies have been removed.
// ════════════════════════════════════════════════════════════════

import { logger } from '@/lib/logger';
import {
  getDecisionTraceById,
  listDecisionTraces,
  type DecisionTrace as CanonicalDecisionTrace,
} from './decisionTraceBuilder';

const log = logger.child({ service: 'explainDecision' });

// ── Types (backward-compatible shape) ──────────────────────────

export interface DecisionTrace {
  decisionId: string;
  ticker: string;
  generatedAt: string;
  proposal: {
    signalType: string;
    confidence: number;
    riskScore: number;
    scenarioTag: string | null;
    marketStance: string | null;
  };
  opportunityInputs: {
    strategies: string[];
    conviction: string | null;
    opportunityScore: number;
  };
  portfolioContext: {
    fitScore: number | null;
    sectorExposure: string | null;
    positionsCount: number | null;
    drawdownPct: number | null;
  };
  riskChecks: {
    gatesPassed: string[];
    gatesFailed: string[];
    rejectionReason: string | null;
  };
  governanceChecks: {
    status: string;
    violations: string[];
  };
  decision: string;
  decisionReason: string;
  decisiveMetrics: string[];
  explanation: string | null;
}

// ── Map canonical trace → legacy shape ─────────────────────────

function mapToLegacyShape(trace: CanonicalDecisionTrace): DecisionTrace {
  const gatesPassed = trace.finalReason.gateChain
    .filter(g => g.status === 'passed' || g.status === 'warning')
    .map(g => g.gate);
  const gatesFailed = trace.finalReason.gateChain
    .filter(g => g.status === 'failed')
    .map(g => g.gate);

  return {
    decisionId: trace.decisionId,
    ticker: trace.proposal.ticker,
    generatedAt: trace.timestamp,
    proposal: {
      signalType: trace.proposal.side.toUpperCase(),
      confidence: trace.fitAnalysis?.fitScore ?? 0,
      riskScore: trace.riskFindings?.riskScore ?? 0,
      scenarioTag: trace.proposal.scenarioId,
      marketStance: null,
    },
    opportunityInputs: {
      strategies: [],
      conviction: null,
      opportunityScore: 0,
    },
    portfolioContext: {
      fitScore: trace.fitAnalysis?.fitScore ?? null,
      sectorExposure: trace.fitAnalysis?.exposure?.sectorName ?? null,
      positionsCount: trace.portfolioContext.positionsCount,
      drawdownPct: null,
    },
    riskChecks: {
      gatesPassed,
      gatesFailed,
      rejectionReason: trace.finalReason.stoppedAtGate,
    },
    governanceChecks: {
      status: trace.governanceFindings?.overallStatus ?? 'unknown',
      violations: (trace.governanceFindings?.rules ?? [])
        .filter(r => r.status !== 'pass')
        .map(r => r.reason),
    },
    decision: trace.decision,
    decisionReason: trace.finalReason.reason,
    decisiveMetrics: trace.decisiveFactors.map(f => `${f.factor}=${f.value}`),
    explanation: trace.summary,
  };
}

// ── Get Decision Trace ─────────────────────────────────────────
// Accepts a decisionId (canonical) and returns the trace in
// backward-compatible shape. The old signalId parameter is no
// longer accepted — all lookups are by decisionId.

export async function getDecisionTrace(decisionId: string): Promise<DecisionTrace | null> {
  const trace = await getDecisionTraceById(decisionId);
  if (!trace) return null;
  return mapToLegacyShape(trace);
}

// ── List Recent Decisions ──────────────────────────────────────
// Delegates to the canonical listDecisionTraces from decisionTraceBuilder.

export async function getRecentDecisions(opts?: {
  limit?: number;
  ticker?: string;
  decision?: string;
}): Promise<{ decisionId: string; ticker: string; decision: string; confidence: number; generatedAt: string }[]> {
  const { traces } = await listDecisionTraces({
    ticker: opts?.ticker,
    decision: opts?.decision,
    limit: opts?.limit ?? 50,
  });

  return traces.map(t => ({
    decisionId: t.decisionId,
    ticker: t.ticker,
    decision: t.decision,
    confidence: t.fitScore ?? 0,
    generatedAt: t.createdAt,
  }));
}
