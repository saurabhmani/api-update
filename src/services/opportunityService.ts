// ════════════════════════════════════════════════════════════════
//  Opportunity Intelligence Integration — Phase 7
//
//  Aggregates signal, news, market stance, and anomaly intelligence
//  into a unified candidate-generation workflow.
//
//  Opportunity is an input, not a final authority.
//  Every opportunity must still go through risk + governance gates.
// ════════════════════════════════════════════════════════════════

import { db } from '@/lib/db';
import { logger } from '@/lib/logger';
import { evaluateInstitutionalDecision, type DecisionInput } from './decisionOrchestrator';
import { resolveByTicker } from './instrumentResolver';

const log = logger.child({ service: 'opportunity' });

// ── Unified Opportunity Object ──────────────────────────────────

export interface Opportunity {
  instrumentId: number;
  ticker: string;
  exchange: string;
  name: string | null;
  source: string;            // signal_engine | news | manual | scanner
  signalType: string | null; // BUY | SELL | HOLD
  conviction: string | null; // high_conviction | actionable | speculative | reject
  direction: 'long' | 'short' | 'neutral';
  catalyst: string | null;
  confidence: number;
  opportunityScore: number;  // 0–100 composite
  timestamp: string;
  notes: string | null;
  flags: string[];
  // Enrichment fields
  sector: string | null;
  ltp: number | null;
  riskScore: number | null;
  portfolioFitScore: number | null;
  scenarioTag: string | null;
  marketStance: string | null;
}

export interface OpportunityListResult {
  opportunities: Opportunity[];
  count: number;
  total: number;
  asOf: string;
}

export interface OpportunityEvaluation {
  opportunity: Opportunity;
  riskDecision: {
    status: string;
    riskScore: number;
    breaches: { check: string; message: string }[];
  };
  governanceDecision: {
    overallStatus: string;
    results: { policyName: string; status: string; reason: string }[];
  };
  finalVerdict: 'actionable' | 'restricted' | 'rejected' | 'review_required';
  explanation: string;
}

// ── Opportunity Normalization ───────────────────────────────────

function normalizeRow(row: any): Opportunity {
  const flags: string[] = [];
  if (row.risk_score != null && row.risk_score > 60) flags.push('high_risk');
  if (row.portfolio_fit_score != null && row.portfolio_fit_score < 40) flags.push('poor_fit');
  if (row.conviction_band === 'reject') flags.push('rejected_signal');

  const signalType = row.signal_type ?? row.direction ?? null;
  const direction: Opportunity['direction'] =
    signalType === 'BUY' ? 'long' :
    signalType === 'SELL' ? 'short' : 'neutral';

  return {
    instrumentId: row.instrument_id ?? row.id ?? 0,
    ticker: row.tradingsymbol ?? row.symbol ?? '',
    exchange: row.exchange ?? 'NSE',
    name: row.name ?? null,
    source: row.generation_source ?? row.source ?? 'signal_engine',
    signalType,
    conviction: row.conviction_band ?? null,
    direction,
    catalyst: row.catalyst ?? row.scenario_tag ?? null,
    confidence: Number(row.confidence_score ?? row.confidence ?? 0),
    opportunityScore: Number(row.opportunity_score ?? row.score ?? 0),
    timestamp: row.generated_at ?? row.created_at ?? new Date().toISOString(),
    notes: row.notes ?? null,
    flags,
    sector: row.sector ?? null,
    ltp: row.ltp != null ? Number(row.ltp) : null,
    riskScore: row.risk_score != null ? Number(row.risk_score) : null,
    portfolioFitScore: row.portfolio_fit_score != null ? Number(row.portfolio_fit_score) : null,
    scenarioTag: row.scenario_tag ?? null,
    marketStance: row.market_stance ?? null,
  };
}

// ── Opportunity Aggregator ──────────────────────────────────────

export async function getOpportunities(opts?: {
  limit?: number;
  offset?: number;
  direction?: string;
  minConfidence?: number;
  sector?: string;
}): Promise<OpportunityListResult> {
  const clauses: string[] = [
    "s.generated_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)",
    "s.conviction_band != 'reject'",
  ];
  const params: any[] = [];

  if (opts?.direction) {
    const dir = opts.direction === 'long' ? 'BUY' : opts.direction === 'short' ? 'SELL' : opts.direction;
    clauses.push('s.signal_type = ?');
    params.push(dir);
  }
  if (opts?.minConfidence) {
    clauses.push('s.confidence_score >= ?');
    params.push(opts.minConfidence);
  }
  if (opts?.sector) {
    clauses.push('s.sector = ?');
    params.push(opts.sector);
  }

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const limit = opts?.limit ?? 50;
  const offset = opts?.offset ?? 0;

  // Count total
  const { rows: countRows } = await db.query(
    `SELECT COUNT(*) AS total FROM q365_signals s ${where}`,
    params,
  );
  const total = Number((countRows[0] as any)?.total ?? 0);

  // Fetch with ranking
  const { rows } = await db.query(
    `SELECT s.*, i.name, i.sector AS inst_sector,
            r.ltp, r.score AS rank_score
     FROM q365_signals s
     LEFT JOIN instruments i ON s.symbol = i.tradingsymbol AND i.is_active = 1
     LEFT JOIN rankings r ON s.symbol = r.tradingsymbol
     ${where}
     ORDER BY s.opportunity_score DESC, s.confidence_score DESC
     LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  );

  const opportunities = (rows as any[]).map((r) => {
    r.sector = r.sector ?? r.inst_sector;
    return normalizeRow(r);
  });

  return {
    opportunities,
    count: opportunities.length,
    total,
    asOf: new Date().toISOString(),
  };
}

// ── Opportunity Ranking Service ─────────────────────────────────

export async function getRankedOpportunities(opts?: {
  limit?: number;
  portfolioId?: number;
}): Promise<Opportunity[]> {
  const limit = opts?.limit ?? 20;

  const { rows } = await db.query(
    `SELECT s.*, i.name, i.sector AS inst_sector, r.ltp
     FROM q365_signals s
     LEFT JOIN instruments i ON s.symbol = i.tradingsymbol AND i.is_active = 1
     LEFT JOIN rankings r ON s.symbol = r.tradingsymbol
     WHERE s.generated_at >= DATE_SUB(NOW(), INTERVAL 3 DAY)
       AND s.conviction_band IN ('high_conviction', 'actionable')
       AND s.confidence_score >= 60
     ORDER BY s.opportunity_score DESC, s.confidence_score DESC
     LIMIT ?`,
    [limit],
  );

  return (rows as any[]).map((r) => {
    r.sector = r.sector ?? r.inst_sector;
    return normalizeRow(r);
  });
}

// ── Opportunity Evaluation (delegates to decisionOrchestrator) ──
//
// PRD Rule: There is ONE decision entry point.
// This function MUST NOT make approval/rejection decisions itself.
// It delegates to evaluateInstitutionalDecision() which runs the
// full 7-gate chain: breach → fit → risk → governance → scenario
// → explainability → audit.
//
// The response is mapped back to OpportunityEvaluation shape for
// backward compatibility with existing API consumers.

export async function evaluateOpportunity(
  ticker: string,
  portfolioId: number,
  quantity: number,
  price: number,
  userId?: number,
): Promise<OpportunityEvaluation> {
  // Fetch the latest opportunity for this ticker
  const { rows } = await db.query(
    `SELECT s.*, i.name, i.sector
     FROM q365_signals s
     LEFT JOIN instruments i ON s.symbol = i.tradingsymbol AND i.is_active = 1
     WHERE s.symbol = ?
     ORDER BY s.generated_at DESC LIMIT 1`,
    [ticker],
  );

  const opp = rows.length ? normalizeRow(rows[0]) : normalizeRow({
    tradingsymbol: ticker,
    signal_type: 'BUY',
    confidence_score: 50,
    opportunity_score: 50,
  });

  // Resolve canonical identity
  const instRef = await resolveByTicker(ticker);
  const resolvedInstrumentId = instRef?.instrumentId ?? 0;

  // ── DELEGATE to the single decision entry point ────────────
  // No direct risk or governance calls. The orchestrator runs
  // ALL gates: breach → fit → risk → governance → scenario →
  // explainability → audit.
  const decision = await evaluateInstitutionalDecision({
    portfolioId,
    userId: userId ?? 0,
    ticker,
    instrumentId: resolvedInstrumentId,
    side: 'buy',
    quantity,
    price,
  });

  // ── Map orchestrator output to OpportunityEvaluation shape ──
  // The verdict comes from the orchestrator's decision, not from
  // local logic. This ensures the full gate chain was evaluated.
  let finalVerdict: OpportunityEvaluation['finalVerdict'];
  switch (decision.decision) {
    case 'approved':
    case 'approved_with_conditions':
      finalVerdict = 'actionable';
      break;
    case 'manual_review':
      finalVerdict = 'review_required';
      break;
    case 'rejected_governance':
      finalVerdict = 'restricted';
      break;
    default:
      finalVerdict = 'rejected';
  }

  return {
    opportunity: opp,
    riskDecision: {
      status: decision.riskSnapshot?.status ?? 'unknown',
      riskScore: decision.riskSnapshot?.riskScore ?? 0,
      breaches: (decision.riskSnapshot?.breaches ?? []).map(b => ({ check: b.check, message: b.message })),
    },
    governanceDecision: {
      overallStatus: decision.governanceSnapshot?.overallStatus ?? 'unknown',
      results: (decision.governanceSnapshot?.violations ?? []).map(v => ({
        policyName: v.policy,
        status: v.status,
        reason: v.reason,
      })),
    },
    finalVerdict,
    explanation: decision.explanation.gateNarrative.join(' '),
  };
}
