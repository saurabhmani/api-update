/**
 * Multi-tenant broker streaming ownership.
 *
 * Product is multi-user (users + broker_connections). Interactive streams
 * are keyed by ConnectionKey { userId, provider }. The process-global Kite
 * ticker / tickBus remains a SYSTEM feed for jobs and shared WS fan-out,
 * owned only by SYSTEM_MARKET_DATA_USER_ID (or an explicit system session).
 *
 * Broker limits:
 *  - Kite Connect: one WebSocket ticker per api_key + access_token (per login).
 *  - Shoonya/Noren: one WebSocket per trading account.
 * Multiple users ⇒ multiple in-process ticker instances (one per ConnectionKey).
 *
 * Rules enforced by the registry:
 *  - No single global access token shared across users for interactive work.
 *  - User A's OAuth must not replace User B's token or tear down B's stream.
 *  - User A's disconnect must not stop User B's stream or clear B's session.
 */

import type { BrokerProviderName } from '@/lib/marketData/brokerProvider/types';

export interface ConnectionKey {
  userId: string;
  provider: BrokerProviderName;
}

export type BrokerConnectionState =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'disconnected'
  | 'expired'
  | 'error';

export interface BrokerConnectionSnapshot {
  key: ConnectionKey;
  keyString: string;
  state: BrokerConnectionState;
  sessionVersion: number;
  refCount: number;
  subscriptionCount: number;
  reconnectAttempts: number;
  lastTickAt: string | null;
  lastSuccessfulPollAt: string | null;
  lastError: string | null;
  hasAuthenticatedSession: boolean;
  updatedAt: string;
}

export interface BrokerConnectionInstance {
  readonly key: ConnectionKey;
  readonly keyString: string;

  getSnapshot(): BrokerConnectionSnapshot;

  /** Apply a freshly hydrated access token / session for THIS key only. */
  authenticate(session: {
    accessToken: string;
    accountId?: string | null;
    authenticatedAt?: string;
  }): Promise<void>;

  connect(): Promise<void>;
  disconnect(): Promise<void>;

  subscribe(brokerRefs: string[]): Promise<void>;
  unsubscribe(brokerRefs: string[]): Promise<void>;

  /** Release one consumer; destroys when refCount hits 0. */
  release(): Promise<void>;
  addRef(): void;

  bumpSessionVersion(): number;
}

export function connectionKeyString(key: ConnectionKey): string {
  return `${String(key.userId).trim()}:${key.provider}`;
}

export function parseConnectionKey(raw: string): ConnectionKey | null {
  const idx = raw.indexOf(':');
  if (idx <= 0) return null;
  const userId = raw.slice(0, idx).trim();
  const provider = raw.slice(idx + 1).trim().toLowerCase();
  if (!userId) return null;
  if (provider !== 'zerodha' && provider !== 'shoonya') return null;
  return { userId, provider };
}
