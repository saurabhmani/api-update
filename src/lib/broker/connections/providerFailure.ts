/**
 * Provider-agnostic failure classification for broker / data-source sessions.
 *
 * Persistent credential status must NEVER be set to `expired` unless
 * `token_expires_at <= now`. Operational failures stay runtime-only.
 */

export type ProviderFailureCategory =
  | 'token_expired'
  | 'credentials_revoked'
  | 'reauth_required'
  | 'rate_limited'
  | 'provider_unavailable'
  | 'network_error'
  | 'timeout'
  | 'transport_disconnected'
  | 'temporary_auth_failure'
  | 'invalid_request'
  | 'permission_denied'
  | 'unknown_provider_error';

/** Failures that must NOT change persistent credential status. */
export const TEMPORARY_PROVIDER_FAILURES = new Set<ProviderFailureCategory>([
  'rate_limited',
  'provider_unavailable',
  'network_error',
  'timeout',
  'transport_disconnected',
  'temporary_auth_failure',
  'invalid_request',
  'permission_denied',
  'unknown_provider_error',
]);

/** Failures that require persistent credential demotion (not time-expiry). */
export const CREDENTIAL_PROVIDER_FAILURES = new Set<ProviderFailureCategory>([
  'credentials_revoked',
  'reauth_required',
]);

export interface ClassifyProviderFailureInput {
  httpStatus?: number | null;
  providerErrorCode?: string | null;
  providerErrorMessage?: string | null;
  /** Provider-specific confirmed invalid-session / invalid-token signal. */
  confirmedCredentialInvalid?: boolean;
  /** Provider-specific confirmed revocation (token revoked / logout). */
  confirmedCredentialsRevoked?: boolean;
  transport?: 'rest' | 'websocket' | 'refresh' | 'unknown';
}

/**
 * Classify a provider failure into a shared category.
 * Broad words like "fail" / "invalid" alone are NOT enough to demote credentials.
 */
export function classifyProviderFailure(
  input: ClassifyProviderFailureInput,
): ProviderFailureCategory {
  if (input.confirmedCredentialsRevoked) return 'credentials_revoked';
  if (input.confirmedCredentialInvalid) return 'reauth_required';

  const code = (input.providerErrorCode ?? '').trim().toLowerCase();
  const msg = (input.providerErrorMessage ?? '').trim().toLowerCase();
  const status = input.httpStatus ?? null;

  // Explicit provider codes first
  if (
    code === 'tokenexception'
    || code === 'invalid_token'
    || code === 'invalid_session'
    || code === 'session_expired'
    || code === 'token_expired'
  ) {
    // Still not time-expiry — provider says credentials are bad.
    return 'reauth_required';
  }
  if (code === 'revoked' || code === 'token_revoked' || code === 'logout') {
    return 'credentials_revoked';
  }

  // Explicit message phrases (narrow — not /fail|invalid|denied/i alone)
  if (
    /\binvalid\s+session\b/.test(msg)
    || /\bsession\s+expired\b/.test(msg)
    || /\binvalid\s+token\b/.test(msg)
    || /\btoken\s+expired\b/.test(msg)
    || /\bnot\s+logged\s+in\b/.test(msg)
    || /\blogged\s+out\b/.test(msg)
  ) {
    return 'reauth_required';
  }

  if (status === 429 || /rate\s*limit|too\s*many\s*requests/.test(msg)) {
    return 'rate_limited';
  }

  if (
    status === 502
    || status === 503
    || status === 504
    || /bad\s*gateway|service\s*unavailable|gateway\s*timeout|provider\s*outage/.test(msg)
  ) {
    return 'provider_unavailable';
  }

  if (
    /econnrefused|enotfound|econnreset|enetunreach|dns|socket hang up|network/.test(msg)
  ) {
    return 'network_error';
  }

  if (
    status == null
    && (/timeout|timed\s*out|aborted|AbortError/i.test(msg)
      || input.transport === 'websocket' && /disconnect|closed|heartbeat/.test(msg))
  ) {
    if (/timeout|timed\s*out|aborted/.test(msg)) return 'timeout';
    return 'transport_disconnected';
  }

  if (/timeout|timed\s*out|aborted/.test(msg)) return 'timeout';

  if (input.transport === 'websocket') {
    // Streaming failures default to transport — never credential demotion
    // without confirmedCredentialInvalid.
    return 'transport_disconnected';
  }

  // HTTP 403: usually permission/policy, not token expiry
  if (status === 403) {
    if (/scope|permission|forbidden|ip\s*(not\s*)?whitelist|access\s*denied/.test(msg)) {
      return 'permission_denied';
    }
    // Ambiguous 403 without explicit session language → temporary
    return 'temporary_auth_failure';
  }

  // HTTP 401: only demote when message/code confirms invalid credentials
  if (status === 401) {
    if (
      /\binvalid\s+(session|token|credentials)\b/.test(msg)
      || /\bunauthori[sz]ed\b/.test(msg) && /\b(token|session|login)\b/.test(msg)
    ) {
      return 'reauth_required';
    }
    return 'temporary_auth_failure';
  }

  if (status != null && status >= 500) return 'provider_unavailable';
  if (status != null && status >= 400) return 'invalid_request';

  return 'unknown_provider_error';
}

export function shouldPersistCredentialDemotion(
  category: ProviderFailureCategory,
): boolean {
  return CREDENTIAL_PROVIDER_FAILURES.has(category);
}

/**
 * Shoonya-specific confirmation of invalid credentials.
 * Requires an explicit session/token phrase — not generic "fail"/"invalid".
 */
export function isConfirmedShoonyaCredentialInvalid(
  emsg: string | null | undefined,
  opts?: { httpStatus?: number | null; stat?: string | null },
): boolean {
  const msg = (emsg ?? '').trim().toLowerCase();
  if (!msg) return false;
  if (
    /\binvalid\s+session\b/.test(msg)
    || /\bsession\s+expired\b/.test(msg)
    || /\binvalid\s+token\b/.test(msg)
    || /\btoken\s+expired\b/.test(msg)
    || /\bnot\s+logged\s+in\b/.test(msg)
  ) {
    return true;
  }
  // 401 alone is insufficient; require message confirmation above.
  void opts;
  return false;
}

/**
 * Zerodha / Kite TokenException-style confirmation.
 */
export function isConfirmedKiteCredentialInvalid(
  errorType: string | null | undefined,
  message?: string | null,
): boolean {
  const type = (errorType ?? '').trim();
  if (type === 'TokenException') return true;
  const msg = (message ?? '').trim().toLowerCase();
  return (
    /\binvalid\s+token\b/.test(msg)
    || /\btoken\s+expired\b/.test(msg)
    || /\binvalid\s+session\b/.test(msg)
  );
}
