// ════════════════════════════════════════════════════════════════
//  Portfolio Risk Engine
//
//  Hard-limit evaluator for a proposed position against an existing
//  portfolio. Computes four exposure dimensions, combines them into
//  a composite total-risk score, and returns an accept/reject
//  decision with per-violation codes.
//
//  Scope boundary vs existing files:
//
//    evaluatePortfolioFit.ts  → soft 0-100 portfolio-fit score
//                                (scoring, with deferred/approved_with_
//                                penalty states). Used for ranking
//                                and advisory display.
//
//    correlationEngine.ts     → return-correlation matrix + cluster
//                                detection. Shared data source, not a
//                                decision layer.
//
//    portfolioRiskEngine.ts   → THIS FILE: hard reject engine. Given
//                                a proposed position and the current
//                                portfolio, returns `approved: false`
//                                with violation codes when any limit
//                                is breached. Designed to plug into
//                                the rejection pipeline as a
//                                pre-trade gate or post-rejection-
//                                engine safety net.
//
//  This module is stateless, synchronous, and IO-free. All inputs
//  are passed explicitly so it is unit-testable without a database.
// ════════════════════════════════════════════════════════════════

import type { PortfolioSnapshot, PortfolioPosition } from '../types/phase3.types';
import type { CorrelationMatrix, CorrelationCluster } from '../correlation/correlationEngine';

// ── Inputs ──────────────────────────────────────────────────────

export interface ProposedPosition {
  symbol: string;
  sector: string;
  direction: 'long' | 'short';
  grossValue: number;
}

export interface PortfolioRiskLimits {
  /** Max % of portfolio capital allocated to any one sector */
  maxSectorExposurePct:     number;
  /** Max % of portfolio capital in any one stock (all positions combined) */
  maxStockExposurePct:      number;
  /** Max % of portfolio capital deployed across all positions */
  maxGrossExposurePct:      number;
  /** Max count of positions correlated with the proposed position */
  maxCorrelationPositions:  number;
  /** Max % of capital concentrated in one correlation cluster */
  maxCorrelationClusterPct: number;
  /** Max % imbalance between long and short gross exposure */
  maxDirectionImbalancePct: number;
  /** Max composite total-risk score in [0, 100] */
  maxTotalRiskScore:        number;
  /** Pair correlation above which two symbols are treated as correlated */
  correlationThreshold:     number;
}

export const DEFAULT_PORTFOLIO_RISK_LIMITS: PortfolioRiskLimits = {
  maxSectorExposurePct:     30,
  maxStockExposurePct:       8,
  maxGrossExposurePct:      95,
  maxCorrelationPositions:   3,
  maxCorrelationClusterPct: 40,
  maxDirectionImbalancePct: 70,
  maxTotalRiskScore:        75,
  correlationThreshold:      0.7,
};

// ── Per-dimension outputs ───────────────────────────────────────

export interface SectorExposure {
  sector:         string;
  currentGross:   number;
  currentPct:     number;
  projectedGross: number;
  projectedPct:   number;
  limitPct:       number;
  withinLimit:    boolean;
}

export interface StockExposure {
  symbol:         string;
  currentGross:   number;
  projectedGross: number;
  projectedPct:   number;
  limitPct:       number;
  withinLimit:    boolean;
  alreadyHeld:    boolean;
}

export interface GrossExposure {
  currentGross:   number;
  currentPct:     number;
  projectedGross: number;
  projectedPct:   number;
  limitPct:       number;
  withinLimit:    boolean;
}

export interface CorrelationRisk {
  correlatedCount:   number;
  correlatedSymbols: string[];
  clusterGross:      number;
  clusterPct:        number;
  limitCount:        number;
  limitClusterPct:   number;
  withinLimits:      boolean;
  /** How correlation was assessed. `none` = no matrix AND no sector peers. */
  source:            'matrix' | 'sector_proxy' | 'none';
}

export interface DirectionImbalance {
  longGross:       number;
  shortGross:      number;
  longGrossPct:    number;
  shortGrossPct:   number;
  netImbalancePct: number;
  limitPct:        number;
  withinLimit:     boolean;
}

export interface TotalPortfolioRisk {
  score:       number;                  // 0-100 composite
  drivers:     Record<string, number>;  // per-dimension utilization
  limitScore:  number;
  withinLimit: boolean;
}

// ── Decision ────────────────────────────────────────────────────

export type PortfolioRiskCode =
  | 'sector_exposure_exceeded'
  | 'stock_exposure_exceeded'
  | 'gross_exposure_exceeded'
  | 'correlation_positions_exceeded'
  | 'correlation_cluster_exceeded'
  | 'direction_imbalance_exceeded'
  | 'total_risk_exceeded';

export interface PortfolioRiskDecision {
  approved: boolean;
  codes:    PortfolioRiskCode[];
  reasons:  string[];
  sectorExposure:     SectorExposure;
  stockExposure:      StockExposure;
  grossExposure:      GrossExposure;
  correlationRisk:    CorrelationRisk;
  directionImbalance: DirectionImbalance;
  totalRisk:          TotalPortfolioRisk;
  limits:             PortfolioRiskLimits;
}

// ── Helpers ─────────────────────────────────────────────────────

function pct(n: number, capital: number): number {
  if (!Number.isFinite(capital) || capital <= 0) return 0;
  return (n / capital) * 100;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// ── Calculations ────────────────────────────────────────────────

/**
 * Sector exposure: sum of gross across open positions in `proposed.sector`,
 * plus the proposed position, compared to the sector limit.
 */
export function calculateSectorExposure(
  portfolio: PortfolioSnapshot,
  proposed:  ProposedPosition,
  limits:    PortfolioRiskLimits = DEFAULT_PORTFOLIO_RISK_LIMITS,
): SectorExposure {
  const currentGross = portfolio.openPositions
    .filter((p) => p.sector === proposed.sector)
    .reduce((sum, p) => sum + p.grossValue, 0);
  const projectedGross = currentGross + proposed.grossValue;
  const projectedPct   = pct(projectedGross, portfolio.capital);
  return {
    sector:         proposed.sector,
    currentGross:   round2(currentGross),
    currentPct:     round2(pct(currentGross, portfolio.capital)),
    projectedGross: round2(projectedGross),
    projectedPct:   round2(projectedPct),
    limitPct:       limits.maxSectorExposurePct,
    withinLimit:    projectedPct <= limits.maxSectorExposurePct,
  };
}

/**
 * Stock exposure: existing gross in this symbol plus the proposed add.
 * Short + long in the same symbol are summed in absolute terms — a
 * hedge-like position is still capital tied up.
 */
export function calculateStockExposure(
  portfolio: PortfolioSnapshot,
  proposed:  ProposedPosition,
  limits:    PortfolioRiskLimits = DEFAULT_PORTFOLIO_RISK_LIMITS,
): StockExposure {
  const existing = portfolio.openPositions.filter((p) => p.symbol === proposed.symbol);
  const currentGross = existing.reduce((sum, p) => sum + p.grossValue, 0);
  const projectedGross = currentGross + proposed.grossValue;
  const projectedPct   = pct(projectedGross, portfolio.capital);
  return {
    symbol:         proposed.symbol,
    currentGross:   round2(currentGross),
    projectedGross: round2(projectedGross),
    projectedPct:   round2(projectedPct),
    limitPct:       limits.maxStockExposurePct,
    withinLimit:    projectedPct <= limits.maxStockExposurePct,
    alreadyHeld:    existing.length > 0,
  };
}

/**
 * Gross exposure: total capital deployed, current + proposed.
 */
export function calculateGrossExposure(
  portfolio: PortfolioSnapshot,
  proposed:  ProposedPosition,
  limits:    PortfolioRiskLimits = DEFAULT_PORTFOLIO_RISK_LIMITS,
): GrossExposure {
  const currentGross   = portfolio.openPositions.reduce((s, p) => s + p.grossValue, 0);
  const projectedGross = currentGross + proposed.grossValue;
  const projectedPct   = pct(projectedGross, portfolio.capital);
  return {
    currentGross:   round2(currentGross),
    currentPct:     round2(pct(currentGross, portfolio.capital)),
    projectedGross: round2(projectedGross),
    projectedPct:   round2(projectedPct),
    limitPct:       limits.maxGrossExposurePct,
    withinLimit:    projectedPct <= limits.maxGrossExposurePct,
  };
}

/**
 * Correlation risk. Preferred data source is a CorrelationMatrix
 * (return-correlation from the correlation engine). When absent,
 * falls back to a sector-proxy — positions sharing `proposed.sector`
 * are treated as correlated. This mirrors the fallback used by
 * evaluatePortfolioFit so both engines stay consistent when
 * correlation data is unavailable.
 *
 * Two limits are evaluated together:
 *   - count of correlated positions ≤ maxCorrelationPositions
 *   - gross of those positions as % of capital ≤ maxCorrelationClusterPct
 * Either breach flips withinLimits to false.
 */
export function calculateCorrelationRisk(
  portfolio:         PortfolioSnapshot,
  proposed:          ProposedPosition,
  limits:            PortfolioRiskLimits = DEFAULT_PORTFOLIO_RISK_LIMITS,
  correlationMatrix?: CorrelationMatrix,
): CorrelationRisk {
  let correlatedSymbols: string[] = [];
  let source: CorrelationRisk['source'] = 'none';

  if (correlationMatrix) {
    source = 'matrix';
    // Pair correlations with the proposed symbol above threshold.
    const pairMatches = correlationMatrix.pairs
      .filter((p) =>
        (p.symbolA === proposed.symbol || p.symbolB === proposed.symbol) &&
        Math.abs(p.correlation) >= limits.correlationThreshold,
      )
      .map((p) => (p.symbolA === proposed.symbol ? p.symbolB : p.symbolA));

    // Cluster membership: if the proposed symbol is in a named
    // cluster, every other member is correlated by construction.
    const clusterPeers = correlationMatrix.clusters
      .filter((c: CorrelationCluster) => c.symbols.includes(proposed.symbol))
      .flatMap((c) => c.symbols.filter((s) => s !== proposed.symbol));

    correlatedSymbols = Array.from(new Set([...pairMatches, ...clusterPeers]));
  }

  // Sector-proxy fallback — only engages when no matrix was supplied
  // OR the matrix didn't produce any correlated symbols. Positions
  // in the same sector as the proposed trade are treated as
  // correlated.
  if (correlatedSymbols.length === 0) {
    const sectorPeers = portfolio.openPositions
      .filter((p) => p.sector === proposed.sector && p.symbol !== proposed.symbol)
      .map((p) => p.symbol);
    if (sectorPeers.length > 0) {
      correlatedSymbols = sectorPeers;
      source = correlationMatrix ? 'matrix' : 'sector_proxy';
    }
  }

  // Intersect with currently-held positions — we care about capital
  // tied up, not hypothetical correlations.
  const heldSymbols = new Set(portfolio.openPositions.map((p) => p.symbol));
  const heldCorrelated = correlatedSymbols.filter((s) => heldSymbols.has(s));

  const clusterGross = portfolio.openPositions
    .filter((p) => heldCorrelated.includes(p.symbol))
    .reduce((sum, p) => sum + p.grossValue, 0) + proposed.grossValue;
  const clusterPct = pct(clusterGross, portfolio.capital);

  const countOk   = heldCorrelated.length <= limits.maxCorrelationPositions;
  const clusterOk = clusterPct           <= limits.maxCorrelationClusterPct;

  return {
    correlatedCount:   heldCorrelated.length,
    correlatedSymbols: heldCorrelated,
    clusterGross:      round2(clusterGross),
    clusterPct:        round2(clusterPct),
    limitCount:        limits.maxCorrelationPositions,
    limitClusterPct:   limits.maxCorrelationClusterPct,
    withinLimits:      countOk && clusterOk,
    source,
  };
}

/**
 * Direction imbalance: |long gross - short gross| / capital.
 * Enforces that a portfolio doesn't become 100% long or 100% short
 * after adding the proposed trade.
 */
export function calculateDirectionImbalance(
  portfolio: PortfolioSnapshot,
  proposed:  ProposedPosition,
  limits:    PortfolioRiskLimits = DEFAULT_PORTFOLIO_RISK_LIMITS,
): DirectionImbalance {
  const projected: PortfolioPosition[] = [
    ...portfolio.openPositions,
    { symbol: proposed.symbol, side: proposed.direction, sector: proposed.sector,
      grossValue: proposed.grossValue, riskAllocated: 0 },
  ];
  const longGross  = projected.filter((p) => p.side === 'long' ).reduce((s, p) => s + p.grossValue, 0);
  const shortGross = projected.filter((p) => p.side === 'short').reduce((s, p) => s + p.grossValue, 0);
  const netImbalancePct = Math.abs(pct(longGross - shortGross, portfolio.capital));
  return {
    longGross:       round2(longGross),
    shortGross:      round2(shortGross),
    longGrossPct:    round2(pct(longGross,  portfolio.capital)),
    shortGrossPct:   round2(pct(shortGross, portfolio.capital)),
    netImbalancePct: round2(netImbalancePct),
    limitPct:        limits.maxDirectionImbalancePct,
    withinLimit:     netImbalancePct <= limits.maxDirectionImbalancePct,
  };
}

/**
 * Total portfolio risk: weighted composite of per-dimension
 * utilization (current usage as % of its limit). Sector, stock,
 * gross, correlation, and direction each contribute equally. A
 * portfolio running at 100% of every limit scores 100.
 */
export function calculateTotalPortfolioRisk(
  sector:     SectorExposure,
  stock:      StockExposure,
  gross:      GrossExposure,
  correlation: CorrelationRisk,
  direction:  DirectionImbalance,
  limits:     PortfolioRiskLimits = DEFAULT_PORTFOLIO_RISK_LIMITS,
): TotalPortfolioRisk {
  const sectorUtil      = Math.min(100, (sector.projectedPct        / sector.limitPct)        * 100);
  const stockUtil       = Math.min(100, (stock.projectedPct         / stock.limitPct)         * 100);
  const grossUtil       = Math.min(100, (gross.projectedPct         / gross.limitPct)         * 100);
  const correlationUtil = Math.min(100,
    Math.max(
      (correlation.correlatedCount / Math.max(1, correlation.limitCount))     * 100,
      (correlation.clusterPct       / Math.max(1, correlation.limitClusterPct)) * 100,
    ),
  );
  const directionUtil   = Math.min(100, (direction.netImbalancePct  / direction.limitPct)     * 100);

  const drivers = {
    sector:      round2(sectorUtil),
    stock:       round2(stockUtil),
    gross:       round2(grossUtil),
    correlation: round2(correlationUtil),
    direction:   round2(directionUtil),
  };
  // Equal-weight average. A dimension at 100% only pushes the total
  // to 20%, but the per-dimension hard limits (above) already fire
  // independently — this score is the "how tight is the portfolio
  // overall" read.
  const score = round2((sectorUtil + stockUtil + grossUtil + correlationUtil + directionUtil) / 5);
  return {
    score,
    drivers,
    limitScore:  limits.maxTotalRiskScore,
    withinLimit: score <= limits.maxTotalRiskScore,
  };
}

// ── Decision ────────────────────────────────────────────────────

/**
 * Top-level evaluator. Runs all five calculations, derives the
 * composite total-risk score, and returns an approve/reject
 * decision with per-violation codes.
 *
 * A proposal is REJECTED if ANY of the following is true:
 *   - sector exposure projected > maxSectorExposurePct
 *   - stock exposure projected > maxStockExposurePct
 *   - gross exposure projected > maxGrossExposurePct
 *   - correlation-position count > maxCorrelationPositions
 *   - correlation-cluster gross > maxCorrelationClusterPct
 *   - direction imbalance > maxDirectionImbalancePct
 *   - composite total-risk score > maxTotalRiskScore
 *
 * `codes[]` and `reasons[]` list every violation (not just the
 * first) so the caller can report the full picture to the user.
 */
export function evaluatePortfolioRisk(
  portfolio:          PortfolioSnapshot,
  proposed:           ProposedPosition,
  limits:             PortfolioRiskLimits = DEFAULT_PORTFOLIO_RISK_LIMITS,
  correlationMatrix?: CorrelationMatrix,
): PortfolioRiskDecision {
  const sectorExposure     = calculateSectorExposure(portfolio, proposed, limits);
  const stockExposure      = calculateStockExposure(portfolio, proposed, limits);
  const grossExposure      = calculateGrossExposure(portfolio, proposed, limits);
  const correlationRisk    = calculateCorrelationRisk(portfolio, proposed, limits, correlationMatrix);
  const directionImbalance = calculateDirectionImbalance(portfolio, proposed, limits);
  const totalRisk          = calculateTotalPortfolioRisk(
    sectorExposure, stockExposure, grossExposure, correlationRisk, directionImbalance, limits,
  );

  const codes:   PortfolioRiskCode[] = [];
  const reasons: string[]            = [];

  if (!sectorExposure.withinLimit) {
    codes.push('sector_exposure_exceeded');
    reasons.push(
      `Sector "${sectorExposure.sector}" projected ${sectorExposure.projectedPct}% > ` +
      `limit ${sectorExposure.limitPct}%`,
    );
  }
  if (!stockExposure.withinLimit) {
    codes.push('stock_exposure_exceeded');
    reasons.push(
      `Stock "${stockExposure.symbol}" projected ${stockExposure.projectedPct}% > ` +
      `limit ${stockExposure.limitPct}%`,
    );
  }
  if (!grossExposure.withinLimit) {
    codes.push('gross_exposure_exceeded');
    reasons.push(
      `Gross exposure projected ${grossExposure.projectedPct}% > limit ${grossExposure.limitPct}%`,
    );
  }
  if (correlationRisk.correlatedCount > correlationRisk.limitCount) {
    codes.push('correlation_positions_exceeded');
    reasons.push(
      `${correlationRisk.correlatedCount} correlated positions (${correlationRisk.correlatedSymbols.join(', ')}) ` +
      `> limit ${correlationRisk.limitCount}`,
    );
  }
  if (correlationRisk.clusterPct > correlationRisk.limitClusterPct) {
    codes.push('correlation_cluster_exceeded');
    reasons.push(
      `Correlation cluster gross ${correlationRisk.clusterPct}% > limit ${correlationRisk.limitClusterPct}%`,
    );
  }
  if (!directionImbalance.withinLimit) {
    codes.push('direction_imbalance_exceeded');
    reasons.push(
      `Direction imbalance ${directionImbalance.netImbalancePct}% > limit ${directionImbalance.limitPct}%`,
    );
  }
  if (!totalRisk.withinLimit) {
    codes.push('total_risk_exceeded');
    reasons.push(
      `Total portfolio risk ${totalRisk.score} > limit ${totalRisk.limitScore}`,
    );
  }

  return {
    approved: codes.length === 0,
    codes,
    reasons,
    sectorExposure,
    stockExposure,
    grossExposure,
    correlationRisk,
    directionImbalance,
    totalRisk,
    limits,
  };
}
