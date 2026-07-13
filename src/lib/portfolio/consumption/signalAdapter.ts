// ════════════════════════════════════════════════════════════════
//  Phase 8 — Signal Consumption Adapter (read-only)
//  Adapts Product A signals without modifying the production pipeline.
// ════════════════════════════════════════════════════════════════

import type { Phase11SignalRow } from '@/lib/signal-engine/types/phase11Signal';
import { getSector } from '@/lib/signal-engine/constants/phase3.constants';
import type { ConsumableSignal } from '../types';

export function adaptPhase11Signal(row: Phase11SignalRow): ConsumableSignal {
  return {
    symbol: row.symbol,
    direction: row.direction,
    confidenceScore: row.confidence_score,
    finalScore: row.final_score,
    portfolioFitScore: row.portfolio_fit_score,
    riskScore: row.risk_score,
    recommendedQuantity: row.recommended_quantity,
    recommendedCapital: row.recommended_capital,
    sector: getSector(row.symbol),
    liquidityScore: row.factor_scores?.liquidity ?? 50,
    signalStatus: row.signal_status,
    generatedAt: row.generated_at,
  };
}

export function adaptSignalBatch(rows: readonly Phase11SignalRow[]): ConsumableSignal[] {
  return rows
    .filter((r) => r.signal_status === 'APPROVED_SIGNAL' && r.direction !== 'HOLD')
    .map(adaptPhase11Signal);
}

export function adaptLooseSignal(input: {
  symbol: string;
  direction?: string;
  confidence_score?: number;
  final_score?: number;
  portfolio_fit_score?: number;
  risk_score?: number;
  recommended_quantity?: number;
  recommended_capital?: number;
  signal_status?: string;
  generated_at?: string;
  factor_scores?: { liquidity?: number };
}): ConsumableSignal {
  return {
    symbol: input.symbol,
    direction: (input.direction as ConsumableSignal['direction']) ?? 'HOLD',
    confidenceScore: input.confidence_score ?? 0,
    finalScore: input.final_score ?? 0,
    portfolioFitScore: input.portfolio_fit_score ?? 0,
    riskScore: input.risk_score ?? 50,
    recommendedQuantity: input.recommended_quantity ?? 0,
    recommendedCapital: input.recommended_capital ?? 0,
    sector: getSector(input.symbol),
    liquidityScore: input.factor_scores?.liquidity ?? 50,
    signalStatus: input.signal_status ?? 'NO_TRADE',
    generatedAt: input.generated_at ?? new Date().toISOString(),
  };
}
