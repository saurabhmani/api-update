/**
 * System-level market-data feed ownership helpers.
 * Relocated from connectionManager (broker WS registry deleted).
 */

export function getSystemMarketDataUserId(): number | null {
  const raw = (process.env.SYSTEM_MARKET_DATA_USER_ID ?? '').trim();
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : null;
}

/** @deprecated System feed no longer drives a broker ticker. */
export function isSystemFeedOwner(userId: number | string): boolean {
  const systemId = getSystemMarketDataUserId();
  if (systemId == null) return false;
  return String(systemId) === String(userId);
}

/** @deprecated Always false — Kite system ticker retired. */
export function shouldUpdateSystemKiteFeed(_userId: number | string): boolean {
  return false;
}
