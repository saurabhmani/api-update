// ════════════════════════════════════════════════════════════════
//  Kite Connect — typed errors
//
//  Normalization layer over the kiteconnect SDK's thrown payloads
//  (`{ error_type, message, ... }`). Call sites catch these classes
//  instead of raw SDK objects.
// ════════════════════════════════════════════════════════════════

/** Known Kite Connect `error_type` values from the HTTP API. */
export type KiteErrorType =
  | 'TokenException'
  | 'PermissionException'
  | 'InputException'
  | 'OrderException'
  | 'DataException'
  | 'NetworkException'
  | 'GeneralException'
  | 'RateLimitException'
  | 'UnknownException'
  | string;

export interface KiteErrorPayload {
  error_type?: string;
  message?: string;
  status?: string;
  data?: unknown;
  /** HTTP status when available (axios / network path). */
  status_code?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function isKiteErrorPayload(value: unknown): value is KiteErrorPayload {
  if (!isRecord(value)) return false;
  return typeof value.error_type === 'string' || typeof value.message === 'string';
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * Base class for all Kite service errors. Carries the upstream
 * `error_type` and optional HTTP status for logging / metrics.
 */
export class KiteAPIError extends Error {
  readonly errorType: KiteErrorType;
  readonly statusCode: number | null;
  readonly raw: unknown;

  constructor(
    message: string,
    options: {
      errorType?: KiteErrorType;
      statusCode?: number | null;
      raw?: unknown;
      cause?: unknown;
    } = {},
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'KiteAPIError';
    this.errorType = options.errorType ?? 'UnknownException';
    this.statusCode = options.statusCode ?? null;
    this.raw = options.raw ?? null;
    Object.setPrototypeOf(this, new.target.prototype);
  }

  /** Stable, log-friendly one-liner. */
  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      message: this.message,
      error_type: this.errorType,
      status_code: this.statusCode,
    };
  }
}

export class KiteAuthenticationError extends KiteAPIError {
  constructor(
    message: string,
    options: {
      errorType?: KiteErrorType;
      statusCode?: number | null;
      raw?: unknown;
      cause?: unknown;
    } = {},
  ) {
    super(message, {
      ...options,
      errorType: options.errorType ?? 'TokenException',
    });
    this.name = 'KiteAuthenticationError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class KiteRateLimitError extends KiteAPIError {
  constructor(
    message: string,
    options: {
      errorType?: KiteErrorType;
      statusCode?: number | null;
      raw?: unknown;
      cause?: unknown;
    } = {},
  ) {
    super(message, {
      ...options,
      errorType: options.errorType ?? 'RateLimitException',
      statusCode: options.statusCode ?? 429,
    });
    this.name = 'KiteRateLimitError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class KiteConfigError extends KiteAPIError {
  constructor(message: string) {
    super(message, { errorType: 'InputException', statusCode: null });
    this.name = 'KiteConfigError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

function looksLikeRateLimit(payload: KiteErrorPayload, statusCode: number | null): boolean {
  if (statusCode === 429) return true;
  const type = (payload.error_type ?? '').toLowerCase();
  const msg = (payload.message ?? '').toLowerCase();
  return (
    type.includes('ratelimit')
    || type.includes('rate_limit')
    || msg.includes('too many requests')
    || msg.includes('rate limit')
  );
}

function looksLikeAuth(payload: KiteErrorPayload, statusCode: number | null): boolean {
  const type = payload.error_type ?? '';
  if (type === 'TokenException' || type === 'PermissionException') return true;
  if (statusCode === 401 || statusCode === 403) return true;
  return false;
}

/**
 * Convert any thrown SDK / network value into a typed `KiteAPIError`
 * subclass. Idempotent for values that are already instances of our
 * error classes.
 */
export function normalizeKiteError(err: unknown): KiteAPIError {
  if (err instanceof KiteAPIError) return err;

  if (isKiteErrorPayload(err)) {
    const errorType = readString(err.error_type) ?? 'UnknownException';
    const message = readString(err.message) ?? 'Kite API error';
    const statusCode = readNumber(err.status_code) ?? null;
    const options = { errorType, statusCode, raw: err, cause: err };

    if (looksLikeRateLimit(err, statusCode)) {
      return new KiteRateLimitError(message, options);
    }
    if (looksLikeAuth(err, statusCode)) {
      return new KiteAuthenticationError(message, options);
    }
    return new KiteAPIError(message, options);
  }

  if (err instanceof Error) {
    return new KiteAPIError(err.message || 'Kite API error', {
      errorType: 'UnknownException',
      raw: err,
      cause: err,
    });
  }

  return new KiteAPIError('Unknown Kite API failure', {
    errorType: 'UnknownException',
    raw: err,
  });
}

/** Run an async Kite call and rethrow as a typed `KiteAPIError`. */
export async function withKiteErrors<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw normalizeKiteError(err);
  }
}
