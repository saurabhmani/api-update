// ════════════════════════════════════════════════════════════════
//  kiteSession — NEUTRALIZED STUB // @deprecated marker
//  @deprecated — Kite is removed; session never establishes.
//
//  Kite removed; all calls report "login required" / no token. // @deprecated marker
//  Public surface preserved so importers keep compiling while they
//  are migrated off.
// ════════════════════════════════════════════════════════════════

export const SHARED_USER_ID = 0;

export interface KiteSessionTokenResponse { // @deprecated marker
  status: 'success' | 'error';
  data?: {
    user_id:      string;
    user_name:    string;
    access_token: string;
    public_token: string;
    refresh_token?: string;
    api_key:      string;
    login_time?:  string;
  };
  message?: string;
}

export function getKiteLoginUrl(): string { // @deprecated marker
  return 'about:blank';
}

export function computeKiteChecksum( // @deprecated marker
  _apiKey: string,
  _requestToken: string,
  _apiSecret: string,
): string {
  return '';
}

export async function exchangeRequestToken(
  _requestToken: string,
  _appUserId?: number,
): Promise<KiteSessionTokenResponse | null> { // @deprecated marker
  return null;
}

export async function getKiteAccessToken(_appUserId?: number): Promise<string | null> { // @deprecated marker
  return null;
}

export async function validateKiteToken( // @deprecated marker
  _token?: string | null,
): Promise<{ ok: boolean; reason?: string; status?: number; message?: string }> {
  // status:403 makes tokenGuard treat this as a permanent dead-token
  // and short-circuit (exactly the right behaviour — the "token" is
  // structurally absent, not transiently failing).
  return {
    ok:      false,
    reason:  'kite_removed', // @deprecated marker
    status:  403,
    message: 'Kite integration removed — signal-only mode.', // @deprecated marker
  };
}

export type KiteStatus = 'ok' | 'login_required' | 'expired'; // @deprecated marker

export async function getKiteStatus(_appUserId?: number): Promise<KiteStatus> { // @deprecated marker
  return 'login_required';
}

export async function clearKiteAccessToken(_appUserId?: number): Promise<void> { // @deprecated marker
  return;
}
