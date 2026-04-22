/**
 * Kite Connect v3 — reusable REST client.
 *
 * Thin wrapper around fetch() that:
 *   - resolves the access_token from kite_tokens on first use
 *   - attaches Authorization: token <api_key>:<access_token>
 *   - attaches X-Kite-Version: 3
 *   - parses Kite's { status, data | message } envelope
 *   - raises KiteAuthError on HTTP 403 so callers can trigger re-auth
 *
 * Usage — one-shot (resolves token from DB every call, safe default):
 *
 *   import { kite } from '@/lib/marketData/kiteRest';
 *   const profile = await kite.get('/user/profile');
 *   const quotes  = await kite.get('/quote', { i: ['NSE:INFY', 'NSE:TCS'] });
 *
 * Usage — explicit user:
 *
 *   const client = createKiteClient({ appUserId: 42 });
 *   await client.get('/portfolio/holdings');
 *
 * Usage — explicit token (testing / CLI):
 *
 *   const client = createKiteClient();
 *   client.setAccessToken('abc123…');
 *   await client.get('/user/profile');
 */

import { getKiteAccessToken } from './kiteSession';

const BASE_URL   = 'https://api.kite.trade';
const TIMEOUT_MS = 8_000;

export class KiteAuthError extends Error {
  constructor(public status: number, public body: string) {
    super(`KITE_AUTH_ERROR status=${status} body=${body.slice(0, 120)}`);
    this.name = 'KiteAuthError';
  }
}

export class KiteApiError extends Error {
  constructor(public status: number, public body: string) {
    super(`KITE_API_ERROR status=${status} body=${body.slice(0, 120)}`);
    this.name = 'KiteApiError';
  }
}

export interface KiteClientOptions {
  /** App user to pull the token for. Defaults to shared (user_id = 0). */
  appUserId?: number;
}

export interface KiteClient {
  /** Override the token. Skips DB lookup for this client instance. */
  setAccessToken(token: string): void;
  /** Explicit clear — forces the next call to re-read from DB. */
  clearAccessToken(): void;
  get<T = any>(path: string, query?: Record<string, any>): Promise<T>;
  post<T = any>(path: string, body?: Record<string, any>): Promise<T>;
  del<T = any>(path: string, query?: Record<string, any>): Promise<T>;
}

export function createKiteClient(opts: KiteClientOptions = {}): KiteClient {
  let overrideToken: string | null = null;

  async function resolveToken(): Promise<string> {
    if (overrideToken) return overrideToken;
    const tok = await getKiteAccessToken(opts.appUserId);
    if (!tok) {
      throw new KiteAuthError(
        401,
        'LOGIN_REQUIRED: no access_token in DB — visit /api/kite/login',
      );
    }
    return tok;
  }

  function buildUrl(path: string, query?: Record<string, any>): string {
    const url = new URL(path.startsWith('/') ? path : `/${path}`, BASE_URL);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v == null) continue;
        if (Array.isArray(v)) {
          for (const item of v) url.searchParams.append(k, String(item));
        } else {
          url.searchParams.set(k, String(v));
        }
      }
    }
    return url.toString();
  }

  async function call<T>(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    opts: { query?: Record<string, any>; body?: Record<string, any> } = {},
  ): Promise<T> {
    const apiKey = process.env.KITE_API_KEY?.trim();
    if (!apiKey) {
      throw new KiteAuthError(0, 'KITE_API_KEY not set in environment');
    }

    const accessToken = (await resolveToken()).trim();
    const url = method === 'GET' || method === 'DELETE'
      ? buildUrl(path, opts.query)
      : buildUrl(path);

    const init: RequestInit = {
      method,
      headers: {
        'X-Kite-Version': '3',
        Authorization:    `token ${apiKey}:${accessToken}`,
        ...(method === 'POST'
          ? { 'Content-Type': 'application/x-www-form-urlencoded' }
          : {}),
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    };

    if (method === 'POST' && opts.body) {
      const form = new URLSearchParams();
      for (const [k, v] of Object.entries(opts.body)) {
        if (v != null) form.set(k, String(v));
      }
      init.body = form;
    }

    const res = await fetch(url, init);
    const text = await res.text();

    if (res.status === 403) {
      // Let the caller decide how to react — typically clear the
      // stored token and redirect to /api/kite/login.
      throw new KiteAuthError(403, text);
    }
    if (!res.ok) {
      throw new KiteApiError(res.status, text);
    }

    // Kite's standard envelope: { status: 'success' | 'error', data?, message? }
    try {
      const json = JSON.parse(text);
      if (json?.status === 'error') {
        throw new KiteApiError(res.status, json.message ?? text);
      }
      return (json?.data ?? json) as T;
    } catch (e) {
      if (e instanceof KiteApiError) throw e;
      // Non-JSON body — return raw text so binary endpoints still work.
      return text as unknown as T;
    }
  }

  return {
    setAccessToken(token: string) {
      overrideToken = token;
    },
    clearAccessToken() {
      overrideToken = null;
    },
    get(path, query)  { return call('GET',    path, { query }); },
    post(path, body)  { return call('POST',   path, { body  }); },
    del(path, query)  { return call('DELETE', path, { query }); },
  };
}

// Process-wide default client — reads token from shared user row on
// every call. Safe for API routes and background workers alike.
export const kite: KiteClient = createKiteClient();
