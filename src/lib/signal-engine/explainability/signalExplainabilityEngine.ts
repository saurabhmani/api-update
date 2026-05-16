// ════════════════════════════════════════════════════════════════
//  Phase-10 Signal Explainability Engine
//
//  Top-level narrative synthesizer. Takes the structured outputs of
//  Phases 4-9 (factor scoring, rejection engine, portfolio risk,
//  stress test, live validation, position sizing) and renders one
//  paragraph per area plus an executive summary and a final-decision
//  narrative.
//
//  Output is a flat, snake_case block ready to drop onto the main
//  signal row for UI display:
//
//    summary_reason              one-line headline
//    factor_score_explanation    Phase-4 factor breakdown
//    risk_explanation            Phase-5 rejection-engine view
//    portfolio_explanation       Phase-6 portfolio-risk view
//    stress_explanation          Phase-7 stress-test view
//    rejection_explanation       composite of every blocking code
//    final_decision_explanation  final approve/reject narrative
//
//  Scope boundary vs existing explain files:
//
//    explain/buildReasons.ts          → feature-level trigger list.
//    explain/buildWarnings.ts         → analogous warning list.
//    ai-explain/buildExplanation.ts   → consumer-facing prose
//                                        (summary + whyNow + guidance).
//    explain/signalExplainabilityEngine.ts  → factor-attribution
//                                              over a ScoringResult.
//
//    explainability/signalExplainabilityEngine.ts (THIS FILE)
//        → Phase-10 synthesis. Higher level than the factor
//          attribution above: it consumes the outputs of every
//          prior gate and produces a single explanation block
//          intended for the main signal row, not the scoring
//          drill-down panel.
//
//  Pure, synchronous, IO-free. Every input field is optional except
//  symbol/direction/finalScore/classification/approved — callers that
//  haven't run Phase 7 / 8 / etc. get a coherent partial report.
// ════════════════════════════════════════════════════════════════

// ── Inputs ──────────────────────────────────────────────────────

export interface FactorScoreBlock {
  strategy_quality?:    number;
  trend_alignment?:     number;
  momentum?:            number;
  volume_confirmation?: number;
  risk_reward?:         number;
  liquidity?:           number;
  market_regime?:       number;
  portfolio_fit?:       number;
  [extra: string]:      number | undefined;
}

export interface RejectionBlock {
  rejected:          boolean;
  rejection_codes:   string[];
  rejection_reasons: string[];
}

export interface PortfolioBlock {
  approved:                   boolean;
  portfolio_fit_score?:       number;
  breach_codes?:              string[];
  sector_exposure_after?:     number;
  stock_exposure_after?:      number;
  total_portfolio_risk_after?: number;
  capital_at_risk?:           number;
  available_risk_budget?:     number;
}

export interface StressBlock {
  expected_loss:          number;
  worst_case_loss:        number;
  worst_case_scenario?:   string;
  stress_survival_score:  number;
  fragile:                boolean;
  stress_rejection_codes: string[];
}

export interface LiveValidationBlock {
  live_valid:             boolean;
  live_validation_codes:  string[];
  drift_pct?:             number;
  distance_to_stop?:      number;
  stop_buffer_pct?:       number;
}

export interface RiskBlock {
  risk_score?:   number;
  risk_band?:    string;
  risk_factors?: string[];
}

export interface SignalExplainabilityInput {
  symbol:           string;
  direction:        'BUY' | 'SELL';
  strategy?:        string;

  // Phase-4 final score (always required — it is the row's identity)
  finalScore:       number;
  classification:   string;
  factorScores?:    FactorScoreBlock;

  // Phase-5 rejection
  rejection?:       RejectionBlock;
  // Phase-6 portfolio risk
  portfolio?:       PortfolioBlock;
  // Phase-7 stress
  stress?:          StressBlock;
  // Phase-8 live validation
  liveValidation?:  LiveValidationBlock;
  // Phase-3 standalone risk (optional drill-down)
  risk?:            RiskBlock;

  // Final approve/reject after every gate
  approved:         boolean;
}

// ── Output ──────────────────────────────────────────────────────

export interface SignalExplainabilityReport {
  symbol:                     string;
  direction:                  'BUY' | 'SELL';
  approved:                   boolean;
  summary_reason:             string;
  factor_score_explanation:   string;
  risk_explanation:           string;
  portfolio_explanation:      string;
  stress_explanation:         string;
  rejection_explanation:      string;
  final_decision_explanation: string;
}

// ── Helpers ─────────────────────────────────────────────────────

function fmtNum(n: number | undefined, fallback = 'n/a'): string {
  if (n === undefined || !Number.isFinite(n)) return fallback;
  return String(Math.round(n * 100) / 100);
}

function fmtPct(n: number | undefined, fallback = 'n/a'): string {
  if (n === undefined || !Number.isFinite(n)) return fallback;
  return `${Math.round(n * 100) / 100}%`;
}

function rankFactors(scores: FactorScoreBlock): {
  top:    Array<{ name: string; score: number }>;
  bottom: Array<{ name: string; score: number }>;
} {
  const entries = Object.entries(scores)
    .filter(([, v]) => typeof v === 'number' && Number.isFinite(v))
    .map(([k, v]) => ({ name: k, score: v as number }));
  const sorted  = [...entries].sort((a, b) => b.score - a.score);
  return {
    top:    sorted.slice(0, 2),
    bottom: sorted.slice(-2).reverse(),
  };
}

function joinList(items: string[], conjunction = 'and'): string {
  if (items.length === 0) return '';
  if (items.length === 1) return items[0];
  if (items.length === 2) return `${items[0]} ${conjunction} ${items[1]}`;
  return `${items.slice(0, -1).join(', ')}, ${conjunction} ${items[items.length - 1]}`;
}

// ── Per-section builders ────────────────────────────────────────

function explainFactorScores(input: SignalExplainabilityInput): string {
  const head = `Final score ${fmtNum(input.finalScore)}/100 → ${input.classification}.`;
  const fs   = input.factorScores;
  if (!fs) return `${head} No per-factor breakdown supplied.`;

  const { top, bottom } = rankFactors(fs);
  if (top.length === 0) return `${head} Factor scores empty.`;

  const topStr    = top.map((f) => `${f.name} ${fmtNum(f.score)}`).join(', ');
  const bottomStr = bottom.map((f) => `${f.name} ${fmtNum(f.score)}`).join(', ');
  // De-duplicate when the entire factor list is shorter than 4.
  const drag = bottom.some((b) => top.some((t) => t.name === b.name))
    ? ''
    : ` Weakest contributors: ${bottomStr}.`;
  return `${head} Strongest factors: ${topStr}.${drag}`;
}

function explainRisk(input: SignalExplainabilityInput): string {
  const r  = input.risk;
  const rj = input.rejection;

  const parts: string[] = [];
  if (r?.risk_band || r?.risk_score !== undefined) {
    parts.push(
      `Standalone risk band "${r.risk_band ?? 'unknown'}"` +
      (r.risk_score !== undefined ? ` (score ${fmtNum(r.risk_score)}/100)` : ''),
    );
  }
  if (r?.risk_factors && r.risk_factors.length > 0) {
    parts.push(`top risk factors: ${joinList(r.risk_factors)}`);
  }
  if (rj && rj.rejection_codes.length > 0) {
    parts.push(`rejection-engine codes: ${rj.rejection_codes.join(', ')}`);
  } else if (rj) {
    parts.push('rejection-engine clear (no blocking codes)');
  }
  if (parts.length === 0) return 'No risk drill-down supplied — assumed neutral.';
  return parts.join('; ') + '.';
}

function explainPortfolio(input: SignalExplainabilityInput): string {
  const p = input.portfolio;
  if (!p) return 'Portfolio risk engine not run for this signal.';

  const head = p.approved
    ? `Portfolio risk: APPROVED (fit score ${fmtNum(p.portfolio_fit_score)}/100).`
    : `Portfolio risk: REJECTED — breach codes: ${(p.breach_codes ?? []).join(', ') || '(none reported)'}.`;

  const exposures: string[] = [];
  if (p.sector_exposure_after !== undefined)
    exposures.push(`sector exposure ${fmtPct(p.sector_exposure_after * 100)}`);
  if (p.stock_exposure_after !== undefined)
    exposures.push(`stock exposure ${fmtPct(p.stock_exposure_after * 100)}`);
  if (p.total_portfolio_risk_after !== undefined)
    exposures.push(`total open-trade risk ${fmtPct(p.total_portfolio_risk_after * 100)}`);

  const risk: string[] = [];
  if (p.capital_at_risk !== undefined)
    risk.push(`capital at risk ${fmtNum(p.capital_at_risk)}`);
  if (p.available_risk_budget !== undefined)
    risk.push(`remaining risk budget ${fmtNum(p.available_risk_budget)}`);

  return [head, exposures.length ? `Post-trade: ${exposures.join(', ')}.` : '',
                risk.length      ? risk.join(', ') + '.'                  : '']
         .filter(Boolean).join(' ');
}

function explainStress(input: SignalExplainabilityInput): string {
  const s = input.stress;
  if (!s) return 'Stress test not run for this signal.';

  const head = `Stress survival ${fmtNum(s.stress_survival_score)}/100` +
               (s.fragile ? ' — FRAGILE (below 60 floor).' : ' — resilient.');
  const worst = s.worst_case_scenario
    ? ` Worst case: "${s.worst_case_scenario}", loss ${fmtNum(s.worst_case_loss)}.`
    : ` Worst-case loss ${fmtNum(s.worst_case_loss)}.`;
  const exp   = ` Probability-weighted expected loss ${fmtNum(s.expected_loss)}.`;
  const codes = s.stress_rejection_codes.length > 0
    ? ` Stress codes: ${s.stress_rejection_codes.join(', ')}.`
    : '';
  return `${head}${worst}${exp}${codes}`;
}

function explainRejection(input: SignalExplainabilityInput): string {
  // Composite of every blocking code from every gate. Caller-friendly
  // de-dup so the same code raised in two places doesn't repeat.
  const codes:   string[] = [];
  const reasons: string[] = [];

  if (input.rejection?.rejected) {
    codes.push(...input.rejection.rejection_codes);
    reasons.push(...input.rejection.rejection_reasons);
  }
  if (input.portfolio && !input.portfolio.approved) {
    codes.push(...(input.portfolio.breach_codes ?? []));
  }
  if (input.stress) {
    codes.push(...input.stress.stress_rejection_codes);
  }
  if (input.liveValidation && !input.liveValidation.live_valid) {
    codes.push(...input.liveValidation.live_validation_codes);
  }

  const uniqCodes = Array.from(new Set(codes));
  if (uniqCodes.length === 0) {
    return 'No blocking codes raised across rejection / portfolio / stress / live gates.';
  }
  const head = `Blocking codes: ${uniqCodes.join(', ')}.`;
  if (reasons.length === 0) return head;
  const tail = ` Reasons: ${reasons.slice(0, 3).join(' | ')}` +
               (reasons.length > 3 ? ` (+${reasons.length - 3} more)` : '') + '.';
  return head + tail;
}

function explainFinalDecision(input: SignalExplainabilityInput): string {
  const head = `Final decision: ${input.approved ? 'APPROVED' : 'REJECTED'} ` +
               `(${input.symbol} ${input.direction}, score ${fmtNum(input.finalScore)}, ` +
               `classification ${input.classification}).`;

  if (input.approved) {
    const cleared: string[] = [];
    if (input.rejection && !input.rejection.rejected)        cleared.push('rejection engine');
    if (input.portfolio && input.portfolio.approved)         cleared.push('portfolio risk');
    if (input.stress && !input.stress.fragile)               cleared.push('stress test');
    if (input.liveValidation && input.liveValidation.live_valid) cleared.push('live validation');
    const trail = cleared.length > 0
      ? ` Cleared: ${joinList(cleared)}.`
      : '';
    return `${head}${trail} Sized for entry.`;
  }

  // Rejected — name the first failing gate the caller sees, in
  // pipeline order.
  const failing: string[] = [];
  if (input.rejection?.rejected)        failing.push('rejection engine');
  if (input.portfolio && !input.portfolio.approved) failing.push('portfolio risk');
  if (input.stress?.fragile)            failing.push('stress test');
  if (input.liveValidation && !input.liveValidation.live_valid) failing.push('live validation');
  const trail = failing.length > 0
    ? ` Failed gates: ${joinList(failing)}.`
    : ' No gate explicitly failing — caller-supplied approved=false.';
  return `${head}${trail} Not sized.`;
}

// ── Summary ─────────────────────────────────────────────────────

function buildSummary(input: SignalExplainabilityInput): string {
  const verdict = input.approved ? 'APPROVED' : 'REJECTED';
  const tag     = input.strategy ? ` ${input.strategy}` : '';
  const head    = `${input.symbol} ${input.direction}${tag} → ${verdict} ` +
                  `(score ${fmtNum(input.finalScore)}, ${input.classification}).`;

  if (input.approved) {
    if (input.factorScores) {
      const { top } = rankFactors(input.factorScores);
      const lead = top.slice(0, 2).map((t) => `${t.name} ${fmtNum(t.score)}`).join(' & ');
      return `${head} Led by ${lead}.`;
    }
    return head;
  }

  // Rejected — surface the first blocking code we find for the headline.
  const firstCode =
    input.rejection?.rejection_codes[0] ??
    input.portfolio?.breach_codes?.[0] ??
    input.stress?.stress_rejection_codes[0] ??
    input.liveValidation?.live_validation_codes[0];
  return firstCode
    ? `${head} Blocked by ${firstCode}.`
    : `${head} Caller-marked rejected.`;
}

// ── Public API ──────────────────────────────────────────────────

/**
 * Synthesize the Phase-10 explainability block from upstream gate
 * outputs. Every field returned is a single human-readable string
 * suitable for direct UI rendering or a JSON column on the main
 * signal row. Missing upstream blocks degrade gracefully — the
 * corresponding section reports "not run" instead of failing.
 */
export function explainSignal(input: SignalExplainabilityInput): SignalExplainabilityReport {
  return {
    symbol:                     input.symbol,
    direction:                  input.direction,
    approved:                   input.approved,
    summary_reason:             buildSummary(input),
    factor_score_explanation:   explainFactorScores(input),
    risk_explanation:           explainRisk(input),
    portfolio_explanation:      explainPortfolio(input),
    stress_explanation:         explainStress(input),
    rejection_explanation:      explainRejection(input),
    final_decision_explanation: explainFinalDecision(input),
  };
}
