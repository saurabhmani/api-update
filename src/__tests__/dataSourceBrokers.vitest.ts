/**
 * dataSourceBrokers — narrowed after Shoonya OAuth module removal.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { validateEnv } from '@/lib/validateEnv';

describe('validateEnv without broker secrets', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.unstubAllEnvs();
  });

  it('does not require KITE_* or SHOONYA_*', () => {
    process.env.MYSQL_HOST = 'localhost';
    process.env.MYSQL_DATABASE = 'test';
    process.env.MYSQL_USER = 'u';
    process.env.SESSION_SECRET = 's'.repeat(32);
    // NODE_ENV left as-is (read-only in some runtimes)
    delete process.env.KITE_API_KEY;
    delete process.env.SHOONYA_CLIENT_ID;
    process.env.INDIANAPI_ENABLED = 'true';
    process.env.INDIANAPI_API_KEY = 'test';
    process.env.MARKET_DATA_PROVIDER = 'indianapi';
    const result = validateEnv();
    expect(result.errors.filter((e) => /KITE_|SHOONYA_/.test(e))).toEqual([]);
  });
});

describe('post-login destination helpers', () => {
  it('routes to /dashboard when no active broker (IndianAPI warehouse)', async () => {
    vi.mock('@/lib/broker/connections/activeDataSource', () => ({
      getUserActiveDataSource: vi.fn(async () => ({
        userId: 7,
        provider: null,
        connection: null,
        connectionId: null,
        isConnected: false,
        isActiveDataSource: false,
        needsSelection: false,
        reason: 'none',
        connectedProviders: [],
        updatedAt: null,
      })),
    }));
    const { resolvePostLoginDestination } = await import('@/lib/broker/connections/status');
    await expect(resolvePostLoginDestination(7)).resolves.toEqual({ path: '/dashboard' });
  });
});
