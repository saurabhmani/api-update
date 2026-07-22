// ════════════════════════════════════════════════════════════════
//  Kite Connect — request_token → session exchange (Phase 5)
//
//  Server-only HTTP exchange against Kite Connect v3.
//  Import via `@/lib/kite/create-session` — never from the client barrel.
// ════════════════════════════════════════════════════════════════

import 'server-only';

import { createHash } from 'node:crypto';
import { getKiteConfig } from './config';
import { KiteConfigError } from './errors';

const KITE_SESSION_TOKEN_URL = 'https://api.kite.trade/session/token';

export interface KiteSessionData {
  userId: string;
  userName: string;
  accessToken: string;
}

export class KiteSessionError extends Error {
  readonly status: number;
  readonly errorType: string;

  constructor(
    message: string,
    options: { status: number; errorType?: string },
  ) {
    super(message);
    this.name = 'KiteSessionError';
    this.status = options.status;
    this.errorType = options.errorType ?? 'UnknownException';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function buildChecksum(apiKey: string, requestToken: string, apiSecret: string): string {
  return createHash('sha256')
    .update(apiKey + requestToken + apiSecret, 'utf8')
    .digest('hex');
}

function parseSuccessPayload(body: unknown): KiteSessionData {
  if (!isRecord(body) || body.status !== 'success' || !isRecord(body.data)) {
    throw new KiteSessionError('Unexpected Kite session response', {
      status: 502,
      errorType: 'DataException',
    });
  }

  const userId = readNonEmptyString(body.data.user_id);
  const userName = readNonEmptyString(body.data.user_name);
  const accessToken = readNonEmptyString(body.data.access_token);

  if (!userId || !userName || !accessToken) {
    throw new KiteSessionError('Kite session response is missing required fields', {
      status: 502,
      errorType: 'DataException',
    });
  }

  return { userId, userName, accessToken };
}

function kiteSessionErrorFromBody(body: unknown, httpStatus: number): KiteSessionError {
  if (isRecord(body)) {
    const message =
      readNonEmptyString(body.message) ?? 'Kite session token exchange failed';
    const errorType =
      readNonEmptyString(body.error_type) ?? 'UnknownException';
    return new KiteSessionError(message, { status: httpStatus, errorType });
  }

  return new KiteSessionError('Kite session token exchange failed', {
    status: httpStatus,
    errorType: 'UnknownException',
  });
}

/**
 * Exchange a Kite `request_token` for a user session (access token).
 */
export async function createKiteSession(requestToken: string): Promise<KiteSessionData> {
  const token = requestToken?.trim();
  if (!token) {
    throw new KiteSessionError('request_token is required', {
      status: 400,
      errorType: 'InputException',
    });
  }

  let apiKey: string;
  let apiSecret: string;
  try {
    ({ apiKey, apiSecret } = getKiteConfig());
  } catch (err) {
    if (err instanceof KiteConfigError) {
      throw new KiteSessionError('Kite is not configured', {
        status: 503,
        errorType: 'InputException',
      });
    }
    throw err;
  }

  const checksum = buildChecksum(apiKey, token, apiSecret);
  const body = new URLSearchParams({
    api_key: apiKey,
    request_token: token,
    checksum,
  });

  let response: Response;
  try {
    response = await fetch(KITE_SESSION_TOKEN_URL, {
      method: 'POST',
      headers: {
        'X-Kite-Version': '3',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
      cache: 'no-store',
    });
  } catch {
    throw new KiteSessionError('Unable to reach Kite API', {
      status: 502,
      errorType: 'NetworkException',
    });
  }

  const rawText = await response.text();
  let parsed: unknown;

  if (!rawText) {
    throw new KiteSessionError('Empty response from Kite API', {
      status: response.ok ? 502 : response.status || 502,
      errorType: 'DataException',
    });
  }

  try {
    parsed = JSON.parse(rawText);
  } catch {
    throw new KiteSessionError('Invalid response from Kite API', {
      status: response.ok ? 502 : response.status || 502,
      errorType: 'DataException',
    });
  }

  if (!response.ok || (isRecord(parsed) && parsed.status === 'error')) {
    throw kiteSessionErrorFromBody(parsed, response.status || 502);
  }

  return parseSuccessPayload(parsed);
}
