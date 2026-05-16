import Redis from 'ioredis';

let redis: Redis | null = null;
let redisFailed = false;

// ── In-process memory cache (used when Redis is unavailable) ──────
// Keeps data hot within the same server process/worker so services
// like the signal engine don't hammer NSE with a call per stock.
interface MemEntry { value: string; expiresAt: number }
const _mem = new Map<string, MemEntry>();

function memSet(key: string, data: unknown, ttl?: number) {
  _mem.set(key, {
    value:     JSON.stringify(data),
    expiresAt: ttl ? Date.now() + ttl * 1000 : Infinity,
  });
}

function memGet<T>(key: string): T | null {
  const entry = _mem.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) { _mem.delete(key); return null; }
  try { return JSON.parse(entry.value) as T; } catch { return null; }
}

function memDel(key: string) { _mem.delete(key); }

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

// ── Typed helpers — Redis first, in-process memory fallback ───────
export async function cacheSet(key: string, data: unknown, ttl?: number) {
  // Always write to in-process memory (fast, same-process reads skip Redis)
  memSet(key, data, ttl);

  const r = getRedis();
  if (!r) return;
  try {
    const val = JSON.stringify(data);
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
    const val = await r.get(key);
    if (val) {
      const parsed = JSON.parse(val) as T;
      // Warm the in-process cache so subsequent same-process reads are fast
      memSet(key, parsed);
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
