// Live Trading Deploy — gated strategy deployment to live execution

import { evaluateLiveTradingGates } from './liveTradingGates';
import { connectBroker } from '../auth/brokerAuth';
import { defaultBrokerName } from '../adapter/registry';
import { acceptDisclaimer as recordDisclaimer } from '../repository/brokerRepository';
import { LIVE_DISCLAIMER_VERSION } from '../types';
import type { BrokerName } from '../types';

export async function deployLiveTrading(
  userId: number,
  strategyId: string,
  actor: string,
  opts?: { broker?: BrokerName; acceptDisclaimer?: boolean },
): Promise<{ ok: boolean; approved: boolean; issues: string[]; accountId?: string }> {
  if (opts?.acceptDisclaimer) {
    await recordDisclaimer(userId, LIVE_DISCLAIMER_VERSION);
  }

  const gates = await evaluateLiveTradingGates(userId);
  if (!gates.allowed) {
    return { ok: false, approved: false, issues: gates.issues };
  }

  let strategyApproved = true;
  const strategyIssues: string[] = [];
  try {
    const { requestPaperDeployment } = await import('@/lib/strategy-lab');
    const paperResult = await requestPaperDeployment(strategyId, actor);
    if (!paperResult.approved) {
      strategyApproved = false;
      strategyIssues.push(...paperResult.issues);
    }
  } catch {
    strategyIssues.push('Strategy validation unavailable — deploy with caution');
  }

  const broker = opts?.broker ?? (defaultBrokerName() as BrokerName);
  const connected = await connectBroker(userId, broker, {
    accessToken: `live_${userId}_${Date.now()}`,
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
    brokerUserId: actor,
  });

  if (!connected.ok || !connected.connection) {
    return {
      ok: false,
      approved: false,
      issues: [...gates.issues, connected.error ?? 'Broker connect failed'],
    };
  }

  return {
    ok: strategyApproved,
    approved: strategyApproved && gates.allowed,
    issues: strategyIssues,
    accountId: connected.connection.id,
  };
}
