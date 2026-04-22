/**
 * Feature key constants — single source of truth.
 * Used by entitlement service, API routes, and UI FeatureGate component.
 */

export const FEATURES = {
  // Signals
  SIGNALS_BASIC:         'signals_basic',
  SIGNALS_ADVANCED:      'signals_advanced',
  SIGNALS_DAILY_LIMIT:   'signals_daily_limit',   // TRUE on free = limited to 3/day

  // Watchlist
  SMART_WATCHLIST:       'smart_watchlist_ranking',

  // Trade setups
  TRADE_SETUPS:          'trade_setups',

  // Alerts
  SMART_ALERTS:          'smart_alerts_full',

  // Market explanation
  MARKET_EXPLANATION:    'market_explanation',

  // Option intelligence
  OPTION_INTELLIGENCE:   'option_intelligence',

  // Top opportunities (elite)
  TOP_OPPORTUNITIES:     'top_opportunities',

  // Analytics
  TRADER_ANALYTICS:      'trader_analytics',

  // Onboarding
  ONBOARDING:            'onboarding',
} as const;

export type FeatureKey = typeof FEATURES[keyof typeof FEATURES];

// Daily signal limit for free users
export const FREE_DAILY_SIGNAL_LIMIT = 3;

// Plan display names
export const PLAN_LABELS: Record<string, string> = {
  free:  'Free',
  pro:   'Pro',
  elite: 'Elite',
};

// Plan upgrade message per feature
export const UPGRADE_MESSAGES: Record<string, { title: string; desc: string; plan: string }> = {
  [FEATURES.TRADE_SETUPS]: {
    title: 'Trade Setups — Pro Feature',
    desc:  'Unlock structured trade ideas with entry, SL, and targets.',
    plan:  'pro',
  },
  [FEATURES.SMART_WATCHLIST]: {
    title: 'Smart Watchlist — Pro Feature',
    desc:  'See your watchlist ranked by opportunity score.',
    plan:  'pro',
  },
  [FEATURES.SMART_ALERTS]: {
    title: 'Smart Alerts — Pro Feature',
    desc:  'Get intelligent alerts for breakouts, volume spikes, and setups.',
    plan:  'pro',
  },
  [FEATURES.OPTION_INTELLIGENCE]: {
    title: 'Option Intelligence — Pro Feature',
    desc:  'Support/resistance zones, build-ups, and trap detection from OI.',
    plan:  'pro',
  },
  [FEATURES.TOP_OPPORTUNITIES]: {
    title: 'Top Opportunities — Elite Feature',
    desc:  'Priority-ranked top picks updated in real time.',
    plan:  'elite',
  },
  [FEATURES.TRADER_ANALYTICS]: {
    title: 'Trader Analytics — Elite Feature',
    desc:  'Deep insights into your trading patterns and mistakes.',
    plan:  'elite',
  },
};
