// ════════════════════════════════════════════════════════════════
//  Regime mapper — engine labels → Trust Layer categories
// ════════════════════════════════════════════════════════════════

import type { MarketRegimeLabel } from '@/lib/signal-engine/types/signalEngine.types';
import type { TrustRegimeCategory } from '../types';

const BULLISH_LABELS: ReadonlySet<string> = new Set(['Strong Bullish', 'Bullish']);
const BEARISH_LABELS: ReadonlySet<string> = new Set(['Bearish', 'Weak']);
const SIDEWAYS_LABELS: ReadonlySet<string> = new Set(['Sideways']);
const HIGH_VOL_LABELS: ReadonlySet<string> = new Set(['High Volatility Risk']);

export function mapRegimeToCategory(label: MarketRegimeLabel | string): TrustRegimeCategory {
  if (HIGH_VOL_LABELS.has(label)) return 'high_volatility';
  if (BULLISH_LABELS.has(label)) return 'bullish';
  if (BEARISH_LABELS.has(label)) return 'bearish';
  if (SIDEWAYS_LABELS.has(label)) return 'sideways';
  return 'sideways';
}

export function categoryDisplayLabel(category: TrustRegimeCategory): string {
  switch (category) {
    case 'bullish':          return 'Bullish';
    case 'bearish':          return 'Bearish';
    case 'sideways':         return 'Sideways';
    case 'high_volatility':  return 'High Volatility';
  }
}
