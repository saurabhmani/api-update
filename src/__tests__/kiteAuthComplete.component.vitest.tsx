/**
 * @vitest-environment jsdom
 */

import React, { StrictMode } from 'react';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

const routerReplace = vi.fn();
const router = {
  replace: (...args: unknown[]) => routerReplace(...args),
  push: vi.fn(),
  prefetch: vi.fn(),
  back: vi.fn(),
  forward: vi.fn(),
  refresh: vi.fn(),
};

vi.mock('next/navigation', () => ({
  useRouter: () => router,
}));

import KiteAuthCompletePage from '@/app/kite/auth-complete/page';
import { getKiteSession } from '@/lib/kite/browser-session';
import { resetAuthCompleteRedemptionState } from '@/lib/kite/auth-complete-redemption';
import {
  ACCESS_TOKEN,
  COMPLETION_CODE,
  KITE_USER_ID,
  LEGACY_SESSION_KEY,
  assertNoAccessTokensInBrowserStorage,
  deferred,
  jsonResponse,
  setWindowLocation,
} from '@/__tests__/kiteComponentTestUtils';

function createSessionStorage() {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (key: string) => map.get(key) ?? null,
    key: (index: number) => Array.from(map.keys())[index] ?? null,
    removeItem: (key: string) => {
      map.delete(key);
    },
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
    _map: map,
  };
}

const AUTHENTICATED_AT = '2026-01-01T00:00:00.000Z';

function successPayload() {
  return {
    ok: true,
    kiteUserId: KITE_USER_ID,
    authenticatedAt: AUTHENTICATED_AT,
  };
}

describe('KiteAuthCompletePage component', () => {
  const fetchMock = vi.fn();
  let storageMap: Map<string, string>;

  beforeEach(() => {
    resetAuthCompleteRedemptionState();
    routerReplace.mockReset();
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    const storage = createSessionStorage();
    storageMap = storage._map;
    Object.defineProperty(window, 'sessionStorage', {
      configurable: true,
      value: storage,
    });
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: createSessionStorage(),
    });
    setWindowLocation('/kite/auth-complete');
  });

  afterEach(() => {
    resetAuthCompleteRedemptionState();
    vi.unstubAllGlobals();
  });

  it('removes the fragment before redemption and preserves query params', async () => {
    const redemption = deferred<Response>();
    fetchMock.mockImplementation(() => {
      expect(window.location.hash).toBe('');
      expect(window.location.pathname).toBe('/kite/auth-complete');
      expect(window.location.search).toBe('?from=dashboard&ref=kite');
      return redemption.promise;
    });

    setWindowLocation(
      `/kite/auth-complete?from=dashboard&ref=kite#code=${COMPLETION_CODE}`,
    );

    render(<KiteAuthCompletePage />);

    expect(screen.getByRole('status')).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByRole('heading', { name: 'Completing authentication' })).toBeInTheDocument();
    expect(screen.getByText('Completing Kite authentication…')).toBeInTheDocument();
    expect(document.body.textContent).not.toContain(COMPLETION_CODE);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(window.location.hash).toBe('');

    await act(async () => {
      redemption.resolve(jsonResponse(successPayload()));
    });

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Authentication successful' })).toBeInTheDocument();
    });
    expect(routerReplace).toHaveBeenCalledWith('/dashboard');
    expect(getKiteSession()).toBeNull();
    expect(window.sessionStorage.getItem(LEGACY_SESSION_KEY)).toBeNull();
    assertNoAccessTokensInBrowserStorage(storageMap);
    expect(document.body.textContent).not.toContain(ACCESS_TOKEN);
    expect(document.body.textContent).not.toContain(COMPLETION_CODE);
  });

  it('shows safe failure UI for missing blank duplicated and malformed codes', async () => {
    for (const hash of ['', '#', '#code=', '#code=%20%20', '#code=a&code=b', '#code=%GG']) {
      resetAuthCompleteRedemptionState();
      setWindowLocation(`/kite/auth-complete${hash}`);
      const { unmount } = render(<KiteAuthCompletePage />);

      await waitFor(() => {
        expect(screen.getByRole('heading', { name: 'Authentication failed' })).toBeInTheDocument();
      });
      expect(screen.getByRole('status')).toHaveAttribute('aria-busy', 'false');
      expect(screen.getByText(/Missing completion code/i)).toBeInTheDocument();
      expect(fetchMock).not.toHaveBeenCalled();
      expect(getKiteSession()).toBeNull();
      unmount();
    }
  });

  it('shows safe failure UI when the API returns an error and stores no session', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ ok: false, error: 'Invalid or expired completion code' }, 401),
    );
    setWindowLocation(`/kite/auth-complete#code=${COMPLETION_CODE}`);

    render(<KiteAuthCompletePage />);

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Authentication failed' })).toBeInTheDocument();
    });
    expect(screen.getByText('Invalid or expired completion code')).toBeInTheDocument();
    expect(getKiteSession()).toBeNull();
    expect(window.sessionStorage.getItem(LEGACY_SESSION_KEY)).toBeNull();
    expect(routerReplace).not.toHaveBeenCalled();
  });

  it('stores no session when the success payload is invalid', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true }, 200));
    setWindowLocation(`/kite/auth-complete#code=${COMPLETION_CODE}`);

    render(<KiteAuthCompletePage />);

    await waitFor(() => {
      expect(screen.getByText(/Invalid session data received/i)).toBeInTheDocument();
    });
    expect(getKiteSession()).toBeNull();
    expect(window.sessionStorage.getItem(LEGACY_SESSION_KEY)).toBeNull();
    expect(routerReplace).not.toHaveBeenCalled();
  });

  it('rejects token leakage in the complete API response', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        ok: true,
        kiteUserId: KITE_USER_ID,
        accessToken: ACCESS_TOKEN,
        authenticatedAt: AUTHENTICATED_AT,
      }),
    );
    setWindowLocation(`/kite/auth-complete#code=${COMPLETION_CODE}`);

    render(<KiteAuthCompletePage />);

    await waitFor(() => {
      expect(screen.getByText(/Invalid session data received/i)).toBeInTheDocument();
    });
    expect(getKiteSession()).toBeNull();
    expect(window.sessionStorage.getItem(LEGACY_SESSION_KEY)).toBeNull();
    assertNoAccessTokensInBrowserStorage(storageMap, ACCESS_TOKEN);
    expect(routerReplace).not.toHaveBeenCalled();
  });

  it('clears legacy browser storage after successful redemption', async () => {
    window.sessionStorage.setItem(
      LEGACY_SESSION_KEY,
      JSON.stringify({ accessToken: ACCESS_TOKEN, kiteUserId: 'OLD' }),
    );
    fetchMock.mockResolvedValue(jsonResponse(successPayload()));
    setWindowLocation(`/kite/auth-complete#code=${COMPLETION_CODE}`);

    render(<KiteAuthCompletePage />);

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Authentication successful' })).toBeInTheDocument();
    });
    expect(window.sessionStorage.getItem(LEGACY_SESSION_KEY)).toBeNull();
    expect(getKiteSession()).toBeNull();
    assertNoAccessTokensInBrowserStorage(storageMap, ACCESS_TOKEN);
    expect(routerReplace).toHaveBeenCalledWith('/dashboard');
  });

  it('shares one redemption POST under React StrictMode', async () => {
    const redemption = deferred<Response>();
    fetchMock.mockImplementation(() => redemption.promise);

    setWindowLocation(`/kite/auth-complete#code=${COMPLETION_CODE}`);
    render(
      <StrictMode>
        <KiteAuthCompletePage />
      </StrictMode>,
    );

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      code: COMPLETION_CODE,
    });

    await act(async () => {
      redemption.resolve(jsonResponse(successPayload()));
    });

    await waitFor(() => expect(routerReplace).toHaveBeenCalledWith('/dashboard'));
    expect(getKiteSession()).toBeNull();
  });

  it('does not navigate or update after unmount during redemption', async () => {
    const redemption = deferred<Response>();
    fetchMock.mockImplementation(() => redemption.promise);

    setWindowLocation(`/kite/auth-complete#code=${COMPLETION_CODE}`);
    const { unmount } = render(<KiteAuthCompletePage />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    unmount();

    await act(async () => {
      redemption.resolve(jsonResponse(successPayload()));
      await redemption.promise;
    });

    expect(routerReplace).not.toHaveBeenCalled();
  });
});
