// ════════════════════════════════════════════════════════════════
//  Kite Connect — one-time opaque completion codes (server-only)
//
//  Codes are random, short-lived, single-use, and bound to the
//  authenticated Quant user. They NEVER contain access tokens.
// ════════════════════════════════════════════════════════════════

import 'server-only';

import { createHash, randomBytes } from 'node:crypto';
import { getRedisClient } from '@/lib/redis';

const COMPLETION_TTL_SECONDS = 60;
const CODE_BYTES = 32;
const CREATE_MAX_ATTEMPTS = 5;
const COMPLETION_KEY_PREFIX = 'kite:completion:';

/**
 * Atomic create-only: write fields + TTL only when the key is absent.
 * Stores no access token — only opaque user binding metadata.
 */
const CREATE_COMPLETION_LUA = `
if redis.call('EXISTS', KEYS[1]) == 1 then
  return 0
end
redis.call('HSET', KEYS[1],
  'quantorusUserId', ARGV[1],
  'kiteUserId', ARGV[2],
  'authenticatedAt', ARGV[3]
)
redis.call('EXPIRE', KEYS[1], tonumber(ARGV[4]))
return 1
`;

const CONSUME_COMPLETION_LUA = `
local quantorusUserId = redis.call('HGET', KEYS[1], 'quantorusUserId')
if not quantorusUserId then
  return nil
end
if quantorusUserId ~= ARGV[1] then
  return 'MISMATCH'
end
local kiteUserId = redis.call('HGET', KEYS[1], 'kiteUserId')
local authenticatedAt = redis.call('HGET', KEYS[1], 'authenticatedAt')
if not kiteUserId then
  return nil
end
redis.call('DEL', KEYS[1])
return cjson.encode({
  kiteUserId = kiteUserId,
  authenticatedAt = authenticatedAt or ''
})
`;

export interface KiteCompletionCodeData {
  quantorusUserId: string;
  kiteUserId: string;
  authenticatedAt: string;
}

export interface KiteCompletionConsumption {
  kiteUserId: string;
  authenticatedAt: string;
}

function hashCode(code: string): string {
  return createHash('sha256').update(code, 'utf8').digest('hex');
}

function completionRedisKey(codeHashHex: string): string {
  return `${COMPLETION_KEY_PREFIX}${codeHashHex}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isRedisSuccess(value: unknown): boolean {
  return value === 1 || value === '1';
}

function parseConsumptionPayload(value: unknown): KiteCompletionConsumption | null {
  if (!isRecord(value)) return null;

  const kiteUserId = value.kiteUserId;
  if (!isNonEmptyString(kiteUserId)) return null;

  const authenticatedAt = isNonEmptyString(value.authenticatedAt)
    ? value.authenticatedAt.trim()
    : new Date().toISOString();

  return {
    kiteUserId: kiteUserId.trim(),
    authenticatedAt,
  };
}

/**
 * Store a one-time opaque completion code (no token material).
 * Returns the plaintext code; only its hash and binding fields are stored.
 */
export async function createKiteCompletionCode(
  data: KiteCompletionCodeData,
): Promise<string> {
  const quantorusUserId = data.quantorusUserId.trim();
  const kiteUserId = data.kiteUserId.trim();
  const authenticatedAt = data.authenticatedAt.trim() || new Date().toISOString();

  if (!quantorusUserId || !kiteUserId) {
    throw new Error('createKiteCompletionCode requires quantorusUserId and kiteUserId');
  }

  const redis = getRedisClient();
  if (!redis) {
    throw new Error('Kite completion store unavailable');
  }

  for (let attempt = 0; attempt < CREATE_MAX_ATTEMPTS; attempt += 1) {
    const code = randomBytes(CODE_BYTES).toString('hex');
    const key = completionRedisKey(hashCode(code));

    try {
      const result = await redis.eval(
        CREATE_COMPLETION_LUA,
        1,
        key,
        quantorusUserId,
        kiteUserId,
        authenticatedAt,
        String(COMPLETION_TTL_SECONDS),
      );
      if (isRedisSuccess(result)) {
        return code;
      }
    } catch {
      throw new Error('Kite completion store unavailable');
    }
  }

  throw new Error('Kite completion store unavailable');
}

/**
 * Validate and consume a completion code for the given Quantorus user.
 * Rejects cross-user redemption and duplicate consumption.
 */
export async function consumeKiteCompletionCode(
  code: string,
  quantorusUserId: string,
): Promise<KiteCompletionConsumption | null> {
  const expectedUserId = quantorusUserId.trim();
  const normalizedCode = code?.trim();
  if (!expectedUserId || !normalizedCode) return null;

  const redis = getRedisClient();
  if (!redis) return null;

  const key = completionRedisKey(hashCode(normalizedCode));

  try {
    const result = await redis.eval(
      CONSUME_COMPLETION_LUA,
      1,
      key,
      expectedUserId,
    );

    if (result === 'MISMATCH' || result === null || result === undefined) {
      return null;
    }

    if (typeof result !== 'string') {
      return null;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(result);
    } catch {
      return null;
    }

    return parseConsumptionPayload(parsed);
  } catch {
    return null;
  }
}
