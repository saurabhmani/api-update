// ════════════════════════════════════════════════════════════════
//  Kite WebSocket ticker — singleton streaming feed
//
//  Protocol reference:
//    https://kite.trade/docs/connect/v3/websocket/
//
//  Wire format (binary frames, big-endian):
//    - Heartbeat:  single 1-byte frame (ignored)
//    - Data frame: 2-byte int16  → number of packets N
//                  then N times:
//                    2-byte int16 → packet length L
//                    L bytes of packet data
//
//  Equity "quote" mode packet is 44 bytes:
//    [0..4)  instrument_token   int32
//    [4..8)  last_price         int32  (paise → /100)
//    [8..12) last_traded_qty    int32
//    [12..16) avg_traded_price  int32
//    [16..20) volume_traded     int32
//    [20..24) total_buy_qty     int32
//    [24..28) total_sell_qty    int32
//    [28..32) ohlc.open         int32
//    [32..36) ohlc.high         int32
//    [36..40) ohlc.low          int32
//    [40..44) ohlc.close        int32
//
//  LTP-only packet is 8 bytes (token + ltp).
//
//  This module holds a process-singleton WebSocket. Callers use
//  getTicker() to lazy-init, then subscribe(symbols). Ticks land in
//  an in-memory Map keyed by instrument_token; getTickBySymbol()
//  hands them to the REST-compat layer in kite.ts.
//
//  Reconnection: exponential backoff capped at 30s. Subscriptions
//  are remembered across reconnects so the caller doesn't need to
//  re-issue them.
// ════════════════════════════════════════════════════════════════

import WebSocket from 'ws';
import { EventEmitter } from 'events';
import { getKiteAccessToken, validateKiteToken, clearKiteAccessToken } from './kiteSession';
import { getInstrumentToken, getSymbolForToken, resolveTokens } from './kiteInstruments';
import { tickBus } from './tickBus';
import { logger } from '@/lib/logger';

const log = logger.child({ component: 'kiteTicker' });

const WS_URL = 'wss://ws.kite.trade';
const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

export type TickMode = 'ltp' | 'quote' | 'full';

export interface Tick {
  token: number;
  symbol?: string;
  lastPrice: number;
  volume?: number;
  avgPrice?: number;
  open?: number;
  high?: number;
  low?: number;
  close?: number;
  change?: number;
  pChange?: number;
  ts: number;
  // Origin of the tick. Omitted or 'kite' for real WebSocket frames;
  // set to 'yahoo' by the fallback poller when Kite has been silent
  // past STALE_THRESHOLD_MS and Yahoo is carrying the feed. Consumers
  // that need real-time certainty (execution path) should gate on
  // `source !== 'yahoo'`; consumers that just need a price (UI) can
  // render regardless and surface the source badge.
  source?: 'kite' | 'yahoo';
}

// ── Canonical freshness predicate (tolerant) ──────────────────
// Returns boolean. Used by paths that tolerate "no data right
// now" (e.g. the price endpoint's decision of whether to fall
// through to NSE/Yahoo when Kite is down).
//
// Default 3s matches MAX_KITE_AGE_MS in getLivePrice.ts.
const DEFAULT_FRESH_MS = Number(process.env.MAX_KITE_AGE_MS) || 3_000;

export function isFresh(tick: Tick | null | undefined, maxAgeMs = DEFAULT_FRESH_MS): boolean {
  if (!tick || !tick.ts || !tick.lastPrice) return false;
  return (Date.now() - tick.ts) <= maxAgeMs;
}

// ── Strict live-tick resolver (THROWS) ────────────────────────
// The single canonical accessor every consumer that *needs*
// a tick must go through:
//
//   signal engine  → getLiveTick(symbol)
//   API            → getLiveTick(symbol) (via getLivePrice)
//   execution      → getLiveTick(symbol) (via signal payload)
//
// Throws typed errors instead of returning null/false so the
// "use old tick" mistake is literally unrepresentable at a call
// site — there IS no fallback object for the caller to use.
//
// Threshold is 2000ms by default (tighter than isFresh's 3000)
// because the strict path is for execution-critical reads
// where we'd rather skip a cycle than act on 2.5s-old data.
export class StaleTickError extends Error {
  constructor(public symbol: string, public ageMs: number) {
    super(`STALE_TICK ${symbol} age=${ageMs}ms`);
    this.name = 'StaleTickError';
  }
}
export class NoTickError extends Error {
  constructor(public symbol: string) {
    super(`NO_TICK ${symbol}`);
    this.name = 'NoTickError';
  }
}
export class WsDownError extends Error {
  constructor(public state: string) {
    super(`WS_DOWN state=${state}`);
    this.name = 'WsDownError';
  }
}

const STRICT_MAX_AGE_MS =
  Number(process.env.STRICT_TICK_MAX_AGE_MS) || 2_000;

export function getLiveTick(symbol: string): Tick {
  const ticker = getTicker();
  const st = ticker.getStatus();
  if (st.state !== 'open') {
    throw new WsDownError(st.state);
  }
  const tick = ticker.getTickBySymbolSync(symbol);
  if (!tick || !tick.lastPrice || !tick.ts) {
    throw new NoTickError(symbol);
  }
  const age = Date.now() - tick.ts;
  if (age > STRICT_MAX_AGE_MS) {
    throw new StaleTickError(symbol, age);
  }
  return tick;
}

/**
 * Non-throwing variant that returns null on any failure. Useful
 * inside the `[SYNC]` log lines so a failed check doesn't
 * cascade into an error log. Prefer getLiveTick() for real use.
 */
export function tryGetLiveTick(symbol: string): Tick | null {
  try {
    return getLiveTick(symbol);
  } catch {
    return null;
  }
}

type State = 'idle' | 'connecting' | 'open' | 'closed';

// Events emitted on the KiteTicker instance itself:
//   'connect'     → fired once the WebSocket is open and ready
//                   for subscribe frames. bootTicker listens for
//                   this so the subscribe() call is guaranteed to
//                   run AFTER the session is established.
//   'ticks'       → fired once per binary frame with an array of
//                   parsed Tick objects. The internal bridge (see
//                   the constructor) fans these out to the global
//                   tickBus as individual 'tick' events so any
//                   number of consumers (strategy engine, UI,
//                   persistence) can subscribe without touching
//                   the socket.
//   'disconnect'  → fired on every close; useful for health probes
class KiteTicker extends EventEmitter {
  private ws: WebSocket | null = null;
  private state: State = 'idle';
  // Token-keyed cache — authoritative store, written in the hot
  // parse loop. One entry per subscribed instrument.
  private readonly ticks = new Map<number, Tick>();
  // Symbol-keyed mirror — populated in the bridge as soon as we
  // know the symbol for a token. /api/price reads this directly,
  // so the hot read path is a single O(1) Map lookup with no DB,
  // no token resolver, no await.
  private readonly ticksBySymbol = new Map<string, Tick>();
  // token → symbol, filled on subscribe so parsePacket never has
  // to hit the async instruments resolver from the hot loop.
  private readonly tokenToSymbol = new Map<number, string>();
  private readonly subs = new Set<number>();
  private mode: TickMode = 'quote';
  private reconnectAttempts = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private connectPromise: Promise<void> | null = null;
  private lastError: string | null = null;
  private lastConnectedAt: number | null = null;
  private packetsReceived = 0;
  // When true, the stored access_token is known-bad (403 from either
  // the REST preflight or the WS handshake). We stop auto-reconnecting
  // until a fresh OAuth round-trip clears this flag via clearLoginRequired().
  private loginRequired = false;

  constructor() {
    super();
    // Allow a comfortable number of listeners — strategy runner,
    // UI broadcaster, persistence writer, health probe… all legit.
    this.setMaxListeners(32);

    // ── Internal bridge: batch 'ticks' → per-tick tickBus events ──
    // Keeping this inside the class means there's exactly one
    // subscriber on our own 'ticks' event, no matter how many
    // times the module is re-imported under HMR. The bridge is
    // idempotent because `this` is the globalThis-cached singleton.
    //
    // CRITICAL FIX (2026-04-14)
    // Previous implementation had no per-tick try/catch around the
    // tickBus.emit call. Node EventEmitter.emit is synchronous — if
    // ANY downstream listener (strategy runner, freshness guard,
    // tickStore, a user-installed debugger) threw on any tick, the
    // for-loop would unwind, the current batch would be partially
    // fanned out, and — because the throw would also escape this
    // handler — subsequent 'ticks' events on the same tick could
    // leave listeners in a wedged state. The symptom was:
    //
    //   packetsReceived: 35542  (parser fine)
    //   ticker.ticks.size: 2024 (set() on hot path fine)
    //   tickBus events:     2024 (STUCK at the initial snapshot)
    //
    // i.e. the initial subscribe-snapshot fan-out succeeded but
    // the very first post-snapshot update tripped a listener error
    // and the bridge effectively stopped for everyone else.
    //
    // The fix is defensive, not clever: wrap the per-tick emit so a
    // single bad listener cannot corrupt the whole fan-out. A buggy
    // downstream handler is now a logged warning, not a silent
    // stream outage.
    this.on('ticks', (batch: Tick[]) => {
      for (const tick of batch) {
        try {
          // Attach symbol (from the pre-loaded tokenToSymbol map,
          // populated at subscribe time) and mirror into the
          // symbol-keyed cache that /api/price reads from.
          if (!tick.symbol) {
            const sym = this.tokenToSymbol.get(tick.token);
            if (sym) tick.symbol = sym;
          }
          if (tick.symbol) {
            this.ticksBySymbol.set(tick.symbol, tick);
            // Proof-of-life log — fires once per symbol per session.
            // Cleared on disconnect, so a reconnect re-prints these.
            if (!this.firstTickLogged.has(tick.symbol)) {
              this.firstTickLogged.add(tick.symbol);
              console.log(`[WS] Tick received symbol=${tick.symbol} price=${tick.lastPrice}`);
            }
          }
          tickBus.emit('tick', tick);
        } catch (err) {
          // Rate-limit the warning — a continuously broken listener
          // would otherwise flood the log once per tick. Log the
          // first occurrence and then one in every 500 after that.
          const c = (this.bridgeErrorCount += 1);
          if (c === 1 || c % 500 === 0) {
            console.warn(
              `[kiteTicker] bridge listener threw (count=${c}, token=${tick.token}):`,
              (err as Error).message,
            );
          }
          // Deliberately DO NOT rethrow — one bad listener must not
          // take down the entire tick stream for all consumers.
        }
      }
    });
  }
  // Bridge-listener error counter — exposed on the instance so the
  // diagnostic monitor can surface it without a globalThis dance.
  private bridgeErrorCount = 0;
  // Symbols for which the first-tick diagnostic line has already
  // been printed. Used by the per-tick log to fire exactly once per
  // symbol, not once per tick. Cleared on disconnect so a reconnect
  // re-prints the proof-of-life lines.
  private firstTickLogged = new Set<string>();
  // Cumulative count of undersized (<8B) packets seen since process
  // start. Surfaced in getStatus() so the UI / monitor can tell the
  // difference between "feed is quiet" and "feed is pumping junk".
  private undersizedCount = 0;
  // Rolling tick-rate window. Each slot is a 1-second bucket
  // containing the count of ticks parsed in that second. 10 slots
  // = a 10-second rolling window averaged to ticks/sec for the
  // [WS] metrics log.
  private readonly rateSlots: number[] = new Array(10).fill(0);
  private rateSlotIdx = 0;
  private rateSlotStart = Math.floor(Date.now() / 1000);
  private recordTicksForRate(n: number): void {
    const nowSec = Math.floor(Date.now() / 1000);
    const drift = nowSec - this.rateSlotStart;
    if (drift > 0) {
      // Advance — zero any slots we skipped over.
      const advance = Math.min(drift, this.rateSlots.length);
      for (let i = 0; i < advance; i++) {
        this.rateSlotIdx = (this.rateSlotIdx + 1) % this.rateSlots.length;
        this.rateSlots[this.rateSlotIdx] = 0;
      }
      this.rateSlotStart = nowSec;
    }
    this.rateSlots[this.rateSlotIdx] += n;
  }
  /** Ticks per second averaged over the last 10 seconds. */
  getTickRate(): number {
    // Exclude the current (partial) slot to get a stable average.
    let sum = 0;
    let buckets = 0;
    for (let i = 0; i < this.rateSlots.length; i++) {
      if (i === this.rateSlotIdx) continue;
      sum += this.rateSlots[i];
      buckets++;
    }
    if (buckets === 0) return 0;
    return Math.round((sum / buckets) * 10) / 10;
  }

  // ── Lifecycle ──────────────────────────────────────────────

  async connect(): Promise<void> {
    if (this.state === 'open') return;
    if (this.connectPromise) return this.connectPromise;

    this.connectPromise = this.openSocket();
    try {
      await this.connectPromise;
    } finally {
      this.connectPromise = null;
    }
  }

  private async openSocket(): Promise<void> {
    // Refuse to waste a handshake on a token we already know is dead.
    if (this.loginRequired) {
      const msg = 'LOGIN_REQUIRED: access_token invalid, waiting for re-login';
      this.lastError = msg;
      throw new Error(msg);
    }

    // Trim defensively — a trailing newline on KITE_API_KEY in .env
    // is the single most common cause of a handshake 403 that "looks
    // like" an auth problem. Never feed untrimmed env values to Kite.
    const apiKey = process.env.KITE_API_KEY?.trim();
    const rawToken = await getKiteAccessToken();
    const accessToken = rawToken?.trim() ?? null;

    // Masked debug line — proves the exact token reaching Kite without
    // leaking it to the log. If THIS doesn't match the token row you
    // just inserted, something is reading a stale api_key.
    const mask = (s: string | null | undefined) =>
      s ? `${s.slice(0, 4)}…${s.slice(-4)}(len=${s.length})` : 'null';
    console.log(
      `[kiteTicker] preconnect  api_key=${mask(apiKey)}  access_token=${mask(accessToken)}`
    );

    if (!apiKey || !accessToken) {
      this.loginRequired = true;
      this.lastError = 'LOGIN_REQUIRED: no api_key or access_token in DB — visit /api/kite/login';
      console.error('[kiteTicker] ✗ ' + this.lastError);
      throw new Error(this.lastError);
    }

    // ── REST preflight ───────────────────────────────────────
    // Hit /user/profile before opening the WS. Fails in ~200ms with a
    // clean HTTP status instead of the ws library's opaque
    // "Unexpected server response: 403" which gives us nothing to act on.
    const probe = await validateKiteToken(accessToken);
    if (!probe.ok) {
      console.error(
        `[kiteTicker] ✗ preflight /user/profile FAILED  status=${probe.status}  msg=${probe.message ?? '-'}`
      );
      if (probe.status === 403) {
        // Token was accepted locally (created_at within 20h) but Kite
        // server-side says no. Clear the dead row and mark login_required
        // so the reconnect loop doesn't keep hammering.
        await clearKiteAccessToken().catch(() => {});
        this.loginRequired = true;
        this.lastError = 'LOGIN_REQUIRED: stored access_token rejected by Kite (403) — cleared. Visit /api/kite/login';
        console.error('[kiteTicker] ✗ ' + this.lastError);
        throw new Error(this.lastError);
      }
      // Non-403 (network, 5xx) — allow normal reconnect backoff.
      this.lastError = `preflight failed: ${probe.status} ${probe.message ?? ''}`;
      throw new Error(this.lastError);
    }
    console.log('[kiteTicker] ✓ preflight /user/profile OK');

    const url = `${WS_URL}?api_key=${encodeURIComponent(apiKey)}&access_token=${encodeURIComponent(accessToken)}`;
    this.state = 'connecting';
    console.log('[kiteTicker] connecting…');

    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(url);
      this.ws = ws;

      const onOpen = () => {
        this.state = 'open';
        this.reconnectAttempts = 0;
        this.lastError = null;
        this.lastConnectedAt = Date.now();

        // Transparent reconnect: if we had subs before the drop,
        // re-apply them. New subscribers should NOT call this path —
        // they listen to the 'connect' event and call subscribe()
        // themselves, which is the contract bootTicker relies on.
        if (this.subs.size > 0) {
          this.sendSubscribe([...this.subs]);
          this.sendMode(this.mode, [...this.subs]);
        }

        // Fire the public 'connect' event AFTER we've re-applied
        // any existing subs, so listeners observing `state === 'open'`
        // also see the replayed subscriptions already in flight.
        console.log(`[WS] Connected  replayedSubs=${this.subs.size}`);
        this.emit('connect');
        resolve();
      };

      const onMessage = (data: WebSocket.RawData) => {
        this.handleMessage(data);
      };

      const onClose = (code: number, reason: Buffer) => {
        console.warn(
          `[kiteTicker] ✗ closed  code=${code}  reason=${reason?.toString() || 'none'}`
        );
        this.state = 'closed';
        this.ws = null;
        // Reset first-tick log set so reconnect re-prints proof-of-life
        // lines for each symbol on the next session.
        this.firstTickLogged.clear();
        this.emit('disconnect', { code, reason: reason?.toString() });
        this.scheduleReconnect();
      };

      const onError = (err: Error) => {
        console.error('[kiteTicker] error:', err.message);
        this.lastError = err.message;
        // Handshake 403 (e.g. token revoked between preflight and WS
        // open, which can happen if another login happened on this
        // api_key in that window). Mark loginRequired so onClose
        // doesn't schedule an infinite reconnect loop.
        if (/\b403\b/.test(err.message)) {
          this.loginRequired = true;
          clearKiteAccessToken().catch(() => {});
          console.error(
            '[kiteTicker] ✗ 403 on WS handshake — token cleared, reconnect loop stopped. Visit /api/kite/login'
          );
        }
        // `close` fires after `error`, so reconnection is handled there.
        // If we're still in the initial connect, reject the promise.
        if (this.state === 'connecting') {
          reject(err);
        }
      };

      ws.on('open',    onOpen);
      ws.on('message', onMessage);
      ws.on('close',   onClose);
      ws.on('error',   onError);
    });
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    if (this.loginRequired) {
      console.warn(
        '[kiteTicker] ✗ NOT reconnecting — login_required is set. ' +
        'Visit /api/kite/login to refresh the access_token, ' +
        'then call ticker.clearLoginRequired() or restart the process.'
      );
      return;
    }
    const delay = Math.min(
      RECONNECT_MAX_MS,
      RECONNECT_MIN_MS * Math.pow(2, this.reconnectAttempts),
    );
    this.reconnectAttempts += 1;
    console.log(`[kiteTicker] reconnect in ${delay}ms (attempt ${this.reconnectAttempts})`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.openSocket().catch((err) => {
        console.error('[kiteTicker] reconnect failed:', err.message);
        this.scheduleReconnect();
      });
    }, delay);
  }

  disconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.close();
      this.ws = null;
    }
    this.state = 'idle';
    this.subs.clear();
    this.ticks.clear();
    this.ticksBySymbol.clear();
    this.tokenToSymbol.clear();
  }

  /**
   * Synchronous, zero-await read of the latest tick for a symbol.
   * Returns null if the symbol isn't subscribed or no frame has
   * arrived yet. This is the hot path for /api/price — a pure
   * in-memory Map lookup with no DB and no network.
   */
  getTickBySymbolSync(symbol: string): Tick | null {
    return this.ticksBySymbol.get(symbol.trim().toUpperCase()) ?? null;
  }

  /**
   * Debug / diagnostic snapshot of the entire tick cache. Returns
   * every currently cached symbol with its latest tick. Intended
   * for the /api/kite/ticks admin endpoint — do NOT call this on
   * hot paths (it materialises a full array on every invocation).
   */
  getAllTicks(): Tick[] {
    return [...this.ticksBySymbol.values()];
  }

  // ── Subscribe / unsubscribe ────────────────────────────────

  async subscribeSymbols(symbols: string[], mode: TickMode = 'quote'): Promise<{
    resolved: string[];
    unknown: string[];
  }> {
    const map = await resolveTokens(symbols);
    const resolved: string[] = [];
    const unknown:  string[] = [];
    const newTokens: number[] = [];

    for (const s of symbols) {
      const up = s.trim().toUpperCase();
      const tok = map.get(up);
      if (tok == null) {
        unknown.push(up);
        continue;
      }
      resolved.push(up);
      // Fill the token→symbol map BEFORE the socket starts
      // streaming this token, so the very first frame can label
      // itself without falling back to the async resolver.
      //
      // Validation: if this token was previously mapped to a
      // DIFFERENT symbol, something is wrong in kite_instruments
      // (duplicate tradingsymbol across instruments, or a rename).
      // Log loudly so you catch it immediately instead of staring
      // at a wrong price later.
      const prior = this.tokenToSymbol.get(tok);
      if (prior && prior !== up) {
        console.warn(
          `[kiteTicker] ⚠ token ${tok} was mapped to ${prior}, now ${up} — ` +
          `instrument master collision; newer mapping wins`
        );
      }
      this.tokenToSymbol.set(tok, up);
      if (!this.subs.has(tok)) {
        this.subs.add(tok);
        newTokens.push(tok);
      }
    }

    // Sanity print — first 5 symbol↔token pairs for a visual
    // gut-check that NESTLEIND isn't pointed at TITAN's token, etc.
    if (resolved.length > 0) {
      const sample = resolved.slice(0, 5)
        .map((s) => `${s}=${map.get(s)}`)
        .join('  ');
      console.log(
        `[kiteTicker] subscribe  resolved=${resolved.length}  unknown=${unknown.length}  ` +
        `sample[${sample}]${resolved.length > 5 ? ' …' : ''}`
      );
    }

    this.mode = mode;

    if (this.state !== 'open') {
      // Connect lazily — the openSocket `open` handler will
      // replay `this.subs` once the session is ready.
      await this.connect();
    } else if (newTokens.length > 0) {
      this.sendSubscribe(newTokens);
      this.sendMode(mode, newTokens);
    }

    return { resolved, unknown };
  }

  async unsubscribeSymbols(symbols: string[]): Promise<void> {
    const map = await resolveTokens(symbols);
    const tokens: number[] = [];
    for (const s of symbols) {
      const up = s.trim().toUpperCase();
      const tok = map.get(up);
      if (tok != null && this.subs.has(tok)) {
        this.subs.delete(tok);
        this.ticks.delete(tok);
        this.tokenToSymbol.delete(tok);
        this.ticksBySymbol.delete(up);
        tokens.push(tok);
      }
    }
    if (tokens.length && this.state === 'open' && this.ws) {
      this.ws.send(JSON.stringify({ a: 'unsubscribe', v: tokens }));
    }
  }

  private sendSubscribe(tokens: number[]): void {
    if (!this.ws || this.state !== 'open') {
      console.warn(
        `[WS] subscribe SKIPPED  ws=${this.ws ? 'present' : 'null'}  state=${this.state}  ` +
        `tokens=${tokens.length} — socket not open, will replay on next open`,
      );
      return;
    }
    // Debug line — grep target [WS]. Proves the subscribe frame hit
    // the socket and shows the first few tokens so you can cross-ref
    // against kite_instruments. If you never see this line, the
    // subscribe path is starved (usually: ticker idle because no
    // valid access_token).
    const sample = tokens.slice(0, 5).join(',');
    console.log(
      `[WS] → subscribe  tokens=${tokens.length}  sample=[${sample}${tokens.length > 5 ? '…' : ''}]`,
    );
    this.ws.send(JSON.stringify({ a: 'subscribe', v: tokens }));
  }

  private sendMode(mode: TickMode, tokens: number[]): void {
    if (!this.ws || this.state !== 'open') {
      console.warn(
        `[WS] setMode SKIPPED  state=${this.state}  mode=${mode}  tokens=${tokens.length}`,
      );
      return;
    }
    console.log(`[WS] → setMode  mode=${mode}  tokens=${tokens.length}`);
    this.ws.send(JSON.stringify({ a: 'mode', v: [mode, tokens] }));
  }

  // ── Frame parsing ──────────────────────────────────────────

  private handleMessage(data: WebSocket.RawData): void {
    // Kite sends text JSON for order/error frames and binary for
    // tick frames. Text frames aren't ticks — log and return.
    if (typeof data === 'string') {
      console.log('[kiteTicker] text frame:', data);
      return;
    }
    const buf = Buffer.isBuffer(data)
      ? data
      : Array.isArray(data)
        ? Buffer.concat(data)
        : Buffer.from(data as ArrayBuffer);

    // Heartbeat frame — single byte, ignore.
    if (buf.length < 2) return;

    const numPackets = buf.readInt16BE(0);
    let offset = 2;
    let parsed = 0;
    let undersized = 0;
    const batch: Tick[] = [];
    for (let i = 0; i < numPackets; i++) {
      if (offset + 2 > buf.length) break;
      const pktLen = buf.readInt16BE(offset);
      offset += 2;
      if (offset + pktLen > buf.length) break;
      const pkt = buf.subarray(offset, offset + pktLen);
      offset += pktLen;
      if (pkt.length < 8) {
        undersized += 1;
        continue;
      }
      const tick = this.parsePacket(pkt);
      if (tick) {
        this.ticks.set(tick.token, tick);
        batch.push(tick);
        parsed += 1;
      }
    }
    // Count only packets that actually produced a tick. The old code
    // added `numPackets` unconditionally, which made packetsReceived
    // look healthy on holiday/empty feeds even when ticksCached=0.
    this.packetsReceived += parsed;
    if (parsed > 0) this.recordTicksForRate(parsed);

    // Rate-limited diagnostic — surfaces when Kite sends us frames
    // full of undersized packets (seen on NSE holidays and during
    // exchange halts). First hit and every 500th after.
    if (undersized > 0) {
      const c = (this.undersizedCount += undersized);
      if (c === undersized || c % 500 === 0) {
        console.warn(
          `[kiteTicker] ⚠ undersized packets (<8B) count=${c} — ` +
          `likely market closed / holiday / no trades on subscribed tokens`
        );
      }
    }

    // Single emission per frame — the bridge installed in the
    // constructor fans each tick out to tickBus. Emitting the
    // batch (instead of calling emit() per packet from inside
    // the parse loop) keeps the hot path branch-free.
    if (batch.length > 0) {
      this.emit('ticks', batch);
    }
  }

  private parsePacket(pkt: Buffer): Tick | null {
    if (pkt.length < 8) return null;
    const token = pkt.readInt32BE(0);
    // NSE equity: prices in paise → /100. Indices use a different
    // divisor but we don't subscribe to them in this module.
    const DIV = 100;
    const ltp = pkt.readInt32BE(4) / DIV;

    // Build a FRESH tick on every packet — no spread from the
    // previous one. Reason: the old `...existing` spread carried
    // OHLC / change / pChange from the prior frame, so a mode=ltp
    // packet (8 bytes, no OHLC) left stale change/pChange values
    // attached to a new lastPrice. Numerically inconsistent data
    // in the cache is the single most common source of "why is
    // the UI showing the wrong change percent" complaints.
    //
    // In quote / full mode (>=44 bytes) we repopulate OHLC and
    // recompute change/pChange from the current `close` field.
    // In LTP-only mode we fall back to the last seen OHLC from
    // the existing cached tick — but ONLY those four numbers,
    // never the computed derivatives.
    const tick: Tick = {
      token,
      lastPrice: ltp,
      ts: Date.now(),
    };

    if (pkt.length >= 44) {
      tick.avgPrice = pkt.readInt32BE(12) / DIV;
      tick.volume   = pkt.readInt32BE(16);
      tick.open     = pkt.readInt32BE(28) / DIV;
      tick.high     = pkt.readInt32BE(32) / DIV;
      tick.low      = pkt.readInt32BE(36) / DIV;
      tick.close    = pkt.readInt32BE(40) / DIV;
      if (tick.close && tick.close > 0) {
        tick.change  = ltp - tick.close;
        tick.pChange = ((ltp - tick.close) / tick.close) * 100;
      }
    } else {
      // LTP-only packet — carry forward the last seen OHLC so
      // the `close` reference point stays available, but
      // RECOMPUTE change/pChange against the new ltp. Never
      // reuse the old derived values.
      const prev = this.ticks.get(token);
      if (prev) {
        tick.open   = prev.open;
        tick.high   = prev.high;
        tick.low    = prev.low;
        tick.close  = prev.close;
        tick.volume = prev.volume;
        if (prev.close && prev.close > 0) {
          tick.change  = ltp - prev.close;
          tick.pChange = ((ltp - prev.close) / prev.close) * 100;
        }
      }
    }

    return tick;
  }

  // ── Read API ───────────────────────────────────────────────

  async getTickBySymbol(symbol: string): Promise<Tick | null> {
    const tok = await getInstrumentToken(symbol);
    if (tok == null) return null;
    const tick = this.ticks.get(tok);
    if (!tick) return null;
    if (!tick.symbol) tick.symbol = (await getSymbolForToken(tok)) ?? symbol.toUpperCase();
    return tick;
  }

  getStatus() {
    return {
      state: this.state,
      subscribed: this.subs.size,
      ticksCached: this.ticks.size,
      packetsReceived: this.packetsReceived,
      // Surfaces the number of times a downstream tickBus listener
      // has thrown since process start. Non-zero = some consumer
      // has a bug, but the fan-out is NOT broken (the bridge now
      // swallows listener errors). See the bridge installation in
      // the constructor for details.
      bridgeErrorCount: this.bridgeErrorCount,
      undersizedPackets: this.undersizedCount,
      tickRatePerSec: this.getTickRate(),
      lastError: this.lastError,
      lastConnectedAt: this.lastConnectedAt,
      reconnectAttempts: this.reconnectAttempts,
      mode: this.mode,
      loginRequired: this.loginRequired,
    };
  }

  /**
   * Called by the OAuth callback (/api/kite/callback) after a fresh
   * access_token has been written to kite_tokens. Clears the dead
   * flag and kicks off an immediate reconnect so the ticker comes
   * back online without a process restart.
   */
  clearLoginRequired(): void {
    if (!this.loginRequired) return;
    console.log('[kiteTicker] ✓ loginRequired cleared — scheduling reconnect');
    this.loginRequired = false;
    this.lastError = null;
    this.reconnectAttempts = 0;
    this.scheduleReconnect();
  }

  listSubscribedSymbols(): Promise<string[]> {
    return Promise.all(
      [...this.subs].map(async (t) => (await getSymbolForToken(t)) ?? String(t)),
    );
  }
}

// ── Singleton ─────────────────────────────────────────────────
// Node module caching would normally be enough, but Next.js dev
// mode aggressively re-imports modules on hot reload which creates
// duplicate tickers that race each other on the same access_token
// and get disconnected by Kite. Stash the instance on globalThis
// so HMR rebinds to the same underlying socket.

const GLOBAL_KEY = '__q365_kite_ticker__';

function getSingleton(): KiteTicker {
  const g = globalThis as unknown as Record<string, KiteTicker | undefined>;
  if (!g[GLOBAL_KEY]) {
    g[GLOBAL_KEY] = new KiteTicker();
  }
  return g[GLOBAL_KEY]!;
}

export function getTicker(): KiteTicker {
  return getSingleton();
}

export type { KiteTicker };
