import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

describe('Shoonya OAuth helpers', () => {
  beforeEach(() => {
    process.env.SHOONYA_CLIENT_ID = 'client-abc';
    process.env.SHOONYA_SECRET_CODE = 'secret-xyz';
    process.env.SESSION_SECRET = 'x'.repeat(32);
    process.env.BROKER_TOKEN_ENCRYPTION_KEY = 'a'.repeat(64);
    vi.stubEnv('NODE_ENV', 'test');
    delete process.env.SHOONYA_UID;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('checksum is SHA256(CLIENT_ID + SECRET_CODE + AUTH_CODE) with no separators', async () => {
    const { generateShoonyaChecksum } = await import('@/lib/broker/oauth/shoonya');
    const code = 'auth-code-1';
    const expected = createHash('sha256')
      .update('client-abc' + 'secret-xyz' + code)
      .digest('hex');
    expect(generateShoonyaChecksum('client-abc', 'secret-xyz', code)).toBe(expected);
  });

  it('builds the correct authorize URL from configurable base', async () => {
    const { buildShoonyaAuthorizeUrl } = await import('@/lib/broker/oauth/shoonya');
    expect(buildShoonyaAuthorizeUrl('client-abc')).toBe(
      'https://trade.shoonya.com/OAuthlogin/authorize/oauth?client_id=client-abc',
    );
    expect(
      buildShoonyaAuthorizeUrl('client-abc', 'https://example.test/oauth'),
    ).toBe('https://example.test/oauth?client_id=client-abc');
  });

  it('token exchange posts a single form-urlencoded jData field', async () => {
    process.env.SHOONYA_UID = 'FV1234';
    const { exchangeShoonyaAuthorizationCode, generateShoonyaChecksum, getShoonyaConfig } =
      await import('@/lib/broker/oauth/shoonya');

    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = String(init?.body ?? '');
      const params = new URLSearchParams(body);
      expect([...params.keys()]).toEqual(['jData']);
      const jData = JSON.parse(params.get('jData') ?? '{}') as Record<string, string>;
      expect(jData.code).toBe('AUTHCODE');
      expect(jData.uid).toBe('FV1234');
      expect(jData.checksum).toBe(
        generateShoonyaChecksum('client-abc', 'secret-xyz', 'AUTHCODE'),
      );

      return new Response(
        JSON.stringify({
          access_token: 'shoonya-access-token',
          actid: 'ACT001',
          uname: 'Trader',
          expires_in: 86400,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    });

    const result = await exchangeShoonyaAuthorizationCode(
      'AUTHCODE',
      getShoonyaConfig(),
      fetchMock as unknown as typeof fetch,
    );

    expect(result.accessToken).toBe('shoonya-access-token');
    expect(result.accountId).toBe('ACT001');
    expect(result.expiresAt).toBeTruthy();
    const expiresMs = new Date(result.expiresAt!).getTime();
    expect(expiresMs).toBeGreaterThan(Date.now() + 60_000);
  });

  it('parses expires_in as unix seconds when value looks like an epoch', async () => {
    const { exchangeShoonyaAuthorizationCode, getShoonyaConfig } =
      await import('@/lib/broker/oauth/shoonya');
    const epochSec = 1893456000; // 2030-01-01-ish
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({ access_token: 'tok', expires_in: String(epochSec) }),
        { status: 200 },
      ),
    );
    const result = await exchangeShoonyaAuthorizationCode(
      'AUTHCODE',
      getShoonyaConfig(),
      fetchMock as unknown as typeof fetch,
    );
    expect(new Date(result.expiresAt!).getTime()).toBe(epochSec * 1000);
  });
});

describe('broker token expiry parsing', () => {
  it('handles duration seconds and unix timestamps without blind addition', async () => {
    const { parseBrokerTokenExpiry } = await import('@/lib/broker/connections/expiry');
    const now = Date.UTC(2026, 0, 1, 0, 0, 0);

    const duration = parseBrokerTokenExpiry(3600, now)!;
    expect(duration.getTime()).toBe(now + 3600_000);

    const epochSec = parseBrokerTokenExpiry('1893456000', now)!;
    expect(epochSec.getTime()).toBe(1893456000 * 1000);

    const epochMs = parseBrokerTokenExpiry(1893456000000, now)!;
    expect(epochMs.getTime()).toBe(1893456000000);

    const iso = parseBrokerTokenExpiry('2030-01-01T00:00:00.000Z', now)!;
    expect(iso.toISOString()).toBe('2030-01-01T00:00:00.000Z');
  });
});

describe('broker credential encryption', () => {
  beforeEach(async () => {
    process.env.BROKER_TOKEN_ENCRYPTION_KEY = 'b'.repeat(64);
    process.env.SESSION_SECRET = 'y'.repeat(32);
    vi.stubEnv('NODE_ENV', 'test');
    const { resetBrokerEncryptionCacheForTests } = await import(
      '@/lib/broker/connections/encryption'
    );
    resetBrokerEncryptionCacheForTests();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('encrypts with versioned AES-GCM and detects tampering', async () => {
    const {
      encryptBrokerCredential,
      decryptBrokerCredential,
    } = await import('@/lib/broker/connections/encryption');

    const encrypted = encryptBrokerCredential('super-secret-token');
    expect(encrypted.startsWith('brk1:')).toBe(true);
    expect(encrypted).not.toContain('super-secret-token');
    expect(decryptBrokerCredential(encrypted)).toBe('super-secret-token');

    const tampered = `${encrypted.slice(0, -4)}xxxx`;
    expect(() => decryptBrokerCredential(tampered)).toThrow(/decryption failed/i);
  });

  it('requires BROKER_TOKEN_ENCRYPTION_KEY in production', async () => {
    delete process.env.BROKER_TOKEN_ENCRYPTION_KEY;
    delete process.env.BROKER_TOKEN_ALLOW_LEGACY_KEY;
    vi.stubEnv('NODE_ENV', 'production');
    const { resetBrokerEncryptionCacheForTests, validateBrokerTokenEncryptionKey } =
      await import('@/lib/broker/connections/encryption');
    resetBrokerEncryptionCacheForTests();
    const result = validateBrokerTokenEncryptionKey();
    expect(result.ok).toBe(false);
  });

  it('rejects non-HTTPS Shoonya authorize/token URLs', async () => {
    process.env.SHOONYA_CLIENT_ID = 'cid';
    process.env.SHOONYA_SECRET_CODE = 'sec';
    process.env.SHOONYA_AUTHORIZE_URL = 'http://evil.example/oauth';
    const { getShoonyaConfig } = await import('@/lib/broker/oauth/shoonya');
    expect(() => getShoonyaConfig()).toThrow(/https/i);
  });

  it('validateEnv fails closed in production for broker secrets and APP_BASE_URL', async () => {
    vi.resetModules();
    const { validateEnv } = await import('@/lib/validateEnv');

    const prevKey = process.env.BROKER_TOKEN_ENCRYPTION_KEY;
    const prevBase = process.env.APP_BASE_URL;
    const prevApp = process.env.APP_URL;
    const prevPublic = process.env.NEXT_PUBLIC_APP_URL;
    const prevSession = process.env.SESSION_SECRET;
    const prevShoonyaEn = process.env.SHOONYA_ENABLED;
    const prevCid = process.env.SHOONYA_CLIENT_ID;
    const prevSec = process.env.SHOONYA_SECRET_CODE;
    const prevLegacy = process.env.BROKER_TOKEN_ALLOW_LEGACY_KEY;

    vi.stubEnv('NODE_ENV', 'production');

    try {
      process.env.SESSION_SECRET = 's'.repeat(32);
      delete process.env.BROKER_TOKEN_ALLOW_LEGACY_KEY;

      delete process.env.BROKER_TOKEN_ENCRYPTION_KEY;
      process.env.APP_BASE_URL = 'https://example.com';
      delete process.env.SHOONYA_ENABLED;
      delete process.env.SHOONYA_CLIENT_ID;
      delete process.env.SHOONYA_SECRET_CODE;
      expect(validateEnv().errors.some((e) => e.includes('BROKER_TOKEN_ENCRYPTION_KEY'))).toBe(true);

      process.env.BROKER_TOKEN_ENCRYPTION_KEY = 'not-hex';
      expect(validateEnv().errors.some((e) => e.includes('64 hex'))).toBe(true);

      process.env.BROKER_TOKEN_ENCRYPTION_KEY = 'a'.repeat(64);
      delete process.env.APP_BASE_URL;
      delete process.env.APP_URL;
      delete process.env.NEXT_PUBLIC_APP_URL;
      expect(validateEnv().errors.some((e) => e.includes('APP_BASE_URL'))).toBe(true);

      process.env.APP_BASE_URL = 'http://insecure.example.com';
      expect(validateEnv().errors.some((e) => e.includes('https://'))).toBe(true);

      process.env.APP_BASE_URL = 'https://example.com';
      process.env.SHOONYA_ENABLED = '1';
      delete process.env.SHOONYA_CLIENT_ID;
      delete process.env.SHOONYA_SECRET_CODE;
      const shoonyaErrors = validateEnv().errors.filter((e) => e.includes('SHOONYA'));
      expect(shoonyaErrors.length).toBeGreaterThanOrEqual(2);
    } finally {
      vi.unstubAllEnvs();
      if (prevKey === undefined) delete process.env.BROKER_TOKEN_ENCRYPTION_KEY;
      else process.env.BROKER_TOKEN_ENCRYPTION_KEY = prevKey;
      if (prevBase === undefined) delete process.env.APP_BASE_URL;
      else process.env.APP_BASE_URL = prevBase;
      if (prevApp === undefined) delete process.env.APP_URL;
      else process.env.APP_URL = prevApp;
      if (prevPublic === undefined) delete process.env.NEXT_PUBLIC_APP_URL;
      else process.env.NEXT_PUBLIC_APP_URL = prevPublic;
      if (prevSession === undefined) delete process.env.SESSION_SECRET;
      else process.env.SESSION_SECRET = prevSession;
      if (prevShoonyaEn === undefined) delete process.env.SHOONYA_ENABLED;
      else process.env.SHOONYA_ENABLED = prevShoonyaEn;
      if (prevCid === undefined) delete process.env.SHOONYA_CLIENT_ID;
      else process.env.SHOONYA_CLIENT_ID = prevCid;
      if (prevSec === undefined) delete process.env.SHOONYA_SECRET_CODE;
      else process.env.SHOONYA_SECRET_CODE = prevSec;
      if (prevLegacy === undefined) delete process.env.BROKER_TOKEN_ALLOW_LEGACY_KEY;
      else process.env.BROKER_TOKEN_ALLOW_LEGACY_KEY = prevLegacy;
    }
  });
});

describe('post-login destination helpers', () => {
  afterEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('routes to /data-source when no active broker', async () => {
    vi.doMock('@/lib/broker/connections/migrate', () => ({
      migrateLegacyBrokerDataForUser: vi.fn(async () => 0),
    }));
    vi.doMock('@/lib/broker/connections/repository', () => ({
      getPrimaryActiveBrokerConnection: vi.fn(async () => null),
      listBrokerConnectionsForUser: vi.fn(async () => []),
      markBrokerConnectionStatus: vi.fn(),
      upsertBrokerConnectionRecord: vi.fn(),
    }));
    vi.doMock('@/lib/kite/active-session-store', () => ({
      getActiveKiteSession: vi.fn(async () => null),
    }));

    const { resolvePostLoginDestination } = await import('@/lib/broker/connections/status');
    await expect(resolvePostLoginDestination(7)).resolves.toEqual({ path: '/data-source' });
  });

  it('routes to /dashboard when an active broker exists', async () => {
    vi.doMock('@/lib/broker/connections/migrate', () => ({
      migrateLegacyBrokerDataForUser: vi.fn(async () => 0),
    }));
    vi.doMock('@/lib/broker/connections/repository', () => ({
      getPrimaryActiveBrokerConnection: vi.fn(async () => ({
        id: 'bc_1',
        userId: 7,
        broker: 'zerodha',
        brokerAccountId: 'AB1234',
        brokerUserName: 'Nik',
        accessTokenEncrypted: 'brk1:x',
        refreshTokenEncrypted: null,
        tokenExpiresAt: new Date(Date.now() + 60_000).toISOString(),
        lastAuthenticatedAt: new Date().toISOString(),
        lastUsedAt: null,
        status: 'active',
        isPrimary: true,
        metadata: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })),
      listBrokerConnectionsForUser: vi.fn(async () => []),
      markBrokerConnectionStatus: vi.fn(),
      upsertBrokerConnectionRecord: vi.fn(),
    }));
    vi.doMock('@/lib/kite/active-session-store', () => ({
      getActiveKiteSession: vi.fn(async () => null),
    }));

    const { resolvePostLoginDestination } = await import('@/lib/broker/connections/status');
    await expect(resolvePostLoginDestination(7)).resolves.toEqual({ path: '/dashboard' });
  });

  it('does not throw into a redirect loop when storage fails', async () => {
    vi.doMock('@/lib/broker/connections/migrate', () => ({
      migrateLegacyBrokerDataForUser: vi.fn(async () => 0),
    }));
    vi.doMock('@/lib/broker/connections/repository', () => ({
      getPrimaryActiveBrokerConnection: vi.fn(async () => {
        throw new Error('db down');
      }),
      listBrokerConnectionsForUser: vi.fn(async () => {
        throw new Error('db down');
      }),
      markBrokerConnectionStatus: vi.fn(),
      upsertBrokerConnectionRecord: vi.fn(),
    }));
    vi.doMock('@/lib/kite/active-session-store', () => ({
      getActiveKiteSession: vi.fn(async () => null),
    }));

    const { resolvePostLoginDestination } = await import('@/lib/broker/connections/status');
    await expect(resolvePostLoginDestination(7)).resolves.toEqual({ path: '/data-source' });
  });
});
