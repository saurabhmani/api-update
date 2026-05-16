// ════════════════════════════════════════════════════════════════
//  Market-close snapshot writer
//
//  At 15:30 IST (NSE cash session close) we capture the last live
//  price/volume/OHLC for every symbol that has a fresh row in the
//  in-memory quote cache and upsert it into `q365_market_close_snapshot`.
//
//  The static-data tier reads from this table whenever the resolver's
//  market-closed gate hits (any time outside 09:15–15:30 IST). Without
//  it, a process restart at 18:00 would lose the last-known prices
//  cached in memory and the off-hours UI would show DATA_DEGRADED.
//
//  Idempotent + crash-safe: PRIMARY KEY (symbol) → upsert is a single
//  row swap per symbol per close. No partial-update windows; readers
//  see either yesterday's snapshot or today's, never half of each.
// ════════════════════════════════════════════════════════════════

import { db } from '@/lib/db';
import { logger } from '@/lib/logger';
import { cache, quoteCacheKey } from '@/lib/cache';
import type { MarketSnapshot } from '@/types/market';
import {
  getNifty500Symbols,
  isNifty500Initialized,
  initNifty500UniverseFromDb,
} from '@/lib/marketData/nifty500Universe';

const log = logger.child({ component: 'marketCloseSnapshot' });

/** Build the universe of symbols that should be snapshot-captured.
 *  Spec NIFTY500_LOCK_ENABLED: source EXCLUSIVELY from the in-memory
 *  cache hydrated at boot from q365_universe(is_active=1). The
 *  snapshot writer thus persists exactly the same set the scanner
 *  will read next session.
 *
 *  Spec STEP 2 — universe init guard. The 15:30 IST close fires from
 *  a scheduled cron, not the request path; if instrumentation's
 *  hydration somehow lapsed (HMR reset, dynamic import order),
 *  await the shared promise lock so we never write a snapshot off
 *  an empty universe. */
async function loadActiveUniverse(): Promise<string[]> {
  if (!isNifty500Initialized()) {
    await initNifty500UniverseFromDb();
  }
  return getNifty500Symbols();
}

export interface SnapshotResult {
  scanned:      number;
  captured:     number;
  skipped:      number;
  elapsedMs:    number;
  sessionDate:  string;
  /** 'cache' = wrote from in-memory quote cache (normal 15:30 path).
   *  'market_data_daily' = bootstrapped from the daily candle table
   *  (cold process / holiday / first deploy). Honest provenance so
   *  operators can tell a real close-snapshot from a bootstrap one. */
  source:       'cache' | 'market_data_daily';
}

export interface RunSnapshotOpts {
  /** If true (or auto-detected when cache is cold), read the latest
   *  daily close per symbol from `market_data_daily` instead of the
   *  in-memory quote cache. Used for first-deploy bootstrap and for
   *  cold-process recovery so the off-hours resolver never serves
   *  DATA_DEGRADED on a process that booted outside session hours. */
  bootstrapFromDaily?: boolean;
}

/** IST date string (YYYY-MM-DD) regardless of server timezone. */
function istDateString(): string {
  const ist = new Date(Date.now() + 5.5 * 3_600_000);
  return ist.toISOString().slice(0, 10);
}

/** Bootstrap path — read the most recent two daily candles per
 *  active-universe symbol from `market_data_daily` (latest = today's
 *  effective close, second-latest = prev_close for change computation)
 *  and upsert into `q365_market_close_snapshot`. ONE bulk SQL with a
 *  windowed sub-query, no per-symbol round-trip — runs in ~1s for the
 *  full ~500-symbol universe. */
async function bootstrapFromDailyCandles(sessionDate: string): Promise<{
  captured: number; skipped: number; scanned: number;
}> {
  // Pull the active universe symbol list to scope the windowed read.
  const symbols = await loadActiveUniverse();
  if (symbols.length === 0) return { captured: 0, skipped: 0, scanned: 0 };
  const placeholders = symbols.map(() => '?').join(',');
  const { rows } = await db.query<{
    symbol: string;
    ts: Date | string;
    open: string | number | null;
    high: string | number | null;
    low: string | number | null;
    close: string | number | null;
    volume: string | number | null;
    prev_close: string | number | null;
  }>(
    `SELECT l.symbol, l.ts, l.open, l.high, l.low, l.close, l.volume,
            p.close AS prev_close
       FROM (
         SELECT symbol, ts, open, high, low, close, volume,
                ROW_NUMBER() OVER (PARTITION BY symbol ORDER BY ts DESC) rn
           FROM market_data_daily
          WHERE symbol IN (${placeholders})
       ) l
       LEFT JOIN (
         SELECT symbol, ts, close,
                ROW_NUMBER() OVER (PARTITION BY symbol ORDER BY ts DESC) rn
           FROM market_data_daily
          WHERE symbol IN (${placeholders})
       ) p ON p.symbol = l.symbol AND p.rn = 2
      WHERE l.rn = 1`,
    [...symbols, ...symbols],
  );
  const num = (v: unknown) => {
    if (v === null || v === undefined || v === '') return null;
    const n = typeof v === 'number' ? v : Number(v);
    return Number.isFinite(n) ? n : null;
  };
  let captured = 0;
  let skipped  = 0;
  for (const r of rows as any[]) {
    const close = num(r.close);
    if (close === null || close <= 0) { skipped++; continue; }
    const prev  = num(r.prev_close);
    const changeAbs = (prev !== null) ? close - prev : null;
    const changePct = (prev !== null && prev > 0) ? ((close - prev) / prev) * 100 : null;
    const tsDate = r.ts instanceof Date ? r.ts : new Date(r.ts);
    try {
      await db.query(
        `INSERT INTO q365_market_close_snapshot
          (symbol, price, change_abs, change_pct, volume,
           open_price, high_price, low_price, prev_close,
           snapshot_ts, snapshot_session)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           price=VALUES(price), change_abs=VALUES(change_abs),
           change_pct=VALUES(change_pct), volume=VALUES(volume),
           open_price=VALUES(open_price), high_price=VALUES(high_price),
           low_price=VALUES(low_price), prev_close=VALUES(prev_close),
           snapshot_ts=VALUES(snapshot_ts), snapshot_session=VALUES(snapshot_session)`,
        [
          r.symbol, close, changeAbs, changePct,
          num(r.volume), num(r.open), num(r.high), num(r.low), prev,
          tsDate, sessionDate,
        ],
      );
      captured++;
    } catch (err) {
      skipped++;
      log.warn('bootstrap upsert failed', {
        symbol: r.symbol, error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { captured, skipped, scanned: symbols.length };
}

/**
 * Capture the last-known snapshot for every active universe symbol
 * that has a fresh entry in the quote cache, into
 * `q365_market_close_snapshot`. Symbols without a cache entry are
 * skipped (NOT zeroed) — the prior session's row stays in place so
 * the resolver fallback always returns *something* meaningful.
 *
 * `bootstrapFromDaily=true` (or auto-engaged when the cache is empty)
 * reads from `market_data_daily` instead. Used for first-deploy
 * bootstrap and for cold-process recovery.
 */
export async function runMarketCloseSnapshot(opts: RunSnapshotOpts = {}): Promise<SnapshotResult> {
  const t0 = Date.now();
  const sessionDate = istDateString();

  if (opts.bootstrapFromDaily) {
    const r = await bootstrapFromDailyCandles(sessionDate);
    const elapsedMs = Date.now() - t0;
    log.info('market_close_snapshot complete (bootstrap)', {
      scanned: r.scanned, captured: r.captured, skipped: r.skipped,
      elapsedMs, sessionDate, source: 'market_data_daily',
    });
    return { ...r, elapsedMs, sessionDate, source: 'market_data_daily' };
  }

  const symbols = await loadActiveUniverse();
  let captured = 0;
  let skipped  = 0;

  for (const sym of symbols) {
    const snap = await cache.get<MarketSnapshot>(quoteCacheKey(sym));
    if (!snap || !Number.isFinite(snap.price) || snap.price <= 0) {
      skipped++;
      continue;
    }
    const tsDate = new Date(Number.isFinite(snap.timestamp) && snap.timestamp > 0
      ? snap.timestamp
      : Date.now());
    try {
      await db.query(
        `INSERT INTO q365_market_close_snapshot
          (symbol, price, change_abs, change_pct, volume,
           open_price, high_price, low_price, prev_close,
           snapshot_ts, snapshot_session)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           price=VALUES(price), change_abs=VALUES(change_abs),
           change_pct=VALUES(change_pct), volume=VALUES(volume),
           open_price=VALUES(open_price), high_price=VALUES(high_price),
           low_price=VALUES(low_price), prev_close=VALUES(prev_close),
           snapshot_ts=VALUES(snapshot_ts), snapshot_session=VALUES(snapshot_session)`,
        [
          sym,
          Number.isFinite(snap.price)         ? snap.price         : 0,
          Number.isFinite(snap.change)        ? snap.change        : null,
          Number.isFinite(snap.changePercent) ? snap.changePercent : null,
          Number.isFinite(snap.volume)        ? snap.volume        : null,
          Number.isFinite(snap.open)          ? snap.open          : null,
          Number.isFinite(snap.high)          ? snap.high          : null,
          Number.isFinite(snap.low)           ? snap.low           : null,
          Number.isFinite(snap.prevClose)     ? snap.prevClose     : null,
          tsDate, sessionDate,
        ],
      );
      captured++;
    } catch (err) {
      skipped++;
      log.warn('snapshot upsert failed', {
        symbol: sym, error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Auto-fallback: if the cache path captured zero rows (cold process
  // or stale cache outside session) AND the snapshot table is empty,
  // bootstrap from market_data_daily. Logged distinctly so an operator
  // can see the fallback engaged. Without this, an off-hours boot
  // leaves the resolver permanently DEGRADED until next session.
  if (captured === 0) {
    const { rows: countRows } = await db.query<{ c: number }>(
      `SELECT COUNT(*) AS c FROM q365_market_close_snapshot`,
    );
    const existingRows = Number((countRows as any[])[0]?.c ?? 0);
    if (existingRows === 0) {
      log.warn('market_close_snapshot cache-path captured 0 rows AND table empty — auto-bootstrap from market_data_daily', {
        scanned: symbols.length,
      });
      const r = await bootstrapFromDailyCandles(sessionDate);
      const elapsedMs = Date.now() - t0;
      log.info('market_close_snapshot complete (auto-bootstrap)', {
        scanned: r.scanned, captured: r.captured, skipped: r.skipped,
        elapsedMs, sessionDate, source: 'market_data_daily',
      });
      return { ...r, elapsedMs, sessionDate, source: 'market_data_daily' };
    }
  }

  const elapsedMs = Date.now() - t0;
  log.info('market_close_snapshot complete', {
    scanned: symbols.length, captured, skipped, elapsedMs, sessionDate,
    source: 'cache',
  });
  return { scanned: symbols.length, captured, skipped, elapsedMs, sessionDate, source: 'cache' };
}
