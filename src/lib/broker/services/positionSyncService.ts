// Position Sync Service — reconcile broker positions with local DB

import { getBrokerAdapter, defaultBrokerName } from '../adapter/registry';
import { paperAdapter } from '../adapter/paperAdapter';
import { getValidCredentials } from '../auth/brokerAuth';
import {
  listBrokerPositions,
  logBrokerSync,
  upsertBrokerPositionFromSync,
} from '../repository/brokerRepository';
import { logFailure } from '../sdk/failureLog';
import type { BrokerName } from '../types';

export async function syncBrokerPositions(userId: number, broker?: BrokerName) {
  const name = broker ?? (defaultBrokerName() as BrokerName);
  if (name === 'paper') paperAdapter.setUserId(userId);

  const t0 = Date.now();
  const creds = await getValidCredentials(userId, name);
  if (!creds.ok || !creds.credentials) {
    await logBrokerSync({
      userId, syncType: 'positions', broker: name, recordsSynced: 0,
      status: 'failed', errorMessage: creds.error, durationMs: Date.now() - t0,
    });
    return { ok: false, error: creds.error, positions: [] };
  }

  try {
    const adapter = getBrokerAdapter(name);
    const remote = await adapter.listPositions(creds.credentials);
    for (const p of remote) {
      await upsertBrokerPositionFromSync(userId, name, {
        symbol: p.symbol,
        side: p.side,
        quantity: p.quantity,
        avgPrice: p.avgPrice,
        currentPrice: p.currentPrice,
        unrealizedPnl: p.unrealizedPnl,
        status: p.status,
      });
    }
    const local = await listBrokerPositions(userId, 'OPEN');
    await logBrokerSync({
      userId, syncType: 'positions', broker: name, recordsSynced: remote.length,
      status: 'ok', durationMs: Date.now() - t0,
    });
    return { ok: true, synced: remote.length, positions: local };
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Sync failed';
    await logFailure({ userId, broker: name, operation: 'sync_positions', errorMessage: msg });
    await logBrokerSync({
      userId, syncType: 'positions', broker: name, recordsSynced: 0,
      status: 'failed', errorMessage: msg, durationMs: Date.now() - t0,
    });
    return { ok: false, error: msg, positions: [] };
  }
}
