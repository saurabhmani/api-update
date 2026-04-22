// ════════════════════════════════════════════════════════════════
//  In-memory market-data cache — Redis-ready interface
//
//  Used by MarketDataProvider as the second link in the fallback
//  chain (IndianAPI → CACHE → Yahoo → DB). Purely in-process today;
//  swap the implementation for ioredis later without changing any
//  call site — the Cache interface is the contract.
//
//  Key format:  `quote:${SYMBOL}`  (uppercase, exchange-stripped)
//  TTL:         per-class (see named constants below); fallback 10 min.
// ════════════════════════════════════════════════════════════════

export interface Cache {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T, ttlSeconds?: number): Promise<void>;
  has(key: string): Promise<boolean>;
  del(key: string): Promise<void>;
  /** Returns the age of the cached value in ms, or null if absent/expired. */
  ageMs(key: string): Promise<number | null>;
}

interface CacheEntry<T> {
  value: T;
  expiresAt: number;   // epoch ms
  storedAt: number;    // epoch ms
}

// ── TTL constants by data class ─────────────────────────────────────
// Per-class TTLs matter because historical data is almost immutable
// intra-day while live quotes must expire in seconds. Using the same
// 10-min TTL for everything (as the old code did) either wastes API
// calls on historical or serves stale quotes.

// Fallback for callers that don't opt into a specific class.
export const DEFAULT_TTL_SECONDS = 10 * 60;

// Live market quotes — short. Tier A refreshes every 10 min; Tier B
// writes fresh values intra-cycle. 60s forces consumers to re-hit the
// provider, which then sees the Tier A batch write as a cache hit.
export const QUOTE_TTL_S        = 60;
export const QUOTE_TTL_OFFHRS_S = 10 * 60;     // 10 min off-hours

// Historical candles don't change intra-day. 24h is conservative for
// daily bars; shorter for intraday ranges should be set at call sites.
export const HIST_TTL_S  = 24 * 60 * 60;

// Corporate intel (sector / PE / marketCap) changes at most daily.
export const CORP_TTL_S  = 6 * 60 * 60;

// Fundamentals are refreshed quarterly upstream; 12h is safe.
export const FUND_TTL_S  = 12 * 60 * 60;

// News — market-wide refreshes frequently, company news slower.
export const MARKET_NEWS_TTL_S  = 30 * 60;
export const COMPANY_NEWS_TTL_S = 60 * 60;

// Movers / trending / shockers — one cycle behind Tier A is fine.
export const MOVERS_TTL_S = 9 * 60;

class InMemoryCache implements Cache {
  private readonly store = new Map<string, CacheEntry<unknown>>();

  async get<T>(key: string): Promise<T | null> {
    const entry = this.store.get(key) as CacheEntry<T> | undefined;
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      this.store.delete(key);
      return null;
    }
    return entry.value;
  }

  async set<T>(key: string, value: T, ttlSeconds: number = DEFAULT_TTL_SECONDS): Promise<void> {
    const now = Date.now();
    this.store.set(key, {
      value,
      storedAt: now,
      expiresAt: now + ttlSeconds * 1000,
    });
  }

  async has(key: string): Promise<boolean> {
    return (await this.get(key)) !== null;
  }

  async del(key: string): Promise<void> {
    this.store.delete(key);
  }

  async ageMs(key: string): Promise<number | null> {
    const entry = this.store.get(key);
    if (!entry || entry.expiresAt <= Date.now()) return null;
    return Date.now() - entry.storedAt;
  }
}

// ── Cache key helpers ───────────────────────────────────────────────

export const quoteCacheKey = (symbol: string) =>
  `quote:${symbol.trim().toUpperCase()}`;

export const historicalCacheKey = (symbol: string, range: string) =>
  `hist:${symbol.trim().toUpperCase()}:${range}`;

export const moversCacheKey = () => `movers:NIFTY500`;

export const corporateIntelCacheKey = (symbol: string) =>
  `corp:${symbol.trim().toUpperCase()}`;

// New keys used by the tiered scheduler paths.
export const marketNewsCacheKey    = () => 'news:market';
export const companyNewsCacheKey   = (symbol: string) => `news:${symbol.trim().toUpperCase()}`;
export const trendingCacheKey      = () => 'movers:trending_symbols';
export const shockersCacheKey      = () => 'movers:price_shockers';
export const nseMostActiveCacheKey = () => 'movers:nse_most_active';
export const newsRecentIndexKey    = () => 'news:recent:symbols';

// Singleton — the provider layer imports THIS instance, not the class.
// Swapping to Redis = replace this export with an ioredis-backed
// implementation; every consumer continues to work unchanged.
export const cache: Cache = new InMemoryCache();
