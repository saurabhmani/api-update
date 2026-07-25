import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const mockList = vi.fn();
const mockSetPrimary = vi.fn();
const mockMarkStatus = vi.fn();
const mockMarkRemaining = vi.fn();
const mockMergeMeta = vi.fn();
const mockUpsert = vi.fn();
const mockMigrate = vi.fn();
const mockKiteSession = vi.fn();

vi.mock('@/lib/broker/connections/repository', () => ({
  listBrokerConnectionsForUser: (...args: unknown[]) => mockList(...args),
  setPrimaryDataSourceBroker: (...args: unknown[]) => mockSetPrimary(...args),
  markBrokerConnectionStatus: (...args: unknown[]) => mockMarkStatus(...args),
  markRemainingConnectionsNeedSelection: (...args: unknown[]) => mockMarkRemaining(...args),
  mergeBrokerConnectionMetadata: (...args: unknown[]) => mockMergeMeta(...args),
  upsertBrokerConnectionRecord: (...args: unknown[]) => mockUpsert(...args),
}));

vi.mock('@/lib/broker/connections/migrate', () => ({
  migrateLegacyBrokerDataForUser: (...args: unknown[]) => mockMigrate(...args),
}));

vi.mock('@/lib/kite/active-session-store', () => ({
  getActiveKiteSession: (...args: unknown[]) => mockKiteSession(...args),
}));

vi.mock('@/lib/marketData/brokerProvider', () => ({
  getBrokerMarketDataProvider: (broker: string) => ({ name: broker }),
}));

function conn(partial: Record<string, unknown>) {
  return {
    id: 'bc_1',
    userId: 7,
    broker: 'zerodha',
    brokerAccountId: 'AB123',
    brokerUserName: 'T',
    accessTokenEncrypted: 'enc',
    refreshTokenEncrypted: null,
    tokenExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    lastAuthenticatedAt: new Date().toISOString(),
    lastUsedAt: null,
    status: 'active',
    isPrimary: false,
    metadata: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...partial,
  };
}

describe('getUserActiveDataSource', () => {
  beforeEach(() => {
    vi.resetModules();
    mockList.mockReset();
    mockSetPrimary.mockReset();
    mockMarkStatus.mockReset();
    mockMarkRemaining.mockReset();
    mockMergeMeta.mockReset();
    mockUpsert.mockReset();
    mockMigrate.mockResolvedValue(undefined);
    mockKiteSession.mockResolvedValue(null);
  });

  it('uses sole connected broker and auto-promotes primary', async () => {
    const sole = conn({ broker: 'shoonya', isPrimary: false, id: 'bc_s' });
    mockList.mockResolvedValue([sole]);
    mockSetPrimary.mockResolvedValue({ ...sole, isPrimary: true });

    const { getUserActiveDataSource } = await import(
      '@/lib/broker/connections/activeDataSource'
    );
    const active = await getUserActiveDataSource(7);
    expect(active.provider).toBe('shoonya');
    expect(active.reason).toBe('sole_connection');
    expect(active.needsSelection).toBe(false);
    expect(mockSetPrimary).toHaveBeenCalledWith(7, 'shoonya');
  });

  it('uses explicit primary when both connected', async () => {
    mockList.mockResolvedValue([
      conn({ broker: 'zerodha', isPrimary: true, id: 'bc_z' }),
      conn({ broker: 'shoonya', isPrimary: false, id: 'bc_s' }),
    ]);

    const { getUserActiveDataSource } = await import(
      '@/lib/broker/connections/activeDataSource'
    );
    const active = await getUserActiveDataSource(7);
    expect(active.provider).toBe('zerodha');
    expect(active.reason).toBe('primary');
    expect(active.connectedProviders.sort()).toEqual(['shoonya', 'zerodha']);
  });

  it('requires selection when both connected and none primary', async () => {
    mockList.mockResolvedValue([
      conn({ broker: 'zerodha', isPrimary: false, id: 'bc_z' }),
      conn({ broker: 'shoonya', isPrimary: false, id: 'bc_s' }),
    ]);

    const { getUserActiveDataSource } = await import(
      '@/lib/broker/connections/activeDataSource'
    );
    const active = await getUserActiveDataSource(7);
    expect(active.provider).toBeNull();
    expect(active.needsSelection).toBe(true);
    expect(active.reason).toBe('needs_selection');
    expect(mockSetPrimary).not.toHaveBeenCalled();
  });

  it('requires selection when remaining broker is pending after disconnect', async () => {
    mockList.mockResolvedValue([
      conn({
        broker: 'shoonya',
        isPrimary: false,
        id: 'bc_s',
        metadata: { pendingActiveSelection: true },
      }),
    ]);

    const { getUserActiveDataSource } = await import(
      '@/lib/broker/connections/activeDataSource'
    );
    const active = await getUserActiveDataSource(7);
    expect(active.provider).toBeNull();
    expect(active.needsSelection).toBe(true);
    expect(mockSetPrimary).not.toHaveBeenCalled();
  });

  it('setUserActiveDataSource persists preference', async () => {
    const shoonya = conn({ broker: 'shoonya', isPrimary: false, id: 'bc_s' });
    mockList
      .mockResolvedValueOnce([
        conn({ broker: 'zerodha', isPrimary: true, id: 'bc_z' }),
        shoonya,
      ])
      .mockResolvedValue([
        conn({ broker: 'zerodha', isPrimary: false, id: 'bc_z' }),
        { ...shoonya, isPrimary: true },
      ]);
    mockSetPrimary.mockResolvedValue({ ...shoonya, isPrimary: true });

    const { setUserActiveDataSource } = await import(
      '@/lib/broker/connections/activeDataSource'
    );
    const active = await setUserActiveDataSource(7, 'shoonya');
    expect(mockSetPrimary).toHaveBeenCalledWith(7, 'shoonya');
    expect(active.provider).toBe('shoonya');
  });

  it('disconnect of active source flags remaining for selection (no silent switch)', async () => {
    mockList
      .mockResolvedValueOnce([
        conn({ broker: 'zerodha', isPrimary: true, id: 'bc_z' }),
        conn({ broker: 'shoonya', isPrimary: false, id: 'bc_s' }),
      ])
      .mockResolvedValue([
        conn({
          broker: 'shoonya',
          isPrimary: false,
          id: 'bc_s',
          metadata: { pendingActiveSelection: true },
        }),
      ]);
    mockMarkRemaining.mockResolvedValue(1);

    const { disconnectDataSourceBroker } = await import(
      '@/lib/broker/connections/activeDataSource'
    );
    const result = await disconnectDataSourceBroker(7, 'zerodha');
    expect(mockMarkStatus).toHaveBeenCalledWith(7, 'zerodha', 'disconnected', true);
    expect(mockMarkRemaining).toHaveBeenCalledWith(7);
    expect(result.needsSelection).toBe(true);
    expect(result.redirectTo).toContain('/data-source');
    expect(result.redirectTo).toContain('select_data_source');
  });
});

describe('resolvePrimaryFlagOnConnect', () => {
  beforeEach(() => {
    vi.resetModules();
    mockList.mockReset();
    mockMigrate.mockResolvedValue(undefined);
    mockKiteSession.mockResolvedValue(null);
  });

  it('marks first broker as primary', async () => {
    mockList.mockResolvedValue([]);
    const { resolvePrimaryFlagOnConnect } = await import(
      '@/lib/broker/connections/activeDataSource'
    );
    await expect(resolvePrimaryFlagOnConnect(7, 'zerodha')).resolves.toBe(true);
  });

  it('keeps existing primary when connecting another broker', async () => {
    mockList.mockResolvedValue([
      conn({ broker: 'zerodha', isPrimary: true, id: 'bc_z' }),
    ]);
    const { resolvePrimaryFlagOnConnect } = await import(
      '@/lib/broker/connections/activeDataSource'
    );
    await expect(resolvePrimaryFlagOnConnect(7, 'shoonya')).resolves.toBe(false);
  });

  it('preserves primary when reconnecting the active broker', async () => {
    mockList.mockResolvedValue([
      conn({ broker: 'shoonya', isPrimary: true, id: 'bc_s' }),
      conn({ broker: 'zerodha', isPrimary: false, id: 'bc_z' }),
    ]);
    const { resolvePrimaryFlagOnConnect } = await import(
      '@/lib/broker/connections/activeDataSource'
    );
    await expect(resolvePrimaryFlagOnConnect(7, 'shoonya')).resolves.toBe(true);
  });

  it('does not auto-steal when others exist without primary', async () => {
    mockList.mockResolvedValue([
      conn({ broker: 'zerodha', isPrimary: false, id: 'bc_z' }),
    ]);
    const { resolvePrimaryFlagOnConnect } = await import(
      '@/lib/broker/connections/activeDataSource'
    );
    await expect(resolvePrimaryFlagOnConnect(7, 'shoonya')).resolves.toBe(false);
  });
});

describe('system provider flags', () => {
  it('exposes getSystemMarketDataProvider separate from user resolution', async () => {
    process.env.MARKET_DATA_PROVIDER = 'yahoo';
    const { getSystemMarketDataProvider, getMarketDataProvider } = await import(
      '@/lib/marketData/providerFlags'
    );
    expect(getSystemMarketDataProvider()).toBe('yahoo');
    expect(getMarketDataProvider()).toBe('yahoo');
  });
});
