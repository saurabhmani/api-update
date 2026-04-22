// ════════════════════════════════════════════════════════════════
//  Phase 3 Risk Engine — Standalone + Portfolio-Integrated
// ════════════════════════════════════════════════════════════════

import type { Phase3RiskBreakdown, PortfolioFitResult } from '../types/phase3.types';
import type { RiskBreakdown } from '../types/signalEngine.types';
import { clamp } from '../utils/math';

export function computePhase3Risk(
  standaloneRisk: RiskBreakdown,
  portfolioFit: PortfolioFitResult,
): Phase3RiskBreakdown {
  const standaloneRiskScore = standaloneRisk.totalScore;

  // Portfolio risk: derive from fit penalties
  let portfolioRiskScore = 0;
  if (portfolioFit.portfolioDecision === 'rejected') portfolioRiskScore = 80;
  else if (portfolioFit.portfolioDecision === 'deferred') portfolioRiskScore = 55;
  else if (portfolioFit.portfolioDecision === 'approved_with_penalty') portfolioRiskScore = 35;
  else portfolioRiskScore = Math.max(0, 100 - portfolioFit.fitScore);

  // Add correlation penalty
  portfolioRiskScore = Math.min(100, portfolioRiskScore + portfolioFit.correlationPenalty);

  // Weighted combination: 55% standalone, 45% portfolio
  const totalRiskScore = clamp(
    Math.round(standaloneRiskScore * 0.55 + portfolioRiskScore * 0.45),
    0, 100,
  );

  const riskFactors: string[] = [];
  if (standaloneRisk.atrRisk > 60) riskFactors.push('High ATR volatility');
  if (standaloneRisk.gapRisk > 50) riskFactors.push('Gap risk elevated');
  if (standaloneRisk.stopDistanceRisk > 60) riskFactors.push('Wide stop distance');
  if (standaloneRisk.overextensionRisk > 50) riskFactors.push('Price overextended from mean');
  if (standaloneRisk.regimeRisk > 50) riskFactors.push('Regime not favorable');
  if (portfolioFit.sectorExposureImpact !== 'acceptable') riskFactors.push(`Sector exposure: ${portfolioFit.sectorExposureImpact}`);
  if (portfolioFit.correlationPenalty > 10) riskFactors.push('Correlation cluster crowded');
  if (portfolioFit.capitalAvailability !== 'sufficient') riskFactors.push(`Capital: ${portfolioFit.capitalAvailability}`);

  const riskBand = totalRiskScore <= 30 ? 'Low Risk' as const
    : totalRiskScore <= 55 ? 'Moderate Risk' as const
    : totalRiskScore <= 75 ? 'Elevated Risk' as const
    : 'High Risk' as const;

  return { standaloneRiskScore, portfolioRiskScore, totalRiskScore, riskBand, riskFactors };
}
