import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const AUTH_STATE_KEY_PREFIX = 'kite:auth-state:';
const COMPLETION_KEY_PREFIX = 'kite:completion:';
const AUTH_STATE_TTL_SECONDS = 10 * 60;
const COMPLETION_TTL_SECONDS = 60;

function normalizeScript(script: string): string {
  return script.replace(/\s+/g, ' ').trim();
}

const CONSUME_AUTH_STATE_LUA = normalizeScript(`
local current = redis.call('GET', KEYS[1])
if not current then
  return 0
end
if current ~= ARGV[1] then
  return 0
end
redis.call('DEL', KEYS[1])
return 1
`);

const CREATE_COMPLETION_LUA = normalizeScript(`
if redis.call('EXISTS', KEYS[1]) == 1 then
  return 0
end
redis.call('HSET', KEYS[1],
  'quantorusUserId', ARGV[1],
  'kiteUserId', ARGV[2],
  'accessToken', ARGV[3]
)
redis.call('EXPIRE', KEYS[1], tonumber(ARGV[4]))
return 1
`);

const CONSUME_COMPLETION_LUA = normalizeScript(`
local quantorusUserId = redis.call('HGET', KEYS[1], 'quantorusUserId')
if not quantorusUserId then
  return nil
end
if quantorusUserId ~= ARGV[1] then
  return 'MISMATCH'
end
local kiteUserId = redis.call('HGET', KEYS[1], 'kiteUserId')
local accessToken = redis.call('HGET', KEYS[1], 'accessToken')
if not kiteUserId or not accessToken then
  return nil
end
redis.call('DEL', KEYS[1])
return cjson.encode({ kiteUserId = kiteUserId, accessToken = accessToken })
`);

type StringEntry = { value: string; expiresAt: number | null };
type HashEntry = { fields: Map<string, string>; expiresAt: number | null };

const { fakeRedis, redisClientRef, randomBytesMock, realRandomBytes } = vi.hoisted(() => {
  const crypto = require('node:crypto') as typeof import('node:crypto');

  class FakeHandoffRedis {
    private strings = new Map<string, StringEntry>();
    private hashes = new Map<string, HashEntry>();
    private now = Date.now();
    failNextWrite = false;

    setNow(value: number): void {
      this.now = value;
    }

    getNow(): number {
      return this.now;
    }

    clear(): void {
      this.strings.clear();
      this.hashes.clear();
      this.now = Date.now();
      this.failNextWrite = false;
    }

    private purgeExpired(): void {
      for (const [key, entry] of this.strings) {
        if (entry.expiresAt !== null && entry.expiresAt <= this.now) {
          this.strings.delete(key);
        }
      }
      for (const [key, entry] of this.hashes) {
        if (entry.expiresAt !== null && entry.expiresAt <= this.now) {
          this.hashes.delete(key);
        }
      }
    }

    inspectString(key: string): StringEntry | null {
      this.purgeExpired();
      const entry = this.strings.get(key);
      if (!entry) return null;
      return {
        value: entry.value,
        expiresAt: entry.expiresAt,
      };
    }

    inspectHash(key: string): { fields: Record<string, string>; expiresAt: number | null } | null {
      this.purgeExpired();
      const entry = this.hashes.get(key);
      if (!entry) return null;
      return {
        fields: Object.fromEntries(entry.fields.entries()),
        expiresAt: entry.expiresAt,
      };
    }

    ttlSeconds(key: string): number | null {
      this.purgeExpired();
      const entry = this.strings.get(key) ?? this.hashes.get(key);
      if (!entry || entry.expiresAt === null) return null;
      return Math.round((entry.expiresAt - this.now) / 1000);
    }

    seedAuthState(key: string, value: string, ttlSeconds: number): void {
      this.strings.set(key, {
        value,
        expiresAt: this.now + ttlSeconds * 1000,
      });
    }

    seedCompletion(
      key: string,
      fields: Record<string, string>,
      ttlSeconds: number,
    ): void {
      this.hashes.set(key, {
        fields: new Map(Object.entries(fields)),
        expiresAt: this.now + ttlSeconds * 1000,
      });
    }

    async set(
      key: string,
      value: string,
      expiryMode?: 'EX',
      ttlSeconds?: number,
      setMode?: 'NX',
    ): Promise<'OK' | null> {
      this.purgeExpired();
      if (this.failNextWrite) {
        this.failNextWrite = false;
        throw new Error('redis write failed');
      }
      if (setMode === 'NX' && this.strings.has(key)) {
        return null;
      }
      this.strings.set(key, {
        value,
        expiresAt: expiryMode === 'EX' && typeof ttlSeconds === 'number'
          ? this.now + ttlSeconds * 1000
          : null,
      });
      return 'OK';
    }

    async eval(script: string, numKeys: number, ...args: string[]): Promise<unknown> {
      this.purgeExpired();
      const keys = args.slice(0, numKeys);
      const argv = args.slice(numKeys);
      const normalized = normalizeScript(script);

      if (normalized === CONSUME_AUTH_STATE_LUA) {
        const key = keys[0];
        const entry = this.strings.get(key);
        if (!entry) return 0;
        if (entry.value !== argv[0]) return 0;
        this.strings.delete(key);
        return 1;
      }

      if (normalized === CREATE_COMPLETION_LUA) {
        if (this.failNextWrite) {
          this.failNextWrite = false;
          throw new Error('redis write failed');
        }

        const key = keys[0];
        if (this.hashes.has(key) || this.strings.has(key)) {
          return 0;
        }

        const ttlSeconds = Number(argv[3]);
        this.hashes.set(key, {
          fields: new Map([
            ['quantorusUserId', argv[0]],
            ['kiteUserId', argv[1]],
            ['accessToken', argv[2]],
          ]),
          expiresAt: Number.isFinite(ttlSeconds)
            ? this.now + ttlSeconds * 1000
            : null,
        });
        return 1;
      }

      if (normalized === CONSUME_COMPLETION_LUA) {
        const key = keys[0];
        const entry = this.hashes.get(key);
        if (!entry) return null;
        const quantorusUserId = entry.fields.get('quantorusUserId');
        if (!quantorusUserId) return null;
        if (quantorusUserId !== argv[0]) return 'MISMATCH';
        const kiteUserId = entry.fields.get('kiteUserId');
        const accessToken = entry.fields.get('accessToken');
        if (!kiteUserId || !accessToken) return null;
        this.hashes.delete(key);
        return JSON.stringify({ kiteUserId, accessToken });
      }

      throw new Error('Unsupported script in FakeHandoffRedis');
    }
  }

  const instance = new FakeHandoffRedis();
  return {
    fakeRedis: instance,
    redisClientRef: { current: instance as typeof instance | null },
    randomBytesMock: vi.fn((size: number) => crypto.randomBytes(size)),
    realRandomBytes: crypto.randomBytes.bind(crypto) as typeof crypto.randomBytes,
  };
});

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return {
    ...actual,
    randomBytes: ((size: number, callback?: (err: Error | null, buf: Buffer) => void) => {
      if (typeof callback === 'function') {
        return actual.randomBytes(size, callback);
      }
      return randomBytesMock(size);
    }) as typeof actual.randomBytes,
  };
});

vi.mock('@/lib/redis', () => ({
  getRedisClient: () => redisClientRef.current,
}));

function hashState(state: string): string {
  return createHash('sha256').update(state, 'utf8').digest('hex');
}

function hashCode(code: string): string {
  return createHash('sha256').update(code, 'utf8').digest('hex');
}

function authKeyForPlaintext(state: string): string {
  return `${AUTH_STATE_KEY_PREFIX}${hashState(state)}`;
}

function completionKeyForPlaintext(code: string): string {
  return `${COMPLETION_KEY_PREFIX}${hashCode(code)}`;
}

function bytesFromHex(hex: string): Buffer {
  return Buffer.from(hex, 'hex');
}

function mockRandomBytesSequence(...hexValues: string[]): void {
  let index = 0;
  randomBytesMock.mockImplementation(((size: number) => {
    if (index < hexValues.length) {
      const next = bytesFromHex(hexValues[index]!);
      index += 1;
      return next;
    }
    return realRandomBytes(size);
  }) as never);
}

function mockRandomBytesAlways(hexValue: string): void {
  randomBytesMock.mockImplementation(((() => bytesFromHex(hexValue)) as never));
}

function mockRandomBytesSharedThenAlternates(
  sharedHex: string,
  ...alternates: string[]
): void {
  let sharedRemaining = 2;
  let alternateIndex = 0;
  randomBytesMock.mockImplementation(((size: number) => {
    if (sharedRemaining > 0) {
      sharedRemaining -= 1;
      return bytesFromHex(sharedHex);
    }
    if (alternateIndex < alternates.length) {
      const next = bytesFromHex(alternates[alternateIndex]!);
      alternateIndex += 1;
      return next;
    }
    return realRandomBytes(size);
  }) as never);
}

function asError(value: unknown): Error {
  if (value instanceof Error) return value;
  throw new Error('expected Error');
}

describe('Kite Redis handoff stores', () => {
  beforeEach(() => {
    fakeRedis.clear();
    redisClientRef.current = fakeRedis;
    randomBytesMock.mockReset();
    randomBytesMock.mockImplementation((size: number) => realRandomBytes(size));
    vi.resetModules();
  });

  afterEach(() => {
    fakeRedis.clear();
    redisClientRef.current = fakeRedis;
    randomBytesMock.mockReset();
    randomBytesMock.mockImplementation((size: number) => realRandomBytes(size));
  });

  it('consumes auth state successfully once', async () => {
    const { createKiteAuthState, consumeKiteAuthState } = await import('@/lib/kite/auth-state');

    const state = await createKiteAuthState('42');
    await expect(consumeKiteAuthState(state, '42')).resolves.toBe(true);
    await expect(consumeKiteAuthState(state, '42')).resolves.toBe(false);
  });

  it('rejects replayed completion codes', async () => {
    const { createKiteCompletionCode, consumeKiteCompletionCode } = await import('@/lib/kite/completion-store');

    const code = await createKiteCompletionCode({
      quantorusUserId: '7',
      kiteUserId: 'KITE123',
      accessToken: 'token-value',
    });

    await expect(consumeKiteCompletionCode(code, '7')).resolves.toEqual({
      kiteUserId: 'KITE123',
      accessToken: 'token-value',
    });
    await expect(consumeKiteCompletionCode(code, '7')).resolves.toBeNull();
  });

  it('expires auth state via Redis TTL', async () => {
    const { createKiteAuthState, consumeKiteAuthState } = await import('@/lib/kite/auth-state');

    const state = await createKiteAuthState('99');
    fakeRedis.setNow(Date.now() + 11 * 60 * 1000);

    await expect(consumeKiteAuthState(state, '99')).resolves.toBe(false);
  });

  it('expires completion codes via Redis TTL', async () => {
    const { createKiteCompletionCode, consumeKiteCompletionCode } = await import('@/lib/kite/completion-store');

    const code = await createKiteCompletionCode({
      quantorusUserId: '8',
      kiteUserId: 'KITE-8',
      accessToken: 'token-8',
    });

    fakeRedis.setNow(Date.now() + 61 * 1000);
    await expect(consumeKiteCompletionCode(code, '8')).resolves.toBeNull();
  });

  it('does not consume auth state for a mismatched user', async () => {
    const { createKiteAuthState, consumeKiteAuthState } = await import('@/lib/kite/auth-state');

    const state = await createKiteAuthState('100');
    await expect(consumeKiteAuthState(state, '200')).resolves.toBe(false);
    await expect(consumeKiteAuthState(state, '100')).resolves.toBe(true);
  });

  it('does not consume completion codes for a mismatched user', async () => {
    const { createKiteCompletionCode, consumeKiteCompletionCode } = await import('@/lib/kite/completion-store');

    const code = await createKiteCompletionCode({
      quantorusUserId: '11',
      kiteUserId: 'KITE-A',
      accessToken: 'token-a',
    });

    await expect(consumeKiteCompletionCode(code, '22')).resolves.toBeNull();
    await expect(consumeKiteCompletionCode(code, '11')).resolves.toEqual({
      kiteUserId: 'KITE-A',
      accessToken: 'token-a',
    });
  });

  it('allows exactly one concurrent auth-state consumer', async () => {
    const { createKiteAuthState, consumeKiteAuthState } = await import('@/lib/kite/auth-state');

    const state = await createKiteAuthState('55');
    const results = await Promise.all([
      consumeKiteAuthState(state, '55'),
      consumeKiteAuthState(state, '55'),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
    expect(results.filter((value) => value === false)).toHaveLength(1);
  });

  it('allows exactly one concurrent completion-code consumer', async () => {
    const { createKiteCompletionCode, consumeKiteCompletionCode } = await import('@/lib/kite/completion-store');

    const code = await createKiteCompletionCode({
      quantorusUserId: '3',
      kiteUserId: 'KITE-Z',
      accessToken: 'token-z',
    });

    const results = await Promise.all([
      consumeKiteCompletionCode(code, '3'),
      consumeKiteCompletionCode(code, '3'),
    ]);

    const successes = results.filter((value) => value !== null);
    const failures = results.filter((value) => value === null);

    expect(successes).toHaveLength(1);
    expect(failures).toHaveLength(1);
    expect(successes[0]).toEqual({
      kiteUserId: 'KITE-Z',
      accessToken: 'token-z',
    });
  });

  it('fails closed when Redis is unavailable', async () => {
    redisClientRef.current = null;

    const { createKiteAuthState, consumeKiteAuthState } = await import('@/lib/kite/auth-state');
    const { createKiteCompletionCode, consumeKiteCompletionCode } = await import('@/lib/kite/completion-store');

    await expect(createKiteAuthState('1')).rejects.toThrow('Kite auth state store unavailable');
    await expect(createKiteCompletionCode({
      quantorusUserId: '1',
      kiteUserId: 'K',
      accessToken: 'T',
    })).rejects.toThrow('Kite completion store unavailable');
    await expect(consumeKiteAuthState('state', '1')).resolves.toBe(false);
    await expect(consumeKiteCompletionCode('code', '1')).resolves.toBeNull();
  });

  it('stores only hashed auth-state keys in Redis', async () => {
    const { createKiteAuthState } = await import('@/lib/kite/auth-state');

    const state = await createKiteAuthState('77');
    const digest = hashState(state);

    expect(digest).toHaveLength(64);
    expect(`${AUTH_STATE_KEY_PREFIX}${digest}`).toMatch(/^kite:auth-state:[0-9a-f]{64}$/);
    expect(state).not.toContain(AUTH_STATE_KEY_PREFIX);
  });

  it('stores only hashed completion-code keys in Redis', async () => {
    const { createKiteCompletionCode } = await import('@/lib/kite/completion-store');

    const code = await createKiteCompletionCode({
      quantorusUserId: '5',
      kiteUserId: 'KITE-5',
      accessToken: 'token-5',
    });
    const digest = hashCode(code);

    expect(`${COMPLETION_KEY_PREFIX}${digest}`).toMatch(/^kite:completion:[0-9a-f]{64}$/);
    expect(code).not.toContain(COMPLETION_KEY_PREFIX);
  });

  it('retries auth-state creation on collision and succeeds with a new value', async () => {
    const collidingPlain = 'aa'.repeat(32);
    const successPlain = 'bb'.repeat(32);
    const collidingKey = authKeyForPlaintext(collidingPlain);

    fakeRedis.seedAuthState(collidingKey, 'original-user', 300);
    const before = fakeRedis.inspectString(collidingKey);
    mockRandomBytesSequence(collidingPlain, successPlain);

    const { createKiteAuthState } = await import('@/lib/kite/auth-state');
    const state = await createKiteAuthState('collision-user');

    expect(state).toBe(successPlain);
    expect(fakeRedis.inspectString(collidingKey)).toEqual(before);
    expect(fakeRedis.inspectString(authKeyForPlaintext(successPlain))).toEqual({
      value: 'collision-user',
      expiresAt: fakeRedis.getNow() + AUTH_STATE_TTL_SECONDS * 1000,
    });
  });

  it('leaves a colliding auth-state record unchanged', async () => {
    const collidingPlain = 'cc'.repeat(32);
    const successPlain = 'dd'.repeat(32);
    const collidingKey = authKeyForPlaintext(collidingPlain);

    fakeRedis.seedAuthState(collidingKey, 'keeper', 120);
    const before = fakeRedis.inspectString(collidingKey);
    const beforeTtl = fakeRedis.ttlSeconds(collidingKey);
    mockRandomBytesSequence(collidingPlain, successPlain);

    const { createKiteAuthState } = await import('@/lib/kite/auth-state');
    await createKiteAuthState('intruder');

    expect(fakeRedis.inspectString(collidingKey)).toEqual(before);
    expect(fakeRedis.ttlSeconds(collidingKey)).toBe(beforeTtl);
  });

  it('retries completion-code creation on collision and succeeds with a new value', async () => {
    const collidingPlain = '11'.repeat(32);
    const successPlain = '22'.repeat(32);
    const collidingKey = completionKeyForPlaintext(collidingPlain);

    fakeRedis.seedCompletion(
      collidingKey,
      {
        quantorusUserId: 'original',
        kiteUserId: 'KITE-ORIG',
        accessToken: 'token-orig',
      },
      45,
    );
    const before = fakeRedis.inspectHash(collidingKey);
    mockRandomBytesSequence(collidingPlain, successPlain);

    const { createKiteCompletionCode } = await import('@/lib/kite/completion-store');
    const code = await createKiteCompletionCode({
      quantorusUserId: 'retry-user',
      kiteUserId: 'KITE-RETRY',
      accessToken: 'token-retry',
    });

    expect(code).toBe(successPlain);
    expect(fakeRedis.inspectHash(collidingKey)).toEqual(before);
    expect(fakeRedis.inspectHash(completionKeyForPlaintext(successPlain))).toEqual({
      fields: {
        quantorusUserId: 'retry-user',
        kiteUserId: 'KITE-RETRY',
        accessToken: 'token-retry',
      },
      expiresAt: fakeRedis.getNow() + COMPLETION_TTL_SECONDS * 1000,
    });
  });

  it('leaves a colliding completion record and TTL unchanged', async () => {
    const collidingPlain = '33'.repeat(32);
    const successPlain = '44'.repeat(32);
    const collidingKey = completionKeyForPlaintext(collidingPlain);

    fakeRedis.seedCompletion(
      collidingKey,
      {
        quantorusUserId: 'keeper',
        kiteUserId: 'KITE-KEEP',
        accessToken: 'token-keep',
      },
      37,
    );
    const before = fakeRedis.inspectHash(collidingKey);
    const beforeTtl = fakeRedis.ttlSeconds(collidingKey);
    mockRandomBytesSequence(collidingPlain, successPlain);

    const { createKiteCompletionCode } = await import('@/lib/kite/completion-store');
    await createKiteCompletionCode({
      quantorusUserId: 'intruder',
      kiteUserId: 'KITE-INTRUDE',
      accessToken: 'token-intrude',
    });

    expect(fakeRedis.inspectHash(collidingKey)).toEqual(before);
    expect(fakeRedis.ttlSeconds(collidingKey)).toBe(beforeTtl);
  });

  it('prevents concurrent completion-code creators from overwriting the same key', async () => {
    const sharedPlain = '55'.repeat(32);
    const altPlainA = '66'.repeat(32);
    const altPlainB = '77'.repeat(32);
    const sharedKey = completionKeyForPlaintext(sharedPlain);

    mockRandomBytesSharedThenAlternates(sharedPlain, altPlainA, altPlainB);

    const { createKiteCompletionCode } = await import('@/lib/kite/completion-store');

    const [codeA, codeB] = await Promise.all([
      createKiteCompletionCode({
        quantorusUserId: 'a',
        kiteUserId: 'KITE-A',
        accessToken: 'token-a',
      }),
      createKiteCompletionCode({
        quantorusUserId: 'b',
        kiteUserId: 'KITE-B',
        accessToken: 'token-b',
      }),
    ]);

    expect(new Set([codeA, codeB]).size).toBe(2);

    const shared = fakeRedis.inspectHash(sharedKey);
    expect(shared).not.toBeNull();
    expect(['a', 'b']).toContain(shared!.fields.quantorusUserId);

    const winnerOwner = shared!.fields.quantorusUserId;
    const winnerToken = winnerOwner === 'a' ? 'token-a' : 'token-b';
    expect(shared!.fields.accessToken).toBe(winnerToken);
  });

  it('throws safely when auth-state creation retries are exhausted', async () => {
    const collidingPlain = '88'.repeat(32);
    fakeRedis.seedAuthState(authKeyForPlaintext(collidingPlain), 'holder', AUTH_STATE_TTL_SECONDS);
    mockRandomBytesAlways(collidingPlain);

    const { createKiteAuthState } = await import('@/lib/kite/auth-state');
    const error = asError(await createKiteAuthState('exhausted').catch((err: unknown) => err));

    expect(error.message).toBe('Kite auth state store unavailable');
    expect(error.message).not.toContain(collidingPlain);
    expect(error.message).not.toContain('exhausted');
  });

  it('throws safely when completion-code creation retries are exhausted', async () => {
    const collidingPlain = '99'.repeat(32);
    fakeRedis.seedCompletion(
      completionKeyForPlaintext(collidingPlain),
      {
        quantorusUserId: 'holder',
        kiteUserId: 'KITE-HOLD',
        accessToken: 'token-hold',
      },
      COMPLETION_TTL_SECONDS,
    );
    mockRandomBytesAlways(collidingPlain);

    const { createKiteCompletionCode } = await import('@/lib/kite/completion-store');
    const error = asError(await createKiteCompletionCode({
      quantorusUserId: 'exhausted',
      kiteUserId: 'KITE-X',
      accessToken: 'token-x',
    }).catch((err: unknown) => err));

    expect(error.message).toBe('Kite completion store unavailable');
    expect(error.message).not.toContain(collidingPlain);
    expect(error.message).not.toContain('token-x');
    expect(error.message).not.toContain('exhausted');
  });

  it('throws safely when Redis write fails during creation', async () => {
    fakeRedis.failNextWrite = true;
    const { createKiteAuthState } = await import('@/lib/kite/auth-state');
    await expect(createKiteAuthState('1')).rejects.toThrow('Kite auth state store unavailable');

    fakeRedis.failNextWrite = true;
    const { createKiteCompletionCode } = await import('@/lib/kite/completion-store');
    await expect(createKiteCompletionCode({
      quantorusUserId: '1',
      kiteUserId: 'K',
      accessToken: 'T',
    })).rejects.toThrow('Kite completion store unavailable');
  });

  it('stores successful records with the exact required TTLs', async () => {
    const { createKiteAuthState } = await import('@/lib/kite/auth-state');
    const { createKiteCompletionCode } = await import('@/lib/kite/completion-store');

    const state = await createKiteAuthState('ttl-user');
    const code = await createKiteCompletionCode({
      quantorusUserId: 'ttl-user',
      kiteUserId: 'KITE-TTL',
      accessToken: 'token-ttl',
    });

    expect(fakeRedis.ttlSeconds(authKeyForPlaintext(state))).toBe(AUTH_STATE_TTL_SECONDS);
    expect(fakeRedis.ttlSeconds(completionKeyForPlaintext(code))).toBe(COMPLETION_TTL_SECONDS);
  });
});
