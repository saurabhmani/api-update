// Shoonya OAuth — server-only token exchange

import crypto from 'crypto';
import { parseBrokerTokenExpiry } from '../connections/expiry';

export class ShoonyaConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ShoonyaConfigError';
  }
}

export class ShoonyaExchangeError extends Error {
  readonly status: number;
  /** Sanitized broker message (emsg) — never contains tokens/codes. */
  readonly brokerMessage: string | null;

  constructor(message: string, status = 502, brokerMessage: string | null = null) {
    super(message);
    this.name = 'ShoonyaExchangeError';
    this.status = status;
    this.brokerMessage = brokerMessage;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export interface ShoonyaConfig {
  clientId: string;
  secretCode: string;
  /** Noren uid required by live GenAcsTok (usually client id without `_U`). */
  uid: string;
  redirectUrl: string;
  authorizeUrl: string;
  tokenUrl: string;
}

const DEFAULT_AUTHORIZE_URL = 'https://trade.shoonya.com/OAuthlogin/authorize/oauth';
const DEFAULT_TOKEN_URL = 'https://api.shoonya.com/NorenWClientAPI/GenAcsTok';

function readRequired(name: string): string {
  const value = process.env[name]?.trim() ?? '';
  if (!value) {
    throw new ShoonyaConfigError(`${name} is not configured`);
  }
  return value;
}

function assertTrustedHttpsUrl(url: string, envName: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ShoonyaConfigError(`${envName} must be a valid absolute URL`);
  }
  if (parsed.protocol !== 'https:') {
    throw new ShoonyaConfigError(`${envName} must use https://`);
  }
  return url;
}

/**
 * GenAcsTok `uid` is the trading user id (e.g. FN213349), NOT the OAuth
 * app client id (FN213349_U). If SHOONYA_UID is unset or accidentally set
 * to the client id, derive by stripping a trailing `_U`.
 */
export function resolveShoonyaUid(clientId: string, configuredUid?: string | null): string {
  const explicit = (configuredUid ?? '').trim();
  if (explicit && explicit !== clientId) return explicit;

  const stripped = clientId.replace(/_U$/i, '').trim();
  if (stripped && stripped !== clientId) return stripped;

  if (explicit) return explicit;
  throw new ShoonyaConfigError(
    'SHOONYA_UID is required (trading user id, usually CLIENT_ID without the _U suffix)',
  );
}

export function getShoonyaConfig(): ShoonyaConfig {
  const clientId = readRequired('SHOONYA_CLIENT_ID');
  const secretCode = readRequired('SHOONYA_SECRET_CODE');
  const uid = resolveShoonyaUid(clientId, process.env.SHOONYA_UID);
  const redirectUrl =
    process.env.SHOONYA_REDIRECT_URL?.trim()
    || `${resolveAppBaseUrl()}/api/brokers/shoonya/callback`;
  const authorizeUrl = assertTrustedHttpsUrl(
    process.env.SHOONYA_AUTHORIZE_URL?.trim() || DEFAULT_AUTHORIZE_URL,
    'SHOONYA_AUTHORIZE_URL',
  );
  const tokenUrl = assertTrustedHttpsUrl(
    process.env.SHOONYA_TOKEN_URL?.trim() || DEFAULT_TOKEN_URL,
    'SHOONYA_TOKEN_URL',
  );

  return {
    clientId,
    secretCode,
    uid,
    redirectUrl,
    authorizeUrl,
    tokenUrl,
  };
}

/**
 * Trusted app origin for redirects. Never derived from the request Host header.
 */
export function resolveAppBaseUrl(): string {
  const base =
    process.env.APP_BASE_URL?.trim()
    || process.env.APP_URL?.trim()
    || process.env.NEXT_PUBLIC_APP_URL?.trim()
    || '';

  if (!base) {
    if (process.env.NODE_ENV === 'production') {
      throw new ShoonyaConfigError('APP_BASE_URL is required in production');
    }
    return 'http://localhost:3000';
  }

  return base.replace(/\/$/, '');
}

/**
 * Shoonya checksum:
 * SHA256(CLIENT_ID + SECRET_CODE + AUTHORIZATION_CODE)
 * Concatenate raw values with no separators.
 */
export function generateShoonyaChecksum(
  clientId: string,
  secretCode: string,
  authorizationCode: string,
): string {
  const payload = `${clientId}${secretCode}${authorizationCode}`;
  return crypto.createHash('sha256').update(payload).digest('hex');
}

export function buildShoonyaAuthorizeUrl(
  clientId: string,
  authorizeUrl: string = DEFAULT_AUTHORIZE_URL,
): string {
  const params = new URLSearchParams({ client_id: clientId });
  return `${authorizeUrl}?${params.toString()}`;
}

export interface ShoonyaTokenResult {
  accessToken: string;
  refreshToken?: string;
  accountId?: string;
  userName?: string;
  /** UTC ISO timestamp when token expires, if known. */
  expiresAt?: string;
  /** Sanitized raw expiry field value for diagnostics (never a secret). */
  rawExpiresIn?: string | number | null;
  rawKeys: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function pickString(obj: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return undefined;
}

function sanitizeBrokerMessage(raw: string | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim().slice(0, 200);
  // Drop anything that looks like a token/code fragment.
  if (/[a-f0-9]{32,}/i.test(trimmed) && /token|code|checksum/i.test(trimmed)) {
    return trimmed.replace(/[a-f0-9]{16,}/gi, '[redacted]');
  }
  return trimmed || null;
}

function pickExpiryField(obj: Record<string, unknown>): {
  parsed: Date | null;
  raw: string | number | null;
  key: string | null;
} {
  for (const key of ['expires_in', 'expiresIn', 'expiry', 'expires_at', 'exch_tm']) {
    if (!(key in obj)) continue;
    const rawValue = obj[key];
    const raw =
      typeof rawValue === 'string' || typeof rawValue === 'number'
        ? rawValue
        : rawValue == null
          ? null
          : String(rawValue);
    return {
      parsed: parseBrokerTokenExpiry(rawValue),
      raw,
      key,
    };
  }
  return { parsed: null, raw: null, key: null };
}

/**
 * Exchange authorization code for access token.
 * Body must be `jData=<json>` (Finvasia / OpenAlgo use text/plain).
 */
export async function exchangeShoonyaAuthorizationCode(
  authorizationCode: string,
  config: ShoonyaConfig = getShoonyaConfig(),
  fetchImpl: typeof fetch = fetch,
): Promise<ShoonyaTokenResult> {
  const checksum = generateShoonyaChecksum(
    config.clientId,
    config.secretCode,
    authorizationCode,
  );

  const payload = {
    code: authorizationCode,
    checksum,
    uid: config.uid,
  };

  // Match Finvasia NorenRestApiOAuth / OpenAlgo: text/plain body `jData={...}`
  const body = `jData=${JSON.stringify(payload)}`;

  let response: Response;
  try {
    response = await fetchImpl(config.tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/plain',
      },
      body,
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    const msg = err instanceof Error && err.name === 'TimeoutError'
      ? 'Shoonya token exchange timed out'
      : 'Unable to reach Shoonya API';
    throw new ShoonyaExchangeError(msg, 504);
  }

  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ShoonyaExchangeError('Invalid response from Shoonya API', 502);
  }

  if (!isRecord(parsed)) {
    throw new ShoonyaExchangeError('Unexpected Shoonya token response', 502);
  }

  const brokerMessage = sanitizeBrokerMessage(
    pickString(parsed, ['emsg', 'message', 'error', 'Error']),
  );

  if (!response.ok) {
    throw new ShoonyaExchangeError(
      'Shoonya token exchange failed',
      response.status >= 400 ? response.status : 502,
      brokerMessage,
    );
  }

  // Success is keyed on access_token presence (stat may be absent).
  const nested = isRecord(parsed.data) ? parsed.data : parsed;
  const accessToken = pickString(nested, [
    'access_token',
    'AccessToken',
    'susertoken',
    'token',
    'actid_token',
  ]);

  if (!accessToken) {
    const status = pickString(parsed, ['stat', 'status', 'Status']);
    if (status && /not_?ok|error|fail/i.test(status)) {
      throw new ShoonyaExchangeError(
        'Shoonya rejected the authorization code',
        401,
        brokerMessage,
      );
    }
    throw new ShoonyaExchangeError(
      'Shoonya response missing access token',
      502,
      brokerMessage,
    );
  }

  const expiry = pickExpiryField(nested);
  return {
    accessToken,
    refreshToken: pickString(nested, ['refresh_token', 'RefreshToken']),
    accountId: pickString(nested, ['actid', 'account_id', 'uid', 'user_id', 'client']),
    userName: pickString(nested, ['uname', 'user_name', 'name']),
    expiresAt: expiry.parsed ? expiry.parsed.toISOString() : undefined,
    rawExpiresIn: expiry.raw,
    rawKeys: Object.keys(nested),
  };
}
