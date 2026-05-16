// ════════════════════════════════════════════════════════════════
//  Phase-6 Portfolio Risk Engine
//
//  Self-contained, pure module that evaluates a candidate trade
//  against the current open-positions book and returns a full risk
//  assessment: per-rule before/after exposures, capital at risk,
//  remaining risk budget, and a 0-100 portfolio_fit_score.
//
//  Coexists with the older portfolio-fit/portfolioRiskEngine.ts
//  (which stressTestEngine still consumes). This Phase-6 deliverable
//  is intentionally NOT wired into any caller yet — once the
//  integration phase replaces the legacy engine, this becomes the
//  canonical risk-limits checker.
//
//  Six limits enforced (every limit has a corresponding breach code):
//
//    max risk per trade             2 %  → PORTFOLIO_RISK_LIMIT
//    max stock exposure            10 %  → POSITION_CONCENTRATION
//    max sector exposure           25 %  → SECTOR_OVEREXPOSURE
//    max correlated cluster expo   35 %  → CORRELATION_RISK
//    max total open trade risk      8 %  → PORTFOLIO_RISK_LIMIT
//    max illiquid exposure         15 %  → LIQUIDITY_EXIT_RISK
//
//  Eight calculations returned (per spec):
//
//    sector_exposure_before, sector_exposure_after, stock_exposure_after,
//    total_portfolio_risk_after, correlation_cluster_risk,
//    capital_at_risk, available_risk_budget, portfolio_fit_score
//
//  All exposure values are FRACTIONS in [0, 1] (e.g. 0.25 = 25 %).
//  All capital values are absolute currency amounts in the same
//  unit the caller supplied for `capital`.
//
//  Pure function. Stateless. IO-free.
// ════════════════════════════════════════════════════════════════

// ── Types ──────────────────────────────────────────────────────

export interface PortfolioRiskOpenPosition {
  symbol:              string;
  sector:              string;
  /** Gross position value in capital currency (price × shares). */
  grossValue:          number;
  /** Dollars at risk on the position: |entry − stop| × shares. */
  riskAllocated:       number;
  /** Optional cluster id for correlated-position grouping. Two
   *  positions sharing this id are treated as one risk bucket. */
  correlationCluster?: string | null;
  /** True when the symbol fails the engine's liquidity floor.
   *  Used by the illiquid-exposure limit. */
  illiquid?:           boolean;
}

export interface PortfolioRiskCandidate {
  symbol:              string;
  sector:              string;
  grossValue:          number;
  riskAllocated:       number;
  correlationCluster?: string | null;
  illiquid?:           boolean;
}

export interface PortfolioRiskInput {
  /** Total deployable capital. Denominator for every exposure ratio. */
  capital:        number;
  openPositions:  PortfolioRiskOpenPosition[];
  candidate:      PortfolioRiskCandidate;
  /** Optional override for any subset of DEFAULT_PORTFOLIO_RISK_LIMITS. */
  limits?:        Partial<PortfolioRiskLimits>;
}

/** All limits expressed as fractions in [0, 1]. The defaults below
 *  match the Phase-6 spec verbatim. */
export interface PortfolioRiskLimits {
  maxRiskPerTrade:               number;
  maxStockExposure:              number;
  maxSectorExposure:             number;
  maxCorrelatedClusterExposure:  number;
  maxTotalOpenTradeRisk:         number;
  maxIlliquidExposure:           number;
}

export const DEFAULT_PORTFOLIO_RISK_LIMITS: Readonly<PortfolioRiskLimits> = Object.freeze({
  maxRiskPerTrade:              0.02,   //  2 %
  maxStockExposure:             0.10,   // 10 %
  maxSectorExposure:            0.25,   // 25 %
  maxCorrelatedClusterExposure: 0.35,   // 35 %
  maxTotalOpenTradeRisk:        0.08,   //  8 %
  maxIlliquidExposure:          0.15,   // 15 %
});

export type PortfolioRejectionCode =
  | 'SECTOR_OVEREXPOSURE'
  | 'POSITION_CONCENTRATION'
  | 'CORRELATION_RISK'
  | 'PORTFOLIO_RISK_LIMIT'
  | 'PORTFOLIO_HEAT_EXCEEDED'
  | 'LIQUIDITY_EXIT_RISK';

export interface PortfolioRiskRuleResult {
  rule:    string;
  /** Limit that applies to this rule, as a fraction. */
  limit:   number;
  /** Computed value being checked, as a fraction. */
  value:   number;
  passed:  boolean;
  /** Breach code on failure, undefined on pass. */
  code?:   PortfolioRejectionCode;
  /** Operator-readable explanation. */
  message: string;
}

export interface PortfolioRiskAssessment {
  /** True iff every rule passed. */
  approved:               boolean;
  rejected:               boolean;
  rejection_codes:        PortfolioRejectionCode[];
  rejection_reasons:      string[];

  // ── Six core calculations (per spec) ────────────────────────
  /** Candidate's sector exposure BEFORE adding the trade. */
  sector_exposure_before:    number;
  /** Candidate's sector exposure AFTER adding the trade. */
  sector_exposure_after:     number;
  /** Candidate-symbol exposure AFTER adding the trade. */
  stock_exposure_after:      number;
  /** Sum of riskAllocated / capital, including candidate. */
  total_portfolio_risk_after: number;
  /** Sum of grossValue (incl. candidate) within candidate's
   *  correlation cluster, divided by capital. Zero when the
   *  candidate has no cluster id. */
  correlation_cluster_risk:  number;
  /** Total dollars at risk across the book including candidate. */
  capital_at_risk:           number;
  /** Open-trade-risk fraction (sum riskAllocated / capital). Same
   *  number as `total_portfolio_risk_after`, surfaced under the
   *  spec name "portfolio heat" so the operator UI / institutional
   *  audit log can address it directly. */
  portfolio_heat:            number;
  /** Remaining dollars within maxTotalOpenTradeRisk after
   *  including the candidate. Negative when breached. */
  available_risk_budget:     number;
  /** 0-100 composite based on average headroom across the six
   *  limits. Falls below 50 once any limit is breached. */
  portfolio_fit_score:       number;
  /** One-paragraph operator-readable summary of every rule's outcome.
   *  Always populated, even on full approval. */
  explanation:               string;

  // ── Audit ─────────────────────────────────────────────────
  /** Per-rule trace of value/limit/breach. Same order as the
   *  six rules in the engine body. */
  rules:        PortfolioRiskRuleResult[];
  /** Limits actually applied (after caller overrides). */
  appliedLimits: PortfolioRiskLimits;
}

// ── Helpers ────────────────────────────────────────────────────

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function pct(fraction: number): string {
  return `${(fraction * 100).toFixed(2)} %`;
}

function applyLimits(overrides: Partial<PortfolioRiskLimits> | undefined): PortfolioRiskLimits {
  return { ...DEFAULT_PORTFOLIO_RISK_LIMITS, ...(overrides ?? {}) };
}

// ── Public API ─────────────────────────────────────────────────

/**
 * Evaluate a candidate trade against the current portfolio book.
 *
 * Pure function. Returns a full assessment with every calculation
 * the spec requires plus per-rule audit. Does NOT mutate the input.
 */
export function evaluatePortfolioRisk(input: PortfolioRiskInput): PortfolioRiskAssessment {
  const limits = applyLimits(input.limits);
  const cap    = input.capital > 0 ? input.capital : 0;
  const cand   = input.candidate;
  const open   = input.openPositions;

  // ── Sums BEFORE adding candidate ────────────────────────────
  const sumGrossBefore     = open.reduce((s, p) => s + (p.grossValue    || 0), 0);
  const sumRiskBefore      = open.reduce((s, p) => s + (p.riskAllocated || 0), 0);
  const sectorGrossBefore  = open
    .filter((p) => p.sector === cand.sector)
    .reduce((s, p) => s + (p.grossValue || 0), 0);
  const sumIlliquidBefore  = open
    .filter((p) => p.illiquid === true)
    .reduce((s, p) => s + (p.grossValue || 0), 0);

  const clusterId = cand.correlationCluster ?? null;
  const clusterGrossBefore = clusterId
    ? open.filter((p) => p.correlationCluster === clusterId)
          .reduce((s, p) => s + (p.grossValue || 0), 0)
    : 0;

  // ── Sums AFTER adding candidate ─────────────────────────────
  const candGross         = cand.grossValue    || 0;
  const candRisk          = cand.riskAllocated || 0;
  const candIlliquid      = cand.illiquid === true ? candGross : 0;
  const candClusterGross  = clusterId ? candGross : 0;

  const sumGrossAfter     = sumGrossBefore     + candGross;
  const sumRiskAfter      = sumRiskBefore      + candRisk;
  const sectorGrossAfter  = sectorGrossBefore  + candGross;
  const clusterGrossAfter = clusterGrossBefore + candClusterGross;
  const sumIlliquidAfter  = sumIlliquidBefore  + candIlliquid;

  // Stock exposure after — sum of gross values for positions sharing
  // the candidate's symbol (e.g. averaging in to an existing position)
  // plus the candidate itself.
  const sameSymbolGross = open
    .filter((p) => p.symbol === cand.symbol)
    .reduce((s, p) => s + (p.grossValue || 0), 0);
  const stockGrossAfter = sameSymbolGross + candGross;

  // ── Fractions ───────────────────────────────────────────────
  const sectorBeforeFrac  = cap > 0 ? sectorGrossBefore  / cap : 0;
  const sectorAfterFrac   = cap > 0 ? sectorGrossAfter   / cap : 0;
  const stockAfterFrac    = cap > 0 ? stockGrossAfter    / cap : 0;
  const totalRiskAfterFrac = cap > 0 ? sumRiskAfter      / cap : 0;
  const clusterAfterFrac  = cap > 0 ? clusterGrossAfter  / cap : 0;
  const illiquidAfterFrac = cap > 0 ? sumIlliquidAfter   / cap : 0;
  const candRiskFrac      = cap > 0 ? candRisk           / cap : 0;

  // ── Capital at risk + available budget ──────────────────────
  const capital_at_risk       = sumRiskAfter;
  const totalRiskBudget       = cap * limits.maxTotalOpenTradeRisk;
  const available_risk_budget = totalRiskBudget - capital_at_risk;

  // ── Six rule checks ─────────────────────────────────────────
  const rules: PortfolioRiskRuleResult[] = [];
  const rejection_codes:   PortfolioRejectionCode[] = [];
  const rejection_reasons: string[]                 = [];
  function record(rule: PortfolioRiskRuleResult): void {
    rules.push(rule);
    if (!rule.passed && rule.code) {
      // Don't double-add the same code (max-risk-per-trade and
      // max-total-open-risk both raise PORTFOLIO_RISK_LIMIT).
      if (!rejection_codes.includes(rule.code)) rejection_codes.push(rule.code);
      rejection_reasons.push(rule.message);
    }
  }

  // 1. max risk per trade  (candidate's risk vs capital)
  {
    const passed = candRiskFrac <= limits.maxRiskPerTrade;
    record({
      rule: 'max_risk_per_trade',
      limit: limits.maxRiskPerTrade,
      value: candRiskFrac,
      passed,
      code: passed ? undefined : 'PORTFOLIO_RISK_LIMIT',
      message: passed
        ? `Per-trade risk ${pct(candRiskFrac)} within ${pct(limits.maxRiskPerTrade)}`
        : `Per-trade risk ${pct(candRiskFrac)} exceeds limit ${pct(limits.maxRiskPerTrade)}`,
    });
  }

  // 2. max stock exposure
  {
    const passed = stockAfterFrac <= limits.maxStockExposure;
    record({
      rule: 'max_stock_exposure',
      limit: limits.maxStockExposure,
      value: stockAfterFrac,
      passed,
      code: passed ? undefined : 'POSITION_CONCENTRATION',
      message: passed
        ? `Stock exposure on ${cand.symbol} ${pct(stockAfterFrac)} within ${pct(limits.maxStockExposure)}`
        : `Stock exposure on ${cand.symbol} ${pct(stockAfterFrac)} exceeds limit ${pct(limits.maxStockExposure)}`,
    });
  }

  // 3. max sector exposure
  {
    const passed = sectorAfterFrac <= limits.maxSectorExposure;
    record({
      rule: 'max_sector_exposure',
      limit: limits.maxSectorExposure,
      value: sectorAfterFrac,
      passed,
      code: passed ? undefined : 'SECTOR_OVEREXPOSURE',
      message: passed
        ? `Sector exposure on ${cand.sector} ${pct(sectorAfterFrac)} within ${pct(limits.maxSectorExposure)}`
        : `Sector exposure on ${cand.sector} ${pct(sectorAfterFrac)} exceeds limit ${pct(limits.maxSectorExposure)}`,
    });
  }

  // 4. max correlated cluster exposure (only when candidate has cluster)
  {
    if (clusterId) {
      const passed = clusterAfterFrac <= limits.maxCorrelatedClusterExposure;
      record({
        rule: 'max_correlated_cluster_exposure',
        limit: limits.maxCorrelatedClusterExposure,
        value: clusterAfterFrac,
        passed,
        code: passed ? undefined : 'CORRELATION_RISK',
        message: passed
          ? `Cluster '${clusterId}' exposure ${pct(clusterAfterFrac)} within ${pct(limits.maxCorrelatedClusterExposure)}`
          : `Cluster '${clusterId}' exposure ${pct(clusterAfterFrac)} exceeds limit ${pct(limits.maxCorrelatedClusterExposure)}`,
      });
    } else {
      record({
        rule: 'max_correlated_cluster_exposure',
        limit: limits.maxCorrelatedClusterExposure,
        value: 0,
        passed: true,
        message: 'Candidate has no correlation cluster — rule skipped',
      });
    }
  }

  // 5. max portfolio heat (sum of open-trade risk / capital)
  //    Same scalar as max_total_open_trade_risk but surfaced under
  //    the institutional-spec name. Distinct rejection code so the
  //    audit log can attribute breaches to the heat ceiling.
  {
    const passed = totalRiskAfterFrac <= limits.maxTotalOpenTradeRisk;
    record({
      rule: 'max_portfolio_heat',
      limit: limits.maxTotalOpenTradeRisk,
      value: totalRiskAfterFrac,
      passed,
      code: passed ? undefined : 'PORTFOLIO_HEAT_EXCEEDED',
      message: passed
        ? `Portfolio heat ${pct(totalRiskAfterFrac)} within ${pct(limits.maxTotalOpenTradeRisk)}`
        : `Portfolio heat ${pct(totalRiskAfterFrac)} exceeds limit ${pct(limits.maxTotalOpenTradeRisk)}`,
    });
  }

  // 6. max illiquid exposure (always evaluated; candidate may add 0)
  {
    const passed = illiquidAfterFrac <= limits.maxIlliquidExposure;
    record({
      rule: 'max_illiquid_exposure',
      limit: limits.maxIlliquidExposure,
      value: illiquidAfterFrac,
      passed,
      code: passed ? undefined : 'LIQUIDITY_EXIT_RISK',
      message: passed
        ? `Illiquid exposure ${pct(illiquidAfterFrac)} within ${pct(limits.maxIlliquidExposure)}`
        : `Illiquid exposure ${pct(illiquidAfterFrac)} exceeds limit ${pct(limits.maxIlliquidExposure)}`,
    });
  }

  // ── portfolio_fit_score ──────────────────────────────────────
  // Headroom-based 0-100 composite. Each rule contributes
  // (1 − value/limit), clamped to [0, 1]. The mean across rules
  // gives the score. Any breached rule contributes 0 for that
  // dimension, dragging the average down.
  let headroomSum   = 0;
  let headroomCount = 0;
  for (const r of rules) {
    if (r.limit <= 0) continue;
    const ratio = r.value / r.limit;
    const headroom = clamp01(1 - ratio);
    headroomSum   += headroom;
    headroomCount += 1;
  }
  const portfolio_fit_score = headroomCount > 0
    ? Math.round((headroomSum / headroomCount) * 100 * 10) / 10
    : 100;

  const rejected = rejection_codes.length > 0;

  // ── One-paragraph explanation ───────────────────────────────
  // Always emitted: a concise audit line summarising the verdict
  // plus the binding constraint when the trade was blocked.
  const explanation = buildExplanation(
    cand.symbol,
    cand.sector,
    rejected,
    rejection_codes,
    rejection_reasons,
    {
      sector_exposure_after:     sectorAfterFrac,
      stock_exposure_after:      stockAfterFrac,
      portfolio_heat:            totalRiskAfterFrac,
      correlation_cluster_risk:  clusterAfterFrac,
      portfolio_fit_score,
    },
  );

  return {
    approved: !rejected,
    rejected,
    rejection_codes,
    rejection_reasons,

    sector_exposure_before:    Math.round(sectorBeforeFrac    * 10000) / 10000,
    sector_exposure_after:     Math.round(sectorAfterFrac     * 10000) / 10000,
    stock_exposure_after:      Math.round(stockAfterFrac      * 10000) / 10000,
    total_portfolio_risk_after: Math.round(totalRiskAfterFrac * 10000) / 10000,
    correlation_cluster_risk:  Math.round(clusterAfterFrac    * 10000) / 10000,
    capital_at_risk:           Math.round(capital_at_risk     * 100)   / 100,
    portfolio_heat:            Math.round(totalRiskAfterFrac * 10000) / 10000,
    available_risk_budget:     Math.round(available_risk_budget * 100) / 100,
    portfolio_fit_score,
    explanation,

    rules,
    appliedLimits: limits,
  };
}

// ── Explanation builder ─────────────────────────────────────────

function buildExplanation(
  symbol:           string,
  sector:           string,
  rejected:         boolean,
  codes:            PortfolioRejectionCode[],
  reasons:          string[],
  metrics: {
    sector_exposure_after:    number;
    stock_exposure_after:     number;
    portfolio_heat:           number;
    correlation_cluster_risk: number;
    portfolio_fit_score:      number;
  },
): string {
  const head = `${symbol} (${sector}) portfolio fit ${metrics.portfolio_fit_score}/100`;
  const exposureLine =
    `stock=${pct(metrics.stock_exposure_after)}, sector=${pct(metrics.sector_exposure_after)}, ` +
    `cluster=${pct(metrics.correlation_cluster_risk)}, heat=${pct(metrics.portfolio_heat)}`;
  if (!rejected) {
    return `${head}: APPROVED. ${exposureLine}.`;
  }
  const codeList = codes.join(', ');
  const tail = reasons.length > 0 ? ` — ${reasons.join('; ')}` : '';
  return `${head}: REJECTED [${codeList}]. ${exposureLine}${tail}.`;
}
