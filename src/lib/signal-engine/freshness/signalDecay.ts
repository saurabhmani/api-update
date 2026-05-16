// ════════════════════════════════════════════════════════════════
//  Signal Freshness & Decay Engine — Phase 4
// ════════════════════════════════════════════════════════════════

import type { SignalFreshness, DecayState, UrgencyTag } from '../types/phase4.types';

// ── Configurable decay constants ───────────────────────────
export interface DecayConfig {
  decayPerBar: number;            // freshness lost per bar (default: 12)
  decayPerDriftPct: number;       // freshness lost per 1% drift (default: 5)
  multiDayPenalty: number;        // penalty if age > 48h (default: 15)
  freshThreshold: number;         // >= this = fresh (default: 75)
  agingThreshold: number;         // >= this = actionable_but_aging (default: 45)
  staleThreshold: number;         // >= this = stale (default: 15)
  tradingHoursPerDay: number;     // for bar estimation (default: 6.5)
}

const DEFAULT_DECAY_CONFIG: DecayConfig = {
  decayPerBar: 12,
  decayPerDriftPct: 5,
  multiDayPenalty: 15,
  freshThreshold: 75,
  agingThreshold: 45,
  staleThreshold: 15,
  tradingHoursPerDay: 6.5,
};

export function computeFreshness(
  generatedAt: string,
  currentPrice: number,
  signalEntryPrice: number,
  barsElapsed = 0,
  config: Partial<DecayConfig> = {},
): SignalFreshness {
  const cfg = { ...DEFAULT_DECAY_CONFIG, ...config };

  const ageMs = Date.now() - new Date(generatedAt).getTime();
  const ageHours = Math.round(ageMs / (1000 * 60 * 60));
  const ageBars = barsElapsed || Math.max(0, Math.floor(ageHours / cfg.tradingHoursPerDay));

  // Price drift since signal
  const priceDriftPct = signalEntryPrice > 0
    ? Math.round(((currentPrice - signalEntryPrice) / signalEntryPrice) * 10000) / 100
    : 0;

  // Freshness score (0-100): decays with age and drift
  let freshnessScore = 100;
  freshnessScore -= ageBars * cfg.decayPerBar;
  freshnessScore -= Math.abs(priceDriftPct) * cfg.decayPerDriftPct;
  if (ageHours > 48) freshnessScore -= cfg.multiDayPenalty;
  freshnessScore = Math.max(0, Math.min(100, Math.round(freshnessScore)));

  // Decay state
  let decayState: DecayState;
  if (freshnessScore >= cfg.freshThreshold) decayState = 'fresh';
  else if (freshnessScore >= cfg.agingThreshold) decayState = 'actionable_but_aging';
  else if (freshnessScore >= cfg.staleThreshold) decayState = 'stale';
  else decayState = 'expired';

  // Urgency
  let urgencyTag: UrgencyTag;
  if (decayState === 'fresh' && Math.abs(priceDriftPct) < 1) urgencyTag = 'high';
  else if (decayState === 'actionable_but_aging') urgencyTag = 'normal';
  else urgencyTag = 'low';

  return { ageBars, ageHours, freshnessScore, decayState, urgencyTag, priceDriftPct };
}
