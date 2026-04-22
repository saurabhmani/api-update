// ════════════════════════════════════════════════════════════════
//  SubscriptionManager — reference-counted symbol subscriptions
//
//  Problem
//  ───────
//  The Kite WebSocket is a SINGLE process-wide socket (enforced
//  by the ticker singleton). Multiple independent consumers want
//  to subscribe to overlapping symbol sets:
//
//    consumer A: ["RELIANCE", "TCS", "INFY"]
//    consumer B: ["RELIANCE", "HDFCBANK"]
//
//  If consumer A later unsubscribes its full list, RELIANCE must
//  STAY subscribed because consumer B still cares. The ticker
//  alone can't know this — it only sees the union.
//
//  Solution
//  ────────
//  A per-symbol reference count. `subscribe()` bumps counts and
//  issues new-symbol subscribes only for transitions 0 → 1.
//  `unsubscribe()` decrements and issues actual unsubscribes only
//  for transitions 1 → 0. Consumers hold a handle and release it
//  by calling .release() — no manual bookkeeping needed.
//
//  Guarantees
//  ──────────
//  - No duplicate WebSocket instances — delegates to the single
//    `getTicker()` everyone else uses.
//  - O(1) per symbol per operation.
//  - Thread-safe under Node's single-threaded event loop: the
//    counts map is mutated synchronously around the await.
// ════════════════════════════════════════════════════════════════

import { getTicker, type TickMode } from './kiteTicker';
import { logger } from '@/lib/logger';

const log = logger.child({ component: 'subscriptionManager' });

export interface SubscriptionHandle {
  readonly id:       number;
  readonly symbols:  ReadonlyArray<string>;
  readonly mode:     TickMode;
  release(): Promise<void>;
}

class SubscriptionManager {
  private readonly refCounts = new Map<string, number>();
  private nextId = 1;

  /**
   * Subscribe to a set of symbols on behalf of a consumer. Returns
   * a handle — call `handle.release()` when the consumer shuts down.
   *
   * Idempotent per consumer: calling subscribe() twice with the
   * same symbols from the same consumer yields TWO handles and
   * bumps counts twice. Release both to tear down.
   */
  async subscribe(
    symbols: string[],
    mode: TickMode = 'quote',
  ): Promise<SubscriptionHandle> {
    const normalized = [...new Set(symbols.map((s) => s.trim().toUpperCase()))];
    const toSubscribe: string[] = [];

    for (const sym of normalized) {
      const prev = this.refCounts.get(sym) ?? 0;
      this.refCounts.set(sym, prev + 1);
      if (prev === 0) toSubscribe.push(sym);
    }

    let resolvedOnWire = 0;
    let unknownOnWire = 0;
    if (toSubscribe.length > 0) {
      const result = await getTicker().subscribeSymbols(toSubscribe, mode);
      resolvedOnWire = result.resolved.length;
      unknownOnWire = result.unknown.length;
    }

    const id = this.nextId++;
    console.log(
      `[subscriptionManager] +handle#${id}  asked=${normalized.length}  ` +
      `newOnWire=${toSubscribe.length}  resolved=${resolvedOnWire}  unknown=${unknownOnWire}  ` +
      `totalSymbols=${this.refCounts.size}`
    );

    const release = async (): Promise<void> => {
      await this.releaseHandle(id, normalized);
    };

    return {
      id,
      symbols: normalized,
      mode,
      release,
    };
  }

  private async releaseHandle(id: number, symbols: string[]): Promise<void> {
    const toUnsubscribe: string[] = [];
    for (const sym of symbols) {
      const prev = this.refCounts.get(sym) ?? 0;
      if (prev <= 1) {
        this.refCounts.delete(sym);
        toUnsubscribe.push(sym);
      } else {
        this.refCounts.set(sym, prev - 1);
      }
    }
    if (toUnsubscribe.length > 0) {
      await getTicker().unsubscribeSymbols(toUnsubscribe);
    }
    console.log(
      `[subscriptionManager] -handle#${id}  droppedOnWire=${toUnsubscribe.length}  ` +
      `totalSymbols=${this.refCounts.size}`
    );
  }

  /** Current ref count for a symbol (0 = not subscribed). */
  refCount(symbol: string): number {
    return this.refCounts.get(symbol.trim().toUpperCase()) ?? 0;
  }

  /** All symbols with at least one active consumer. */
  activeSymbols(): string[] {
    return [...this.refCounts.keys()];
  }
}

// ── Singleton ─────────────────────────────────────────────────
const GLOBAL_KEY = '__q365_subscription_manager__';

function getSingleton(): SubscriptionManager {
  const g = globalThis as unknown as Record<string, SubscriptionManager | undefined>;
  if (!g[GLOBAL_KEY]) {
    g[GLOBAL_KEY] = new SubscriptionManager();
  }
  return g[GLOBAL_KEY]!;
}

export function getSubscriptionManager(): SubscriptionManager {
  return getSingleton();
}

export type { SubscriptionManager };
