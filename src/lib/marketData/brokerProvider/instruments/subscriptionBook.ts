/**
 * Per-user + per-provider subscription book.
 * Deduplicates by instrumentKey; retains broker-native refs for reconnect resub.
 */

import type { BrokerProviderName, NormalizedInstrument } from '../types';
import { connectionKeyString, type ConnectionKey } from '../../connectionManager/types';

export interface SubscriptionEntry {
  instrument: NormalizedInstrument;
  /** Provider-native wire key: Kite token string OR Shoonya `EXCH|token` */
  brokerRef: string;
  subscribedAt: string;
}

export interface SubscribeDelta {
  added: SubscriptionEntry[];
  already: SubscriptionEntry[];
  /** instrumentKeys that could not be mapped */
  failed: string[];
}

export interface UnsubscribeDelta {
  removed: SubscriptionEntry[];
  missing: string[];
}

export class SubscriptionBook {
  readonly key: ConnectionKey;
  readonly keyString: string;
  private readonly entries = new Map<string, SubscriptionEntry>();

  constructor(userId: string | number, provider: BrokerProviderName) {
    this.key = { userId: String(userId), provider };
    this.keyString = connectionKeyString(this.key);
  }

  size(): number {
    return this.entries.size;
  }

  has(instrumentKey: string): boolean {
    return this.entries.has(instrumentKey);
  }

  get(instrumentKey: string): SubscriptionEntry | undefined {
    return this.entries.get(instrumentKey);
  }

  list(): SubscriptionEntry[] {
    return [...this.entries.values()];
  }

  listInstrumentKeys(): string[] {
    return [...this.entries.keys()];
  }

  listBrokerRefs(): string[] {
    return [...this.entries.values()].map((e) => e.brokerRef);
  }

  /**
   * Record subscriptions. Dedupes by instrumentKey — duplicates land in `already`.
   */
  applySubscribe(
    rows: Array<{ instrument: NormalizedInstrument; brokerRef: string }>,
  ): SubscribeDelta {
    const added: SubscriptionEntry[] = [];
    const already: SubscriptionEntry[] = [];

    for (const row of rows) {
      const key = row.instrument.instrumentKey;
      const existing = this.entries.get(key);
      if (existing) {
        already.push(existing);
        continue;
      }
      const entry: SubscriptionEntry = {
        instrument: row.instrument,
        brokerRef: row.brokerRef,
        subscribedAt: new Date().toISOString(),
      };
      this.entries.set(key, entry);
      added.push(entry);
    }

    return { added, already, failed: [] };
  }

  applyUnsubscribe(instrumentKeys: string[]): UnsubscribeDelta {
    const removed: SubscriptionEntry[] = [];
    const missing: string[] = [];
    for (const key of instrumentKeys) {
      const entry = this.entries.get(key);
      if (!entry) {
        missing.push(key);
        continue;
      }
      this.entries.delete(key);
      removed.push(entry);
    }
    return { removed, missing };
  }

  clear(): void {
    this.entries.clear();
  }
}

const GLOBAL_KEY = '__q365_subscription_books__';

function books(): Map<string, SubscriptionBook> {
  const g = globalThis as unknown as Record<string, Map<string, SubscriptionBook> | undefined>;
  if (!g[GLOBAL_KEY]) g[GLOBAL_KEY] = new Map();
  return g[GLOBAL_KEY]!;
}

export function getSubscriptionBook(
  userId: string | number,
  provider: BrokerProviderName,
): SubscriptionBook {
  const id = connectionKeyString({ userId: String(userId), provider });
  const map = books();
  let book = map.get(id);
  if (!book) {
    book = new SubscriptionBook(userId, provider);
    map.set(id, book);
  }
  return book;
}

export function clearSubscriptionBook(
  userId: string | number,
  provider: BrokerProviderName,
): void {
  books().delete(connectionKeyString({ userId: String(userId), provider }));
}

/** Test helper */
export function __resetAllSubscriptionBooksForTests(): void {
  books().clear();
}
