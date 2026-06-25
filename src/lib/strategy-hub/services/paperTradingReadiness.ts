// ════════════════════════════════════════════════════════════════
//  Paper Trading Readiness — deployment gate checks
// ════════════════════════════════════════════════════════════════

import { STRATEGY_REGISTRY } from '@/lib/signal-engine/strategies/strategyRegistry';
import type { StrategyName } from '@/lib/signal-engine/types/signalEngine.types';
import type { DeploymentStatus, PaperTradingReadiness, StrategyProfileRow } from '../types';

interface ReadinessContext {
  hasEvaluator: boolean;
  isActiveInRunner: boolean;
  profile?: StrategyProfileRow | null;
  totalSignals?: number;
}

export function assessPaperTradingReadiness(
  strategyId: StrategyName | string,
  context: ReadinessContext,
): PaperTradingReadiness {
  const entry = STRATEGY_REGISTRY[strategyId as StrategyName];
  const inRegistry = !!entry;

  const checks = [
    { name: 'Registered in strategy registry', pass: inRegistry, required: true },
    { name: 'Evaluator implemented', pass: context.hasEvaluator, required: true },
    { name: 'Active in signal engine runner', pass: context.isActiveInRunner, required: true },
    { name: 'Risk profile declared', pass: !!entry?.riskProfile, required: true },
    { name: 'Trade plan metadata complete', pass: !!entry?.explanationTemplate && !!entry?.invalidationLogic, required: true },
    {
      name: 'Minimum performance sample (5 signals)',
      pass: (context.totalSignals ?? 0) >= 5,
      required: false,
    },
  ];

  const requiredChecks = checks.filter((c) => c.required);
  const ready = requiredChecks.every((c) => c.pass);
  const score = Math.round((checks.filter((c) => c.pass).length / checks.length) * 100);

  let deploymentStatus: DeploymentStatus = 'registered';
  if (context.profile?.deployment_status) {
    deploymentStatus = context.profile.deployment_status;
  } else if (ready) {
    deploymentStatus = 'paper_ready';
  } else if (context.hasEvaluator) {
    deploymentStatus = 'staging';
  }

  return {
    ready,
    score,
    checks,
    deploymentStatus,
    paperTradingEnabled: context.profile?.paper_trading_enabled ?? ready,
  };
}
