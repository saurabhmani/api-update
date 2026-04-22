// ════════════════════════════════════════════════════════════════
//  TickStore — in-memory, Map-based snapshot of the live feed
//
//  A thin, pluggable facade over the ticker's symbol cache. The
//  ticker itself (kiteTicker.ts) already holds a Map<symbol,Tick>
//  for the hot read path of /api/price. TickStore exposes that
//  same data through a small, stable interface that downstream
//  modules (SignalEngine, UI broadcaster, debug endpoints) can
//  depend on WITHOUT importing the whole ticker surface.
//
//  Guarantees
//  ──────────
//  - Pure memory. No DB writes, no network calls. Every method
//    is O(1) except `snapshot()` which materialises the cache.
//  - Singleton via globalThis (HMR-safe).
//  - Updates are event-driven: we subscribe to tickBus once and
//    mirror every frame into the local Map. Reads never touch
//    the bus, so consumer code can poll getLatest() without
//    contention.
//  - Immutable on the read side: get() hands back the Tick by
//    reference — callers must not mutate it. The ticker parses
//    a fresh object per frame, so this is safe.
// ════════════════════════════════════════════════════════════════

import { tickBus } from './tickBus';
import { getTicker } from './kiteTicker';
import type { TickData } from './tickTypes';
import { logger } from '@/lib/logger';

const log = logger.child({ component: 'tickStore' });

export interface TickStoreStats {
  size:            number;
  totalTicks:      number;
  lastUpdatedTs:   number | null;
  installedAt:     number | null;
}

class TickStore {
  // Authoritative Kite cache — only populated by frames with
  // source='kite' (or absent source, which the ticker uses for real
  // WS frames). This is the source of truth for "last traded price"
  // and deliberately never decays: a Friday-close Kite LTP must
  // still be readable on Saturday so the UI can render it.
  private readonly kiteStore  = new Map<string, TickData>();
  // Yahoo shadow cache — used only for symbols that have no Kite
  // entry yet. A Kite tick for the same symbol takes over
  // immediately and the Yahoo entry becomes dormant.
  private readonly yahooStore = new Map<string, TickData>();
  private totalTicks = 0;
  private lastUpdatedTs: number | null = null;
  private installedAt: number | null = null;
  private busHandler: ((tick: TickData) => void) | null = null;

  /** Install the bus listener. Idempotent. */
  install(): void {
    if (this.busHandler) return;
    this.installedAt = Date.now();

    // Source-aware write: Yahoo frames can never overwrite a Kite
    // entry. The ticker emits real frames without a `source` field,
    // so we treat "absent" as Kite (the only producer that does this).
    this.busHandler = (tick: TickData): void => {
      if (!tick.symbol) return;
      const key = tick.symbol.toUpperCase();
      const isYahoo = tick.source === 'yahoo';
      if (isYahoo) {
        this.yahooStore.set(key, tick);
      } else {
        this.kiteStore.set(key, tick);
      }
      this.totalTicks += 1;
      this.lastUpdatedTs = Date.now();
    };
    tickBus.on('tick', this.busHandler);

    // Seed the Kite cache from the ticker's current snapshot (the
    // ticker only stores Kite frames, so this never pollutes).
    const seed = getTicker().getAllTicks();
    for (const t of seed) {
      if (t.symbol) this.kiteStore.set(t.symbol.toUpperCase(), t);
    }
    console.log(`[tickStore] installed  seeded=${seed.length}  (kite-only)`);
  }

  /** Remove the listener. Used by tests and teardown. */
  uninstall(): void {
    if (this.busHandler) {
      tickBus.off('tick', this.busHandler);
      this.busHandler = null;
    }
  }

  /** O(1) lookup with source priority — Kite entry wins, Yahoo is
   *  only returned when Kite has never produced a tick for this
   *  symbol. Returns null if neither cache has the symbol. */
  get(symbol: string): TickData | null {
    assertNotBacktest('get');
    const key = symbol.trim().toUpperCase();
    return this.kiteStore.get(key) ?? this.yahooStore.get(key) ?? null;
  }

  /** Explicit Kite-only read. Callers that MUST not accept a Yahoo
   *  fallback (e.g. execution paths) should use this. */
  getKite(symbol: string): TickData | null {
    assertNotBacktest('getKite');
    return this.kiteStore.get(symbol.trim().toUpperCase()) ?? null;
  }

  has(symbol: string): boolean {
    assertNotBacktest('has');
    const key = symbol.trim().toUpperCase();
    return this.kiteStore.has(key) || this.yahooStore.has(key);
  }

  size(): number {
    // Union size — a symbol present in both counts once. The only
    // caller is the stats/debug endpoint; overcounting would be
    // misleading.
    const union = new Set<string>(this.kiteStore.keys());
    for (const k of this.yahooStore.keys()) union.add(k);
    return union.size;
  }

  /**
   * Materialise the merged view (Kite wins). O(n). For debug
   * endpoints only — do NOT call from a tick handler or an API
   * hot path.
   */
  snapshot(): TickData[] {
    const merged = new Map<string, TickData>();
    for (const [k, t] of this.yahooStore) merged.set(k, t);
    for (const [k, t] of this.kiteStore)  merged.set(k, t);
    return [...merged.values()];
  }

  stats(): TickStoreStats {
    return {
      size:          this.size(),
      totalTicks:    this.totalTicks,
      lastUpdatedTs: this.lastUpdatedTs,
      installedAt:   this.installedAt,
    };
  }
}

// ── Backtest isolation guard ──────────────────────────────────
// The backtest runner flips this flag at entry and clears it on
// exit. Any call into the tick store while the flag is set means
// a backtest path has crossed into live WS territory — we throw
// immediately so the violation surfaces in test runs rather than
// silently contaminating backtest results with live ticks.
const BT_FLAG = '__q365_backtest_active__';

export function setBacktestMode(active: boolean): void {
  (globalThis as any)[BT_FLAG] = active;
  if (active) {
    console.log('[DATA SOURCE] mode=BACKTEST  tickStore access will throw');
  } else {
    console.log('[DATA SOURCE] mode=LIVE     tickStore access permitted');
  }
}

export function isBacktestMode(): boolean {
  return (globalThis as any)[BT_FLAG] === true;
}

function assertNotBacktest(method: string): void {
  if (isBacktestMode()) {
    throw new Error(
      `[tickStore] ${method}() called during BACKTEST mode — ` +
      `backtest must use historical candles only, never live ticks`
    );
  }
}

// ── Singleton ─────────────────────────────────────────────────
const GLOBAL_KEY = '__q365_tick_store__';

function getSingleton(): TickStore {
  const g = globalThis as unknown as Record<string, TickStore | undefined>;
  if (!g[GLOBAL_KEY]) {
    g[GLOBAL_KEY] = new TickStore();
  }
  return g[GLOBAL_KEY]!;
}

export function getTickStore(): TickStore {
  return getSingleton();
}

export type { TickStore };
