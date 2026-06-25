// Regime-based confidence adjustment — applied after base scoring, before display.

import type { TrustRegimeCategory, TrustRegimeSnapshot } from '../types';

export interface RegimeConfidenceAdjustment {
  baseConfidence: number;
  adjustedConfidence: number;
  modifier: number;
  reason: string;
}

export function applyRegimeConfidenceModifier(
  baseConfidence: number,
  direction: 'BUY' | 'SELL',
  regime: Pick<TrustRegimeSnapshot, 'category' | 'label' | 'allowBullishSignals'>,
): RegimeConfidenceAdjustment {
  let modifier = 0;
  let reason = 'Neutral regime — no adjustment';

  const cat = regime.category;

  if (cat === 'high_volatility') {
    modifier = -12;
    reason = 'High volatility regime reduces confidence across setups';
  } else if (cat === 'bullish') {
    modifier = direction === 'BUY' ? 8 : -6;
    reason = direction === 'BUY'
      ? 'Bullish regime supports long setups'
      : 'Bullish regime penalizes counter-trend shorts';
  } else if (cat === 'bearish') {
    modifier = direction === 'SELL' ? 8 : -6;
    reason = direction === 'SELL'
      ? 'Bearish regime supports short setups'
      : 'Bearish regime penalizes counter-trend longs';
  } else if (cat === 'sideways') {
    modifier = -4;
    reason = 'Sideways regime — reduced trend conviction';
  }

  if (!regime.allowBullishSignals && direction === 'BUY') {
    modifier = Math.min(modifier, -8);
    reason = 'Regime blocks bullish signals — confidence capped';
  }

  const adjusted = Math.max(0, Math.min(100, Math.round(baseConfidence + modifier)));

  return { baseConfidence, adjustedConfidence: adjusted, modifier, reason };
}

export function getRegimeCategoryModifier(category: TrustRegimeCategory): number {
  switch (category) {
    case 'bullish':         return 5;
    case 'bearish':         return -5;
    case 'high_volatility': return -12;
    case 'sideways':        return -3;
  }
}
