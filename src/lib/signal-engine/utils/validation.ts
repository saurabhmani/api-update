// ════════════════════════════════════════════════════════════════
//  Validation Utilities
// ════════════════════════════════════════════════════════════════

import type { SignalFeatures } from '../types/signalEngine.types';
import { isValidNumber } from './math';

export function validateFeatures(f: SignalFeatures): { valid: boolean; reason?: string } {
  const checks: [string, unknown][] = [
    ['ema20', f.trend.ema20],
    ['ema50', f.trend.ema50],
    ['ema200', f.trend.ema200],
    ['close', f.trend.close],
    ['rsi14', f.momentum.rsi14],
    ['macdLine', f.momentum.macdLine],
    ['atr14', f.volatility.atr14],
    ['avgVolume20', f.volume.avgVolume20],
    ['recentResistance20', f.structure.recentResistance20],
    ['recentSupport20', f.structure.recentSupport20],
  ];

  for (const [name, value] of checks) {
    if (!isValidNumber(value)) {
      return { valid: false, reason: `Invalid feature value: ${name} = ${value}` };
    }
  }

  // Sanity bounds: reject clearly anomalous values
  if (f.trend.close <= 0) {
    return { valid: false, reason: `Close price must be positive: ${f.trend.close}` };
  }
  if (f.trend.ema20 <= 0 || f.trend.ema50 <= 0) {
    return { valid: false, reason: 'EMA values must be positive' };
  }
  if (f.momentum.rsi14 < 0 || f.momentum.rsi14 > 100) {
    return { valid: false, reason: `RSI out of range [0,100]: ${f.momentum.rsi14}` };
  }
  if (f.volatility.atr14 < 0) {
    return { valid: false, reason: `ATR must be non-negative: ${f.volatility.atr14}` };
  }
  if (f.volume.avgVolume20 < 0) {
    return { valid: false, reason: `Average volume must be non-negative: ${f.volume.avgVolume20}` };
  }

  return { valid: true };
}

export function isLiquid(avgVolume: number, price: number, minVolume: number, minPrice: number): boolean {
  return avgVolume >= minVolume && price >= minPrice;
}
