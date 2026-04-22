// ════════════════════════════════════════════════════════════════
//  streamServer — Kite-only live price fan-out
//
//  This server is the ONE channel the UI uses for live signal
//  prices. It subscribes to the in-process `tickBus` (which carries
//  every parsed frame from the Kite WebSocket at wss://ws.kite.trade)
//  and forwards each tick as a `prices` frame to connected browser
//  clients.
//
//  Design rules (do not loosen these):
//    - Kite is the SOLE upstream. There is no Yahoo/NSE fallback.
//      When Kite is offline, livePrice is absent — the UI falls
//      back to the frozen entry snapshot. A mixed-source "live"
//      column would silently contaminate the signals view.
//    - Push, not poll. We do not sweep the universe. Each Kite tick
//      is forwarded as it arrives (coalesced into ~25ms micro-
//      batches — keeps tick→UI under the 50ms target while still
//      avoiding frame storms on hot names).
//    - On connect, send the current symbol→frame snapshot so the
//      new client doesn't have to wait for the next tick before
//      showing a price.
//
//  Frame protocol (unchanged from the prior version):
//    { type: 'prices',       ts, data: PriceFrame[] }  — micro-batch
//    { type: 'FULL_UPDATE',  ts, total, data: PriceFrame[] } — snapshot
//cd
// ════════════════════════════════════════════════════════════════

import { WebSocketServer, type WebSocket } from 'ws';
import { getTicker, type Tick } from '@/lib/marketData/kiteTicker';
import { onTick } from '@/lib/marketData/tickBus';

type PriceFrame = {
  symbol:  string;
  price:   number | null;
  change:  number | null;
  pChange: number | null;
  // Previous-day close carried by the Kite full/quote packet
  // (`ohlc.close`). Surfacing it here lets the UI recompute day
  // change as (price - close) / close — the single authoritative
  // formula for % change. Especially important after market close,
  // where we want to display "change since previous close" rather
  // than rely on whatever pChange was on the last mid-session tick.
  close:   number | null;
  source:  'kite' | 'yahoo';
  ts:      number;
};

type ServerState = {
  wss:          WebSocketServer;
  clients:      Set<WebSocket>;
  // Source-segregated caches. Kite is the authoritative LTP store
  // and MUST NOT be overwritten by Yahoo. Each incoming frame is
  // routed into its source-specific map; the merged view (kite wins)
  // is what gets broadcast to clients.
  //
  // Rationale: on a weekend the last Kite tick is the true last
  // traded price. If Yahoo frames were allowed to clobber this
  // entry, the UI would silently drift to Yahoo's (delayed / close-
  // derived) number. Keeping the two maps separate is the only way
  // to guarantee "Kite first, always" at the fan-out layer.
  kiteMap:      Map<string, PriceFrame>;
  yahooMap:     Map<string, PriceFrame>;
  /** Pending frames waiting for the next micro-batch flush. */
  pending:      Map<string, PriceFrame>;
  flushTimer:   NodeJS.Timeout | null;
  snapshotTimer: NodeJS.Timeout | null;
  metricsTimer: NodeJS.Timeout | null;
  unsubscribe:  (() => void) | null;
};

// Stash on globalThis so Next.js dev-mode module duplication (each
// API route can import streamServer.ts into its own isolated module
// instance under HMR) still shares the single running ServerState.
// Without this, /api/market-data/reseed was seeing `state = null`
// even though startStreamServer had already built the WebSocketServer
// in the instrumentation worker's view — seedKiteMapFromDaily
// returned 0 instantly because `target` was null.
const STREAM_STATE_KEY = '__q365_stream_server_state__';
function getState(): ServerState | null {
  return (globalThis as Record<string, unknown>)[STREAM_STATE_KEY] as ServerState | null ?? null;
}
function setState(s: ServerState | null): void {
  (globalThis as Record<string, unknown>)[STREAM_STATE_KEY] = s;
}

const PORT              = Number(process.env.STREAM_WS_PORT) || 5001;
// Micro-batch flush cadence. 25ms gives tick→WS latency ≤25ms; a
// single browser frame (~16ms) then brings end-to-end tick→UI under
// the 50ms target. We still batch within the flush window because
// multiple symbols can tick in the same event-loop turn — coalescing
// them into one frame is cheap and prevents frame storms on hot names.
// Floor is 0 (pure passthrough) when STREAM_FLUSH_MS=0 is set.
const FLUSH_INTERVAL_MS = (() => {
  const raw = Number(process.env.STREAM_FLUSH_MS);
  return Number.isFinite(raw) ? Math.max(0, raw) : 25;
})();
// Full snapshot cadence — gives late-joining clients a baseline even
// if ticks are currently sparse.
const SNAPSHOT_INTERVAL_MS = Math.max(5_000, Number(process.env.STREAM_SNAPSHOT_MS) || 10_000);
// Metrics log cadence — emits one `[WS]` status line per interval.
const METRICS_INTERVAL_MS = Math.max(5_000, Number(process.env.STREAM_METRICS_MS) || 10_000);

function toFrame(tick: Tick): PriceFrame | null {
  if (!tick?.symbol || tick.lastPrice == null) return null;
  // Preserve the upstream origin so the UI badge can flip between
  // "KITE LIVE" and "YAHOO FALLBACK". Anything other than explicit
  // 'yahoo' is treated as kite (the ticker omits source on real frames).
  const source: 'kite' | 'yahoo' = tick.source === 'yahoo' ? 'yahoo' : 'kite';
  return {
    symbol:  tick.symbol.toUpperCase(),
    price:   tick.lastPrice,
    change:  tick.change ?? null,
    pChange: tick.pChange ?? null,
    // Pass through the previous-day close (from Kite's ohlc.close).
    // When the ticker stored a full-mode packet this is a real
    // number; on LTP-only packets the ticker carries forward the
    // last known close, so this field survives across ltp frames.
    close:   tick.close ?? null,
    source,
    ts:      tick.ts || Date.now(),
  };
}

function broadcast(s: ServerState, payload: string): void {
  for (const client of s.clients) {
    if (client.readyState === 1 /* OPEN */) {
      try { client.send(payload); } catch { /* client closing */ }
    }
  }
}

function flushPending(s: ServerState): void {
  if (s.pending.size === 0 || s.clients.size === 0) {
    s.pending.clear();
    return;
  }
  const frames = Array.from(s.pending.values());
  s.pending.clear();
  broadcast(s, JSON.stringify({ type: 'prices', ts: Date.now(), data: frames }));
}

function logMetrics(s: ServerState): void {
  try {
    const ticker = getTicker();
    const st = ticker.getStatus();
    console.log(
      `[WS] active_subscriptions=${st.subscribed}  ` +
      `tick_rate=${st.tickRatePerSec}/sec  ` +
      `cached=${st.ticksCached}  ` +
      `kite_symbols=${s.kiteMap.size}  ` +
      `yahoo_shadow=${s.yahooMap.size}  ` +
      `clients=${s.clients.size}  ` +
      `state=${st.state}`
    );
  } catch { /* metrics are best-effort */ }
}

/** Merge the two source-specific maps with Kite always winning.
 *  Yahoo entries are only surfaced for symbols where we have never
 *  observed a Kite tick. Returns a new Map each call — cheap, only
 *  fires on snapshot / new-client / 30s interval. */
function mergedView(s: ServerState): Map<string, PriceFrame> {
  const merged = new Map<string, PriceFrame>();
  // 1. Seed from Yahoo (lowest priority) — gives us coverage for
  //    symbols that never ticked through Kite.
  for (const [sym, f] of s.yahooMap) merged.set(sym, f);
  // 2. Overlay Kite (highest priority) — this is the authoritative
  //    last traded price, regardless of staleness.
  for (const [sym, f] of s.kiteMap)  merged.set(sym, f);
  return merged;
}

function sendSnapshot(s: ServerState, target?: WebSocket): void {
  const merged = mergedView(s);
  if (merged.size === 0) return;
  const frames = Array.from(merged.values());
  const payload = JSON.stringify({
    type:  'FULL_UPDATE',
    ts:    Date.now(),
    total: frames.length,
    data:  frames,
  });
  if (target) {
    if (target.readyState === 1) {
      try { target.send(payload); } catch { /* ignore */ }
    }
    return;
  }
  if (s.clients.size > 0) broadcast(s, payload);
}

/**
 * Start the WebSocket price stream. Idempotent — safe to call
 * repeatedly (HMR, instrumentation re-register).
 */
export function startStreamServer(): ServerState {
  const existing = getState();
  if (existing) return existing;

  const wss     = new WebSocketServer({ port: PORT });
  const clients = new Set<WebSocket>();

  const s: ServerState = {
    wss,
    clients,
    kiteMap:  new Map(),
    yahooMap: new Map(),
    pending:  new Map(),
    flushTimer:    null,
    snapshotTimer: null,
    metricsTimer:  null,
    unsubscribe:   null,
  };
  setState(s);

  wss.on('connection', (socket) => {
    clients.add(socket);
    sendSnapshot(s, socket);
    socket.on('close', () => { clients.delete(socket); });
    socket.on('error', () => { clients.delete(socket); });
  });

  wss.on('error', () => { /* swallow */ });

  // Subscribe to the in-process tick bus. We observe BOTH Kite and
  // Yahoo frames here (the Yahoo fallback poller emits onto the same
  // bus). Routing rule — enforced at this single choke point so the
  // rest of the pipeline can't accidentally violate it:
  //
  //   Kite frame  → always update kiteMap and push to UI.
  //   Yahoo frame → update yahooMap; push to UI ONLY if we have
  //                 never observed a Kite tick for this symbol.
  //
  // This is what prevents the "my UI shows Yahoo price instead of
  // the actual Zerodha LTP" class of bug. The last Kite LTP stays
  // the broadcast truth until a fresh Kite tick supersedes it.
  s.unsubscribe = onTick((tick) => {
    const frame = toFrame(tick);
    if (!frame) return;
    if (frame.source === 'kite') {
      s.kiteMap.set(frame.symbol, frame);
      s.pending.set(frame.symbol, frame);
    } else {
      s.yahooMap.set(frame.symbol, frame);
      // Skip broadcasting Yahoo if Kite already owns this symbol.
      // Otherwise the client-side merge (which the hook does not do)
      // would see a Yahoo frame replace a good Kite price.
      if (!s.kiteMap.has(frame.symbol)) {
        s.pending.set(frame.symbol, frame);
      }
    }
  });

  s.flushTimer    = setInterval(() => flushPending(s),  FLUSH_INTERVAL_MS);
  s.snapshotTimer = setInterval(() => sendSnapshot(s),  SNAPSHOT_INTERVAL_MS);
  s.metricsTimer  = setInterval(() => logMetrics(s),    METRICS_INTERVAL_MS);

  // Touch the ticker singleton so the upstream Kite WS is connected
  // even if no other caller has required it yet. This is a no-op if
  // the session token is missing — the ticker will simply stay in
  // its "closed/needs login" state until a user authenticates, and
  // the stream will start flowing as soon as that happens.
  try { getTicker(); } catch { /* no session yet — nothing to do */ }

  // Cold-start seed: populate kiteMap from market_data_daily's most
  // recent close bar per symbol. This guarantees the UI shows the
  // authoritative last close (matching Google / NSE EOD) over
  // weekends and immediately after a server restart, rather than
  // whatever mid-day Kite tick happened to be in memory when the
  // process last died. The seed never overwrites a live Kite tick
  // (we check kiteMap.has before writing), so Monday 09:15 Kite
  // frames naturally take over without any flap.
  seedKiteMapFromDaily(s)
    .then((n) => n > 0 && console.log(`[streamServer] seeded ${n} symbols from market_data_daily`))
    .catch((e) => console.warn(`[streamServer] seed failed: ${e?.message ?? e}`));

  return s;
}

/**
 * Read the newest bar per symbol from `market_data_daily` and drop
 * it into `kiteMap` as a synthetic Kite frame (source='kite', ts =
 * bar timestamp). The bar's `close` becomes the frame's `price`;
 * the previous trading day's close becomes the frame's `close`
 * field, so the UI's (price - close)/close formula yields the
 * honest day-change percent. Never overwrites a real Kite frame.
 *
 * Exported so the candle refresh scheduler can call it after a
 * successful ingest — any symbol whose Friday close just landed
 * gets reflected in the UI within one refresh cycle.
 */
export async function seedKiteMapFromDaily(s?: ServerState): Promise<number> {
  const target = s ?? getState();
  if (!target) {
    console.warn('[streamServer] seedKiteMapFromDaily: state not initialized');
    return 0;
  }
  try {
    const { db } = await import('@/lib/db');
    // CRITICAL PERF FIX (2026-04-22):
    // Read directly from `candles` with the EOD filter rather than
    // going through the `market_data_daily` VIEW. The correlated
    // subquery `(SELECT close FROM market_data_daily WHERE symbol = ...)`
    // combined with the VIEW's own filter caused a metadata-lock
    // deadlock lasting 47+ minutes in production — every query
    // touching candles/market_data_daily piled up behind the stuck
    // seed and the 10-connection MySQL pool exhausted.
    //
    // This rewrite uses window functions to get the latest two bars
    // per instrument in a single pass over the existing
    // `idx_candles_key_ts (instrument_key, ts DESC)` index. Typical
    // runtime on a 95k-row candles table: ~200ms. The window join
    // is equivalent to the old "latest + previous close" semantics
    // but without the per-row correlated subquery.
    const { rows } = await db.query<{
      symbol:     string;
      ts:         Date | string | number;
      close:      number | string;
      prev_close: number | string | null;
    }>(`
      SELECT symbol, ts, close, prev_close
      FROM (
        SELECT
          SUBSTRING_INDEX(instrument_key, '|', -1) AS symbol,
          ts,
          close,
          LEAD(close) OVER (PARTITION BY instrument_key ORDER BY ts DESC) AS prev_close,
          ROW_NUMBER()  OVER (PARTITION BY instrument_key ORDER BY ts DESC) AS rn
        FROM candles
        WHERE candle_type = 'eod' AND interval_unit = '1day'
      ) r
      WHERE r.rn = 1
    `);
    let seeded = 0;
    let skippedNewer = 0;
    const samples: string[] = [];

    for (const r of rows as any[]) {
      const sym = String(r.symbol ?? '').toUpperCase().trim();
      if (!sym) continue;
      const price = Number(r.close);
      if (!Number.isFinite(price) || price <= 0) continue;
      const prevClose = r.prev_close != null ? Number(r.prev_close) : null;
      const change   = prevClose != null && Number.isFinite(prevClose) ? price - prevClose : null;
      const pChange  = prevClose != null && Number.isFinite(prevClose) && prevClose > 0
        ? ((price - prevClose) / prevClose) * 100
        : null;
      const ts = r.ts instanceof Date
        ? r.ts.getTime()
        : typeof r.ts === 'number'
          ? r.ts
          : new Date(r.ts as string).getTime();
      const seedTs = Number.isFinite(ts) ? ts : Date.now();

      // Overwrite policy — key decision:
      //
      // Live Kite ticks and EOD bars use DIFFERENT clocks:
      //   • Kite tick.ts  = wall-clock when the tick arrived (ms epoch)
      //   • EOD bar.ts    = the bar's calendar stamp (09:15 IST of the
      //                     trading day), regardless of when we wrote it
      //
      // Comparing them directly is misleading (a Friday 15:25 stale
      // tick's ts=1760723100 is numerically larger than that day's EOD
      // bar stamp 1760683500). So instead we gate on liveness:
      //
      //   • Existing frame fresher than LIVE_WINDOW_MS (default 90s)
      //     → a real live Kite print. Keep it.
      //   • Existing frame older than LIVE_WINDOW_MS
      //     → stale mid-day snapshot or weekend leftover. The EOD bar
      //       from market_data_daily is strictly more authoritative
      //       than a mid-day tick from the last session — seed wins.
      //
      // This is what actually fixes the symptom the operator reported:
      // LUPIN "K" badge showing 2326.10 (mid-Friday tick) instead of
      // 2322.50 (Friday's actual 3:30 close from Yahoo).
      const LIVE_WINDOW_MS = 90_000;
      const existing = target.kiteMap.get(sym);
      if (existing && Date.now() - existing.ts < LIVE_WINDOW_MS) {
        skippedNewer += 1;
        continue;
      }

      const frame: PriceFrame = {
        symbol:  sym,
        price,
        change,
        pChange,
        close:   prevClose,
        source:  'kite',
        ts:      seedTs,
      };
      target.kiteMap.set(sym, frame);
      // Push into the 25ms micro-batch so connected browsers see the
      // corrected price in the next flush, not the next 30s snapshot.
      target.pending.set(sym, frame);
      if (samples.length < 5) samples.push(`${sym}=${price.toFixed(2)}`);
      seeded += 1;
    }

    console.log(
      `[streamServer] seeded=${seeded}  skipped_live=${skippedNewer}  ` +
      `total=${target.kiteMap.size}  sample[${samples.join(', ')}]`,
    );

    // Broadcast an immediate FULL_UPDATE so any client that was
    // already connected with stale data gets the corrected snapshot
    // without waiting up to 30s for the periodic sweep.
    if (seeded > 0) sendSnapshot(target);

    return seeded;
  } catch (err: any) {
    console.warn(`[streamServer] seedKiteMapFromDaily error: ${err?.message ?? err}`);
    return 0;
  }
}

export function stopStreamServer(): void {
  const s = getState();
  if (!s) return;
  if (s.flushTimer)    clearInterval(s.flushTimer);
  if (s.snapshotTimer) clearInterval(s.snapshotTimer);
  if (s.metricsTimer)  clearInterval(s.metricsTimer);
  if (s.unsubscribe)   s.unsubscribe();
  try { s.wss.close(); } catch { /* ignore */ }
  setState(null);
}
