// Live Trading Kill Switch

export function isGlobalLiveKillSwitchActive(): boolean {
  return (
    process.env.LIVE_KILL_SWITCH === '1'
    || process.env.BROKER_KILL_SWITCH === '1'
    || process.env.EXECUTION_HALT === '1'
  );
}

export function isLiveTradingEnabled(): boolean {
  const mode = process.env.EXECUTION_MODE ?? 'signal-only';
  return mode === 'live' || mode === 'paper';
}
