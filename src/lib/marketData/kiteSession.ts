// ════════════════════════════════════════════════════════════════
//  kiteSession — NEUTRALIZED STUB
//
//  Kite removed; all calls report "login required" / no token.
//  Public surface preserved so importers keep compiling while they
//  are migrated off.
// ════════════════════════════════════════════════════════════════

export const SHARED_USER_ID = 0;

export interface KiteSessionTokenResponse {
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

export function getKiteLoginUrl(): string {
  return 'about:blank';
}

export function computeKiteChecksum(
  _apiKey: string,
  _requestToken: string,
  _apiSecret: string,
): string {
  return '';
}

export async function exchangeRequestToken(
  _requestToken: string,
  _appUserId?: number,
): Promise<KiteSessionTokenResponse | null> {
  return null;
}

export async function getKiteAccessToken(_appUserId?: number): Promise<string | null> {
  return null;
}

export async function validateKiteToken(
  _token?: string | null,
): Promise<{ ok: boolean; reason?: string; status?: number; message?: string }> {
  // status:403 makes tokenGuard treat this as a permanent dead-token
  // and short-circuit (exactly the right behaviour — the "token" is
  // structurally absent, not transiently failing).
  return {
    ok:      false,
    reason:  'kite_removed',
    status:  403,
    message: 'Kite integration removed — signal-only mode.',
  };
}

export type KiteStatus = 'ok' | 'login_required' | 'expired';

export async function getKiteStatus(_appUserId?: number): Promise<KiteStatus> {
  return 'login_required';
}

export async function clearKiteAccessToken(_appUserId?: number): Promise<void> {
  return;
}
