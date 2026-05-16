// ════════════════════════════════════════════════════════════════
//  Position Sizing Engine — Phase 3
//
//  Determines how many units to trade based on risk budget,
//  stop distance, volatility, and portfolio constraints.
// ════════════════════════════════════════════════════════════════

import type { PositionSizingInput, PositionSizingResult } from '../types/phase3.types';

export function calculatePositionSize(input: PositionSizingInput): PositionSizingResult {
  const warnings: string[] = [];

  const riskBudgetPct = input.riskPerTradePct;
  const riskBudgetAmount = input.portfolioCapital * (riskBudgetPct / 100);

  // Risk per unit (entry - stop)
  const direction = input.entryPrice >= input.stopLoss ? 1 : -1;
  const initialRiskPerUnit = Math.abs(input.entryPrice - input.stopLoss);

  if (initialRiskPerUnit <= 0) {
    return invalidResult(input, riskBudgetPct, riskBudgetAmount, 0, 'Stop loss equals entry — zero risk per unit');
  }

  // Fixed fractional: size = riskBudget / riskPerUnit
  let positionSizeUnits = Math.floor(riskBudgetAmount / initialRiskPerUnit);

  // Volatility adjustment: reduce size for high-volatility instruments
  if (input.model === 'volatility_adjusted' && input.atrPct > 2.5) {
    const volFactor = Math.max(0.4, 1 - (input.atrPct - 2.5) * 0.15);
    const adjusted = Math.floor(positionSizeUnits * volFactor);
    if (adjusted < positionSizeUnits) {
      warnings.push(`Size reduced ${positionSizeUnits} → ${adjusted} units due to elevated volatility (ATR ${input.atrPct.toFixed(1)}%)`);
      positionSizeUnits = adjusted;
    }
  }

  if (positionSizeUnits <= 0) {
    return invalidResult(input, riskBudgetPct, riskBudgetAmount, initialRiskPerUnit, 'Calculated position size is zero');
  }

  let grossPositionValue = positionSizeUnits * input.entryPrice;
  let validationStatus: PositionSizingResult['validationStatus'] = 'valid';

  // Cap: max gross exposure
  const maxGross = input.portfolioCapital * (input.maxGrossExposurePct / 100);
  const remainingGross = maxGross - input.currentGrossExposure;

  if (grossPositionValue > remainingGross) {
    const capped = Math.floor(remainingGross / input.entryPrice);
    if (capped <= 0) {
      return invalidResult(input, riskBudgetPct, riskBudgetAmount, initialRiskPerUnit, 'No gross exposure capacity remaining');
    }
    warnings.push(`Position capped from ${positionSizeUnits} to ${capped} units — gross exposure limit`);
    positionSizeUnits = capped;
    grossPositionValue = positionSizeUnits * input.entryPrice;
    validationStatus = 'capped';
  }

  // Cap: max 20% of capital in a single position
  const maxSingle = input.portfolioCapital * 0.20;
  if (grossPositionValue > maxSingle) {
    const capped = Math.floor(maxSingle / input.entryPrice);
    warnings.push(`Position capped to ${capped} units — single position max 20% of capital`);
    positionSizeUnits = capped;
    grossPositionValue = positionSizeUnits * input.entryPrice;
    validationStatus = 'capped';
  }

  return {
    capitalModel: input.model,
    portfolioCapital: input.portfolioCapital,
    riskBudgetPct,
    riskBudgetAmount: Math.round(riskBudgetAmount),
    initialRiskPerUnit: Math.round(initialRiskPerUnit * 100) / 100,
    positionSizeUnits,
    grossPositionValue: Math.round(grossPositionValue),
    validationStatus,
    warnings,
  };
}

function invalidResult(
  input: PositionSizingInput, riskBudgetPct: number,
  riskBudgetAmount: number, riskPerUnit: number, reason: string
): PositionSizingResult {
  return {
    capitalModel: input.model,
    portfolioCapital: input.portfolioCapital,
    riskBudgetPct,
    riskBudgetAmount: Math.round(riskBudgetAmount),
    initialRiskPerUnit: riskPerUnit,
    positionSizeUnits: 0,
    grossPositionValue: 0,
    validationStatus: 'invalid',
    warnings: [reason],
  };
}
