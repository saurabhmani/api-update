// ════════════════════════════════════════════════════════════════
//  Kite Connect — OAuth CSRF state (Phase 3, server-only)
//
//  Redis-backed one-time state for the Kite login callback handshake.
//  Import via `@/lib/kite/auth-state` — never from the client barrel.
// ════════════════════════════════════════════════════════════════

import 'server-only';

import { createHash, randomBytes } from 'node:crypto';
import { getRedisClient } from '@/lib/redis';

const STATE_TTL_SECONDS = 10 * 60;
const STATE_BYTES = 32;
const CREATE_MAX_ATTEMPTS = 5;
const AUTH_STATE_KEY_PREFIX = 'kite:auth-state:';

const CONSUME_AUTH_STATE_LUA = `
local current = redis.call('GET', KEYS[1])
if not current then
  return 0
end
if current ~= ARGV[1] then
  return 0
end
redis.call('DEL', KEYS[1])
return 1
`;

function hashState(state: string): string {
  return createHash('sha256').update(state, 'utf8').digest('hex');
}

function authStateRedisKey(stateHashHex: string): string {
  return `${AUTH_STATE_KEY_PREFIX}${stateHashHex}`;
}

function isRedisSuccess(value: unknown): boolean {
  return value === 1 || value === '1';
}

/**
 * Create a one-time OAuth state for a Quantorus user.
 * Returns the plaintext state (send to Kite); only its hash is stored.
 *
 * Uses atomic SET NX EX so concurrent creators cannot overwrite an existing
 * live record. On NX collision, a new plaintext state is generated and retried.
 */
export async function createKiteAuthState(quantorusUserId: string): Promise<string> {
  const id = quantorusUserId.trim();
  if (!id) {
    throw new Error('createKiteAuthState requires a non-empty quantorusUserId');
  }

  const redis = getRedisClient();
  if (!redis) {
    throw new Error('Kite auth state store unavailable');
  }

  for (let attempt = 0; attempt < CREATE_MAX_ATTEMPTS; attempt += 1) {
    const state = randomBytes(STATE_BYTES).toString('hex');
    const key = authStateRedisKey(hashState(state));

    try {
      const result = await redis.set(key, id, 'EX', STATE_TTL_SECONDS, 'NX');
      if (result === 'OK') {
        return state;
      }
    } catch {
      throw new Error('Kite auth state store unavailable');
    }
  }

  throw new Error('Kite auth state store unavailable');
}

/**
 * Validate and consume a OAuth callback state for the given user.
 * Returns false for missing, expired, consumed, or user-mismatched states.
 */
export async function consumeKiteAuthState(
  state: string,
  quantorusUserId: string,
): Promise<boolean> {
  const expectedUserId = quantorusUserId.trim();
  const normalizedState = state?.trim();
  if (!expectedUserId || !normalizedState) return false;

  const redis = getRedisClient();
  if (!redis) return false;

  const key = authStateRedisKey(hashState(normalizedState));

  try {
    const result = await redis.eval(
      CONSUME_AUTH_STATE_LUA,
      1,
      key,
      expectedUserId,
    );
    return isRedisSuccess(result);
  } catch {
    return false;
  }
}
