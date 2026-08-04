// ════════════════════════════════════════════════════════════════
//  liveFeedBaseline — market-open symbol seed for the poll loop
//
//  receiveAll WebSocket clients do not register per-symbol demand,
//  so without a baseline the poll loop has zero symbols and never
//  fetches ticks. This module loads active signal symbols (+ a
//  small benchmark slice) and registers HTTP demand.
// ════════════════════════════════════════════════════════════════

import { isMarketOpen } from '@/lib/marketData/marketHours';
import { registerDemand } from '@/lib/marketData/liveMarketFeed';
import { logger } from '@/lib/logger';

const log = logger.child({ component: 'liveFeedBaseline' });

const BASELINE_CAP = Math.max(
  10,
  Math.min(200, Number(process.env.LIVE_FEED_BASELINE_SYMBOLS) || 80),
);
const REFRESH_MS = Math.max(
  30_000,
  Number(process.env.LIVE_FEED_BASELINE_REFRESH_MS) || 120_000,
);

const GLOBAL_KEY = '__q365_live_feed_baseline__';

interface BaselineGlobal {
  symbols: string[];
  lastRefreshAt: number;
  refreshInFlight: Promise<string[]> | null;
}

function baseline(): BaselineGlobal {
  const g = globalThis as unknown as Record<string, BaselineGlobal | undefined>;
  if (!g[GLOBAL_KEY]) {
    g[GLOBAL_KEY] = { symbols: [], lastRefreshAt: 0, refreshInFlight: null };
  }
  return g[GLOBAL_KEY]!;
}

/** Soft-timeout: resolve with fallback when `p` takes too long.
 *  The original promise keeps running (caller must not depend on cancel). */
async function softTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(fallback), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function queryBaselineSymbols(): Promise<string[]> {
  const out = new Set<string>();
  try {
    const { db } = await import('@/lib/db');
    const { rows: snap } = await db.query<{ symbol: string }>(
      `SELECT symbol FROM q365_confirmed_signal_snapshots
        WHERE status IN ('ACTIVE', 'APPROVED_SIGNAL')
        ORDER BY id DESC
        LIMIT ?`,
      [BASELINE_CAP],
    );
    for (const r of snap as any[]) {
      const s = String(r.symbol ?? '').trim().toUpperCase();
      if (s) out.add(s);
    }
    const remaining = BASELINE_CAP - out.size;
    if (remaining > 0) {
      // Prefer PK `id DESC` over DISTINCT+ORDER BY generated_at — the latter
      // full-scans q365_signals on large tables and was stalling every
      // /api/signals poll via refreshLiveFeedBaseline's shared in-flight.
      const { rows: sig } = await db.query<{ symbol: string }>(
        `SELECT symbol FROM q365_signals
          WHERE status IN ('active', 'watchlist')
            AND (invalidation_reason IS NULL OR invalidation_reason = '')
          ORDER BY id DESC
          LIMIT ?`,
        [Math.max(remaining * 3, remaining)],
      );
      for (const r of sig as any[]) {
        if (out.size >= BASELINE_CAP) break;
        const s = String(r.symbol ?? '').trim().toUpperCase();
        if (s) out.add(s);
      }
    }
  } catch (err) {
    log.warn('baseline DB query failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  if (out.size === 0) {
    try {
      const { DEFAULT_PHASE1_CONFIG } = await import(
        '@/lib/signal-engine/constants/signalEngine.constants'
      );
      for (const sym of DEFAULT_PHASE1_CONFIG.universe.slice(0, BASELINE_CAP)) {
        out.add(String(sym).toUpperCase());
      }
    } catch { /* universe not loaded yet */ }
  }

  return [...out];
}

export function getBaselineSymbols(): string[] {
  return baseline().symbols;
}

/** Cap how long request-path callers wait on a baseline DB refresh.
 *  A hung DISTINCT/ORDER BY on q365_signals previously blocked every
 *  concurrent /api/signals poll (shared refreshInFlight) past nginx's
 *  60s read timeout → Partial Intelligence Mode. */
const BASELINE_WAIT_MS = Math.max(
  500,
  Math.min(8_000, Number(process.env.LIVE_FEED_BASELINE_WAIT_MS) || 2_500),
);

/** Refresh baseline symbol set and register poll demand. */
export async function refreshLiveFeedBaseline(force = false): Promise<string[]> {
  const store = baseline();
  if (!isMarketOpen()) {
    store.symbols = [];
    return store.symbols;
  }
  const now = Date.now();
  if (!force && store.symbols.length > 0 && now - store.lastRefreshAt < REFRESH_MS) {
    return store.symbols;
  }
  if (!store.refreshInFlight) {
    store.refreshInFlight = (async () => {
      try {
        const next = await queryBaselineSymbols();
        store.symbols = next;
        store.lastRefreshAt = Date.now();
        if (store.symbols.length > 0) {
          registerDemand(store.symbols);
          log.info('baseline demand registered', { count: store.symbols.length });
        }
        return store.symbols;
      } finally {
        store.refreshInFlight = null;
      }
    })();
  }

  // Never await the DB refresh unboundedly — return the last-known
  // baseline (or []) so /api/signals / broker connect stay responsive.
  return softTimeout(store.refreshInFlight, BASELINE_WAIT_MS, store.symbols);
}

export function _resetLiveFeedBaselineForTests(): void {
  delete (globalThis as unknown as Record<string, unknown>)[GLOBAL_KEY];
}
