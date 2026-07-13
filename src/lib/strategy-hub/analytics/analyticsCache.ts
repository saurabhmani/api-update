// ════════════════════════════════════════════════════════════════
//  Strategy analytics — in-process cache (Phase 5)
// ════════════════════════════════════════════════════════════════

const DEFAULT_TTL_MS = 5 * 60 * 1000;

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
  storedAt: number;
}

const store = new Map<string, CacheEntry<unknown>>();

export function analyticsCacheKey(parts: Record<string, string | number | null | undefined>): string {
  return Object.entries(parts)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v ?? ''}`)
    .join('|');
}

export function getAnalyticsCache<T>(key: string): { value: T; ageMs: number } | null {
  const entry = store.get(key) as CacheEntry<T> | undefined;
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    store.delete(key);
    return null;
  }
  return { value: entry.value, ageMs: Date.now() - entry.storedAt };
}

export function setAnalyticsCache<T>(key: string, value: T, ttlMs = DEFAULT_TTL_MS): void {
  const now = Date.now();
  store.set(key, { value, expiresAt: now + ttlMs, storedAt: now });
}

export function invalidateAnalyticsCache(prefix?: string): void {
  if (!prefix) {
    store.clear();
    return;
  }
  for (const key of store.keys()) {
    if (key.startsWith(prefix)) store.delete(key);
  }
}

export function invalidateStrategyAnalytics(strategyId: string): void {
  invalidateAnalyticsCache(`strategy-analytics:${strategyId}`);
}
