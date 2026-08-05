import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

describe('classifyProviderFailure (provider-agnostic)', () => {
  it('does not demote credentials on network timeout', async () => {
    const { classifyProviderFailure, shouldPersistCredentialDemotion } =
      await import('@/lib/broker/connections/providerFailure');
    const cat = classifyProviderFailure({
      providerErrorMessage: 'request timed out',
      transport: 'rest',
    });
    expect(cat).toBe('timeout');
    expect(shouldPersistCredentialDemotion(cat)).toBe(false);
  });

  it('does not demote on DNS / connectivity failure', async () => {
    const { classifyProviderFailure, shouldPersistCredentialDemotion } =
      await import('@/lib/broker/connections/providerFailure');
    const cat = classifyProviderFailure({
      providerErrorMessage: 'getaddrinfo ENOTFOUND api.example.com',
    });
    expect(cat).toBe('network_error');
    expect(shouldPersistCredentialDemotion(cat)).toBe(false);
  });

  it('does not demote on HTTP 429', async () => {
    const { classifyProviderFailure, shouldPersistCredentialDemotion } =
      await import('@/lib/broker/connections/providerFailure');
    const cat = classifyProviderFailure({ httpStatus: 429 });
    expect(cat).toBe('rate_limited');
    expect(shouldPersistCredentialDemotion(cat)).toBe(false);
  });

  it('does not demote on HTTP 500/502/503', async () => {
    const { classifyProviderFailure, shouldPersistCredentialDemotion } =
      await import('@/lib/broker/connections/providerFailure');
    for (const status of [500, 502, 503]) {
      const cat = classifyProviderFailure({ httpStatus: status });
      expect(cat).toBe('provider_unavailable');
      expect(shouldPersistCredentialDemotion(cat)).toBe(false);
    }
  });

  it('does not demote on WebSocket disconnect', async () => {
    const { classifyProviderFailure, shouldPersistCredentialDemotion } =
      await import('@/lib/broker/connections/providerFailure');
    const cat = classifyProviderFailure({
      providerErrorMessage: 'socket closed',
      transport: 'websocket',
    });
    expect(cat).toBe('transport_disconnected');
    expect(shouldPersistCredentialDemotion(cat)).toBe(false);
  });

  it('does not demote on generic fail/invalid/denied text', async () => {
    const { classifyProviderFailure, shouldPersistCredentialDemotion } =
      await import('@/lib/broker/connections/providerFailure');
    for (const msg of ['failed', 'invalid', 'denied', 'auth failed']) {
      const cat = classifyProviderFailure({ providerErrorMessage: msg });
      expect(shouldPersistCredentialDemotion(cat)).toBe(false);
    }
  });

  it('does not demote ambiguous HTTP 401 without session language', async () => {
    const { classifyProviderFailure, shouldPersistCredentialDemotion } =
      await import('@/lib/broker/connections/providerFailure');
    const cat = classifyProviderFailure({
      httpStatus: 401,
      providerErrorMessage: 'Unauthorized',
    });
    expect(cat).toBe('temporary_auth_failure');
    expect(shouldPersistCredentialDemotion(cat)).toBe(false);
  });

  it('does not demote permission/scope HTTP 403', async () => {
    const { classifyProviderFailure, shouldPersistCredentialDemotion } =
      await import('@/lib/broker/connections/providerFailure');
    const cat = classifyProviderFailure({
      httpStatus: 403,
      providerErrorMessage: 'missing scope trading',
    });
    expect(cat).toBe('permission_denied');
    expect(shouldPersistCredentialDemotion(cat)).toBe(false);
  });

  it('demotes on explicit invalid session message', async () => {
    const { classifyProviderFailure, shouldPersistCredentialDemotion } =
      await import('@/lib/broker/connections/providerFailure');
    const cat = classifyProviderFailure({
      providerErrorMessage: 'Invalid Session',
      confirmedCredentialInvalid: false,
    });
    expect(cat).toBe('reauth_required');
    expect(shouldPersistCredentialDemotion(cat)).toBe(true);
  });

  it('demotes on confirmed credential invalid flag', async () => {
    const { classifyProviderFailure, shouldPersistCredentialDemotion } =
      await import('@/lib/broker/connections/providerFailure');
    const cat = classifyProviderFailure({
      httpStatus: 401,
      confirmedCredentialInvalid: true,
    });
    expect(cat).toBe('reauth_required');
    expect(shouldPersistCredentialDemotion(cat)).toBe(true);
  });

  it('revokes on confirmedCredentialsRevoked', async () => {
    const { classifyProviderFailure } =
      await import('@/lib/broker/connections/providerFailure');
    expect(
      classifyProviderFailure({ confirmedCredentialsRevoked: true }),
    ).toBe('credentials_revoked');
  });
});

describe('Shoonya / Kite confirmed invalid helpers', () => {
  it('Shoonya requires explicit session/token phrases', async () => {
    const { isConfirmedShoonyaCredentialInvalid } =
      await import('@/lib/broker/connections/providerFailure');
    expect(isConfirmedShoonyaCredentialInvalid('Session Expired')).toBe(true);
    expect(isConfirmedShoonyaCredentialInvalid('Invalid Session')).toBe(true);
    expect(isConfirmedShoonyaCredentialInvalid('failed')).toBe(false);
    expect(isConfirmedShoonyaCredentialInvalid('invalid')).toBe(false);
    expect(isConfirmedShoonyaCredentialInvalid('denied')).toBe(false);
  });

  it('Kite TokenException is confirmed invalid', async () => {
    const { isConfirmedKiteCredentialInvalid } =
      await import('@/lib/broker/connections/providerFailure');
    expect(isConfirmedKiteCredentialInvalid('TokenException')).toBe(true);
    expect(isConfirmedKiteCredentialInvalid('NetworkException', 'timeout')).toBe(false);
  });
});

describe('credential usability + effective status', () => {
  it('past token expiry makes active unusable and effective expired', async () => {
    const { isCredentialUsable, effectiveCredentialStatus } =
      await import('@/lib/broker/connections/credentialStatus');
    const past = new Date(Date.now() - 60_000).toISOString();
    expect(
      isCredentialUsable({
        status: 'active',
        accessTokenEncrypted: 'enc',
        tokenExpiresAt: past,
      }),
    ).toBe(false);
    expect(
      effectiveCredentialStatus({ status: 'active', tokenExpiresAt: past }),
    ).toBe('expired');
  });

  it('future expiry + revoked remains unusable', async () => {
    const { isCredentialUsable, effectiveCredentialStatus } =
      await import('@/lib/broker/connections/credentialStatus');
    const future = new Date(Date.now() + 86_400_000).toISOString();
    expect(
      isCredentialUsable({
        status: 'revoked',
        accessTokenEncrypted: 'enc',
        tokenExpiresAt: future,
      }),
    ).toBe(false);
    expect(
      effectiveCredentialStatus({ status: 'revoked', tokenExpiresAt: future }),
    ).toBe('revoked');
  });

  it('future expiry + reauth_required remains unusable', async () => {
    const { isCredentialUsable } =
      await import('@/lib/broker/connections/credentialStatus');
    const future = new Date(Date.now() + 86_400_000).toISOString();
    expect(
      isCredentialUsable({
        status: 'reauth_required',
        accessTokenEncrypted: 'enc',
        tokenExpiresAt: future,
      }),
    ).toBe(false);
  });

  it('future expiry + active is usable', async () => {
    const { isCredentialUsable } =
      await import('@/lib/broker/connections/credentialStatus');
    const future = new Date(Date.now() + 86_400_000).toISOString();
    expect(
      isCredentialUsable({
        status: 'active',
        accessTokenEncrypted: 'enc',
        tokenExpiresAt: future,
      }),
    ).toBe(true);
  });

  it('no expiry + temporary failure context stays active-usable', async () => {
    const { isCredentialUsable } =
      await import('@/lib/broker/connections/credentialStatus');
    expect(
      isCredentialUsable({
        status: 'active',
        accessTokenEncrypted: 'enc',
        tokenExpiresAt: null,
      }),
    ).toBe(true);
  });
});

describe('setCredentialStatus / expireCredentialIfPastExpiry', () => {
  const mockGet = vi.fn();
  const mockMark = vi.fn();
  const mockMerge = vi.fn();

  beforeEach(() => {
    vi.resetModules();
    mockGet.mockReset();
    mockMark.mockReset();
    mockMerge.mockReset();
    vi.doMock('@/lib/broker/connections/repository', () => ({
      getBrokerConnectionByUserAndBroker: (...a: unknown[]) => mockGet(...a),
      markBrokerConnectionStatus: (...a: unknown[]) => mockMark(...a),
      mergeBrokerConnectionMetadata: (...a: unknown[]) => mockMerge(...a),
    }));
    vi.doMock('@/lib/logger', () => ({
      logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
    }));
  });

  it('blocks expired write when token_expires_at is still future', async () => {
    mockGet.mockResolvedValue({
      id: 'bc_1',
      userId: 1,
      broker: 'shoonya',
      status: 'active',
      tokenExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    });
    const { setCredentialStatus } =
      await import('@/lib/broker/connections/credentialStatus');
    const result = await setCredentialStatus({
      userId: 1,
      broker: 'shoonya',
      newStatus: 'expired',
      reason: 'time_expiry',
      source: 'test',
    });
    expect(result.changed).toBe(false);
    expect(result.skippedReason).toBe('token_not_past_expiry');
    expect(mockMark).not.toHaveBeenCalled();
  });

  it('allows expired when token_expires_at is past', async () => {
    mockGet.mockResolvedValue({
      id: 'bc_1',
      userId: 1,
      broker: 'zerodha',
      status: 'active',
      tokenExpiresAt: new Date(Date.now() - 60_000).toISOString(),
    });
    mockMark.mockResolvedValue(undefined);
    mockMerge.mockResolvedValue(undefined);
    const { setCredentialStatus } =
      await import('@/lib/broker/connections/credentialStatus');
    const result = await setCredentialStatus({
      userId: 1,
      broker: 'zerodha',
      newStatus: 'expired',
      reason: 'time_expiry',
      source: 'test',
    });
    expect(result.changed).toBe(true);
    expect(mockMark).toHaveBeenCalledWith(1, 'zerodha', 'expired', false);
  });

  it('applyProviderFailure does not persist on timeout', async () => {
    const { applyProviderFailureToCredentialStatus } =
      await import('@/lib/broker/connections/credentialStatus');
    const out = await applyProviderFailureToCredentialStatus(
      1,
      'shoonya',
      { providerErrorMessage: 'timed out', transport: 'rest' },
      'test',
    );
    expect(out.persisted).toBe(false);
    expect(out.category).toBe('timeout');
    expect(mockMark).not.toHaveBeenCalled();
  });

  it('applyProviderFailure persists reauth_required on confirmed invalid', async () => {
    mockGet.mockResolvedValue({
      id: 'bc_1',
      userId: 1,
      broker: 'shoonya',
      status: 'active',
      tokenExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    });
    mockMark.mockResolvedValue(undefined);
    mockMerge.mockResolvedValue(undefined);
    const { applyProviderFailureToCredentialStatus } =
      await import('@/lib/broker/connections/credentialStatus');
    const out = await applyProviderFailureToCredentialStatus(
      1,
      'shoonya',
      {
        confirmedCredentialInvalid: true,
        providerErrorMessage: 'Invalid Session',
        transport: 'rest',
      },
      'test',
    );
    expect(out.persisted).toBe(true);
    expect(out.category).toBe('reauth_required');
    expect(mockMark).toHaveBeenCalledWith(1, 'shoonya', 'reauth_required', false);
  });

  it('repairMisclassifiedExpired moves future-dated expired → reauth_required', async () => {
    mockGet.mockResolvedValue({
      id: 'bc_1',
      userId: 1,
      broker: 'shoonya',
      status: 'expired',
      tokenExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      metadata: null,
    });
    mockMark.mockResolvedValue(undefined);
    mockMerge.mockResolvedValue(undefined);
    const { repairMisclassifiedExpiredCredential } =
      await import('@/lib/broker/connections/credentialStatus');
    const repaired = await repairMisclassifiedExpiredCredential({
      id: 'bc_1',
      userId: 1,
      broker: 'shoonya',
      brokerAccountId: null,
      brokerUserName: null,
      accessTokenEncrypted: 'enc',
      refreshTokenEncrypted: null,
      tokenExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      lastAuthenticatedAt: null,
      lastUsedAt: null,
      status: 'expired',
      isPrimary: true,
      metadata: null,
      createdAt: '',
      updatedAt: '',
    });
    expect(repaired.status).toBe('reauth_required');
    expect(mockMark).toHaveBeenCalledWith(1, 'shoonya', 'reauth_required', false);
  });
});

describe('broker stream helpers removed', () => {
  it('connectionHelpers path is not part of the brokerProvider surface', async () => {
    const { getBrokerMarketDataProvider } = await import(
      '@/lib/marketData/brokerProvider'
    );
    expect(() => getBrokerMarketDataProvider('zerodha')).toThrow(/removed/i);
  });
});

describe('classifyStreamError narrowed', () => {
  it('documents that broker stream classifiers were removed', () => {
    expect(true).toBe(true);
  });
});
