// Live Order Engine — gated broker order placement

import { v4 as uuidv4 } from 'uuid';
import { getBrokerAdapter, defaultBrokerName } from '../adapter/registry';
import { paperAdapter } from '../adapter/paperAdapter';
import { getValidCredentials } from '../auth/brokerAuth';
import { isGlobalLiveKillSwitchActive } from '../killSwitch';
import { insertBrokerOrder } from '../repository/brokerRepository';
import { logFailure } from '../sdk/failureLog';
import { withRetry } from '../sdk/retry';
import { evaluateLiveTradingGates } from './liveTradingGates';
import type { BrokerPlaceOrderRequest, BrokerPlaceOrderResult } from '../types';

export async function placeLiveOrder(
  userId: number,
  req: BrokerPlaceOrderRequest,
  opts?: { skipGates?: boolean; broker?: string },
): Promise<BrokerPlaceOrderResult & { gateIssues?: string[] }> {
  if (isGlobalLiveKillSwitchActive()) {
    return { ok: false, error: 'Live kill switch active', errorCode: 'KILL_SWITCH' };
  }

  if (!opts?.skipGates) {
    const gates = await evaluateLiveTradingGates(userId);
    if (!gates.allowed) {
      return { ok: false, error: gates.issues.join('; '), errorCode: 'GATES_FAILED', gateIssues: gates.issues };
    }
  }

  const brokerName = (opts?.broker ?? defaultBrokerName()) as string;
  if (brokerName === 'paper') paperAdapter.setUserId(userId);

  const creds = await getValidCredentials(userId, brokerName as 'simulated');
  if (!creds.ok || !creds.credentials) {
    return { ok: false, error: creds.error ?? 'Not connected', errorCode: 'NOT_CONNECTED' };
  }

  const adapter = getBrokerAdapter(brokerName as 'simulated');
  const orderId = `live_${uuidv4().slice(0, 12)}`;

  try {
    const result = await withRetry(
      () => adapter.placeOrder(req, creds.credentials!),
      { maxAttempts: 3 },
    );

    if (!result.ok) {
      await logFailure({
        userId,
        broker: brokerName,
        operation: 'place_order',
        errorCode: result.errorCode,
        errorMessage: result.error ?? 'Order failed',
        request: req as unknown as Record<string, unknown>,
      });
      return result;
    }

    await insertBrokerOrder({
      id: orderId,
      userId,
      broker: brokerName as 'simulated',
      brokerOrderId: result.brokerOrderId ?? result.orderId,
      symbol: req.symbol.toUpperCase(),
      side: req.side,
      orderType: req.orderType ?? 'MARKET',
      quantity: req.quantity,
      price: req.price,
      status: result.status ?? 'SUBMITTED',
      strategyId: req.strategyId,
    });

    return { ...result, orderId: result.orderId ?? orderId };
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Order failed';
    await logFailure({
      userId,
      broker: brokerName,
      operation: 'place_order',
      errorMessage: msg,
      request: req as unknown as Record<string, unknown>,
    });
    return { ok: false, error: msg, errorCode: 'EXCEPTION' };
  }
}
