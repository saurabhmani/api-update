// ════════════════════════════════════════════════════════════════
//  Kite Connect — authentication helpers
//
//  Supports API key + API secret + access token from env.
//  Login UI / request_token exchange is intentionally out of scope
//  for Phase 2 (helpers only).
// ════════════════════════════════════════════════════════════════

import {
  getKiteClient,
  loadKiteConfig,
  type KiteClient,
} from './client';
import {
  KiteAuthenticationError,
  KiteConfigError,
  normalizeKiteError,
  withKiteErrors,
} from './errors';
import type { KiteConnectionValidation, KiteProfile } from './types';

/** Return the shared Kite client singleton. */
export function getClient(): KiteClient {
  return getKiteClient();
}

/** Apply a runtime access token to the singleton client. */
export function setAccessToken(accessToken: string): void {
  getKiteClient().setAccessToken(accessToken);
}

/**
 * Probe connectivity with `getProfile()`.
 * Returns a structured result (does not throw on auth failure) so
 * health checks can stay non-fatal.
 */
export async function validateConnection(): Promise<KiteConnectionValidation> {
  const cfg = loadKiteConfig();
  if (!cfg.apiKey) {
    return {
      ok: false,
      profile: null,
      error: 'KITE_API_KEY is not configured',
    };
  }

  const client = getKiteClient();
  const hasSession = await client.hydrateAccessTokenFromSession();
  if (!hasSession) {
    return {
      ok: false,
      profile: null,
      error: 'No active Kite session — connect Zerodha from the dashboard',
    };
  }

  try {
    const profile = await client.call((kc) => kc.getProfile()) as KiteProfile;
    return { ok: true, profile, error: null };
  } catch (err) {
    const normalized = normalizeKiteError(err);
    return {
      ok: false,
      profile: null,
      error: normalized.message,
    };
  }
}

/**
 * Strict variant — throws `KiteAuthenticationError` / `KiteConfigError`
 * when the connection is not usable.
 */
export async function assertConnection(): Promise<KiteProfile> {
  const result = await validateConnection();
  if (!result.ok || !result.profile) {
    const msg = result.error ?? 'Kite connection validation failed';
    if (msg.includes('not configured')) {
      throw new KiteConfigError(msg);
    }
    throw new KiteAuthenticationError(msg);
  }
  return result.profile;
}

/** Login URL for a future Phase-3 OAuth flow (no UI yet). */
export function getLoginUrl(): string {
  return getKiteClient().getLoginUrl();
}

/**
 * Exchange a `request_token` for a session (access token).
 * Sets the token on the singleton. No login UI — callers pass the
 * token obtained out-of-band (e.g. redirect callback in a later phase).
 */
export async function generateSession(requestToken: string): Promise<{
  access_token: string;
  user_id: string;
  login_time?: string;
}> {
  const client = getKiteClient();
  const secret = client.getApiSecret();
  if (!secret) {
    throw new KiteConfigError(
      'KITE_API_SECRET is required to exchange a request_token for a session',
    );
  }
  const token = requestToken.trim();
  if (!token) {
    throw new KiteConfigError('request_token is required');
  }

  // generateSession runs BEFORE an access token exists — bypass client.call().
  const session = await withKiteErrors(() => client.sdk.generateSession(token, secret));
  if (!session?.access_token) {
    throw new KiteAuthenticationError('generateSession did not return an access_token');
  }
  client.setAccessToken(session.access_token);
  return {
    access_token: session.access_token,
    user_id: session.user_id,
    login_time: session.login_time,
  };
}
