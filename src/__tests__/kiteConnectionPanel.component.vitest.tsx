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
import {
  getKiteSession,
  saveKiteSession,
  clearKiteSession,
} from '@/lib/kite/browser-session';
import { resetBrowserConnectionState, REMOTE_INVALIDATION_WARNING } from '@/lib/kite/browser-connection';
import {
  ACCESS_TOKEN,
  KITE_USER_ID,
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
  } as Storage;
}

function saveValidSession(overrides?: Partial<{ kiteUserId: string; accessToken: string; authenticatedAt: string }>) {
  saveKiteSession({
    kiteUserId: overrides?.kiteUserId ?? KITE_USER_ID,
    accessToken: overrides?.accessToken ?? ACCESS_TOKEN,
    authenticatedAt: overrides?.authenticatedAt ?? new Date().toISOString(),
  });
}

describe('KiteConnectionPanel component', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    resetBrowserConnectionState();
    clearKiteSession();
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    Object.defineProperty(window, 'sessionStorage', {
      configurable: true,
      value: createSessionStorage(),
    });
  });

  afterEach(() => {
    resetBrowserConnectionState();
    clearKiteSession();
    vi.unstubAllGlobals();
  });

  it('renders checking then not connected accessibly without a local session', async () => {
    render(<KiteConnectionPanel />);

    expect(screen.getByLabelText('Zerodha Kite connection')).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByText('Not connected')).toBeInTheDocument();
    });

    const connect = screen.getByRole('link', { name: /Connect Zerodha/i });
    expect(connect).toHaveAttribute('href', '/api/kite/auth/start');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('clears an expired local session and does not call the profile API', async () => {
    const expired = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    saveValidSession({ authenticatedAt: expired });

    render(<KiteConnectionPanel />);

    await waitFor(() => {
      expect(screen.getByText('Not connected')).toBeInTheDocument();
    });
    expect(getKiteSession()).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('verifies a valid session and renders connected profile details without the token', async () => {
    saveValidSession();
    fetchMock.mockResolvedValue(jsonResponse(profileSuccessBody()));

    render(<KiteConnectionPanel />);

    expect(screen.getByText('Verifying')).toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getByText('Connected')).toBeInTheDocument();
    });

    expect(fetchMock).toHaveBeenCalledWith('/api/kite/profile', expect.objectContaining({
      method: 'GET',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { Authorization: `Bearer ${ACCESS_TOKEN}` },
    }));

    expect(screen.getByText('Component User')).toBeInTheDocument();
    expect(screen.getByText(KITE_USER_ID)).toBeInTheDocument();
    expect(screen.getByText('ZERODHA')).toBeInTheDocument();
    expect(document.body.textContent).not.toContain(ACCESS_TOKEN);

    const disconnect = screen.getByRole('button', { name: /Disconnect Zerodha/i });
    expect(disconnect.tagName).toBe('BUTTON');
  });

  it('clears storage and requires reconnect on profile 401', async () => {
    saveValidSession();
    fetchMock.mockResolvedValue(jsonResponse({ ok: false, error: 'Invalid' }, 401));

    render(<KiteConnectionPanel />);

    await waitFor(() => {
      expect(screen.getByText('Verification failed')).toBeInTheDocument();
    });
    expect(screen.getByText(/Zerodha session has expired/i)).toBeInTheDocument();
    expect(getKiteSession()).toBeNull();
    expect(screen.getByRole('link', { name: /Connect Zerodha/i })).toBeInTheDocument();
  });

  it('preserves storage and offers retry on temporary profile failure', async () => {
    saveValidSession();
    let profileCalls = 0;
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url === '/api/kite/session' && init?.method === 'POST') {
        return Promise.resolve(jsonResponse({ ok: true }));
      }
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
    expect(getKiteSession()).not.toBeNull();

    const retry = screen.getByRole('button', { name: /Retry verification/i });
    await user.click(retry);

    await waitFor(() => {
      expect(screen.getByText('Connected')).toBeInTheDocument();
    });
    expect(profileCalls).toBe(2);
  });

  it('clears storage when the profile Kite user ID mismatches', async () => {
    saveValidSession();
    fetchMock.mockResolvedValue(jsonResponse(profileSuccessBody('OTHER')));

    render(<KiteConnectionPanel />);

    await waitFor(() => {
      expect(screen.getByText('Verification failed')).toBeInTheDocument();
    });
    expect(getKiteSession()).toBeNull();
  });

  it('clears UI and storage before remote invalidation settles and ignores stale verification', async () => {
    saveValidSession();
    const profile = deferred<Response>();
    const invalidate = deferred<Response>();

    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url === '/api/kite/profile') return profile.promise;
      if (url === '/api/kite/session' && init?.method === 'POST') {
        return Promise.resolve(jsonResponse({ ok: true }));
      }
      if (url === '/api/kite/session' && init?.method === 'DELETE') return invalidate.promise;
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

  it('does not start duplicate DELETE requests on repeated disconnect clicks', async () => {
    saveValidSession();
    const invalidate = deferred<Response>();
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url === '/api/kite/profile') return Promise.resolve(jsonResponse(profileSuccessBody()));
      if (url === '/api/kite/session' && init?.method === 'POST') {
        return Promise.resolve(jsonResponse({ ok: true }));
      }
      if (url === '/api/kite/session' && init?.method === 'DELETE') return invalidate.promise;
      throw new Error(`Unexpected fetch ${url}`);
    });

    render(<KiteConnectionPanel />);

    await waitFor(() => expect(screen.getByText('Connected')).toBeInTheDocument());

    const disconnect = screen.getByRole('button', { name: /Disconnect Zerodha/i });
    fireEvent.click(disconnect);
    fireEvent.click(disconnect);
    fireEvent.click(disconnect);

    const deletes = fetchMock.mock.calls.filter(
      (call) => call[0] === '/api/kite/session' && (call[1] as RequestInit).method === 'DELETE',
    );
    expect(deletes).toHaveLength(1);

    await act(async () => {
      invalidate.resolve(new Response(null, { status: 204 }));
    });
  });

  it('does not start duplicate concurrent profile requests under StrictMode', async () => {
    saveValidSession();
    const profile = deferred<Response>();
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url === '/api/kite/profile') return profile.promise;
      if (url === '/api/kite/session' && init?.method === 'POST') {
        return Promise.resolve(jsonResponse({ ok: true }));
      }
      throw new Error(`Unexpected fetch ${url}`);
    });

    render(
      <StrictMode>
        <KiteConnectionPanel />
      </StrictMode>,
    );

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(fetchMock.mock.calls.filter((call) => call[0] === '/api/kite/profile')).toHaveLength(1);

    await act(async () => {
      profile.resolve(jsonResponse(profileSuccessBody()));
    });

    await waitFor(() => expect(screen.getByText('Connected')).toBeInTheDocument());
  });
});
