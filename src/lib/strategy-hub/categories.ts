// ════════════════════════════════════════════════════════════════
//  Strategy Categories — display metadata for hub grouping
// ════════════════════════════════════════════════════════════════

import type { StrategyCategory } from '@/lib/signal-engine/types/signalEngine.types';
import type { StrategyCategoryInfo } from './types';

export const CATEGORY_META: Record<StrategyCategory, { label: string; description: string; sortOrder: number }> = {
  breakout:              { label: 'Breakout',              description: 'Price breaking key resistance or range boundaries with volume confirmation.', sortOrder: 1 },
  trend_following:       { label: 'Trend Following',       description: 'Entries aligned with established trend structure via moving-average systems.', sortOrder: 2 },
  momentum:              { label: 'Momentum',              description: 'Continuation setups riding strong directional impulse.', sortOrder: 3 },
  pullback:              { label: 'Pullback',              description: 'Retracement entries within an intact uptrend or downtrend.', sortOrder: 4 },
  mean_reversion:        { label: 'Mean Reversion',        description: 'Counter-trend bounces from oversold or overextended conditions.', sortOrder: 5 },
  reversal:              { label: 'Reversal',              description: 'Structural reversals at exhaustion or divergence points.', sortOrder: 6 },
  breakdown:             { label: 'Breakdown',             description: 'Bearish breakdowns below support with momentum confirmation.', sortOrder: 7 },
  risk_defense:          { label: 'Risk Defense',          description: 'Defensive setups for capital preservation in adverse conditions.', sortOrder: 8 },
  confirmation:          { label: 'Confirmation',          description: 'Secondary confirmation filters applied to primary setups.', sortOrder: 9 },
  intraday_confirmation: { label: 'Intraday Confirmation', description: 'Intraday confirmation signals (requires intraday data feed).', sortOrder: 10 },
  intraday_breakout:     { label: 'Intraday Breakout',     description: 'Intraday breakout patterns (requires intraday data feed).', sortOrder: 11 },
  intraday_breakdown:    { label: 'Intraday Breakdown',    description: 'Intraday breakdown patterns (requires intraday data feed).', sortOrder: 12 },
};

export const RISK_PROFILE_LABELS: Record<string, string> = {
  conservative:   'Conservative',
  moderate:       'Moderate',
  moderate_high:  'Moderate-High',
  high:           'High',
};

export function categoryLabel(category: StrategyCategory): string {
  return CATEGORY_META[category]?.label ?? category.replace(/_/g, ' ');
}

export function riskProfileLabel(profile: string): string {
  return RISK_PROFILE_LABELS[profile] ?? profile;
}

export function buildCategoryIndex(
  counts: Partial<Record<StrategyCategory, number>>,
): StrategyCategoryInfo[] {
  return (Object.keys(CATEGORY_META) as StrategyCategory[])
    .map((id) => ({
      id,
      label: CATEGORY_META[id].label,
      description: CATEGORY_META[id].description,
      strategyCount: counts[id] ?? 0,
    }))
    .filter((c) => c.strategyCount > 0)
    .sort((a, b) => CATEGORY_META[a.id].sortOrder - CATEGORY_META[b.id].sortOrder);
}
