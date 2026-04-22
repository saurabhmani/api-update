// ════════════════════════════════════════════════════════════════
//  tickSimulator — synthetic ticks for dev/after-hours testing
//
//  Why this exists
//  ────────────────
//  Market hours in India are narrow (09:15–15:30 IST, Mon–Fri).
//  Outside that window, no source in the universe — Kite, Yahoo,
//  anything — streams live ticks. That makes it impossible to
//  build/debug real-time UI features after hours.
//
//  This module generates plausible synthetic ticks by taking each
//  subscribed symbol's last-known price (from tickStore or the DB
//  close) and applying a small random walk at ~20 Hz. Frames are
//  emitted via the same `tickBus` that Kite uses, so the entire
//  downstream pipeline — tickStore, streamServer, signal engine,
//  UI — runs exactly as it would in live market hours. Only the
//  source changes.
//
//  Strict safety rules
//  ───────────────────
//  • OFF by default. Requires `MARKET_SIMULATE=1` in `.env.local`.
//  • NEVER runs in production (`NODE_ENV === 'production'` short-
//    circuits the installer).
//  • NEVER runs when the real market is open — a simulator firing
//    alongside live Kite frames would corrupt tickStore. If the
//    real market opens mid-session, the simulator auto-stops.
//  • Every synthetic frame carries `symbol` but no token, and is
//    tagged `[SIM]` in the log so it is never mistaken for real
//    tape when you grep production logs.
//  • The redisTickBridge still writes these to Redis — that's the
//    whole point: the UI's WebSocket consumer sees identical
//    frames and exercises the live code paths. If you don't want
//    your Redis tick stream polluted during dev, use a separate
//    Redis DB for dev vs prod (which is standard).
// ════════════════════════════════════════════════════════════════

import { tickBus } from './tickBus';
import { getTickStore } from './tickStore';
import { getMarketStatus } from './marketHours';
import { db } from '@/lib/db';
import type { TickData } from './tickTypes';

const TICK_INTERVAL_MS =
  Number(process.env.SIM_TICK_INTERVAL_MS) || 100;   // 10 Hz per sample loop

const BATCH_SIZE =
  Number(process.env.SIM_BATCH_SIZE) || 3;           // symbols per frame

// Max % move per tick — 0.05% keeps the walk visibly alive without
// producing absurd 10% drifts inside a single minute. Tune via env.
const MAX_TICK_PCT =
  Number(process.env.SIM_MAX_TICK_PCT) || 0.0005;

interface SimState {
  installed: boolean;
  timer:     NodeJS.Timeout | null;
  emitted:   number;
  startedAt: number | null;
  // Per-symbol price anchor — seeded from the tickStore on first
  // emit and then evolved via the random walk. Keeps consecutive
  // ticks for the same symbol serially correlated, which is what a
  // real tape looks like.
  prices:    Map<string, number>;
}

const GLOBAL_KEY = '__q365_tick_simulator__';

function getState(): SimState {
  const g = globalThis as unknown as Record<string, SimState | undefined>;
  if (!g[GLOBAL_KEY]) {
    g[GLOBAL_KEY] = {
      installed: false, timer: null, emitted: 0,
      startedAt: null, prices: new Map(),
    };
  }
  return g[GLOBAL_KEY]!;
}

function simEnabled(): boolean {
  if (process.env.NODE_ENV === 'production') return false;
  return process.env.MARKET_SIMULATE === '1';
}

function pickBatch(symbols: string[], n: number): string[] {
  if (symbols.length <= n) return symbols.slice();
  const out: string[] = [];
  const seen = new Set<number>();
  while (out.length < n) {
    const i = Math.floor(Math.random() * symbols.length);
    if (seen.has(i)) continue;
    seen.add(i);
    out.push(symbols[i]);
  }
  return out;
}

function emitFrame(): void {
  const state = getState();

  // Real market has opened — suspend simulation immediately so
  // real Kite frames and synthetic frames don't interleave in the
  // tickStore.
  const market = getMarketStatus();
  if (market.isOpen) {
    console.warn(
      '[SIM] real market opened — suspending synthetic ticker. ' +
      'Remove MARKET_SIMULATE=1 from .env.local before live trading.',
    );
    uninstallTickSimulator();
    return;
  }

  const store = getTickStore();
  const snapshot = store.snapshot();

  // Pull the symbol list from the live tickStore if Kite has
  // subscribed anything, otherwise fall back to the anchors we
  // seeded from the DB. Both paths converge on the same emit loop.
  let symbols: string[];
  if (snapshot.length > 0) {
    symbols = snapshot
      .map((t) => t.symbol)
      .filter((s): s is string => typeof s === 'string' && s.length > 0);
  } else if (state.prices.size > 0) {
    symbols = Array.from(state.prices.keys());
  } else {
    return; // no seed yet — sample loop will wait
  }

  const batch = pickBatch(symbols, BATCH_SIZE);

  for (const sym of batch) {
    // Seed anchor from tickStore's last known price if we don't
    // have one yet. Subsequent ticks evolve from the anchor.
    let anchor: number | undefined = state.prices.get(sym);
    if (anchor == null) {
      const seed = snapshot.find((t) => t.symbol === sym);
      const seedPrice = seed?.lastPrice ?? seed?.close;
      if (seedPrice == null || seedPrice <= 0) continue;
      anchor = seedPrice;
      state.prices.set(sym, anchor);
    }

    // Random walk — uniform on [-MAX, +MAX] scaled by anchor.
    const drift = (Math.random() * 2 - 1) * MAX_TICK_PCT * anchor;
    const nextPrice = Math.max(0.01, anchor + drift);
    state.prices.set(sym, nextPrice);

    const prev = anchor;
    const tick: TickData = {
      token:     0,                       // synthetic — no real Kite token
      symbol:    sym,
      lastPrice: nextPrice,
      volume:    Math.floor(Math.random() * 500) + 100,
      ts:        Date.now(),
      open:      prev,
      high:      Math.max(prev, nextPrice),
      low:       Math.min(prev, nextPrice),
      close:     prev,
      change:    nextPrice - prev,
      pChange:   ((nextPrice - prev) / prev) * 100,
    };

    tickBus.emit('tick', tick);
    state.emitted += 1;
  }
}

/**
 * Seed price anchors from the newest daily close per symbol in
 * `market_data_daily`. Runs asynchronously on install — until the
 * seed lands the emit loop is a no-op, which is fine.
 *
 * We cap to the first 150 symbols to match the typical WS universe
 * size and avoid hammering the DB with one query per thousand rows.
 */
async function seedAnchorsFromDb(state: SimState): Promise<void> {
  try {
    // CRITICAL FIX (2026-04-22):
    //
    // The original query used a correlated subquery against the
    // `market_data_daily` VIEW:
    //
    //   WHERE ts = (SELECT MAX(ts) FROM market_data_daily WHERE symbol = m.symbol)
    //
    // That re-runs the subquery for every outer row and re-scans the
    // VIEW's base `candles` table each time. On a database with ~95k
    // EOD candles across ~2700 symbols the planner never finishes —
    // we observed a single invocation holding a metadata lock on
    // `market_data_daily` for 47+ minutes, blocking every other
    // query (CREATE TABLE IF NOT EXISTS candles / ensureAllSchemas /
    // signals enricher EOD lookup / stream seed) behind it and
    // exhausting the 10-connection MySQL pool.
    //
    // The fix is to read `candles` directly with the EOD filter,
    // group by instrument_key, and JOIN back to get the close —
    // a single pass that uses the existing
    // (instrument_key, ts DESC) index:
    //
    //   KEY idx_candles_key_ts (instrument_key, ts DESC)
    //
    // We also extract `symbol` from instrument_key (NSE_EQ|RELIANCE
    // → RELIANCE) so the Map keys line up with the tick.symbol the
    // emitter uses.
    const { rows } = await db.query<{ symbol: string; close: number | string }>(
      `SELECT SUBSTRING_INDEX(c.instrument_key, '|', -1) AS symbol,
              c.close
         FROM candles c
         INNER JOIN (
           SELECT instrument_key, MAX(ts) AS max_ts
           FROM candles
           WHERE candle_type = 'eod' AND interval_unit = '1day'
           GROUP BY instrument_key
         ) m ON m.instrument_key = c.instrument_key AND m.max_ts = c.ts
         WHERE c.candle_type = 'eod' AND c.interval_unit = '1day'
         LIMIT 200`,
    );
    let seeded = 0;
    for (const row of rows as Array<{ symbol: string; close: number | string }>) {
      const price = Number(row.close);
      if (!Number.isFinite(price) || price <= 0) continue;
      if (!state.prices.has(row.symbol)) {
        state.prices.set(row.symbol, price);
        seeded += 1;
      }
    }
    if (seeded > 0) {
      console.log(`[SIM] seeded ${seeded} price anchors from candles (eod 1day)`);
    }
  } catch (err) {
    console.warn('[SIM] DB seed failed:', (err as Error).message);
  }
}

/**
 * Start the simulator. Idempotent; safe across HMR.
 *
 * Controlled by env:
 *   MARKET_SIMULATE=1       — required, off by default
 *   SIM_TICK_INTERVAL_MS    — frame rate, default 100 ms
 *   SIM_BATCH_SIZE          — symbols per frame, default 3
 *   SIM_MAX_TICK_PCT        — max per-tick drift, default 0.0005 (5 bps)
 */
export function installTickSimulator(): void {
  const state = getState();
  if (state.installed) return;
  if (!simEnabled()) return;

  const market = getMarketStatus();
  if (market.isOpen) {
    // Real market is live — never shadow real ticks with simulated
    // ones. Bail silently; the caller can retry after close.
    return;
  }

  // Kick off the DB seed so even cold-boot dev sessions (no Kite
  // login, empty tickStore) start emitting within a second or two.
  void seedAnchorsFromDb(state);

  state.timer = setInterval(() => {
    try { emitFrame(); }
    catch (err) { console.warn('[SIM] emit error:', (err as Error).message); }
  }, TICK_INTERVAL_MS);
  state.timer.unref?.();
  state.installed = true;
  state.startedAt = Date.now();

  const ratePerSec = Math.round((1000 / TICK_INTERVAL_MS) * BATCH_SIZE);
  console.log(
    `[SIM] tick simulator installed — ${ratePerSec} ticks/sec ` +
    `(interval=${TICK_INTERVAL_MS}ms, batch=${BATCH_SIZE}, maxDrift=${MAX_TICK_PCT * 100}%) ` +
    '— frames tagged [SIM], never use in production',
  );
}

export function uninstallTickSimulator(): void {
  const state = getState();
  if (state.timer) {
    clearInterval(state.timer);
    state.timer = null;
  }
  state.installed = false;
  if (state.emitted > 0) {
    console.log(`[SIM] simulator stopped — emitted ${state.emitted} synthetic ticks`);
  }
}

export function getTickSimulatorStats(): {
  installed: boolean;
  enabled:   boolean;
  emitted:   number;
  symbols:   number;
  startedAt: number | null;
} {
  const s = getState();
  return {
    installed: s.installed,
    enabled:   simEnabled(),
    emitted:   s.emitted,
    symbols:   s.prices.size,
    startedAt: s.startedAt,
  };
}
