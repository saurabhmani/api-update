// ════════════════════════════════════════════════════════════════
//  Portfolio Fit Engine — Phase 3
//
//  Evaluates whether a new signal fits within portfolio constraints:
//  sector exposure, direction balance, correlation clusters, capital.
// ════════════════════════════════════════════════════════════════

import type {
  PortfolioSnapshot, PortfolioFitResult, SectorExposureSnapshot,
  DirectionExposureSnapshot, CorrelationSnapshot, Phase3Config,
} from '../types/phase3.types';
import { getSector } from '../constants/phase3.constants';

export function evaluatePortfolioFit(
  symbol: string,
  direction: 'long' | 'short',
  grossValue: number,
  portfolio: PortfolioSnapshot,
  config: Phase3Config,
): PortfolioFitResult {
  let fitScore = 100;
  const penalties: string[] = [];

  const sector = getSector(symbol);

  // ── Sector Exposure ───────────────────────────────────────
  const sectorSnap = computeSectorExposure(sector, grossValue, portfolio, config);
  if (sectorSnap.sectorPenalty > 0) {
    fitScore -= sectorSnap.sectorPenalty;
    penalties.push(`Sector ${sector}: ${sectorSnap.projectedExposurePct.toFixed(1)}% (max ${config.maxSectorExposurePct}%)`);
  }

  // ── Direction Exposure ────────────────────────────────────
  const dirSnap = computeDirectionExposure(direction, grossValue, portfolio, config);
  if (dirSnap.directionPenalty > 0) {
    fitScore -= dirSnap.directionPenalty;
    penalties.push(`Direction imbalance: ${direction} side at ${direction === 'long' ? dirSnap.longExposurePct : dirSnap.shortExposurePct}%`);
  }

  // ── Correlation Cluster ───────────────────────────────────
  const corrSnap = computeCorrelation(symbol, sector, portfolio, config);
  if (corrSnap.correlationPenalty > 0) {
    fitScore -= corrSnap.correlationPenalty;
    penalties.push(`Correlation cluster "${corrSnap.correlationCluster}": ${corrSnap.clusterExposureCount} positions`);
  }

  // ── Capital Availability ──────────────────────────────────
  const capitalPct = portfolio.cashAvailable / portfolio.capital * 100;
  let capitalAvailability: PortfolioFitResult['capitalAvailability'] = 'sufficient';
  if (grossValue > portfolio.cashAvailable) {
    fitScore -= 30;
    capitalAvailability = 'exhausted';
    penalties.push('Insufficient cash for this position');
  } else if (capitalPct < 20) {
    fitScore -= 10;
    capitalAvailability = 'tight';
    penalties.push(`Cash available only ${capitalPct.toFixed(1)}% of capital`);
  }

  // ── Duplicate Symbol Check ────────────────────────────────
  if (portfolio.openPositions.some(p => p.symbol === symbol)) {
    fitScore -= 20;
    penalties.push('Already holding a position in this symbol');
  }

  fitScore = Math.max(0, Math.min(100, fitScore));

  // ── Decision ──────────────────────────────────────────────
  const sectorImpact: PortfolioFitResult['sectorExposureImpact'] =
    sectorSnap.sectorPenalty >= 20 ? 'high' : sectorSnap.sectorPenalty >= 8 ? 'moderate' : 'acceptable';
  const dirImpact: PortfolioFitResult['directionImpact'] =
    dirSnap.directionPenalty >= 20 ? 'extreme' : dirSnap.directionPenalty >= 10 ? 'crowded' : 'acceptable';

  let portfolioDecision: PortfolioFitResult['portfolioDecision'] = 'approved';
  if (fitScore < 30) portfolioDecision = 'rejected';
  else if (fitScore < 50) portfolioDecision = 'deferred';
  else if (fitScore < 70) portfolioDecision = 'approved_with_penalty';

  return {
    fitScore,
    sectorExposureImpact: sectorImpact,
    directionImpact: dirImpact,
    capitalAvailability,
    correlationCluster: corrSnap.correlationCluster,
    correlationPenalty: corrSnap.correlationPenalty,
    portfolioDecision,
    penalties,
  };
}

// ── Sub-engines ─────────────────────────────────────────────

function computeSectorExposure(
  sector: string, newGross: number, p: PortfolioSnapshot, cfg: Phase3Config,
): SectorExposureSnapshot {
  const currentSectorGross = p.openPositions
    .filter(pos => pos.sector === sector)
    .reduce((sum, pos) => sum + pos.grossValue, 0);
  const totalGross = p.openPositions.reduce((sum, pos) => sum + pos.grossValue, 0) + newGross;

  const currentPct = p.capital > 0 ? (currentSectorGross / p.capital) * 100 : 0;
  const projectedPct = p.capital > 0 ? ((currentSectorGross + newGross) / p.capital) * 100 : 0;
  const sectorSignalCount = p.openPositions.filter(pos => pos.sector === sector).length;

  let penalty = 0;
  if (projectedPct > cfg.maxSectorExposurePct) penalty = Math.min(30, Math.round((projectedPct - cfg.maxSectorExposurePct) * 2));
  else if (projectedPct > cfg.maxSectorExposurePct * 0.8) penalty = 5;

  return { sector, currentExposurePct: currentPct, projectedExposurePct: projectedPct, sectorSignalCount, sectorPenalty: penalty };
}

function computeDirectionExposure(
  direction: 'long' | 'short', newGross: number, p: PortfolioSnapshot, cfg: Phase3Config,
): DirectionExposureSnapshot {
  let longGross = p.openPositions.filter(pos => pos.side === 'long').reduce((s, pos) => s + pos.grossValue, 0);
  let shortGross = p.openPositions.filter(pos => pos.side === 'short').reduce((s, pos) => s + pos.grossValue, 0);

  if (direction === 'long') longGross += newGross;
  else shortGross += newGross;

  const total = longGross + shortGross || 1;
  const longPct = (longGross / total) * 100;
  const shortPct = (shortGross / total) * 100;
  const netPct = longPct - shortPct;

  let penalty = 0;
  const dominant = Math.max(longPct, shortPct);
  if (dominant > cfg.maxDirectionImbalancePct) {
    penalty = Math.min(25, Math.round((dominant - cfg.maxDirectionImbalancePct) * 1.5));
  }

  return { longCount: p.openPositions.filter(pos => pos.side === 'long').length,
    shortCount: p.openPositions.filter(pos => pos.side === 'short').length,
    longExposurePct: Math.round(longPct), shortExposurePct: Math.round(shortPct),
    netExposurePct: Math.round(netPct), directionPenalty: penalty };
}

function computeCorrelation(
  symbol: string, sector: string, p: PortfolioSnapshot, cfg: Phase3Config,
): CorrelationSnapshot {
  // Cluster by sector as proxy for correlation
  const clusterCount = p.openPositions.filter(pos => pos.sector === sector).length;
  let penalty = 0;

  if (clusterCount >= cfg.maxCorrelationClusterCount) {
    penalty = Math.min(25, (clusterCount - cfg.maxCorrelationClusterCount + 1) * 8);
  } else if (clusterCount >= 2) {
    penalty = 4;
  }

  return {
    correlationCluster: sector,
    clusterExposureCount: clusterCount,
    correlationPenalty: penalty,
  };
}
