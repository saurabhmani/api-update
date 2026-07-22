// ════════════════════════════════════════════════════════════════
//  Kite Connect — active access-token session
//
//  Persists the OAuth access token in Redis so market-data APIs and
//  CLI jobs can use the dashboard login — not KITE_ACCESS_TOKEN env.
//  Safe for Node/CLI (no `server-only` marker). Do not import from
//  client components; use `@/lib/kite/active-session-store` on server/CLI only.
// ════════════════════════════════════════════════════════════════

import { getRedisClient } from '@/lib/redis';

/** Kite access tokens are day-scoped; keep slightly under 24h. */
const ACTIVE_SESSION_TTL_SECONDS = 20 * 60 * 60;
const ACTIVE_SESSION_KEY = 'kite:active-session';

export interface KiteActiveSession {
  accessToken: string;
  kiteUserId: string;
  quantorusUserId: string;
  authenticatedAt: string;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function normalizeSession(fields: Record<string, string>): KiteActiveSession | null {
  const accessToken = fields.accessToken?.trim() ?? '';
  const kiteUserId = fields.kiteUserId?.trim() ?? '';
  const quantorusUserId = fields.quantorusUserId?.trim() ?? '';
  const authenticatedAt = fields.authenticatedAt?.trim() ?? '';

  if (!accessToken || !kiteUserId || !quantorusUserId || !authenticatedAt) {
    return null;
  }

  return { accessToken, kiteUserId, quantorusUserId, authenticatedAt };
}

/**
 * Persist the active Kite session used by getKiteClient / market data.
 * Overwrites any previous active session (single shared broker login).
 */
export async function saveActiveKiteSession(session: KiteActiveSession): Promise<void> {
  if (
    !isNonEmptyString(session.accessToken)
    || !isNonEmptyString(session.kiteUserId)
    || !isNonEmptyString(session.quantorusUserId)
    || !isNonEmptyString(session.authenticatedAt)
  ) {
    throw new Error('saveActiveKiteSession requires non-empty session fields');
  }

  const redis = getRedisClient();
  if (!redis) {
    throw new Error('Kite active session store unavailable');
  }

  const key = ACTIVE_SESSION_KEY;
  await redis.hset(key, {
    accessToken: session.accessToken.trim(),
    kiteUserId: session.kiteUserId.trim(),
    quantorusUserId: session.quantorusUserId.trim(),
    authenticatedAt: session.authenticatedAt.trim(),
  });
  await redis.expire(key, ACTIVE_SESSION_TTL_SECONDS);
}

/** Read the active session, or null if absent / incomplete / Redis down. */
export async function getActiveKiteSession(): Promise<KiteActiveSession | null> {
  const redis = getRedisClient();
  if (!redis) return null;

  try {
    const fields = await redis.hgetall(ACTIVE_SESSION_KEY);
    if (!fields || Object.keys(fields).length === 0) return null;
    return normalizeSession(fields);
  } catch {
    return null;
  }
}

/** Access token only — used by KiteClient hydration. */
export async function getActiveKiteAccessToken(): Promise<string | null> {
  const session = await getActiveKiteSession();
  return session?.accessToken ?? null;
}

/**
 * Clear the active session.
 * When `accessToken` is provided, only clears if it matches (safe disconnect).
 */
export async function clearActiveKiteSession(accessToken?: string): Promise<boolean> {
  const redis = getRedisClient();
  if (!redis) return false;

  try {
    if (accessToken !== undefined) {
      const expected = accessToken.trim();
      if (!expected) return false;
      const current = await redis.hget(ACTIVE_SESSION_KEY, 'accessToken');
      if (!current || current.trim() !== expected) {
        return false;
      }
    }

    const removed = await redis.del(ACTIVE_SESSION_KEY);
    return removed > 0;
  } catch {
    return false;
  }
}
