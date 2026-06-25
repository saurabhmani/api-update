// Broker Health Monitoring

import { getBrokerAdapter, defaultBrokerName, listBrokerAdapters } from '../adapter/registry';
import { getValidCredentials } from '../auth/brokerAuth';
import {
  getLatestBrokerHealth,
  logBrokerFailure,
  saveBrokerHealth,
} from '../repository/brokerRepository';
import { isGlobalLiveKillSwitchActive } from '../killSwitch';
import type { BrokerHealthSnapshot, BrokerName } from '../types';

export async function checkBrokerHealth(
  userId: number,
  broker?: BrokerName,
): Promise<BrokerHealthSnapshot & { killSwitchActive: boolean }> {
  const name = broker ?? (defaultBrokerName() as BrokerName);
  const killSwitchActive = isGlobalLiveKillSwitchActive();

  const creds = await getValidCredentials(userId, name);
  if (!creds.ok || !creds.credentials) {
    const snapshot: BrokerHealthSnapshot = {
      broker: name,
      status: 'down',
      tokenValid: false,
      message: creds.error ?? 'Not connected',
      checkedAt: new Date().toISOString(),
    };
    await saveBrokerHealth(snapshot);
    return { ...snapshot, killSwitchActive };
  }

  const adapter = getBrokerAdapter(name);
  const t0 = Date.now();
  try {
    const health = await adapter.healthCheck(creds.credentials);
    const latency = Date.now() - t0;
    const snapshot: BrokerHealthSnapshot = {
      ...health,
      latencyMs: health.latencyMs ?? latency,
      checkedAt: new Date().toISOString(),
      message: killSwitchActive ? 'Kill switch active' : health.message,
      status: killSwitchActive ? 'degraded' : health.status,
    };
    await saveBrokerHealth(snapshot);
    return { ...snapshot, killSwitchActive };
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Health check failed';
    await logBrokerFailure({ userId, broker: name, operation: 'health_check', errorMessage: msg });
    const snapshot: BrokerHealthSnapshot = {
      broker: name,
      status: 'down',
      tokenValid: false,
      message: msg,
      checkedAt: new Date().toISOString(),
    };
    await saveBrokerHealth(snapshot);
    return { ...snapshot, killSwitchActive };
  }
}

export async function getBrokerHealthReport(userId: number) {
  const adapters = listBrokerAdapters();
  const reports = await Promise.all(
    adapters.map(async (b) => {
      const latest = await getLatestBrokerHealth(b);
      let current: BrokerHealthSnapshot & { killSwitchActive: boolean };
      try {
        current = await checkBrokerHealth(userId, b);
      } catch {
        current = {
          broker: b,
          status: 'down',
          tokenValid: false,
          checkedAt: new Date().toISOString(),
          killSwitchActive: isGlobalLiveKillSwitchActive(),
        };
      }
      return { broker: b, current, lastSnapshot: latest };
    }),
  );
  return {
    mode: process.env.EXECUTION_MODE ?? 'signal-only',
    killSwitchActive: isGlobalLiveKillSwitchActive(),
    brokers: reports,
  };
}
