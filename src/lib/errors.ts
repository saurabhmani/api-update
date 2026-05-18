// ════════════════════════════════════════════════════════════════
//  Error Hierarchy — Typed errors with HTTP status codes
//
//  Usage:
//    import { ValidationError, NotFoundError } from '@/lib/errors';
//    throw new ValidationError('Missing required field: symbol');
//    throw new NotFoundError('Instrument', symbol);
//
//  All errors extend AppError which serialises to a consistent
//  JSON shape for the API handler.
// ════════════════════════════════════════════════════════════════

export class AppError extends Error {
  public readonly statusCode: number;
  public readonly code: string;
  public readonly isOperational: boolean;
  public readonly details?: unknown;

  constructor(
    message: string,
    statusCode: number,
    code: string,
    details?: unknown,
    isOperational = true,
  ) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    this.isOperational = isOperational;
    this.details = details;
    Object.setPrototypeOf(this, new.target.prototype);
  }

  toJSON(): Record<string, unknown> {
    return {
      error: this.message,
      code: this.code,
      statusCode: this.statusCode,
      ...(this.details !== undefined ? { details: this.details } : {}),
    };
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: unknown) {
    super(message, 400, 'VALIDATION_ERROR', details);
    this.name = 'ValidationError';
  }
}

export class AuthenticationError extends AppError {
  constructor(message = 'Authentication required') {
    super(message, 401, 'AUTHENTICATION_ERROR');
    this.name = 'AuthenticationError';
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'Insufficient permissions') {
    super(message, 403, 'FORBIDDEN');
    this.name = 'ForbiddenError';
  }
}

export class NotFoundError extends AppError {
  constructor(resource: string, identifier?: string | number) {
    const msg = identifier
      ? `${resource} not found: ${identifier}`
      : `${resource} not found`;
    super(msg, 404, 'NOT_FOUND');
    this.name = 'NotFoundError';
  }
}

export class ConflictError extends AppError {
  constructor(message: string, details?: unknown) {
    super(message, 409, 'CONFLICT', details);
    this.name = 'ConflictError';
  }
}

export class RateLimitError extends AppError {
  constructor(message = 'Too many requests') {
    super(message, 429, 'RATE_LIMIT');
    this.name = 'RateLimitError';
  }
}

export class DatabaseError extends AppError {
  constructor(message: string, details?: unknown) {
    super(message, 500, 'DATABASE_ERROR', details, false);
    this.name = 'DatabaseError';
  }
}

export class ExternalServiceError extends AppError {
  constructor(service: string, message: string, details?: unknown) {
    super(`${service}: ${message}`, 502, 'EXTERNAL_SERVICE_ERROR', details);
    this.name = 'ExternalServiceError';
  }
}

/** Type guard: is this error one we threw intentionally? */
export function isOperationalError(err: unknown): err is AppError {
  return err instanceof AppError && err.isOperational;
}

/**
 * DIGEST-CRASH-FIX-2026-05 — universal unknown-to-Error normaliser.
 *
 * Next.js's `app-page.runtime.prod.js` reads `error.digest` on every
 * thrown value to detect framework-specific errors (redirect, notFound,
 * authentication). When something throws / rejects with `null`,
 * `undefined`, a plain object, a `Response`, or a string, the framework
 * crashes with:
 *
 *   TypeError: Cannot read properties of null (reading 'digest')
 *
 * This helper converts any unknown rejection / catch value into a real
 * Error instance with `.message`, `.stack`, and a stable `.digest`
 * string so the framework's error path never sees a null. It is the
 * single defensive wrapper for every catch / rethrow / error-boundary
 * surface that may receive a non-Error.
 *
 * Idempotent: passing in a real Error returns it unchanged (preserves
 * the original stack). Adds `digest` only when missing so existing
 * framework-specific errors (NEXT_REDIRECT, NEXT_NOT_FOUND, …) keep
 * their identity.
 */
export function normalizeError(raw: unknown): Error & { digest?: string } {
  // Already a real Error — preserve everything; only stamp a digest if
  // the framework hasn't already set one.
  if (raw instanceof Error) {
    if (!(raw as { digest?: string }).digest) {
      (raw as { digest?: string }).digest = raw.name || 'Error';
    }
    return raw as Error & { digest?: string };
  }
  // Response thrown (legacy `requireSession()` pattern). Surface the
  // status as the error message and tag the digest so the framework's
  // error path can still classify it.
  if (raw instanceof Response) {
    const e = new Error(`Response thrown: HTTP ${raw.status}`) as Error & { digest?: string };
    e.name   = 'ResponseThrown';
    e.digest = `RESPONSE_${raw.status}`;
    return e;
  }
  // null / undefined / primitive — the exact case that crashed the
  // framework. Synthesise a labelled Error so .digest access is safe.
  if (raw == null) {
    const e = new Error(`Null or undefined thrown (value=${String(raw)})`) as Error & { digest?: string };
    e.name   = 'NullThrown';
    e.digest = 'NULL_THROWN';
    return e;
  }
  // Plain object / string / number / boolean — JSON-stringify so the
  // original payload is recoverable from logs, and stamp a generic
  // digest so the framework reader is satisfied.
  let message: string;
  try {
    message = typeof raw === 'string' ? raw : JSON.stringify(raw);
  } catch {
    message = String(raw);
  }
  const e = new Error(message || 'Unknown non-Error thrown') as Error & { digest?: string };
  e.name   = 'NonErrorThrown';
  e.digest = 'NON_ERROR_THROWN';
  return e;
}

/**
 * Safe message extractor for UI error boundaries. Never throws, never
 * returns null/undefined. Use in error.tsx / global-error.tsx where
 * the framework may hand us a partially-formed error object.
 */
export function extractErrorMessage(raw: unknown, fallback = 'An unexpected error occurred'): string {
  if (raw == null) return fallback;
  if (typeof raw === 'string' && raw.trim().length > 0) return raw;
  if (raw instanceof Error && raw.message) return raw.message;
  if (typeof raw === 'object') {
    const m = (raw as { message?: unknown }).message;
    if (typeof m === 'string' && m.trim().length > 0) return m;
  }
  return fallback;
}
