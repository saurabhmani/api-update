// ════════════════════════════════════════════════════════════════
//  redisTickBridge — publish live ticks into Redis Streams and
//  expose read helpers so other processes (or this one) can pull
//  them back out WITHOUT touching the Kite WebSocket directly. // @deprecated marker
//
//  Layout
//  ──────
//    Stream   : `ticks`                    (MAXLEN ~100_000)
//    Hash key : `tick:latest:<SYMBOL>`     (O(1) snapshot per symbol)
//
//  Why both?
//    - The stream is the event log — consumers (strategy engines,
//      loggers) do XREAD/XREADGROUP on it and see every tick in
//      order.
//    - The hash is the point-in-time cache — a status endpoint or
//      a late-joining reader does HGETALL and gets the freshest
//      tick per symbol in a single round-trip.
//
//  No REST polling upstream. This bridge is a pure WebSocket-fed
//  fan-out: every frame the in-process tickBus emits is mirrored
//  into Redis. Consumers read only from Redis.
// ════════════════════════════════════════════════════════════════

import Redis from 'ioredis';
import { tickBus } from './tickBus';
import type { TickData } from './tickTypes';
import { MARKET_TICKS_STREAM, MARKET_TICKS_MAXLEN } from '@/lib/pipeline/streams';
import { recordProcessed, recordError } from '@/lib/pipeline/pipelineMetrics';
import { logger } from '@/lib/logger';

const log = logger.child({ component: 'redisTickBridge' });

const STREAM_KEY    = MARKET_TICKS_STREAM;
const LATEST_PREFIX = 'tick:latest:';
const STREAM_MAXLEN = MARKET_TICKS_MAXLEN;

interface BridgeState {
  publisher: Redis | null;
  reader:    Redis | null;
  installed: boolean;
  published: number;
  errors:    number;
  handler:   ((t: TickData) => void) | null;
}

const GLOBAL_KEY = '__q365_redis_tick_bridge__';

function getState(): BridgeState {
  const g = globalThis as unknown as Record<string, BridgeState | undefined>;
  if (!g[GLOBAL_KEY]) {
    g[GLOBAL_KEY] = {
      publisher: null,
      reader:    null,
      installed: false,
      published: 0,
      errors:    0,
      handler:   null,
    };
  }
  return g[GLOBAL_KEY]!;
}

function redisUrl(): string {
  if (process.env.REDIS_URL) return process.env.REDIS_URL;
  // Synthesize a URL from the component env vars so Redis 6+ ACL
  // credentials flow through (username + password). Falls back to
  // the default host if nothing is set.
  const host = process.env.REDIS_HOST || '127.0.0.1';
  const port = process.env.REDIS_PORT || '6379';
  const user = process.env.REDIS_USER ? encodeURIComponent(process.env.REDIS_USER) : '';
  const pw   = process.env.REDIS_PASSWORD ? encodeURIComponent(process.env.REDIS_PASSWORD) : '';
  const auth = user || pw ? `${user}:${pw}@` : '';
  return `redis://${auth}${host}:${port}`;
}

// ── Publisher ─────────────────────────────────────────────────

/**
 * Attach a tickBus listener that writes every frame into Redis.
 * Idempotent (safe on HMR) and a no-op when REDIS_DISABLED=1.
 * No await — the bridge must never block the tick hot path.
 */
export function installRedisTickBridge(): void {
  if (process.env.REDIS_DISABLED === '1') return;
  const state = getState();
  if (state.installed) return;

  const pub = new Redis(redisUrl(), {
    lazyConnect: false,
    maxRetriesPerRequest: 2,
    enableOfflineQueue: true,
  });
  pub.on('error', (e) => {
    state.errors += 1;
    if (state.errors % 50 === 1) {
      console.warn('[redisTickBridge] publisher error:', e.message);
    }
  });

  state.publisher = pub;

  const onTick = (t: TickData): void => {
    if (!t.symbol || !t.lastPrice) return;
    const sym = t.symbol;
    const t0 = Date.now();

    // Source gate — Kite-first, Yahoo only when no Kite entry exists // @deprecated marker
    // for this symbol. Without this, a Yahoo poll cycle overwrites // @deprecated marker
    // the authoritative Kite LTP in `tick:latest:<SYM>` and every // @deprecated marker
    // downstream Redis reader sees Yahoo data. The separate hash // @deprecated marker
    // `tick:latest:yahoo:<SYM>` is still written so operators can // @deprecated marker
    // inspect the shadow channel without polluting truth.
    const isYahoo = t.source === 'yahoo'; // @deprecated marker
    const latestKey = `${LATEST_PREFIX}${sym}`;

    // Fire-and-forget pipeline: one stream append + one latest hash
    // write per tick. We don't await — the tick handler must stay
    // synchronous from the bus's point of view.
    const fields = {
      sym,
      ltp:  t.lastPrice,
      vol:  t.volume ?? 0,
      ts:   t.ts,
      open: t.open ?? 0,
      high: t.high ?? 0,
      low:  t.low  ?? 0,
      close:t.close?? 0,
      src:  isYahoo ? 'yahoo' : 'kite', // @deprecated marker
    };

    const pipe = pub.pipeline()
      .xadd(
        STREAM_KEY,
        'MAXLEN', '~', String(STREAM_MAXLEN),
        '*',
        'sym',  sym,
        'ltp',  String(t.lastPrice),
        'vol',  String(t.volume ?? 0),
        'ts',   String(t.ts),
        'open', String(t.open ?? 0),
        'high', String(t.high ?? 0),
        'low',  String(t.low  ?? 0),
        'close',String(t.close?? 0),
        'src',  isYahoo ? 'yahoo' : 'kite', // @deprecated marker
      );

    if (isYahoo) { // @deprecated marker
      // Shadow key — never the authoritative latest.
      pipe.hset(`${LATEST_PREFIX}yahoo:${sym}`, fields); // @deprecated marker
      // Only SET the authoritative key if NO Kite entry exists. // @deprecated marker
      // HSETNX is per-field, so we use a tiny EVAL for "set-if-missing-
      // entire-hash" semantics. Redis runs this server-side atomically.
      pipe.eval(
        `if redis.call('EXISTS', KEYS[1]) == 0 then redis.call('HSET', KEYS[1], unpack(ARGV)) end`,
        1,
        latestKey,
        ...Object.entries(fields).flatMap(([k, v]) => [k, String(v)]),
      );
    } else {
      // Kite frame — authoritative write, always wins. // @deprecated marker
      pipe.hset(latestKey, fields);
    }

    pipe.exec()
      .then(() => {
        state.published += 1;
        recordProcessed('publisher', Date.now() - t0);
      })
      .catch((e: Error) => {
        state.errors += 1;
        recordError('publisher', e);
        if (state.errors % 50 === 1) {
          console.warn('[redisTickBridge] publish failed:', e.message);
        }
      });
  };

  tickBus.on('tick', onTick);
  state.handler = onTick;
  state.installed = true;
}

export function uninstallRedisTickBridge(): void {
  const state = getState();
  if (state.handler) {
    tickBus.off('tick', state.handler);
    state.handler = null;
  }
  if (state.publisher) {
    state.publisher.quit().catch(() => { /* noop */ });
    state.publisher = null;
  }
  if (state.reader) {
    state.reader.quit().catch(() => { /* noop */ });
    state.reader = null;
  }
  state.installed = false;
}

// ── Readers ───────────────────────────────────────────────────

function getReader(): Redis {
  const state = getState();
  if (!state.reader) {
    state.reader = new Redis(redisUrl(), { lazyConnect: false });
  }
  return state.reader;
}

export interface RedisTick {
  symbol: string;
  ltp:    number;
  volume: number;
  ts:     number;
  open:   number;
  high:   number;
  low:    number;
  close:  number;
}

function parseLatest(h: Record<string, string>): RedisTick | null {
  if (!h.sym) return null;
  return {
    symbol: h.sym,
    ltp:    Number(h.ltp),
    volume: Number(h.vol),
    ts:     Number(h.ts),
    open:   Number(h.open),
    high:   Number(h.high),
    low:    Number(h.low),
    close:  Number(h.close),
  };
}

/** O(1) latest tick for a symbol, straight from the Redis hash. */
export async function getTickFromRedis(symbol: string): Promise<RedisTick | null> {
  const h = await getReader().hgetall(`${LATEST_PREFIX}${symbol.toUpperCase()}`);
  if (!h || Object.keys(h).length === 0) return null;
  return parseLatest(h);
}

/** Batch latest ticks — uses a pipeline so N symbols = 1 round trip. */
export async function getTicksFromRedis(symbols: ReadonlyArray<string>): Promise<Map<string, RedisTick>> {
  const out = new Map<string, RedisTick>();
  if (symbols.length === 0) return out;
  const r = getReader();
  const pipe = r.pipeline();
  for (const s of symbols) pipe.hgetall(`${LATEST_PREFIX}${s.toUpperCase()}`);
  const res = await pipe.exec();
  if (!res) return out;
  res.forEach((entry, i) => {
    const [err, h] = entry;
    if (err || !h) return;
    const parsed = parseLatest(h as Record<string, string>);
    if (parsed) out.set(symbols[i].toUpperCase(), parsed);
  });
  return out;
}

/**
 * Stream consumer. Blocks with XREAD until new entries arrive, then
 * invokes `onTick` for each. Caller decides when to stop by throwing
 * or awaiting forever.
 */
export async function consumeTickStream(
  onTick: (t: RedisTick) => void,
  fromId: string = '$',
): Promise<void> {
  const r = new Redis(redisUrl(), { lazyConnect: false });
  let lastId = fromId;
  while (true) {
    const res = await r.xread('BLOCK', 5000, 'STREAMS', STREAM_KEY, lastId);
    if (!res) continue;
    for (const [, entries] of res) {
      for (const [id, flat] of entries) {
        const fields: Record<string, string> = {};
        for (let i = 0; i < flat.length; i += 2) fields[flat[i]] = flat[i + 1];
        const tick = parseLatest(fields);
        if (tick) onTick(tick);
        lastId = id;
      }
    }
  }
}

export function getRedisBridgeStats(): {
  installed: boolean;
  published: number;
  errors:    number;
} {
  const s = getState();
  return { installed: s.installed, published: s.published, errors: s.errors };
}
