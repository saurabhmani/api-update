// ════════════════════════════════════════════════════════════════
//  Strategy Hub Portfolio — in-process cache (Phase 8)
// ════════════════════════════════════════════════════════════════

const TTL_MS = 5 * 60 * 1000;
const store = new Map<string, { value: unknown; expiresAt: number; storedAt: number }>();

export function portfolioCacheKey(parts: Record<string, string | number | boolean | null | undefined>): string {
  return Object.entries(parts)
    .filter(([, v]) => v != null)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join('|');
}

export function getPortfolioCache<T>(key: string): { value: T; ageMs: number } | null {
  const entry = store.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    store.delete(key);
    return null;
  }
  return { value: entry.value as T, ageMs: Date.now() - entry.storedAt };
}

export function setPortfolioCache<T>(key: string, value: T, ttlMs = TTL_MS): void {
  const now = Date.now();
  store.set(key, { value, expiresAt: now + ttlMs, storedAt: now });
}

export function clearPortfolioCache(): void {
  store.clear();
}

export function _resetPortfolioCache(): void {
  store.clear();
}
