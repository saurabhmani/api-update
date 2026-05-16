// ════════════════════════════════════════════════════════════════
//  Backtesting Validation Utilities
// ════════════════════════════════════════════════════════════════

import type { BacktestRunConfig, HistoricalBar } from '../types';

/** Validate backtest run config before execution */
export function validateBacktestConfig(cfg: BacktestRunConfig): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (!cfg.name?.trim()) errors.push('Run name is required');
  if (!cfg.universe?.length) errors.push('Universe must have at least 1 symbol');
  if (!cfg.benchmarkSymbol?.trim()) errors.push('Benchmark symbol is required');
  if (!cfg.startDate || !cfg.endDate) errors.push('Start and end dates required');
  if (cfg.startDate && cfg.endDate && new Date(cfg.startDate) >= new Date(cfg.endDate)) {
    errors.push('Start date must be before end date');
  }
  if (cfg.warmupBars < 50) errors.push('Warmup bars must be >= 50 (need data for EMA200)');
  if (cfg.evaluationHorizon < 5) errors.push('Evaluation horizon must be >= 5 bars');
  if (cfg.initialCapital <= 0) errors.push('Initial capital must be positive');
  if (cfg.riskPerTradePct <= 0 || cfg.riskPerTradePct > 5) errors.push('Risk per trade must be 0–5%');
  if (cfg.maxGrossExposurePct <= 0 || cfg.maxGrossExposurePct > 100) errors.push('Max gross exposure must be 1–100%');
  if (cfg.maxOpenPositions < 1) errors.push('Max open positions must be >= 1');
  if (cfg.slippageBps < 0) errors.push('Slippage cannot be negative');
  if (cfg.signalExpiryBars < 1) errors.push('Signal expiry must be >= 1 bar');
  if (cfg.minConfidence < 0 || cfg.minConfidence > 100) errors.push('Min confidence must be 0–100');
  if (cfg.minRewardRisk < 0) errors.push('Min reward-risk must be >= 0');
  if (cfg.commissionPerTrade < 0) errors.push('Commission cannot be negative');
  if (!['conservative', 'midpoint', 'aggressive'].includes(cfg.fillModel)) {
    errors.push('Fill model must be conservative, midpoint, or aggressive');
  }

  return { valid: errors.length === 0, errors };
}

/** Validate a single bar of historical data */
export function validateBar(bar: HistoricalBar): { valid: boolean; reason?: string } {
  if (!bar.symbol) return { valid: false, reason: 'Missing symbol' };
  if (!bar.date) return { valid: false, reason: 'Missing date' };
  if (!isFinite(bar.open) || bar.open <= 0) return { valid: false, reason: `Invalid open: ${bar.open}` };
  if (!isFinite(bar.high) || bar.high <= 0) return { valid: false, reason: `Invalid high: ${bar.high}` };
  if (!isFinite(bar.low) || bar.low <= 0) return { valid: false, reason: `Invalid low: ${bar.low}` };
  if (!isFinite(bar.close) || bar.close <= 0) return { valid: false, reason: `Invalid close: ${bar.close}` };
  if (bar.high < bar.low) return { valid: false, reason: `High ${bar.high} < Low ${bar.low}` };
  if (bar.close > bar.high || bar.close < bar.low) return { valid: false, reason: 'Close outside H/L range' };
  if (bar.open > bar.high || bar.open < bar.low) return { valid: false, reason: 'Open outside H/L range' };
  if (!isFinite(bar.volume) || bar.volume < 0) return { valid: false, reason: `Invalid volume: ${bar.volume}` };
  return { valid: true };
}

/** Validate sufficient data for a symbol before replay */
export function validateDataSufficiency(
  symbol: string,
  barCount: number,
  minBars: number,
): { sufficient: boolean; reason?: string } {
  if (barCount < minBars) {
    return { sufficient: false, reason: `${symbol}: only ${barCount} bars, need ${minBars}` };
  }
  return { sufficient: true };
}
