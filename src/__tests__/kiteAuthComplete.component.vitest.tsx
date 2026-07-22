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
  } as Storage;
}

describe('KiteAuthCompletePage component', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    resetAuthCompleteRedemptionState();
    routerReplace.mockReset();
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    Object.defineProperty(window, 'sessionStorage', {
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
      redemption.resolve(jsonResponse({
        kiteUserId: KITE_USER_ID,
        accessToken: ACCESS_TOKEN,
      }));
    });

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Authentication successful' })).toBeInTheDocument();
    });
    expect(routerReplace).toHaveBeenCalledWith('/dashboard');
    expect(getKiteSession()).toEqual({
      kiteUserId: KITE_USER_ID,
      accessToken: ACCESS_TOKEN,
      authenticatedAt: expect.any(String),
    });
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
    expect(routerReplace).not.toHaveBeenCalled();
  });

  it('stores no session when the success payload is invalid', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ kiteUserId: KITE_USER_ID }, 200));
    setWindowLocation(`/kite/auth-complete#code=${COMPLETION_CODE}`);

    render(<KiteAuthCompletePage />);

    await waitFor(() => {
      expect(screen.getByText(/Invalid session data received/i)).toBeInTheDocument();
    });
    expect(getKiteSession()).toBeNull();
    expect(routerReplace).not.toHaveBeenCalled();
  });

  it('shows safe failure UI when saveKiteSession fails', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ kiteUserId: KITE_USER_ID, accessToken: ACCESS_TOKEN }),
    );
    Object.defineProperty(window, 'sessionStorage', {
      configurable: true,
      value: {
        getItem: () => null,
        setItem: () => {
          throw new Error('quota exceeded');
        },
        removeItem: () => undefined,
        clear: () => undefined,
        key: () => null,
        length: 0,
      } as Storage,
    });

    setWindowLocation(`/kite/auth-complete#code=${COMPLETION_CODE}`);
    render(<KiteAuthCompletePage />);

    await waitFor(() => {
      expect(screen.getByText(/Unable to save your Kite session locally/i)).toBeInTheDocument();
    });
    expect(routerReplace).not.toHaveBeenCalled();
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
      redemption.resolve(jsonResponse({
        kiteUserId: KITE_USER_ID,
        accessToken: ACCESS_TOKEN,
      }));
    });

    await waitFor(() => expect(routerReplace).toHaveBeenCalledWith('/dashboard'));
  });

  it('does not navigate or update after unmount during redemption', async () => {
    const redemption = deferred<Response>();
    fetchMock.mockImplementation(() => redemption.promise);

    setWindowLocation(`/kite/auth-complete#code=${COMPLETION_CODE}`);
    const { unmount } = render(<KiteAuthCompletePage />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    unmount();

    await act(async () => {
      redemption.resolve(jsonResponse({
        kiteUserId: KITE_USER_ID,
        accessToken: ACCESS_TOKEN,
      }));
      await redemption.promise;
    });

    expect(routerReplace).not.toHaveBeenCalled();
  });
});
