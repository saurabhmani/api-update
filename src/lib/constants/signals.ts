export const SIGNAL_TYPES = ['BUY', 'SELL', 'HOLD', 'WAIT'] as const;
export type SignalType = typeof SIGNAL_TYPES[number];

export const TIMEFRAMES = ['intraday', 'swing', 'positional'] as const;
export type Timeframe = typeof TIMEFRAMES[number];

export const RISK_LEVELS = ['Low', 'Medium', 'High'] as const;
export type RiskLevel = typeof RISK_LEVELS[number];

export const SIGNAL_STATUSES = ['active', 'expired', 'target_hit', 'sl_hit', 'cancelled'] as const;
export type SignalStatus = typeof SIGNAL_STATUSES[number];

export const SETUP_STATUSES = ['pending', 'triggered', 'target_hit', 'stop_loss_hit', 'expired', 'cancelled'] as const;
export type SetupStatus = typeof SETUP_STATUSES[number];

// Validity windows
export const VALIDITY_HOURS: Record<Timeframe, number> = {
  intraday:   0.5,  // until market close same day
  swing:      72,   // 3 trading days
  positional: 240,  // ~10 trading days
};

// Minimum confidence to generate a trade setup
export const MIN_SETUP_CONFIDENCE = 65;

// Maximum reasons to show per signal
export const MAX_SIGNAL_REASONS = 3;

// Signal refresh intervals (seconds)
export const REFRESH_INTERVALS: Record<Timeframe, number> = {
  intraday:   60,
  swing:      900,   // 15 min
  positional: 3600,  // 1 hour
};
