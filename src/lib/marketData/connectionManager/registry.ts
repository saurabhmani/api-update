/**
 * Process-local registry: Map<`${userId}:${provider}`, BrokerConnectionInstance>
 *
 * acquire() increments refCount; releaseConnection() decrements and destroys at 0.
 */

import { logger } from '@/lib/logger';
import type { BrokerProviderName } from '@/lib/marketData/brokerProvider/types';
import { ShoonyaConnectionInstance } from './shoonyaInstance';
import type {
  BrokerConnectionInstance,
  BrokerConnectionSnapshot,
  ConnectionKey,
} from './types';
import { connectionKeyString } from './types';
import { ZerodhaConnectionInstance } from './zerodhaInstance';

const log = logger.child({ component: 'connection.registry' });

const GLOBAL_KEY = '__q365_broker_connection_registry__';

type RegistryStore = Map<string, BrokerConnectionInstance>;

function store(): RegistryStore {
  const g = globalThis as unknown as Record<string, RegistryStore | undefined>;
  if (!g[GLOBAL_KEY]) g[GLOBAL_KEY] = new Map();
  return g[GLOBAL_KEY]!;
}

function normalizeKey(input: {
  userId: number | string;
  provider: BrokerProviderName | 'kite';
}): ConnectionKey {
  const provider = input.provider === 'kite' ? 'zerodha' : input.provider;
  return {
    userId: String(input.userId).trim(),
    provider,
  };
}

function createInstance(key: ConnectionKey): BrokerConnectionInstance {
  if (key.provider === 'shoonya') return new ShoonyaConnectionInstance(key);
  return new ZerodhaConnectionInstance(key);
}

/**
 * Acquire (or create) a connection instance for this user+provider.
 * Does not authenticate — caller must call authenticate() with that user's token.
 */
export function acquireBrokerConnection(input: {
  userId: number | string;
  provider: BrokerProviderName | 'kite';
}): BrokerConnectionInstance {
  const key = normalizeKey(input);
  const id = connectionKeyString(key);
  const map = store();
  let inst = map.get(id);
  if (!inst) {
    inst = createInstance(key);
    map.set(id, inst);
    log.info('connection_acquired_new', { key: id });
  }
  inst.addRef();
  return inst;
}

export function getBrokerConnection(input: {
  userId: number | string;
  provider: BrokerProviderName | 'kite';
}): BrokerConnectionInstance | null {
  const key = normalizeKey(input);
  return store().get(connectionKeyString(key)) ?? null;
}

export async function releaseBrokerConnection(input: {
  userId: number | string;
  provider: BrokerProviderName | 'kite';
}): Promise<void> {
  const key = normalizeKey(input);
  const id = connectionKeyString(key);
  const map = store();
  const inst = map.get(id);
  if (!inst) return;
  await inst.release();
  if (inst.getSnapshot().refCount <= 0) {
    map.delete(id);
    log.info('connection_destroyed', { key: id });
  }
}

/**
 * Authenticate + connect a user's broker stream without touching other keys.
 * Idempotent: does not stack refCounts on repeated OAuth.
 */
export async function upsertUserBrokerSession(input: {
  userId: number | string;
  provider: BrokerProviderName | 'kite';
  accessToken: string;
  accountId?: string | null;
  connectStream?: boolean;
}): Promise<BrokerConnectionSnapshot> {
  const key = normalizeKey(input);
  const id = connectionKeyString(key);
  const map = store();
  let inst = map.get(id);
  if (!inst) {
    inst = createInstance(key);
    map.set(id, inst);
    inst.addRef();
    log.info('connection_acquired_new', { key: id });
  } else if (inst.getSnapshot().refCount <= 0) {
    inst.addRef();
  }

  await inst.authenticate({
    accessToken: input.accessToken,
    accountId: input.accountId,
  });
  if (input.connectStream !== false) {
    await inst.connect();
  }
  return inst.getSnapshot();
}

export function listBrokerConnectionSnapshots(): BrokerConnectionSnapshot[] {
  return [...store().values()].map((i) => i.getSnapshot());
}

/** Test helper — wipe registry between tests. */
export async function __resetBrokerConnectionRegistryForTests(): Promise<void> {
  const map = store();
  for (const inst of [...map.values()]) {
    try {
      await inst.disconnect();
    } catch { /* ignore */ }
  }
  map.clear();
}
