// Order Sync Service — reconcile broker orders with local DB

import { getBrokerAdapter, defaultBrokerName } from '../adapter/registry';
import { paperAdapter } from '../adapter/paperAdapter';
import { getValidCredentials } from '../auth/brokerAuth';
import {
  listBrokerOrders,
  logBrokerSync,
  upsertBrokerOrderFromSync,
} from '../repository/brokerRepository';
import { logFailure } from '../sdk/failureLog';
import type { BrokerName } from '../types';

export async function syncBrokerOrders(userId: number, broker?: BrokerName) {
  const name = broker ?? (defaultBrokerName() as BrokerName);
  if (name === 'paper') paperAdapter.setUserId(userId);

  const t0 = Date.now();
  const creds = await getValidCredentials(userId, name);
  if (!creds.ok || !creds.credentials) {
    await logBrokerSync({
      userId, syncType: 'orders', broker: name, recordsSynced: 0,
      status: 'failed', errorMessage: creds.error, durationMs: Date.now() - t0,
    });
    return { ok: false, error: creds.error, orders: [] };
  }

  try {
    const adapter = getBrokerAdapter(name);
    const remote = await adapter.listOrders(creds.credentials);
    for (const o of remote) {
      await upsertBrokerOrderFromSync(userId, name, {
        brokerOrderId: o.brokerOrderId,
        symbol: o.symbol,
        side: o.side,
        quantity: o.quantity,
        filledQty: o.filledQty,
        price: o.price,
        avgFillPrice: o.avgFillPrice,
        status: o.status,
      });
    }
    const local = await listBrokerOrders(userId);
    await logBrokerSync({
      userId, syncType: 'orders', broker: name, recordsSynced: remote.length,
      status: 'ok', durationMs: Date.now() - t0,
    });
    return { ok: true, synced: remote.length, orders: local };
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Sync failed';
    await logFailure({ userId, broker: name, operation: 'sync_orders', errorMessage: msg });
    await logBrokerSync({
      userId, syncType: 'orders', broker: name, recordsSynced: 0,
      status: 'failed', errorMessage: msg, durationMs: Date.now() - t0,
    });
    return { ok: false, error: msg, orders: [] };
  }
}
