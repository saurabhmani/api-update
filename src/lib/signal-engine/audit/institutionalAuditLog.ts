// ════════════════════════════════════════════════════════════════
//  Institutional Audit Log — Phase NEXT
//
//  Single-source-of-truth record for every signal decision. Captures
//  enough state to answer, after the fact:
//
//    • Why was this signal approved?
//    • Why was this signal rejected?
//    • Which gate blocked it?
//    • What was the score breakdown?
//    • What was the portfolio impact?
//    • What was the live execution risk?
//    • What did multi-timeframe alignment say?
//    • What did stress survival say?
//
//  Pure builder — produces a structured AuditRecord. Persistence is
//  the caller's responsibility (q365 audit table, JSON log, etc.).
// ════════════════════════════════════════════════════════════════

import type { TradeLifecycleState } from '../lifecycle/tradeLifecycleEngine';
import type {
  PortfolioRiskAssessment,
  PortfolioRejectionCode,
} from '../portfolio/portfolioRiskEngine';
import type { LiveExecutionResult }       from '../live/liveExecutionValidation';
import type { LiveValidationResult }      from '../live/liveValidationEngine';
import type { MultiTimeframeAlignmentResult } from '../multitimeframe/multiTimeframeAlignment';
import type { StressTestResult }          from '../risk/stressTestEngine';

// ── Decision verdict ────────────────────────────────────────────

export type AuditDecision = 'APPROVED' | 'REJECTED' | 'DEFERRED';

export type AuditGate =
  | 'maturity'
  | 'strict_filter'
  | 'portfolio_risk'
  | 'stress_test'
  | 'live_validation'
  | 'live_execution'
  | 'multi_timeframe'
  | 'rejection_engine'
  | 'none';

// ── Audit record ────────────────────────────────────────────────

export interface ScoreBreakdown {
  final_score:             number;
  classification:          string;
  factor_scores:           Record<string, number>;
  confidence_score?:       number;
  maturity_score?:         number;
  /** Modifier delta from feedback learning. */
  feedback_modifier?:      number;
  /** Modifier delta from multi-timeframe alignment. */
  alignment_modifier?:     number;
}

export interface PortfolioImpactBlock {
  approved:               boolean;
  portfolio_fit_score:    number;
  portfolio_heat:         number;
  sector_exposure_after:  number;
  stock_exposure_after:   number;
  correlation_cluster_risk: number;
  rejection_codes:        PortfolioRejectionCode[];
  rejection_reasons:      string[];
  explanation:            string;
}

export interface ExecutionRiskBlock {
  execution_allowed:    boolean;
  execution_codes:      string[];
  slippage_pct:         number;
  liquidity_exit_risk:  number;
  reasons:              string[];
}

export interface LiveValidationBlock {
  live_valid:           boolean;
  validation_codes:     string[];
  validation_reasons:   string[];
  drift_pct:            number;
  signal_age_hours:     number;
}

export interface AlignmentBlock {
  alignment_state:           string;
  timeframe_alignment_score: number;
  daily:                     string;
  fourHour:                  string;
  oneHour:                   string;
  explanation:               string;
}

export interface StressBlock {
  survival_score:        number;
  fragile:               boolean;
  worst_case_loss:       number;
  worst_case_scenario:   string;
  rejection_codes:       string[];
}

export interface AuditRecord {
  symbol:              string;
  direction:           'BUY' | 'SELL';
  strategy:            string;
  decision:            AuditDecision;
  blockingGate:        AuditGate;
  /** Lifecycle state at the moment of the decision. */
  lifecycleState:      TradeLifecycleState;
  /** All rejection codes from every gate (deduped). */
  rejectionCodes:      string[];
  /** Approval reasons (non-empty when APPROVED). */
  approvalReasons:     string[];
  /** Scoring breakdown. */
  scoreBreakdown:      ScoreBreakdown;
  /** Portfolio-impact gate output. */
  portfolioImpact:     PortfolioImpactBlock | null;
  /** Live-execution gate output. */
  executionRisk:       ExecutionRiskBlock   | null;
  /** Phase-8 live-validation gate output. */
  liveValidation:      LiveValidationBlock  | null;
  /** Multi-timeframe alignment gate output. */
  alignment:           AlignmentBlock       | null;
  /** Stress survival gate output. */
  stress:              StressBlock          | null;
  /** Operator-readable narrative. */
  narrative:           string;
  generatedAt:         string;
}

// ── Builder inputs ──────────────────────────────────────────────

export interface AuditInput {
  symbol:        string;
  direction:     'BUY' | 'SELL';
  strategy:      string;
  /** Lifecycle state at the time of the decision. */
  lifecycleState: TradeLifecycleState;
  /** Final approve/reject/defer decision. */
  decision:      AuditDecision;
  scoreBreakdown: ScoreBreakdown;
  /** Optional approval reasons (when decision === 'APPROVED'). */
  approvalReasons?: string[];

  /** Outputs of each gate; pass null/undefined to skip a gate. */
  portfolio?:        PortfolioRiskAssessment | null;
  liveExecution?:    LiveExecutionResult | null;
  liveValidation?:   LiveValidationResult | null;
  alignment?:        MultiTimeframeAlignmentResult | null;
  stress?:           StressTestResult | null;
  /** Codes from the upstream rejection engine (Phase-5). */
  upstreamRejectionCodes?:   string[];
  upstreamRejectionReasons?: string[];

  now?: Date;
}

// ── Helpers ─────────────────────────────────────────────────────

function mapPortfolio(a: PortfolioRiskAssessment | null | undefined): PortfolioImpactBlock | null {
  if (!a) return null;
  return {
    approved:                a.approved,
    portfolio_fit_score:     a.portfolio_fit_score,
    portfolio_heat:          a.portfolio_heat,
    sector_exposure_after:   a.sector_exposure_after,
    stock_exposure_after:    a.stock_exposure_after,
    correlation_cluster_risk: a.correlation_cluster_risk,
    rejection_codes:         a.rejection_codes,
    rejection_reasons:       a.rejection_reasons,
    explanation:             a.explanation,
  };
}

function mapExecution(e: LiveExecutionResult | null | undefined): ExecutionRiskBlock | null {
  if (!e) return null;
  return {
    execution_allowed:    e.execution_allowed,
    execution_codes:      e.execution_codes,
    slippage_pct:         e.slippage_pct,
    liquidity_exit_risk:  e.liquidity_exit_risk,
    reasons:              e.execution_reasons,
  };
}

function mapLive(v: LiveValidationResult | null | undefined): LiveValidationBlock | null {
  if (!v) return null;
  return {
    live_valid:         v.live_valid,
    validation_codes:   v.live_validation_codes,
    validation_reasons: v.live_validation_reasons,
    drift_pct:          v.live_price_snapshot.drift_pct,
    signal_age_hours:   v.live_price_snapshot.signal_age_hours,
  };
}

function mapAlignment(a: MultiTimeframeAlignmentResult | null | undefined): AlignmentBlock | null {
  if (!a) return null;
  return {
    alignment_state:           a.alignment_state,
    timeframe_alignment_score: a.timeframe_alignment_score,
    daily:                     a.daily.reason,
    fourHour:                  a.fourHour.reason,
    oneHour:                   a.oneHour.reason,
    explanation:               a.explanation,
  };
}

function mapStress(s: StressTestResult | null | undefined): StressBlock | null {
  if (!s) return null;
  return {
    survival_score:      s.stress_survival_score,
    fragile:             s.fragile,
    worst_case_loss:     s.worst_case_loss,
    worst_case_scenario: s.worst_case_scenario,
    rejection_codes:     s.stress_rejection_codes,
  };
}

/** Decide which gate carried the binding rejection. The order
 *  reflects evaluation precedence: maturity → strict filter →
 *  portfolio → stress → live validation → live execution → alignment. */
function inferBlockingGate(input: AuditInput): AuditGate {
  if (input.decision === 'APPROVED') return 'none';
  if (input.upstreamRejectionCodes && input.upstreamRejectionCodes.length > 0) {
    // Treat upstream codes as the rejection-engine output unless
    // they map cleanly to another known gate.
    const codes = input.upstreamRejectionCodes.join(',').toUpperCase();
    if (codes.includes('MATURITY')) return 'maturity';
    if (codes.includes('STRICT'))   return 'strict_filter';
    return 'rejection_engine';
  }
  if (input.portfolio && input.portfolio.rejected)            return 'portfolio_risk';
  if (input.stress && input.stress.fragile)                   return 'stress_test';
  if (input.liveValidation && !input.liveValidation.live_valid) return 'live_validation';
  if (input.liveExecution && !input.liveExecution.execution_allowed) return 'live_execution';
  if (input.alignment && input.alignment.alignment_state === 'conflicting') return 'multi_timeframe';
  return 'rejection_engine';
}

function unionRejectionCodes(input: AuditInput): string[] {
  const codes: string[] = [];
  if (input.upstreamRejectionCodes) codes.push(...input.upstreamRejectionCodes);
  if (input.portfolio)              codes.push(...input.portfolio.rejection_codes);
  if (input.liveExecution && !input.liveExecution.execution_allowed) {
    codes.push(...input.liveExecution.execution_codes);
  }
  if (input.liveValidation && !input.liveValidation.live_valid) {
    codes.push(...input.liveValidation.live_validation_codes);
  }
  if (input.stress)                 codes.push(...input.stress.stress_rejection_codes);
  if (input.alignment && input.alignment.alignment_state === 'conflicting') {
    codes.push('TIMEFRAME_CONFLICT');
  }
  return Array.from(new Set(codes));
}

function buildNarrative(input: AuditInput, blockingGate: AuditGate): string {
  const head = `${input.symbol} ${input.direction} (${input.strategy}) → ${input.decision}`;
  if (input.decision === 'APPROVED') {
    const reasons = (input.approvalReasons ?? []).slice(0, 3).join('; ');
    return `${head}. final_score=${input.scoreBreakdown.final_score} ` +
           `(${input.scoreBreakdown.classification}). ${reasons || 'All gates passed.'}`;
  }
  const codes = unionRejectionCodes(input);
  const codeList = codes.length > 0 ? codes.join(', ') : 'unspecified';
  return `${head}. blocking_gate=${blockingGate}. codes=[${codeList}]. ` +
         `final_score=${input.scoreBreakdown.final_score} (${input.scoreBreakdown.classification}).`;
}

// ── Public API ──────────────────────────────────────────────────

export function buildAuditRecord(input: AuditInput): AuditRecord {
  const now          = input.now ?? new Date();
  const blockingGate = inferBlockingGate(input);
  const codes        = unionRejectionCodes(input);
  const narrative    = buildNarrative(input, blockingGate);

  return {
    symbol:          input.symbol,
    direction:       input.direction,
    strategy:        input.strategy,
    decision:        input.decision,
    blockingGate,
    lifecycleState:  input.lifecycleState,
    rejectionCodes:  codes,
    approvalReasons: input.approvalReasons ?? [],
    scoreBreakdown:  input.scoreBreakdown,
    portfolioImpact: mapPortfolio(input.portfolio),
    executionRisk:   mapExecution(input.liveExecution),
    liveValidation:  mapLive(input.liveValidation),
    alignment:       mapAlignment(input.alignment),
    stress:          mapStress(input.stress),
    narrative,
    generatedAt:     now.toISOString(),
  };
}

/**
 * Render the audit record as a single-line operator log entry. Useful
 * for stdout / file logging when a structured DB persistence layer
 * isn't available yet.
 */
export function renderAuditLine(record: AuditRecord): string {
  const stress    = record.stress    ? `stress=${record.stress.survival_score}` : 'stress=NA';
  const portfolio = record.portfolioImpact
    ? `pf=${record.portfolioImpact.portfolio_fit_score}/heat=${(record.portfolioImpact.portfolio_heat * 100).toFixed(1)}%`
    : 'pf=NA';
  const exec      = record.executionRisk
    ? `exec=${record.executionRisk.execution_allowed ? 'OK' : 'BLOCK'}`
    : 'exec=NA';
  const live      = record.liveValidation
    ? `live=${record.liveValidation.live_valid ? 'OK' : 'BLOCK'}`
    : 'live=NA';
  const align     = record.alignment
    ? `align=${record.alignment.alignment_state}(${record.alignment.timeframe_alignment_score >= 0 ? '+' : ''}${record.alignment.timeframe_alignment_score})`
    : 'align=NA';
  return [
    record.generatedAt,
    record.symbol,
    record.direction,
    record.strategy,
    record.lifecycleState,
    record.decision,
    `gate=${record.blockingGate}`,
    `score=${record.scoreBreakdown.final_score}`,
    stress, portfolio, exec, live, align,
    `codes=[${record.rejectionCodes.join(',')}]`,
  ].join(' | ');
}
