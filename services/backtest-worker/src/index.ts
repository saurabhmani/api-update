import { loadBacktestWorkerConfig, serviceMayClaimJobs } from './config';

export function getBacktestWorkerReadiness(env: NodeJS.ProcessEnv = process.env) {
  const config = loadBacktestWorkerConfig(env);
  return {
    healthy: true,
    ready: false,
    claimingEnabled: serviceMayClaimJobs(config),
    reason: serviceMayClaimJobs(config)
      ? 'Service ownership requested; production activation requires approval and a queue adapter.'
      : `Backtest processor owner is ${config.owner}; service will not claim jobs.`,
    config,
  };
}
