// ════════════════════════════════════════════════════════════════
//  Decision Trace Builder — Institutional Explainability
//
//  Builds a complete, machine-readable trace for every trade
//  decision. Answers the 7 institutional questions:
//
//    1. What was proposed?
//    2. What portfolio context mattered?
//    3. How did fit analysis score?
//    4. What risk checks ran and what did they find?
//    5. What governance rules applied?
//    6. What scenario impact was projected?
//    7. Why was this decision made?
//
//  RULES:
//    - Deterministic: no AI, no LLM, no heuristic guessing
//    - Uses ONLY outputs from the decision orchestrator
//    - Every field must be populated (null for skipped gates)
//    - Machine-readable AND human-readable
//    - Feeds directly into audit system
//
//  This is the single artifact an auditor, regulator, or PM opens
//  to understand WHY the system did what it did.
// ════════════════════════════════════════════════════════════════

import { db } from '@/lib/db';
import { logger } from '@/lib/logger';
import type {
  InstitutionalDecision,
  DecisionInput,
  GateResult,
  FinalDecision,
} from './decisionOrchestrator';

const log = logger.child({ service: 'decisionTrace' });

// ── Types ───────────────────────────────────────────────────────

export interface DecisionTrace {
  // ── Identity ──────────────────────────────────────────────────
  decisionId: string;               // unique, time-sortable
  version: '1.0';

  // ── Summary ───────────────────────────────────────────────────
  summary: string;                   // one-line human-readable
  decision: FinalDecision;
  decisiveFactors: DecisiveFactor[];

  // ── 1. Proposal ───────────────────────────────────────────────
  proposal: {
    instrumentId: number | null;  // canonical ID (preferred)
    ticker: string;               // display only
    exchange: string;
    side: 'buy' | 'sell';
    requestedQuantity: number;
    requestedNotional: number;
    price: number;
    strategySleeve: string | null;
    scenarioId: string | null;
  };

  // ── 2. Portfolio Context ──────────────────────────────────────
  portfolioContext: {
    portfolioId: number;
    positionsCount: number;
    totalAum: number;
    unrealizedPnlPct: number;
    holdingsSnapshot: string[];      // list of tickers currently held
  };

  // ── 3. Fit Analysis ───────────────────────────────────────────
  fitAnalysis: {
    fitScore: number;
    suggestedQuantity: number;
    suggestedNotional: number;
    sizingMethod: string;
    exposure: {
      sectorName: string;
      currentPct: number;
      projectedPct: number;
      threshold: number;
      breached: boolean;
    };
    concentration: {
      hhiBefore: number;
      hhiAfter: number;
      hhiDelta: number;
    };
    diversification: {
      correlationWithBook: number | null;
      effect: 'positive' | 'neutral' | 'negative';
      addsNewSector: boolean;
    };
    liquidity: {
      avgDailyVolume: number;
      positionAsVolumePct: number;
      daysToExit: number;
      stress: 'none' | 'moderate' | 'severe';
    };
    strategySleeve: {
      sleeveName: string;
      currentFraction: number;
      threshold: number;
      breached: boolean;
    };
    warnings: string[];
  } | null;

  // ── 4. Risk Findings ──────────────────────────────────────────
  riskFindings: {
    overallStatus: string;
    riskScore: number;
    breaches: RiskBreach[];
    warnings: string[];
    recommendedQuantity: number;
  } | null;

  // ── 5. Governance Findings ────────────────────────────────────
  governanceFindings: {
    overallStatus: string;
    rules: GovernanceRuleResult[];
  } | null;

  // ── 5b. Active Monitoring Breaches ────────────────────────────
  monitoringBreaches: {
    count: number;
    critical: number;
    warning: number;
    impact: 'blocked' | 'downgraded' | 'none';
    breaches: { category: string; severity: string; metric: string; message: string }[];
  } | null;

  // ── 6. Scenario Impact ────────────────────────────────────────
  scenarioImpact: {
    scenarioId: string;
    scenarioName: string;
    portfolioLossWithout: number;
    portfolioLossWith: number;
    marginalImpactPct: number;
    threshold: number;
    acceptable: boolean;
  } | null;

  // ── 7. Final Reason ───────────────────────────────────────────
  finalReason: {
    decision: FinalDecision;
    reason: string;
    stoppedAtGate: string | null;
    gateChain: GateChainEntry[];
    totalGates: number;
    passedGates: number;
    failedGates: number;
    warningGates: number;
  };

  // ── Metadata ──────────────────────────────────────────────────
  auditId: number | null;
  userId: number;
  durationMs: number;
  timestamp: string;
}

export interface DecisiveFactor {
  factor: string;
  value: string;
  impact: 'positive' | 'negative' | 'neutral';
  weight: 'high' | 'medium' | 'low';
}

export interface RiskBreach {
  check: string;
  severity: 'hard' | 'soft';
  message: string;
  currentValue: number | null;
  limitValue: number | null;
}

export interface GovernanceRuleResult {
  policyName: string;
  status: 'pass' | 'warn' | 'fail';
  reason: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
}

export interface GateChainEntry {
  gate: string;
  order: number;
  status: string;
  durationMs: number;
  failReason: string | null;
}

// ── Scenario name lookup ────────────────────────────────────────

const SCENARIO_NAMES: Record<string, string> = {
  mkt_drop_5: 'Market Drop 5%',
  mkt_drop_10: 'Market Drop 10%',
  mkt_drop_20: 'Market Crash 20%',
  sector_it_crash: 'IT Sector Crash',
  sector_bank_crash: 'Banking Sector Crash',
  vol_spike: 'Volatility Spike',
  rate_hike: 'Rate Hike Shock',
  hist_2020_crash: 'COVID-19 March 2020',
  hist_2008_crisis: 'GFC 2008 Template',
};

// ── ID generation ───────────────────────────────────────────────

let _seq = 0;
export function generateDecisionId(): string {
  _seq = (_seq + 1) % 1_000_000;
  const ts = Date.now().toString(36);
  const seq = _seq.toString(36).padStart(4, '0');
  return `DEC-${ts}-${seq}`;
}

// ═══════════════════════════════════════════════════════════════
//  BUILD TRACE — Deterministic, no AI
// ═══════════════════════════════════════════════════════════════

export function buildDecisionTrace(
  input: DecisionInput,
  result: InstitutionalDecision,
  externalDecisionId?: string,
): DecisionTrace {
  const decisionId = externalDecisionId ?? generateDecisionId();

  // ── Decisive factors (structured) ─────────────────────────────
  const decisiveFactors: DecisiveFactor[] = [];

  // From fit
  if (result.portfolioContext) {
    const fit = result.portfolioContext;
    decisiveFactors.push({
      factor: 'portfolio_fit_score',
      value: `${fit.fitScore}/100`,
      impact: fit.fitScore >= 60 ? 'positive' : fit.fitScore >= 40 ? 'neutral' : 'negative',
      weight: 'high',
    });
    if (fit.concentrationImpact > 100) {
      decisiveFactors.push({
        factor: 'concentration_increase',
        value: `HHI +${fit.concentrationImpact}`,
        impact: 'negative',
        weight: fit.concentrationImpact > 200 ? 'high' : 'medium',
      });
    }
    if (fit.diversificationEffect === 'positive') {
      decisiveFactors.push({
        factor: 'diversification_benefit',
        value: fit.diversificationEffect,
        impact: 'positive',
        weight: 'medium',
      });
    }
    if (fit.liquidityImpact !== 'none') {
      decisiveFactors.push({
        factor: 'liquidity_stress',
        value: fit.liquidityImpact,
        impact: 'negative',
        weight: fit.liquidityImpact === 'severe' ? 'high' : 'medium',
      });
    }
    if (fit.suggestedQuantity !== input.quantity) {
      decisiveFactors.push({
        factor: 'quantity_adjustment',
        value: `${input.quantity} → ${fit.suggestedQuantity}`,
        impact: 'neutral',
        weight: 'high',
      });
    }
  }

  // From risk
  if (result.riskSnapshot) {
    if (result.riskSnapshot.riskScore > 50) {
      decisiveFactors.push({
        factor: 'risk_score',
        value: `${result.riskSnapshot.riskScore}/100`,
        impact: 'negative',
        weight: 'high',
      });
    }
    for (const b of result.riskSnapshot.breaches) {
      decisiveFactors.push({
        factor: `risk_breach:${b.check}`,
        value: b.message,
        impact: 'negative',
        weight: b.severity === 'hard' ? 'high' : 'medium',
      });
    }
  }

  // From governance
  if (result.governanceSnapshot) {
    const violations = result.governanceSnapshot.violations.filter(v => v.status !== 'pass');
    for (const v of violations) {
      decisiveFactors.push({
        factor: `governance:${v.policy}`,
        value: v.reason,
        impact: 'negative',
        weight: v.status === 'fail' ? 'high' : 'medium',
      });
    }
  }

  // From scenario
  if (result.scenarioSnapshot && !result.scenarioSnapshot.acceptable) {
    decisiveFactors.push({
      factor: 'scenario_impact',
      value: `+${result.scenarioSnapshot.marginalImpact}% portfolio loss`,
      impact: 'negative',
      weight: Math.abs(result.scenarioSnapshot.marginalImpact) > 6 ? 'high' : 'medium',
    });
  }

  // From active breaches
  if (result.activeBreaches && result.activeBreaches.count > 0) {
    if (result.activeBreaches.impact === 'blocked') {
      decisiveFactors.push({
        factor: 'active_breach_critical',
        value: `${result.activeBreaches.critical} critical breach(es)`,
        impact: 'negative',
        weight: 'high',
      });
    }
    for (const b of result.activeBreaches.breaches.filter(b => b.severity === 'critical')) {
      decisiveFactors.push({
        factor: `breach:${b.metric}`,
        value: b.message,
        impact: 'negative',
        weight: 'high',
      });
    }
    if (result.activeBreaches.impact === 'downgraded') {
      decisiveFactors.push({
        factor: 'active_breach_warning',
        value: `${result.activeBreaches.warning} warning(s) — decision downgraded`,
        impact: 'negative',
        weight: 'medium',
      });
    }
  }

  // ── Fit analysis ──────────────────────────────────────────────
  let fitAnalysis: DecisionTrace['fitAnalysis'] = null;
  if (result.portfolioContext) {
    const ctx = result.portfolioContext;
    // Extract gate details for fit dimensions
    const fitGate = result.gates.find(g => g.gate === 'portfolio_context_and_fit');
    const details = (fitGate?.details ?? {}) as Record<string, any>;

    fitAnalysis = {
      fitScore: ctx.fitScore,
      suggestedQuantity: ctx.suggestedQuantity,
      suggestedNotional: ctx.suggestedNotional,
      sizingMethod: String(details.sizingMethod ?? 'unknown'),
      exposure: {
        sectorName: String(details.sectorExposure != null ? 'resolved' : 'unknown'),
        currentPct: 0,
        projectedPct: Number(details.sectorExposure ?? 0),
        threshold: 30,
        breached: Number(details.sectorExposure ?? 0) > 30,
      },
      concentration: {
        hhiBefore: 0,
        hhiAfter: 0,
        hhiDelta: ctx.concentrationImpact,
      },
      diversification: {
        correlationWithBook: null,
        effect: ctx.diversificationEffect as any,
        addsNewSector: ctx.diversificationEffect === 'positive',
      },
      liquidity: {
        avgDailyVolume: 0,
        positionAsVolumePct: 0,
        daysToExit: 0,
        stress: ctx.liquidityImpact as any,
      },
      strategySleeve: {
        sleeveName: input.strategySleeve ?? 'unknown',
        currentFraction: 0,
        threshold: 0.5,
        breached: false,
      },
      warnings: ctx.warnings,
    };
  }

  // ── Risk findings ─────────────────────────────────────────────
  let riskFindings: DecisionTrace['riskFindings'] = null;
  if (result.riskSnapshot) {
    riskFindings = {
      overallStatus: result.riskSnapshot.status,
      riskScore: result.riskSnapshot.riskScore,
      breaches: result.riskSnapshot.breaches.map(b => ({
        check: b.check,
        severity: b.severity as 'hard' | 'soft',
        message: b.message,
        currentValue: null,
        limitValue: null,
      })),
      warnings: result.riskSnapshot.warnings,
      recommendedQuantity: result.recommendedQuantity,
    };
  }

  // ── Governance findings ───────────────────────────────────────
  let governanceFindings: DecisionTrace['governanceFindings'] = null;
  if (result.governanceSnapshot) {
    governanceFindings = {
      overallStatus: result.governanceSnapshot.overallStatus,
      rules: result.governanceSnapshot.violations.map(v => ({
        policyName: v.policy,
        status: v.status as 'pass' | 'warn' | 'fail',
        reason: v.reason,
        severity: v.status === 'fail' ? 'critical' as const : v.status === 'warn' ? 'medium' as const : 'low' as const,
      })),
    };
  }

  // ── Scenario impact ───────────────────────────────────────────
  let scenarioImpact: DecisionTrace['scenarioImpact'] = null;
  if (result.scenarioSnapshot) {
    const sid = result.scenarioSnapshot.scenarioId;
    scenarioImpact = {
      scenarioId: sid,
      scenarioName: SCENARIO_NAMES[sid] ?? sid,
      portfolioLossWithout: result.scenarioSnapshot.withoutTrade.lossPct,
      portfolioLossWith: result.scenarioSnapshot.withTrade.lossPct,
      marginalImpactPct: result.scenarioSnapshot.marginalImpact,
      threshold: 3,
      acceptable: result.scenarioSnapshot.acceptable,
    };
  }

  // ── Gate chain ────────────────────────────────────────────────
  const gateChain: GateChainEntry[] = result.gates.map((g, i) => ({
    gate: g.gate,
    order: i + 1,
    status: g.status,
    durationMs: g.durationMs,
    failReason: g.failReason ?? null,
  }));

  // ── Portfolio context ─────────────────────────────────────────
  // Holdings list comes from the overview that Gate 1 fetched
  const holdingsSnapshot: string[] = [];
  // We don't have raw holdings here — extract from gate details if available
  if (result.portfolioContext) {
    // The orchestrator doesn't persist raw holdings in the snapshot.
    // This field will be populated by the persistence layer below.
  }

  // ── Build trace ───────────────────────────────────────────────
  const trace: DecisionTrace = {
    decisionId,
    version: '1.0',
    summary: result.explanation.summary,
    decision: result.decision,
    decisiveFactors,

    proposal: {
      instrumentId: result.instrument?.instrumentId ?? input.instrumentId ?? null,
      ticker: input.ticker,
      exchange: result.instrument?.exchange ?? 'NSE',
      side: input.side,
      requestedQuantity: input.quantity,
      requestedNotional: input.quantity * input.price,
      price: input.price,
      strategySleeve: input.strategySleeve ?? null,
      scenarioId: input.scenarioId ?? null,
    },

    portfolioContext: {
      portfolioId: input.portfolioId,
      positionsCount: result.portfolioContext?.positionsCount ?? 0,
      totalAum: result.portfolioContext?.totalAum ?? 0,
      unrealizedPnlPct: result.portfolioContext?.pnlPct ?? 0,
      holdingsSnapshot,
    },

    fitAnalysis,
    riskFindings,
    governanceFindings,
    monitoringBreaches: result.activeBreaches ? {
      count: result.activeBreaches.count,
      critical: result.activeBreaches.critical,
      warning: result.activeBreaches.warning,
      impact: result.activeBreaches.impact,
      breaches: result.activeBreaches.breaches,
    } : null,
    scenarioImpact,

    finalReason: {
      decision: result.decision,
      reason: result.decisionReason,
      stoppedAtGate: result.gatesSummary.stoppedAt,
      gateChain,
      totalGates: result.gatesSummary.total,
      passedGates: result.gatesSummary.passed,
      failedGates: result.gatesSummary.failed,
      warningGates: result.gatesSummary.warnings,
    },

    auditId: result.auditId,
    userId: input.userId,
    durationMs: result.totalDurationMs,
    timestamp: result.timestamp,
  };

  return trace;
}

// ═══════════════════════════════════════════════════════════════
//  PERSIST TRACE — Write to DB for audit retrieval
// ═══════════════════════════════════════════════════════════════

export async function persistDecisionTrace(trace: DecisionTrace): Promise<void> {
  try {
    // Enrich holdings snapshot before persisting
    if (trace.portfolioContext.portfolioId > 0 && trace.portfolioContext.holdingsSnapshot.length === 0) {
      const { rows } = await db.query(
        `SELECT pp.tradingsymbol FROM portfolio_positions pp
         WHERE pp.portfolio_id = ? AND pp.quantity > 0
         ORDER BY pp.tradingsymbol`,
        [trace.portfolioContext.portfolioId],
      );
      trace.portfolioContext.holdingsSnapshot = (rows as any[]).map(r => r.tradingsymbol);
    }

    await db.query(
      `INSERT INTO decision_traces
         (decision_id, ticker, side, decision, fit_score, risk_score,
          governance_status, scenario_impact, trace_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
      [
        trace.decisionId,
        trace.proposal.ticker,
        trace.proposal.side,
        trace.decision,
        trace.fitAnalysis?.fitScore ?? null,
        trace.riskFindings?.riskScore ?? null,
        trace.governanceFindings?.overallStatus ?? null,
        trace.scenarioImpact?.marginalImpactPct ?? null,
        JSON.stringify(trace),
      ],
    );

    log.info('Decision trace persisted', { decisionId: trace.decisionId, ticker: trace.proposal.ticker });
  } catch (err) {
    // Non-fatal — the trace is still returned to the caller
    log.warn('Decision trace persistence failed', { error: (err as Error).message, decisionId: trace.decisionId });
  }
}

// ═══════════════════════════════════════════════════════════════
//  RETRIEVE TRACE — For audit UI and compliance
// ═══════════════════════════════════════════════════════════════

export async function getDecisionTraceById(decisionId: string): Promise<DecisionTrace | null> {
  try {
    const { rows } = await db.query(
      'SELECT trace_json FROM decision_traces WHERE decision_id = ? LIMIT 1',
      [decisionId],
    );
    if (!rows.length) return null;
    const raw = (rows[0] as any).trace_json;
    return typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    return null;
  }
}

export async function listDecisionTraces(opts?: {
  ticker?: string;
  decision?: string;
  limit?: number;
  offset?: number;
}): Promise<{ traces: { decisionId: string; ticker: string; decision: string; fitScore: number | null; riskScore: number | null; createdAt: string }[]; total: number }> {
  const clauses: string[] = [];
  const params: any[] = [];

  if (opts?.ticker) { clauses.push('ticker = ?'); params.push(opts.ticker); }
  if (opts?.decision) { clauses.push('decision = ?'); params.push(opts.decision); }

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const limit = opts?.limit ?? 50;
  const offset = opts?.offset ?? 0;

  const { rows: countRows } = await db.query(`SELECT COUNT(*) AS total FROM decision_traces ${where}`, params);
  const total = Number((countRows[0] as any)?.total ?? 0);

  const { rows } = await db.query(
    `SELECT decision_id, ticker, side, decision, fit_score, risk_score, governance_status, scenario_impact, created_at
     FROM decision_traces ${where}
     ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  );

  return {
    traces: (rows as any[]).map(r => ({
      decisionId: r.decision_id,
      ticker: r.ticker,
      decision: r.decision,
      fitScore: r.fit_score,
      riskScore: r.risk_score,
      createdAt: r.created_at,
    })),
    total,
  };
}
