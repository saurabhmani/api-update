// Broker Adapter Registry

import type { BrokerAdapter } from './types';
import type { BrokerName } from '../types';
import { simulatedAdapter } from './simulatedAdapter';
import { paperAdapter } from './paperAdapter';

const adapters = new Map<BrokerName, BrokerAdapter>([
  ['simulated', simulatedAdapter],
  ['paper', paperAdapter],
]);

export function registerBrokerAdapter(adapter: BrokerAdapter): void {
  adapters.set(adapter.name, adapter);
}

export function getBrokerAdapter(name: BrokerName): BrokerAdapter {
  const adapter = adapters.get(name);
  if (!adapter) throw new Error(`Unknown broker adapter: ${name}`);
  return adapter;
}

export function listBrokerAdapters(): BrokerName[] {
  return Array.from(adapters.keys());
}

export function defaultBrokerName(): BrokerName {
  const mode = process.env.EXECUTION_MODE ?? 'signal-only';
  if (mode === 'live') return process.env.BROKER_ADAPTER ?? 'simulated';
  if (mode === 'paper') return 'paper';
  return 'simulated';
}
