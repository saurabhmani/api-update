import Redis from 'ioredis';
import { recordCacheCodecDuration } from '@/lib/monitor/apiPerformanceMetrics';

let redis: Redis | null = null;
let redisFailed = false;

// ── In-process memory cache (used when Redis is unavailable) ──────
// Keeps data hot within the same server process/worker so services
// like the signal engine don't hammer NSE with a call per stock.
interface MemEntry { value: string; expiresAt: number }
const _mem = new Map<string, MemEntry>();
const _memLocks = new Map<string, { token: string; expiresAt: number }>();

function memSetSerialized(key: string, value: string, ttl?: number) {
  _mem.set(key, {
    value,
    expiresAt: ttl ? Date.now() + ttl * 1000 : Infinity,
  });
}

function memGet<T>(key: string): T | null {
  const entry = _mem.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) { _mem.delete(key); return null; }
  const startedAt = performance.now();
  try { return JSON.parse(entry.value) as T; } catch { return null; }
  finally { recordCacheCodecDuration('deserialize', performance.now() - startedAt); }
}

function memDel(key: string) { _mem.delete(key); }

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escaped.replace(/\*/g, '.*').replace(/\?/g, '.')}$`);
}

function memDelByPattern(pattern: string): number {
  const matcher = globToRegExp(pattern);
  let deleted = 0;
  for (const key of _mem.keys()) {
    if (!matcher.test(key)) continue;
    _mem.delete(key);
    deleted += 1;
  }
  return deleted;
}

// ── Redis client ──────────────────────────────────────────────────
function getRedis(): Redis | null {
  // Respect REDIS_DISABLED env var — treat as permanently unavailable
  if (process.env.REDIS_DISABLED === '1') return null;
  if (redisFailed) return null;
  if (!redis) {
    try {
      // Redis 6+ ACL: when REDIS_USER is set we authenticate as
      // that user (AUTH <user> <password>) instead of the legacy
      // password-only default user. ioredis takes the username via
      // the `username` option — mixing it with `password` runs the
      // right AUTH form automatically.
      redis = new Redis({
        host:     process.env.REDIS_HOST || '127.0.0.1',
        port:     parseInt(process.env.REDIS_PORT || '6379'),
        username: process.env.REDIS_USER || undefined,
        password: process.env.REDIS_PASSWORD || undefined,
        retryStrategy: (times) => (times > 3 ? null : 1000),
        lazyConnect: true,
        maxRetriesPerRequest: 1,
        // Fail fast — a hung Redis must not stall /api/signals.
        connectTimeout: Math.max(500, Number(process.env.REDIS_CONNECT_TIMEOUT_MS) || 2_000),
        commandTimeout: Math.max(500, Number(process.env.REDIS_COMMAND_TIMEOUT_MS) || 2_000),
      });
      redis.on('error', () => {
        if (!redisFailed) {
          redisFailed = true;
          console.warn('[Redis] Unavailable — falling back to in-process memory cache');
        }
      });
    } catch {
      redisFailed = true;
      return null;
    }
  }
  return redis;
}

/** Shared ioredis client for fail-closed server modules (no in-memory fallback). */
export function getRedisClient(): Redis | null {
  return getRedis();
}

// ── Typed helpers — Redis first, in-process memory fallback ───────
export async function cacheSet(key: string, data: unknown, ttl?: number) {
  const serializationStartedAt = performance.now();
  const val = JSON.stringify(data);
  recordCacheCodecDuration('serialize', performance.now() - serializationStartedAt);
  // Always write to in-process memory (fast, same-process reads skip Redis).
  // Reuse the exact serialized value written to Redis.
  memSetSerialized(key, val, ttl);

  const r = getRedis();
  if (!r) return;
  try {
    if (ttl) await r.setex(key, ttl, val);
    else await r.set(key, val);
  } catch {
    redisFailed = true;
  }
}

export async function cacheGet<T = unknown>(key: string): Promise<T | null> {
  // In-process memory first (zero latency, works when Redis is disabled)
  const mem = memGet<T>(key);
  if (mem !== null) return mem;

  const r = getRedis();
  if (!r) return null;
  try {
    const result = await r.pipeline().get(key).pttl(key).exec();
    const val = result?.[0]?.[1] as string | null | undefined;
    const ttlMs = Number(result?.[1]?.[1]);
    if (val) {
      const deserializationStartedAt = performance.now();
      const parsed = JSON.parse(val) as T;
      recordCacheCodecDuration('deserialize', performance.now() - deserializationStartedAt);
      // Preserve Redis expiry when warming the in-process tier. The old
      // code made Redis-loaded entries immortal inside this process.
      const ttlSeconds = Number.isFinite(ttlMs) && ttlMs > 0
        ? Math.max(1, Math.ceil(ttlMs / 1000))
        : undefined;
      memSetSerialized(key, val, ttlSeconds);
      return parsed;
    }
    return null;
  } catch {
    redisFailed = true;
    return null;
  }
}

export async function cacheDel(key: string) {
  memDel(key);
  const r = getRedis();
  if (!r) return;
  try {
    await r.del(key);
  } catch {
    redisFailed = true;
  }
}

/**
 * Delete matching cache entries without using Redis KEYS.
 *
 * Redis outages are intentionally swallowed: invalidation also runs against
 * the in-process fallback, and callers may safely continue to MySQL/provider
 * paths when Redis is unavailable.
 */
export async function cacheDelByPattern(pattern: string): Promise<number> {
  const memoryDeleted = memDelByPattern(pattern);
  const r = getRedis();
  if (!r) return memoryDeleted;

  try {
    let cursor = '0';
    let redisDeleted = 0;
    do {
      const [nextCursor, keys] = await r.scan(
        cursor,
        'MATCH',
        pattern,
        'COUNT',
        250,
      );
      cursor = nextCursor;
      if (keys.length > 0) redisDeleted += await r.del(...keys);
    } while (cursor !== '0');
    return Math.max(memoryDeleted, redisDeleted);
  } catch {
    redisFailed = true;
    return memoryDeleted;
  }
}

/** Acquire a short-lived distributed lock, falling back to this process. */
export async function cacheAcquireLock(
  key: string,
  token: string,
  ttlSeconds: number,
): Promise<boolean> {
  const r = getRedis();
  if (r) {
    try {
      return (await r.set(key, token, 'EX', ttlSeconds, 'NX')) === 'OK';
    } catch {
      redisFailed = true;
    }
  }

  const now = Date.now();
  const current = _memLocks.get(key);
  if (current && current.expiresAt > now) return false;
  _memLocks.set(key, { token, expiresAt: now + ttlSeconds * 1000 });
  return true;
}

export type DistributedLockState = 'acquired' | 'held' | 'unavailable';

/**
 * Redis-only lock acquisition. Callers must use promise coalescing when this
 * reports unavailable; an in-process guard is not a distributed lock.
 */
export async function cacheAcquireDistributedLock(
  key: string,
  token: string,
  ttlSeconds: number,
): Promise<DistributedLockState> {
  const r = getRedis();
  if (!r) return 'unavailable';
  try {
    return (await r.set(key, token, 'EX', ttlSeconds, 'NX')) === 'OK'
      ? 'acquired'
      : 'held';
  } catch {
    redisFailed = true;
    return 'unavailable';
  }
}

/** Release only a lock owned by the supplied token. */
export async function cacheReleaseLock(key: string, token: string): Promise<void> {
  const local = _memLocks.get(key);
  if (local?.token === token) _memLocks.delete(key);

  const r = getRedis();
  if (!r) return;
  try {
    await r.eval(
      'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end',
      1,
      key,
      token,
    );
  } catch {
    redisFailed = true;
  }
}

export async function setTick(instrumentKey: string, data: unknown, ttl = 60) {
  await cacheSet(`tick:${instrumentKey}`, data, ttl);
}

export async function getTick<T = unknown>(instrumentKey: string): Promise<T | null> {
  return cacheGet<T>(`tick:${instrumentKey}`);
}

export async function setQuote(instrumentKey: string, data: unknown, ttl = 15) {
  await cacheSet(`quote:${instrumentKey}`, data, ttl);
}

export async function readCachedQuote<T = unknown>(instrumentKey: string): Promise<T | null> { // @deprecated marker
  return cacheGet<T>(`quote:${instrumentKey}`);
}
