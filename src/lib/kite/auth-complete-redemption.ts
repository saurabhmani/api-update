/**
 * Redeem an opaque Kite completion code.
 * Never stores broker access tokens in browser storage.
 */

type RedemptionResult =
  | { ok: true; kiteUserId: string; authenticatedAt: string }
  | { ok: false; message: string };

const AUTH_COMPLETE_PAGE_KEY = '/kite/auth-complete';
const capturedCompletionCodes = new Map<string, string>();
const inFlightRedemptions = new Map<string, Promise<RedemptionResult>>();

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export function resolveCompletionCode(fragmentCode: string | null): string | null {
  if (fragmentCode) {
    capturedCompletionCodes.set(AUTH_COMPLETE_PAGE_KEY, fragmentCode);
    return fragmentCode;
  }

  return capturedCompletionCodes.get(AUTH_COMPLETE_PAGE_KEY) ?? null;
}

function clearCapturedCompletionCode(): void {
  capturedCompletionCodes.delete(AUTH_COMPLETE_PAGE_KEY);
}

export function redeemCompletionCode(completionCode: string): Promise<RedemptionResult> {
  const existing = inFlightRedemptions.get(completionCode);
  if (existing) return existing;

  const promise = (async (): Promise<RedemptionResult> => {
    try {
      const response = await fetch('/api/kite/auth/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        cache: 'no-store',
        body: JSON.stringify({ code: completionCode }),
      });

      let data: unknown;
      try {
        data = await response.json();
      } catch {
        return { ok: false, message: 'Invalid response from the server. Please try again.' };
      }

      if (!response.ok) {
        const errorMessage =
          data
          && typeof data === 'object'
          && !Array.isArray(data)
          && typeof (data as { error?: unknown }).error === 'string'
            ? (data as { error: string }).error
            : 'Kite authentication could not be completed.';
        return { ok: false, message: errorMessage };
      }

      const payload = data as Record<string, unknown>;
      if (isNonEmptyString(payload.accessToken)) {
        // Hard reject any accidental token leakage from the API.
        return { ok: false, message: 'Invalid session data received. Please try again.' };
      }

      const kiteUserId = payload.kiteUserId;
      if (!isNonEmptyString(kiteUserId)) {
        return { ok: false, message: 'Invalid session data received. Please try again.' };
      }

      const authenticatedAt = isNonEmptyString(payload.authenticatedAt)
        ? payload.authenticatedAt.trim()
        : new Date().toISOString();

      // Clear any legacy browser-held Kite tokens from earlier builds.
      try {
        const { clearKiteSession } = await import('@/lib/kite/browser-session');
        clearKiteSession();
      } catch {
        // ignore
      }

      return {
        ok: true,
        kiteUserId: kiteUserId.trim(),
        authenticatedAt,
      };
    } catch {
      return { ok: false, message: 'Network error. Please try again.' };
    }
  })().finally(() => {
    inFlightRedemptions.delete(completionCode);
    clearCapturedCompletionCode();
  });

  inFlightRedemptions.set(completionCode, promise);
  return promise;
}

export function hasCapturedCompletionCode(): boolean {
  return capturedCompletionCodes.has(AUTH_COMPLETE_PAGE_KEY);
}

export function isRedemptionInFlight(completionCode: string): boolean {
  return inFlightRedemptions.has(completionCode);
}

export function resetAuthCompleteRedemptionState(): void {
  capturedCompletionCodes.clear();
  inFlightRedemptions.clear();
}

export function getInFlightRedemptionCount(): number {
  return inFlightRedemptions.size;
}
