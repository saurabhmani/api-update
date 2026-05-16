// ════════════════════════════════════════════════════════════════
//  pipeline/streams — shared constants, types and helpers for the
//  Redis-Streams-backed market-data pipeline.
//
//  Flow:
//    Kite WS → Tick Collector → MARKET_TICKS_STREAM
//                                     │
//                    ┌────────────────┴────────────────┐
//                    ▼                                 ▼
//           Strategy Worker A                 Strategy Worker B
//           (consumer group                   (same consumer group,
//            "strategy")                       different consumer id)
//                    └────────────────┬────────────────┘
//                                     ▼
//                             SIGNALS_STREAM
//                                     │
//                                     ▼
//                            Execution Worker(s)
//                          (consumer group "execution")
//
//  Why consumer groups?
//    - Each stream entry is delivered to exactly ONE consumer in a
//      group (XREADGROUP + XACK). Adding a second worker doubles
//      throughput without duplicating work.
//    - Unacked entries sit in the PEL (pending entries list). A
//      freshly started worker can XCLAIM stale entries from crashed
//      peers, giving us at-least-once delivery for free.
// ════════════════════════════════════════════════════════════════

import Redis from 'ioredis';

export const MARKET_TICKS_STREAM = 'market_ticks';
export const SIGNALS_STREAM      = 'signals_stream';

export const STRATEGY_GROUP      = 'strategy';
export const EXECUTION_GROUP     = 'execution';

// Trim bounds — "~" MAXLEN gives O(1) amortised trimming.
export const MARKET_TICKS_MAXLEN = 200_000;
export const SIGNALS_MAXLEN      = 50_000;

// Block duration for XREADGROUP in ms. Short enough that SIGINT
// responds quickly, long enough that we don't busy-loop on empty.
export const BLOCK_MS = 5_000;

// Claim entries that have been pending for longer than this
// (i.e. the original consumer crashed between XREADGROUP and XACK).
export const CLAIM_IDLE_MS = 60_000;

export interface TickStreamEntry {
  symbol: string;
  ltp:    number;
  volume: number;
  ts:     number;
  open:   number;
  high:   number;
  low:    number;
  close:  number;
}

export interface SignalStreamEntry {
  id:         string;
  symbol:     string;
  direction:  'BUY' | 'SELL';
  entry:      number;
  stop:       number;
  target:     number;
  confidence: number;
  strategy:   string;
  ts:         number;
}

export function redisUrl(): string {
  if (process.env.REDIS_URL) return process.env.REDIS_URL;
  // Synthesize a URL from component env vars so Redis 6+ ACL
  // credentials (username + password) reach every client, not just
  // the one in lib/redis.ts.
  const host = process.env.REDIS_HOST || '127.0.0.1';
  const port = process.env.REDIS_PORT || '6379';
  const user = process.env.REDIS_USER ? encodeURIComponent(process.env.REDIS_USER) : '';
  const pw   = process.env.REDIS_PASSWORD ? encodeURIComponent(process.env.REDIS_PASSWORD) : '';
  const auth = user || pw ? `${user}:${pw}@` : '';
  return `redis://${auth}${host}:${port}`;
}

export function createRedis(): Redis {
  return new Redis(redisUrl(), {
    lazyConnect:          false,
    maxRetriesPerRequest: null, // block indefinitely rather than erroring
    enableOfflineQueue:   true,
  });
}

/**
 * Create a consumer group. Idempotent — swallows BUSYGROUP so two
 * workers starting at the same time don't race each other.
 * MKSTREAM makes this safe to call before the first producer write.
 */
export async function ensureGroup(
  redis: Redis,
  stream: string,
  group:  string,
): Promise<void> {
  try {
    await redis.xgroup('CREATE', stream, group, '$', 'MKSTREAM');
  } catch (err) {
    const msg = (err as Error).message ?? '';
    if (!msg.includes('BUSYGROUP')) throw err;
  }
}

/** Flatten a [key1, val1, key2, val2, ...] stream payload into an object. */
export function fieldsToObject(flat: ReadonlyArray<string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < flat.length; i += 2) out[flat[i]] = flat[i + 1];
  return out;
}

export function parseTickEntry(o: Record<string, string>): TickStreamEntry | null {
  if (!o.sym) return null;
  return {
    symbol: o.sym,
    ltp:    Number(o.ltp),
    volume: Number(o.vol),
    ts:     Number(o.ts),
    open:   Number(o.open),
    high:   Number(o.high),
    low:    Number(o.low),
    close:  Number(o.close),
  };
}

export function parseSignalEntry(o: Record<string, string>): SignalStreamEntry | null {
  if (!o.sym || !o.dir) return null;
  const dir = o.dir === 'BUY' || o.dir === 'SELL' ? o.dir : null;
  if (!dir) return null;
  return {
    id:         o.id,
    symbol:     o.sym,
    direction:  dir,
    entry:      Number(o.entry),
    stop:       Number(o.stop),
    target:     Number(o.target),
    confidence: Number(o.conf),
    strategy:   o.strategy,
    ts:         Number(o.ts),
  };
}
