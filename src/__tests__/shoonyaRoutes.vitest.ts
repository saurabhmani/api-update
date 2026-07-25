import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('server-only', () => ({}));

const mockRequireSession = vi.fn();
const mockHandleCallback = vi.fn();
const mockGetAuthorizationUrl = vi.fn();
const mockGetSafeBrokerStatus = vi.fn();
const mockGetBrokerConnection = vi.fn();
const mockMarkStatus = vi.fn();
const mockDisconnectDataSource = vi.fn();

vi.mock('@/lib/session', () => ({
  requireSession: (...args: unknown[]) => mockRequireSession(...args),
}));

vi.mock('@/lib/broker/oauth/shoonyaAdapter', () => ({
  shoonyaBrokerAdapter: {
    name: 'shoonya',
    getAuthorizationUrl: (...args: unknown[]) => mockGetAuthorizationUrl(...args),
    handleCallback: (...args: unknown[]) => mockHandleCallback(...args),
  },
}));

vi.mock('@/lib/broker/oauth/shoonya', async () => {
  const actual = await vi.importActual<typeof import('@/lib/broker/oauth/shoonya')>(
    '@/lib/broker/oauth/shoonya',
  );
  return {
    ...actual,
    resolveAppBaseUrl: () => 'http://localhost:3000',
  };
});

vi.mock('@/lib/broker/connections', async () => {
  const actual = await vi.importActual<typeof import('@/lib/broker/connections')>(
    '@/lib/broker/connections',
  );
  return {
    ...actual,
    getSafeBrokerStatus: (...args: unknown[]) => mockGetSafeBrokerStatus(...args),
    getBrokerConnectionByUserAndBroker: (...args: unknown[]) => mockGetBrokerConnection(...args),
    markBrokerConnectionStatus: (...args: unknown[]) => mockMarkStatus(...args),
    disconnectDataSourceBroker: (...args: unknown[]) => mockDisconnectDataSource(...args),
    resolveUserFeedMeta: vi.fn(async () => ({
      provider: 'zerodha' as const,
      status: 'fresh' as const,
      active: {
        userId: 42,
        provider: 'zerodha',
        connection: null,
        connectionId: null,
        isConnected: true,
        isActiveDataSource: true,
        needsSelection: false,
        reason: 'primary',
        connectedProviders: ['zerodha'],
        updatedAt: null,
      },
    })),
  };
});

vi.mock('@/lib/kite/active-session-store', () => ({
  clearActiveKiteSession: vi.fn(async () => true),
  clearUserKiteSession: vi.fn(async () => ({ userCleared: true, systemCleared: false })),
}));

vi.mock('@/lib/kite/client', () => ({
  resetKiteClient: vi.fn(),
}));

vi.mock('@/lib/broker/repository/brokerRepository', () => ({
  disconnectBrokerAccount: vi.fn(async () => undefined),
}));

describe('Shoonya broker routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireSession.mockResolvedValue({ id: 42, email: 'a@b.com' });
    process.env.SHOONYA_CLIENT_ID = 'cid';
    process.env.SHOONYA_SECRET_CODE = 'sec';
  });

  it('connect redirects to Shoonya authorize URL', async () => {
    mockGetAuthorizationUrl.mockResolvedValue(
      'https://trade.shoonya.com/OAuthlogin/authorize/oauth?client_id=cid',
    );
    const { GET } = await import('@/app/api/brokers/shoonya/connect/route');
    const res = await GET(new NextRequest('http://localhost:3000/api/brokers/shoonya/connect'));
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('client_id=cid');
  });

  it('connect not_configured redirects to same-host data-source', async () => {
    const { ShoonyaConfigError } = await import('@/lib/broker/oauth/shoonya');
    mockGetAuthorizationUrl.mockRejectedValue(new ShoonyaConfigError('missing'));
    const { GET } = await import('@/app/api/brokers/shoonya/connect/route');
    const res = await GET(
      new NextRequest('http://localhost:3000/api/brokers/shoonya/connect'),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(
      'http://localhost:3000/data-source?broker=shoonya&error=not_configured',
    );
  });

  it('callback rejects missing code', async () => {
    const { GET } = await import('@/app/api/brokers/shoonya/callback/route');
    const req = new NextRequest('http://localhost:3000/api/brokers/shoonya/callback');
    const res = await GET(req);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('error=missing_code');
    expect(mockHandleCallback).not.toHaveBeenCalled();
  });

  it('callback rejects invalid pending transaction', async () => {
    mockHandleCallback.mockResolvedValue({
      ok: false,
      broker: 'shoonya',
      errorCode: 'invalid_transaction',
    });
    const { GET } = await import('@/app/api/brokers/shoonya/callback/route');
    const req = new NextRequest(
      'http://localhost:3000/api/brokers/shoonya/callback?code=abc',
    );
    const res = await GET(req);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('error=invalid_transaction');
  });

  it('successful callback redirects to dashboard', async () => {
    mockHandleCallback.mockResolvedValue({
      ok: true,
      broker: 'shoonya',
      connection: { id: 'bc_1' },
    });
    const { GET } = await import('@/app/api/brokers/shoonya/callback/route');
    const req = new NextRequest(
      'http://localhost:3000/api/brokers/shoonya/callback?code=abc',
    );
    const res = await GET(req);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('http://localhost:3000/dashboard');
  });

  it('duplicate successful callback stays idempotent via adapter', async () => {
    mockHandleCallback
      .mockResolvedValueOnce({ ok: true, broker: 'shoonya', connection: { id: 'bc_1' } })
      .mockResolvedValueOnce({ ok: true, broker: 'shoonya', connection: { id: 'bc_1' } });
    const { GET } = await import('@/app/api/brokers/shoonya/callback/route');
    const req = new NextRequest(
      'http://localhost:3000/api/brokers/shoonya/callback?code=abc',
    );
    const first = await GET(req);
    const second = await GET(req);
    expect(first.headers.get('location')).toContain('/dashboard');
    expect(second.headers.get('location')).toContain('/dashboard');
  });
});

describe('GET /api/brokers/status', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireSession.mockResolvedValue({ id: 42, email: 'a@b.com' });
    mockGetSafeBrokerStatus.mockResolvedValue({
      connected: true,
      broker: 'zerodha',
      status: 'active',
      accountId: 'AB****34',
      userName: 'Nik',
      expiresAt: '2026-07-24T00:00:00.000Z',
      displayName: 'Zerodha Kite',
    });
  });

  it('never returns tokens or secrets and is no-store', async () => {
    const { GET } = await import('@/app/api/brokers/status/route');
    const res = await GET();
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    const body = await res.json();
    const serialized = JSON.stringify(body);
    expect(serialized).not.toMatch(/accessToken|refreshToken|apiSecret|checksum|brk1:|enc:/i);
    const status = body.data ?? body;
    expect(status.connected).toBe(true);
    expect(body.provider === 'zerodha' || body.provider === null || typeof body.provider === 'string').toBe(true);
    expect(typeof body.status).toBe('string');
  });
});

describe('POST /api/brokers/:broker/disconnect', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireSession.mockResolvedValue({ id: 42, email: 'a@b.com' });
    mockGetBrokerConnection.mockResolvedValue({
      id: 'bc_1',
      userId: 42,
      broker: 'zerodha',
      status: 'active',
    });
    mockMarkStatus.mockResolvedValue(undefined);
    mockDisconnectDataSource.mockResolvedValue({
      disconnected: 'zerodha',
      needsSelection: false,
      remainingConnected: [],
      redirectTo: '/data-source',
    });
    vi.stubEnv('NODE_ENV', 'test');
  });

  it('rejects unknown broker paths', async () => {
    const { POST } = await import('@/app/api/brokers/[broker]/disconnect/route');
    const req = new NextRequest('http://localhost:3000/api/brokers/evil/disconnect', {
      method: 'POST',
      headers: { Origin: 'http://localhost:3000' },
    });
    const res = await POST(req, { params: Promise.resolve({ broker: 'evil' }) });
    expect(res.status).toBe(400);
    expect(mockDisconnectDataSource).not.toHaveBeenCalled();
  });

  it('rejects cross-user disconnect attempts', async () => {
    mockGetBrokerConnection.mockResolvedValue(null);
    const { POST } = await import('@/app/api/brokers/[broker]/disconnect/route');
    const req = new NextRequest('http://localhost:3000/api/brokers/zerodha/disconnect', {
      method: 'POST',
      headers: { Origin: 'http://localhost:3000' },
    });
    const res = await POST(req, { params: Promise.resolve({ broker: 'zerodha' }) });
    expect(res.status).toBe(404);
    expect(mockDisconnectDataSource).not.toHaveBeenCalled();
  });

  it('disconnects owned connection when origin is trusted', async () => {
    const { POST } = await import('@/app/api/brokers/[broker]/disconnect/route');
    const req = new NextRequest('http://localhost:3000/api/brokers/zerodha/disconnect', {
      method: 'POST',
      headers: { Origin: 'http://localhost:3000' },
    });
    const res = await POST(req, { params: Promise.resolve({ broker: 'zerodha' }) });
    expect(res.status).toBe(200);
    expect(mockDisconnectDataSource).toHaveBeenCalledWith(42, 'zerodha');
    const body = await res.json();
    expect(body.redirectTo).toBe('/data-source');
  });
});
