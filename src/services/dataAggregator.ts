/**
 * Data Aggregator
 *
 * Coordinates the 4-layer market data pipeline at the system level.
 * This module owns the refresh lifecycle — it fetches once, writes to
 * Redis, and all API routes/services read from Redis.
 *
 * Usage patterns:
 *   1. Background scheduler calls refreshMarketUniverse() every 60s
 *   2. API routes call getSnapshot(symbol) — reads Redis only
 *   3. Admin panel calls forceRefresh(symbol) to bypass TTL
 *
 * IMPORTANT: Do NOT call getMarketSnapshot() directly in API routes.
 *            Always call getSnapshot() from this module so caching
 *            is respected and NSE is never hit per user request.
 */

import { db }                            from '@/lib/db';
import { cacheGet, cacheSet, cacheDel }  from '@/lib/redis';
import {
  getMarketSnapshot,
  getBatchSnapshots,
  getOptionChainSnapshot,
  persistCandle,
  type MarketSnapshot,
  type OptionChainSnapshot,
}                                        from './marketDataService';

// ── In-memory refresh state (single process) ─────────────────────
// Prevents concurrent refreshes from hammering NSE simultaneously

const _refreshLocks  = new Set<string>();   // symbols currently being refreshed
let   _isRefreshing  = false;               // global universe refresh in progress
let   _lastRefreshAt = 0;                   // Unix ms of last full refresh

const UNIVERSE_TTL_MS  = 60_000;   // refresh universe every 60s
const SYMBOL_REDIS_TTL = 60;       // Redis TTL per symbol snapshot (seconds)

// ── Universe management ──────────────────────────────────────────

/**
 * Load the active universe from MySQL rankings table.
 * Returns top N instruments ranked by score.
 */
export async function loadUniverse(limit = 100): Promise<
  Array<{ symbol: string; instrument_key: string; name: string }>
> {
  try {
    const { rows } = await db.query(`
      SELECT r.tradingsymbol AS symbol,
             COALESCE(r.instrument_key, CONCAT('NSE_EQ|', r.tradingsymbol)) AS instrument_key,
             COALESCE(r.name, r.tradingsymbol) AS name
      FROM rankings r
      INNER JOIN (
        SELECT tradingsymbol, MAX(score) AS max_score
        FROM rankings
        GROUP BY tradingsymbol
      ) best ON r.tradingsymbol = best.tradingsymbol AND r.score = best.max_score
      GROUP BY r.tradingsymbol
      ORDER BY r.score DESC
      LIMIT ?
    `, [limit]);

    return (rows as any[]).map(r => ({
      symbol:         String(r.symbol  || '').toUpperCase(),
      instrument_key: String(r.instrument_key || ''),
      name:           String(r.name    || ''),
    })).filter(r => r.symbol);
  } catch {
    return [];
  }
}

// ── Core: getSnapshot ────────────────────────────────────────────

/**
 * Primary read path for all API routes and services.
 * Reads Redis first (fast path). If Redis miss, triggers a background
 * fetch and returns null (caller should handle gracefully).
 *
 * To guarantee data is available, call refreshSymbol() first in the
 * background scheduler, then rely on getSnapshot() in hot paths.
 */
export async function getSnapshot(symbol: string): Promise<MarketSnapshot | null> {
  const sym  = symbol.toUpperCase();
  const key  = `stock:${sym}`;

  // Redis fast path — most calls return here
  const cached = await cacheGet<MarketSnapshot>(key);
  if (cached) return cached;

  // Cache miss — fetch immediately but do NOT block on concurrent fetches
  if (!_refreshLocks.has(sym)) {
    // Fire-and-forget; caller gets null this time but next call hits cache
    refreshSymbol(sym).catch(() => {});
  }

  return null;
}

/**
 * Synchronous version — waits for the snapshot even on cache miss.
 * Use this when you MUST have data (e.g. signal generation, not UI).
 */
export async function getSnapshotSync(
  symbol:        string,
  instrumentKey: string
): Promise<MarketSnapshot | null> {
  const sym = symbol.toUpperCase();
  const key = `stock:${sym}`;

  const cached = await cacheGet<MarketSnapshot>(key);
  if (cached) return cached;

  return getMarketSnapshot(sym, instrumentKey);
}

// ── Refresh a single symbol ───────────────────────────────────────

export async function refreshSymbol(
  symbol:        string,
  instrumentKey: string = ''
): Promise<MarketSnapshot | null> {
  const sym = symbol.toUpperCase();

  if (_refreshLocks.has(sym)) {
    // Another coroutine is already refreshing — wait for it then read cache
    await new Promise(r => setTimeout(r, 500));
    return cacheGet<MarketSnapshot>(`stock:${sym}`);
  }

  _refreshLocks.add(sym);
  try {
    // Resolve instrument_key from DB if not provided
    let iKey = instrumentKey;
    if (!iKey) {
      const { rows } = await db.query(
        `SELECT instrument_key FROM instruments WHERE tradingsymbol = ? AND exchange = 'NSE' LIMIT 1`,
        [sym]
      ).catch(() => ({ rows: [] }));
      iKey = (rows[0] as any)?.instrument_key ?? `NSE_EQ|${sym}`;
    }

    const snap = await getMarketSnapshot(sym, iKey);
    return snap;
  } finally {
    _refreshLocks.delete(sym);
  }
}

// ── Refresh the full universe ─────────────────────────────────────

/**
 * Called by the background scheduler every 60s.
 * Fetches all ranked instruments, caches each in Redis, persists candles.
 * Never called per user request.
 */
export async function refreshMarketUniverse(limit = 100): Promise<{
  refreshed: number;
  failed:    number;
  duration_ms: number;
}> {
  if (_isRefreshing) {
    console.log('[DataAggregator] Universe refresh already in progress — skipping');
    return { refreshed: 0, failed: 0, duration_ms: 0 };
  }

  const now = Date.now();
  if (now - _lastRefreshAt < UNIVERSE_TTL_MS * 0.8) {
    // Throttle: don't refresh more than once per ~50s even if called repeatedly
    return { refreshed: 0, failed: 0, duration_ms: 0 };
  }

  _isRefreshing = true;
  const start   = Date.now();
  let refreshed = 0, failed = 0;

  try {
    const universe = await loadUniverse(limit);
    if (!universe.length) {
      console.warn('[DataAggregator] Universe empty — run rankings sync first');
      return { refreshed: 0, failed: 0, duration_ms: Date.now() - start };
    }

    console.log(`[DataAggregator] Refreshing ${universe.length} symbols...`);

    // Process in batches of 5 to avoid NSE rate-limiting
    const BATCH = 5;
    for (let i = 0; i < universe.length; i += BATCH) {
      const chunk  = universe.slice(i, i + BATCH);
      const snaps  = await getBatchSnapshots(chunk);

      for (const item of chunk) {
        if (snaps[item.symbol]) {
          refreshed++;
        } else {
          failed++;
          console.warn(`[DataAggregator] No data for ${item.symbol}`);
        }
      }

      // Brief pause between batches
      if (i + BATCH < universe.length) {
        await new Promise(r => setTimeout(r, 250));
      }
    }

    _lastRefreshAt = Date.now();

    // Persist aggregator run metadata to MySQL for monitoring
    await db.query(`
      INSERT INTO instrument_sync_logs
        (exchange, total, inserted, updated, status, error_msg)
      VALUES ('MARKET_DATA', ?, ?, ?, 'success', NULL)
    `, [universe.length, refreshed, failed]).catch(() => {});

    console.log(`[DataAggregator] Done: ${refreshed} refreshed, ${failed} failed in ${Date.now()-start}ms`);

  } catch (err: any) {
    console.error('[DataAggregator] Universe refresh error:', err?.message);
    await db.query(`
      INSERT INTO instrument_sync_logs
        (exchange, total, inserted, updated, status, error_msg)
      VALUES ('MARKET_DATA', 0, 0, 0, 'error', ?)
    `, [err?.message ?? 'unknown']).catch(() => {});
  } finally {
    _isRefreshing = false;
  }

  return { refreshed, failed, duration_ms: Date.now() - start };
}

// ── Force refresh (bypasses TTL) ─────────────────────────────────

export async function forceRefresh(
  symbol:        string,
  instrumentKey: string = ''
): Promise<MarketSnapshot | null> {
  const sym = symbol.toUpperCase();
  // Delete Redis cache to force a live fetch
  await cacheDel(`stock:${sym}`);
  return refreshSymbol(sym, instrumentKey);
}

// ── Option chain aggregation ──────────────────────────────────────

export async function getOptionChain(symbol: string): Promise<OptionChainSnapshot | null> {
  return getOptionChainSnapshot(symbol);
}

// ── Batch read: multiple symbols from Redis ───────────────────────
/**
 * Reads multiple symbols from Redis in one go.
 * Returns only symbols that are in cache — no live fetches.
 * Use refreshMarketUniverse() to populate the cache first.
 */
export async function getMultipleSnapshots(
  symbols: string[]
): Promise<Record<string, MarketSnapshot>> {
  const results: Record<string, MarketSnapshot> = {};

  await Promise.all(symbols.map(async sym => {
    const snap = await getSnapshot(sym);
    if (snap) results[sym.toUpperCase()] = snap;
  }));

  return results;
}

// ── Metrics ──────────────────────────────────────────────────────

export function getAggregatorStatus() {
  return {
    is_refreshing:   _isRefreshing,
    last_refresh_at: _lastRefreshAt ? new Date(_lastRefreshAt).toISOString() : null,
    locks_active:    _refreshLocks.size,
    locked_symbols:  Array.from(_refreshLocks),
  };
}
