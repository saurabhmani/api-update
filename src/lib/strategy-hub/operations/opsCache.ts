const DEFAULT_TTL_MS = 60_000;

interface Entry<T> { value: T; expiresAt: number; storedAt: number }
const store = new Map<string, Entry<unknown>>();

export function opsCacheKey(parts: Record<string, string | number | null | undefined>): string {
  return Object.entries(parts).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v ?? ''}`).join('|');
}

export function getOpsCache<T>(key: string): { value: T; ageMs: number } | null {
  const e = store.get(key) as Entry<T> | undefined;
  if (!e || e.expiresAt <= Date.now()) {
    if (e) store.delete(key);
    return null;
  }
  return { value: e.value, ageMs: Date.now() - e.storedAt };
}

export function setOpsCache<T>(key: string, value: T, ttlMs = DEFAULT_TTL_MS): void {
  const now = Date.now();
  store.set(key, { value, expiresAt: now + ttlMs, storedAt: now });
}

export function invalidateOpsCache(prefix?: string): void {
  if (!prefix) { store.clear(); return; }
  for (const k of store.keys()) if (k.startsWith(prefix)) store.delete(k);
}

/** IST market hours Mon–Fri 09:15–15:30 */
export function isIndianMarketHours(now = new Date()): boolean {
  const ist = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  const day = ist.getDay();
  if (day === 0 || day === 6) return false;
  const mins = ist.getHours() * 60 + ist.getMinutes();
  return mins >= 9 * 60 + 15 && mins <= 15 * 60 + 30;
}

export function marketHoursPollIntervalMs(): number {
  return isIndianMarketHours() ? 30_000 : 120_000;
}
