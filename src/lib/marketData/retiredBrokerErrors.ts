/**
 * Stub error classes — former Kite SDK errors.
 * Kept so marketDataResolver typechecks without @/lib/kite.
 */

export class KiteAuthenticationError extends Error {
  constructor(message = 'Kite authentication failed (provider removed)') {
    super(message);
    this.name = 'KiteAuthenticationError';
  }
}

export class KiteRateLimitError extends Error {
  constructor(message = 'Kite rate limited (provider removed)') {
    super(message);
    this.name = 'KiteRateLimitError';
  }
}

export class KiteConfigError extends Error {
  constructor(message = 'Kite not configured (provider removed)') {
    super(message);
    this.name = 'KiteConfigError';
  }
}
