// ════════════════════════════════════════════════════════════════
//  Kite Connect — active access-token sessions (per-user + system)
//
//  Interactive users: kite:active-session:user:{userId}
//  System feed (jobs / global ticker): kite:active-session:system
//  Legacy key kite:active-session is read as a fallback for system only.
// ════════════════════════════════════════════════════════════════

import { getRedisClient } from '@/lib/redis';
import { isSystemFeedOwner } from '@/lib/marketData/connectionManager/systemFeed';

/** Kite access tokens are day-scoped; keep slightly under 24h. */
const ACTIVE_SESSION_TTL_SECONDS = 20 * 60 * 60;
const LEGACY_SYSTEM_KEY = 'kite:active-session';
const SYSTEM_KEY = 'kite:active-session:system';

export interface KiteActiveSession {
  accessToken: string;
  kiteUserId: string;
  quantorusUserId: string;
  authenticatedAt: string;
}

function userSessionKey(userId: string | number): string {
  return `kite:active-session:user:${String(userId).trim()}`;
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

async function writeSession(key: string, session: KiteActiveSession): Promise<void> {
  const redis = getRedisClient();
  if (!redis) {
    throw new Error('Kite active session store unavailable');
  }
  await redis.hset(key, {
    accessToken: session.accessToken.trim(),
    kiteUserId: session.kiteUserId.trim(),
    quantorusUserId: session.quantorusUserId.trim(),
    authenticatedAt: session.authenticatedAt.trim(),
  });
  await redis.expire(key, ACTIVE_SESSION_TTL_SECONDS);
}

async function readSession(key: string): Promise<KiteActiveSession | null> {
  const redis = getRedisClient();
  if (!redis) return null;
  try {
    const fields = await redis.hgetall(key);
    if (!fields || Object.keys(fields).length === 0) return null;
    return normalizeSession(fields);
  } catch {
    return null;
  }
}

async function clearKey(key: string, accessToken?: string): Promise<boolean> {
  const redis = getRedisClient();
  if (!redis) return false;
  try {
    if (accessToken !== undefined) {
      const expected = accessToken.trim();
      if (!expected) return false;
      const current = await redis.hget(key, 'accessToken');
      if (!current || current.trim() !== expected) return false;
    }
    const removed = await redis.del(key);
    return removed > 0;
  } catch {
    return false;
  }
}

function assertSession(session: KiteActiveSession): void {
  if (
    !isNonEmptyString(session.accessToken)
    || !isNonEmptyString(session.kiteUserId)
    || !isNonEmptyString(session.quantorusUserId)
    || !isNonEmptyString(session.authenticatedAt)
  ) {
    throw new Error('Kite session requires non-empty fields');
  }
}

/** Persist THIS user's Kite session — never overwrites another user's key. */
export async function saveUserKiteSession(
  userId: number | string,
  session: KiteActiveSession,
): Promise<void> {
  assertSession(session);
  const uid = String(userId).trim();
  const payload = {
    ...session,
    quantorusUserId: uid,
  };
  await writeSession(userSessionKey(uid), payload);

  // Only the designated system feed owner may update the process-global session.
  if (isSystemFeedOwner(uid)) {
    await writeSession(SYSTEM_KEY, payload);
    // Keep legacy key in sync for older readers during rollout.
    await writeSession(LEGACY_SYSTEM_KEY, payload).catch(() => undefined);
  }
}

/**
 * @deprecated Prefer saveUserKiteSession(userId, session).
 * Writes the user key; updates system keys only if the user is the system feed owner.
 */
export async function saveActiveKiteSession(session: KiteActiveSession): Promise<void> {
  assertSession(session);
  await saveUserKiteSession(session.quantorusUserId, session);
}

/** Read a specific user's session. */
export async function getUserKiteSession(
  userId: number | string,
): Promise<KiteActiveSession | null> {
  return readSession(userSessionKey(userId));
}

export async function getUserKiteAccessToken(
  userId: number | string,
): Promise<string | null> {
  const session = await getUserKiteSession(userId);
  return session?.accessToken ?? null;
}

/** System feed session (jobs / global ticker). */
export async function getSystemKiteSession(): Promise<KiteActiveSession | null> {
  const modern = await readSession(SYSTEM_KEY);
  if (modern) return modern;
  return readSession(LEGACY_SYSTEM_KEY);
}

/**
 * Read the system feed session (not an arbitrary user's).
 * @deprecated Name kept for call sites; behavior is system-scoped.
 */
export async function getActiveKiteSession(): Promise<KiteActiveSession | null> {
  return getSystemKiteSession();
}

export async function getActiveKiteAccessToken(): Promise<string | null> {
  const session = await getSystemKiteSession();
  return session?.accessToken ?? null;
}

/** Clear only this user's Redis session. Optionally clear system if they own it. */
export async function clearUserKiteSession(
  userId: number | string,
  accessToken?: string,
): Promise<{ userCleared: boolean; systemCleared: boolean }> {
  const uid = String(userId).trim();
  const userCleared = await clearKey(userSessionKey(uid), accessToken);
  let systemCleared = false;
  if (isSystemFeedOwner(uid)) {
    systemCleared = await clearKey(SYSTEM_KEY, accessToken);
    await clearKey(LEGACY_SYSTEM_KEY, accessToken);
  }
  return { userCleared, systemCleared };
}

/**
 * Clear the system session.
 * When `accessToken` is provided, only clears if it matches.
 */
export async function clearActiveKiteSession(accessToken?: string): Promise<boolean> {
  const a = await clearKey(SYSTEM_KEY, accessToken);
  const b = await clearKey(LEGACY_SYSTEM_KEY, accessToken);
  return a || b;
}
