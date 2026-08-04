export type BacktestProcessorOwner = 'monolith' | 'service' | 'disabled';

export function getBacktestProcessorOwner(env: NodeJS.ProcessEnv = process.env): BacktestProcessorOwner {
  const value = env.BACKTEST_PROCESSOR_OWNER ?? 'monolith';
  if (value !== 'monolith' && value !== 'service' && value !== 'disabled') {
    throw new Error(`Invalid BACKTEST_PROCESSOR_OWNER: ${value}`);
  }
  return value;
}

export function ownerMayProcess(kind: 'monolith' | 'service', env: NodeJS.ProcessEnv = process.env): boolean {
  return getBacktestProcessorOwner(env) === kind;
}

export function requireProcessorOwnership(kind: 'monolith' | 'service', env: NodeJS.ProcessEnv = process.env): void {
  const owner = getBacktestProcessorOwner(env);
  if (owner !== kind) throw new Error(`Backtest processing owner is ${owner}; ${kind} claims are disabled`);
}
