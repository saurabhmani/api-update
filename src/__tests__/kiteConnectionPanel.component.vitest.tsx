/**
 * @vitest-environment jsdom
 */

import React, { StrictMode } from 'react';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';

vi.mock('@/app/dashboard/dashboard.module.scss', () => {
  const handler: ProxyHandler<Record<string, string>> = {
    get: (_target, prop) => String(prop),
  };
  return { default: new Proxy({}, handler) };
});

vi.mock('lucide-react', () => ({
  Link2: () => null,
  LogOut: () => null,
  Plug: () => null,
  RefreshCw: () => null,
}));

import KiteConnectionPanel from '@/app/dashboard/KiteConnectionPanel';
import { clearKiteSession, getKiteSession } from '@/lib/kite/browser-session';
import { REMOTE_INVALIDATION_WARNING } from '@/lib/kite/invalidate-remote-session';
import {
  ACCESS_TOKEN,
  KITE_USER_ID,
  LEGACY_SESSION_KEY,
  assertNoAccessTokensInBrowserStorage,
  deferred,
  jsonResponse,
  profileSuccessBody,
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
  } as Storage & { _map: Map<string, string> };
}

function expectFetchWithoutBearer(init?: RequestInit, method = 'GET'): void {
  expect(init?.method ?? 'GET').toBe(method);
  expect(init?.credentials).toBe('same-origin');
  expect(init?.cache).toBe('no-store');
  const headers = new Headers(init?.headers);
  expect(headers.has('Authorization')).toBe(false);
}

describe('KiteConnectionPanel component', () => {
  const fetchMock = vi.fn();
  let storageMap: Map<string, string>;

  beforeEach(() => {
    clearKiteSession();
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    const storage = createSessionStorage();
    storageMap = storage._map;
    Object.defineProperty(window, 'sessionStorage', {
      configurable: true,
      value: storage,
    });
  });

  afterEach(() => {
    clearKiteSession();
    vi.unstubAllGlobals();
  });

  it('renders checking then not connected when the server has no Kite session', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: false, error: 'Kite is not connected' }, 401));

    render(<KiteConnectionPanel />);

    expect(screen.getByLabelText('Zerodha Kite connection')).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByText('Not connected')).toBeInTheDocument();
    });

    const connect = screen.getByRole('link', { name: /Connect Zerodha/i });
    expect(connect).toHaveAttribute('href', '/api/kite/auth/start');
    expect(fetchMock).toHaveBeenCalledWith('/api/kite/profile', expect.anything());
    expectFetchWithoutBearer(fetchMock.mock.calls[0]?.[1] as RequestInit);
    expect(getKiteSession()).toBeNull();
  });

  it('clears legacy browser token storage before verifying', async () => {
    window.sessionStorage.setItem(
      LEGACY_SESSION_KEY,
      JSON.stringify({ accessToken: ACCESS_TOKEN, kiteUserId: KITE_USER_ID }),
    );
    fetchMock.mockResolvedValue(jsonResponse({ ok: false, error: 'Kite is not connected' }, 401));

    render(<KiteConnectionPanel />);

    await waitFor(() => {
      expect(screen.getByText('Not connected')).toBeInTheDocument();
    });
    expect(window.sessionStorage.getItem(LEGACY_SESSION_KEY)).toBeNull();
    assertNoAccessTokensInBrowserStorage(storageMap, ACCESS_TOKEN);
    expect(getKiteSession()).toBeNull();
  });

  it('verifies via cookie session and renders connected profile details without the token', async () => {
    fetchMock.mockResolvedValue(jsonResponse(profileSuccessBody()));

    render(<KiteConnectionPanel />);

    expect(screen.getByText('Verifying')).toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getByText('Connected')).toBeInTheDocument();
    });

    expect(fetchMock).toHaveBeenCalledWith('/api/kite/profile', expect.anything());
    expectFetchWithoutBearer(fetchMock.mock.calls[0]?.[1] as RequestInit);

    expect(screen.getByText('Component User')).toBeInTheDocument();
    expect(screen.getByText(KITE_USER_ID)).toBeInTheDocument();
    expect(screen.getByText('ZERODHA')).toBeInTheDocument();
    expect(document.body.textContent).not.toContain(ACCESS_TOKEN);
    assertNoAccessTokensInBrowserStorage(storageMap, ACCESS_TOKEN);

    const disconnect = screen.getByRole('button', { name: /Disconnect Zerodha/i });
    expect(disconnect.tagName).toBe('BUTTON');
  });

  it('shows not connected when profile verification returns 401', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: false, error: 'Invalid' }, 401));

    render(<KiteConnectionPanel />);

    await waitFor(() => {
      expect(screen.getByText('Not connected')).toBeInTheDocument();
    });
    expect(getKiteSession()).toBeNull();
    expect(screen.getByRole('link', { name: /Connect Zerodha/i })).toBeInTheDocument();
  });

  it('offers retry on temporary profile failure without storing tokens', async () => {
    let profileCalls = 0;
    fetchMock.mockImplementation((url: string) => {
      if (url === '/api/kite/profile') {
        profileCalls += 1;
        if (profileCalls === 1) {
          return Promise.resolve(
            jsonResponse({ ok: false, error: 'Kite verification is temporarily unavailable.' }, 503),
          );
        }
        return Promise.resolve(jsonResponse(profileSuccessBody()));
      }
      throw new Error(`Unexpected fetch ${url}`);
    });

    const user = userEvent.setup();
    render(<KiteConnectionPanel />);

    await waitFor(() => {
      expect(screen.getByText('Verification unavailable')).toBeInTheDocument();
    });
    expect(getKiteSession()).toBeNull();
    assertNoAccessTokensInBrowserStorage(storageMap, ACCESS_TOKEN);

    const retry = screen.getByRole('button', { name: /Retry verification/i });
    await user.click(retry);

    await waitFor(() => {
      expect(screen.getByText('Connected')).toBeInTheDocument();
    });
    expect(profileCalls).toBe(2);
  });

  it('treats profile responses that leak access tokens as verification failures', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ ...profileSuccessBody(), accessToken: ACCESS_TOKEN }),
    );

    render(<KiteConnectionPanel />);

    await waitFor(() => {
      expect(screen.getByText('Verification failed')).toBeInTheDocument();
    });
    expect(getKiteSession()).toBeNull();
    assertNoAccessTokensInBrowserStorage(storageMap, ACCESS_TOKEN);
  });

  it('clears UI before remote invalidation settles and ignores stale verification', async () => {
    const profile = deferred<Response>();
    const invalidate = deferred<Response>();

    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url === '/api/kite/profile') return profile.promise;
      if (url === '/api/brokers/zerodha/disconnect' && init?.method === 'POST') {
        return invalidate.promise;
      }
      throw new Error(`Unexpected fetch ${url}`);
    });

    const user = userEvent.setup();
    render(<KiteConnectionPanel />);

    await waitFor(() => expect(screen.getByText('Verifying')).toBeInTheDocument());
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      '/api/kite/profile',
      expect.anything(),
    ));

    await user.click(screen.getByRole('button', { name: /Disconnect Zerodha/i }));

    expect(screen.getByText('Not connected')).toBeInTheDocument();
    expect(getKiteSession()).toBeNull();

    await act(async () => {
      profile.resolve(jsonResponse(profileSuccessBody()));
    });

    await waitFor(() => {
      expect(screen.queryByText('Connected')).not.toBeInTheDocument();
    });
    expect(screen.getByText('Not connected')).toBeInTheDocument();

    await act(async () => {
      invalidate.resolve(new Response(null, { status: 502 }));
    });

    await waitFor(() => {
      expect(screen.getByText(REMOTE_INVALIDATION_WARNING)).toBeInTheDocument();
    });
    expect(screen.getByRole('link', { name: /Connect Zerodha/i })).toBeInTheDocument();
    expect(document.body.textContent).not.toContain(ACCESS_TOKEN);
  });

  it('disconnects via the broker API without Bearer tokens', async () => {
    const invalidate = deferred<Response>();
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url === '/api/kite/profile') return Promise.resolve(jsonResponse(profileSuccessBody()));
      if (url === '/api/brokers/zerodha/disconnect' && init?.method === 'POST') {
        return invalidate.promise;
      }
      throw new Error(`Unexpected fetch ${url}`);
    });

    render(<KiteConnectionPanel />);

    await waitFor(() => expect(screen.getByText('Connected')).toBeInTheDocument());

    const disconnect = screen.getByRole('button', { name: /Disconnect Zerodha/i });
    fireEvent.click(disconnect);
    fireEvent.click(disconnect);
    fireEvent.click(disconnect);

    const disconnectCalls = fetchMock.mock.calls.filter(
      (call) => call[0] === '/api/brokers/zerodha/disconnect'
        && (call[1] as RequestInit).method === 'POST',
    );
    expect(disconnectCalls.length).toBeGreaterThanOrEqual(1);
    for (const [, init] of disconnectCalls) {
      expectFetchWithoutBearer(init as RequestInit, 'POST');
    }

    await act(async () => {
      invalidate.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    });
  });

  it('issues profile verification requests under StrictMode', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url === '/api/kite/profile') {
        return Promise.resolve(jsonResponse(profileSuccessBody()));
      }
      throw new Error(`Unexpected fetch ${url}`);
    });

    render(
      <StrictMode>
        <KiteConnectionPanel />
      </StrictMode>,
    );

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(fetchMock.mock.calls.filter((call) => call[0] === '/api/kite/profile').length)
      .toBeGreaterThanOrEqual(1);

    await waitFor(() => expect(screen.getByText('Connected')).toBeInTheDocument());
  });
});
