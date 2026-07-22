import { afterEach, beforeEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { resetAuthCompleteRedemptionState } from '@/lib/kite/auth-complete-redemption';
import { resetBrowserConnectionState } from '@/lib/kite/browser-connection';
import { clearKiteSession } from '@/lib/kite/browser-session';

export const ACCESS_TOKEN = 'component-test-access-token';
export const COMPLETION_CODE = 'component-test-completion-code';
export const KITE_USER_ID = 'AB1234';

type StorageMap = Map<string, string>;

function createSessionStorage(map: StorageMap): Storage {
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

export function installBrowserTestEnvironment(): {
  storage: StorageMap;
  replaceState: ReturnType<typeof vi.fn>;
  routerReplace: ReturnType<typeof vi.fn>;
} {
  const storage: StorageMap = new Map();
  const replaceState = vi.fn((_: unknown, __: string, url?: string | URL | null) => {
    if (typeof url === 'string') {
      const next = new URL(url, window.location.origin);
      window.location.href = next.toString();
      // jsdom Location hash/search/pathname update
      Object.defineProperty(window.location, 'pathname', {
        configurable: true,
        value: next.pathname,
      });
      Object.defineProperty(window.location, 'search', {
        configurable: true,
        value: next.search,
      });
      Object.defineProperty(window.location, 'hash', {
        configurable: true,
        value: next.hash,
      });
    }
  });

  Object.defineProperty(window, 'sessionStorage', {
    configurable: true,
    value: createSessionStorage(storage),
  });

  Object.defineProperty(window, 'history', {
    configurable: true,
    value: {
      ...window.history,
      replaceState,
    },
  });

  const routerReplace = vi.fn();
  return { storage, replaceState, routerReplace };
}

export function setWindowLocation(pathWithQueryAndHash: string): void {
  const url = new URL(pathWithQueryAndHash, 'http://localhost');
  window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`);
}

export function deferred<T = Response>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export function profileSuccessBody(userId = KITE_USER_ID) {
  return {
    userId,
    userName: 'Component User',
    email: 'component@example.com',
    broker: 'ZERODHA',
  };
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export function resetKiteComponentTestState(): void {
  resetAuthCompleteRedemptionState();
  resetBrowserConnectionState();
  clearKiteSession();
  cleanup();
}

export function useKiteComponentTestLifecycle(): void {
  beforeEach(() => {
    resetKiteComponentTestState();
  });

  afterEach(() => {
    resetKiteComponentTestState();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });
}
