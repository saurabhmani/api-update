/**
 * System-level market-data feed ownership.
 *
 * Interactive users use ConnectionKey registry instances.
 * Scanners / liveMarketFeed / kiteTicker singleton hydrate ONLY from
 * the system feed owner — never from "any active zerodha row LIMIT 1".
 *
 * Phase 13: job classification + requireSystemOwnedBrokerConnection
 * live in `@/lib/marketData/jobs`.
 */

export function getSystemMarketDataUserId(): number | null {
  const raw = (process.env.SYSTEM_MARKET_DATA_USER_ID ?? '').trim();
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : null;
}

/** True when this Quantorus user may drive the process-global Kite ticker. */
export function isSystemFeedOwner(userId: number | string): boolean {
  const systemId = getSystemMarketDataUserId();
  if (systemId == null) return false;
  return String(systemId) === String(userId);
}

/**
 * Whether post-OAuth should reconnect the process-global system ticker.
 * Requires an explicit SYSTEM_MARKET_DATA_USER_ID match.
 */
export function shouldUpdateSystemKiteFeed(userId: number | string): boolean {
  return isSystemFeedOwner(userId);
}
