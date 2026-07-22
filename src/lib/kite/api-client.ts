import 'server-only';

import { getKiteConfig } from './config';
import { KiteConfigError } from './errors';

export const KITE_API_BASE_URL = 'https://api.kite.trade';
export const KITE_API_TIMEOUT_MS = 10_000;

export type KiteApiErrorClassification =
  | 'invalid_token'
  | 'rate_limited'
  | 'upstream'
  | 'network'
  | 'invalid_response'
  | 'configuration';

export type KiteAuthenticatedHttpMethod = 'GET' | 'DELETE';

export type KiteCredentialMode = 'authorization' | 'form';

export interface KiteAuthenticatedRequestOptions {
  method: KiteAuthenticatedHttpMethod;
  path: string;
  accessToken: string;
  credentialMode?: KiteCredentialMode;
  formFields?: Record<string, string>;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface KiteApiResponse {
  httpStatus: number;
  body: unknown | null;
  empty: boolean;
  kiteErrorType: string | null;
  kiteStatus: 'success' | 'error' | null;
}

export class KiteApiError extends Error {
  readonly status: number;
  readonly classification: KiteApiErrorClassification;
  readonly kiteErrorType: string | null;

  constructor(
    message: string,
    options: {
      status: number;
      classification: KiteApiErrorClassification;
      kiteErrorType?: string | null;
    },
  ) {
    super(message);
    this.name = 'KiteApiError';
    this.status = options.status;
    this.classification = options.classification;
    this.kiteErrorType = options.kiteErrorType ?? null;
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

function readKiteErrorType(body: unknown): string | null {
  if (!isRecord(body) || body.status !== 'error') return null;
  return readNonEmptyString(body.error_type) ?? null;
}

function readKiteStatus(body: unknown): 'success' | 'error' | null {
  if (!isRecord(body)) return null;
  if (body.status === 'success') return 'success';
  if (body.status === 'error') return 'error';
  return null;
}

function isRedirectStatus(status: number): boolean {
  return status >= 300 && status < 400;
}

function isRateLimitStatus(status: number, kiteErrorType: string | null): boolean {
  if (status === 429) return true;
  if (!kiteErrorType) return false;
  const normalized = kiteErrorType.toLowerCase();
  return normalized.includes('ratelimit') || normalized.includes('rate_limit');
}

export function validateKiteApiPath(path: string): string {
  const trimmed = path.trim();
  if (!trimmed.startsWith('/')) {
    throw new KiteApiError('Invalid Kite API path', {
      status: 400,
      classification: 'invalid_response',
    });
  }

  if (
    trimmed.startsWith('//')
    || trimmed.includes('://')
    || trimmed.includes('\\')
    || trimmed.includes('#')
    || trimmed.includes('@')
  ) {
    throw new KiteApiError('Invalid Kite API path', {
      status: 400,
      classification: 'invalid_response',
    });
  }

  return trimmed;
}

function buildRequestUrl(path: string): string {
  return new URL(validateKiteApiPath(path), KITE_API_BASE_URL).toString();
}

function requireAccessToken(accessToken: string): string {
  const trimmed = accessToken.trim();
  if (!trimmed) {
    throw new KiteApiError('Kite access token is required', {
      status: 401,
      classification: 'invalid_token',
    });
  }
  return trimmed;
}

function createAbortSignal(
  incoming: AbortSignal | undefined,
  timeoutMs: number,
): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let abortListener: (() => void) | undefined;

  const cleanup = () => {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
    if (incoming && abortListener) {
      incoming.removeEventListener('abort', abortListener);
    }
  };

  if (incoming?.aborted) {
    controller.abort();
    return { signal: controller.signal, cleanup };
  }

  timeoutId = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  if (incoming) {
    abortListener = () => controller.abort();
    incoming.addEventListener('abort', abortListener, { once: true });
  }

  return { signal: controller.signal, cleanup };
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}

function buildHeaders(
  apiKey: string,
  accessToken: string,
  credentialMode: KiteCredentialMode,
  formFields: Record<string, string> | undefined,
  method: KiteAuthenticatedHttpMethod,
): Headers {
  const headers = new Headers({
    'X-Kite-Version': '3',
  });

  if (credentialMode === 'authorization') {
    headers.set('Authorization', `token ${apiKey}:${accessToken}`);
    return headers;
  }

  if (method !== 'DELETE') {
    throw new KiteApiError('Form credentials are only supported for DELETE requests', {
      status: 400,
      classification: 'invalid_response',
    });
  }

  headers.set('Content-Type', 'application/x-www-form-urlencoded');
  return headers;
}

function buildBody(
  apiKey: string,
  accessToken: string,
  credentialMode: KiteCredentialMode,
  formFields: Record<string, string> | undefined,
): string | undefined {
  if (credentialMode !== 'form') return undefined;

  const params = new URLSearchParams({
    api_key: apiKey,
    access_token: accessToken,
    ...formFields,
  });
  return params.toString();
}

function parseResponseBody(rawText: string): unknown {
  try {
    return JSON.parse(rawText) as unknown;
  } catch {
    throw new KiteApiError('Invalid response from Kite API', {
      status: 502,
      classification: 'invalid_response',
    });
  }
}

export function isKiteInvalidToken(response: KiteApiResponse): boolean {
  if (response.httpStatus === 401 || response.httpStatus === 403) return true;
  return response.kiteErrorType === 'TokenException';
}

export function isKiteRateLimited(response: KiteApiResponse): boolean {
  return isRateLimitStatus(response.httpStatus, response.kiteErrorType);
}

export function classifyKiteApiResponse(response: KiteApiResponse): KiteApiErrorClassification | 'success' {
  if (response.httpStatus >= 200 && response.httpStatus < 300 && response.kiteStatus !== 'error') {
    return 'success';
  }

  if (isKiteInvalidToken(response)) return 'invalid_token';
  if (isKiteRateLimited(response)) return 'rate_limited';
  if (response.httpStatus >= 500) return 'upstream';
  return 'upstream';
}

export async function kiteAuthenticatedRequest(
  options: KiteAuthenticatedRequestOptions,
): Promise<KiteApiResponse> {
  const accessToken = requireAccessToken(options.accessToken);
  const path = validateKiteApiPath(options.path);
  const credentialMode = options.credentialMode ?? 'authorization';
  const timeoutMs = options.timeoutMs ?? KITE_API_TIMEOUT_MS;

  let apiKey: string;
  try {
    ({ apiKey } = getKiteConfig());
  } catch (err) {
    if (err instanceof KiteConfigError) {
      throw new KiteApiError('Kite is not configured', {
        status: 503,
        classification: 'configuration',
      });
    }
    throw err;
  }

  const url = buildRequestUrl(path);
  const headers = buildHeaders(apiKey, accessToken, credentialMode, options.formFields, options.method);
  const body = buildBody(apiKey, accessToken, credentialMode, options.formFields);
  const { signal, cleanup } = createAbortSignal(options.signal, timeoutMs);

  try {
    const response = await fetch(url, {
      method: options.method,
      headers,
      body,
      cache: 'no-store',
      redirect: 'manual',
      signal,
    });

    if (isRedirectStatus(response.status)) {
      throw new KiteApiError('Kite API redirect rejected', {
        status: 502,
        classification: 'upstream',
      });
    }

    const rawText = await response.text();
    let parsed: unknown | null = null;

    if (rawText) {
      try {
        parsed = parseResponseBody(rawText);
      } catch (err) {
        if (response.ok) {
          return {
            httpStatus: response.status,
            body: null,
            empty: true,
            kiteErrorType: null,
            kiteStatus: null,
          };
        }
        throw err;
      }
    }

    return {
      httpStatus: response.status,
      body: parsed,
      empty: !rawText,
      kiteErrorType: readKiteErrorType(parsed),
      kiteStatus: readKiteStatus(parsed),
    };
  } catch (err) {
    if (err instanceof KiteApiError) throw err;

    if (isAbortError(err)) {
      throw new KiteApiError('Kite API request timed out', {
        status: 502,
        classification: 'network',
      });
    }

    throw new KiteApiError('Unable to reach Kite API', {
      status: 502,
      classification: 'network',
    });
  } finally {
    cleanup();
  }
}
