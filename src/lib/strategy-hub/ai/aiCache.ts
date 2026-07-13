// ════════════════════════════════════════════════════════════════
//  Strategy Hub AI — in-process cache (Phase 7)
// ════════════════════════════════════════════════════════════════

const TTL_MS = 5 * 60 * 1000;
const store = new Map<string, { value: unknown; expiresAt: number }>();

export function aiCacheKey(parts: Record<string, string | number | boolean | null | undefined>): string {
  return Object.entries(parts)
    .filter(([, v]) => v != null)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join('|');
}

export function getAiCache<T>(key: string): { value: T; ageMs: number } | null {
  const entry = store.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    store.delete(key);
    return null;
  }
  return { value: entry.value as T, ageMs: Date.now() - (entry.expiresAt - TTL_MS) };
}

export function setAiCache<T>(key: string, value: T, ttlMs = TTL_MS): void {
  store.set(key, { value, expiresAt: Date.now() + ttlMs });
}

export function clearAiCache(): void {
  store.clear();
}

/** Reset cache for tests. */
export function _resetAiCache(): void {
  store.clear();
}
