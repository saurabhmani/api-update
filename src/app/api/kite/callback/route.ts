// ════════════════════════════════════════════════════════════════
//  GET /api/kite/callback?request_token=…&action=login&status=success
//
//  Kite redirects here after the user authorises the app. We:
//    1. Read the request_token from the query string
//    2. Read the app session cookie to identify the logged-in user
//    3. Compute sha256(api_key + request_token + api_secret)
//    4. POST /session/token to Kite to obtain the access_token
//    5. Persist the access_token to kite_tokens linked to user_id
//       (and mirror to SHARED_USER_ID=0 for background workers)
//    6. Ensure the ticker is booted, clear loginRequired, force a
//       reconnect so the WS picks up the fresh token
//    7. Redirect the user to /dashboard
//
//  If the app session is missing, the token is stored under
//  SHARED_USER_ID (0) — this preserves the single-user dev flow
//  where you hit the callback without logging into the app.
//
//  request_token is ONE-TIME USE. Reloading this URL in the browser
//  produces "Token is invalid or has expired" from Kite — we surface
//  that cleanly with kite_error=token_expired_or_reused.
// ════════════════════════════════════════════════════════════════

import { NextRequest, NextResponse } from 'next/server';
import { exchangeRequestToken, SHARED_USER_ID } from '@/lib/marketData/kiteSession';
import { getTicker } from '@/lib/marketData/kiteTicker';
import { bootTickerSafe } from '@/lib/marketData/bootTicker';
import { getSession } from '@/lib/session';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// Resolve a safe absolute redirect URL. Prefer NEXT_PUBLIC_APP_URL
// when it parses, otherwise fall back to the request's own origin
// (new URL(path, req.url) is Next's idiomatic construction and
// cannot produce an invalid URL for a same-origin path).
function safeRedirectUrl(path: string, req: NextRequest): URL {
  const configured = process.env.NEXT_PUBLIC_APP_URL?.trim();
  if (configured) {
    try {
      const base = configured.endsWith('/') ? configured : `${configured}/`;
      return new URL(path.replace(/^\//, ''), base);
    } catch {
      console.warn(
        `[kite/callback] NEXT_PUBLIC_APP_URL is not parseable (${configured}) — ` +
        `falling back to req.url`,
      );
    }
  }
  return new URL(path, req.url);
}

export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  const requestToken = params.get('request_token');
  const status       = params.get('status');

  console.log(
    `[kite/callback] request_token=${requestToken ? requestToken.slice(0, 4) + '…' : 'null'}  status=${status}`,
  );

  if (status === 'error' || !requestToken) {
    const reason = params.get('error_type') ?? 'missing request_token';
    console.warn(`[kite/callback] rejected — ${reason}`);
    const url = safeRedirectUrl('/dashboard', req);
    url.searchParams.set('kite_error', reason);
    return NextResponse.redirect(url);
  }

  const appUser = await getSession();
  const appUserId = appUser?.id ?? SHARED_USER_ID;

  try {
    const { access_token, kite_user_id, kite_user_name } =
      await exchangeRequestToken(requestToken, appUserId);

    const banner = '═'.repeat(72);
    console.log('\n' + banner);
    console.log('  ✓ KITE ACCESS TOKEN ACQUIRED');
    console.log(banner);
    console.log(`  app_user_id  : ${appUserId}${appUser ? ` (${appUser.email})` : ' (shared)'}`);
    console.log(`  kite_user_id : ${kite_user_id ?? '(none)'}`);
    console.log(`  kite_user_nm : ${kite_user_name ?? '(none)'}`);
    console.log(`  api_key      : ${(process.env.KITE_API_KEY ?? '').slice(0, 4)}…[REDACTED]`);
    console.log(`  access_token : ${access_token.slice(0, 4)}…[REDACTED]`);
    console.log(`  stored in    : kite_tokens  (mysql, AES-256-GCM encrypted)`);
    console.log(`  valid until  : ~06:00 IST next day`);
    console.log(banner + '\n');

    // Ensure the ticker singleton is bootstrapped. On a cold process
    // where the server started before the daily OAuth, bootTicker
    // threw and the singleton is idle — this call wires strategy
    // runner + subscribe-on-connect handler BEFORE we kick the socket.
    // Fire-and-forget: bootTickerSafe never throws.
    bootTickerSafe()
      .then((r) => console.log('[kite/callback] bootTickerSafe →', r))
      .catch((e) => console.warn('[kite/callback] bootTickerSafe rejected:', e?.message));

    // Clear the dead-token flag and schedule an immediate reconnect.
    // The ticker's onOpen handler re-applies existing `subs`; the
    // bootTicker 'connect' listener (registered above) runs
    // dynamicSubscriptionSync to (re)populate the universe. Net
    // effect: ticks start flowing within ~1s with no process restart.
    try {
      const ticker = getTicker();
      ticker.clearLoginRequired();
      // clearLoginRequired is a no-op when the flag wasn't set, so
      // also nudge the socket for the first-login-on-fresh-boot path.
      ticker.connect().catch((e: any) =>
        console.warn('[kite/callback] ticker.connect after login failed:', e?.message),
      );
    } catch (e: any) {
      console.warn('[kite/callback] post-exchange ticker wake failed:', e?.message);
    }

    return NextResponse.redirect(safeRedirectUrl('/dashboard', req));
  } catch (err: any) {
    const msg = err?.message ?? 'exchange failed';
    console.error('[kite/callback] exchange failed:', msg);

    // Kite treats request_token as single-use. If the user refreshes
    // the callback URL (or the same token is replayed for any reason),
    // Kite responds with "Token is invalid or has expired". Surface a
    // stable label to the UI so the banner can prompt a fresh login.
    const label = /expired|invalid/i.test(msg)
      ? 'token_expired_or_reused'
      : 'exchange_failed';

    const url = safeRedirectUrl('/dashboard', req);
    url.searchParams.set('kite_error', label);
    return NextResponse.redirect(url);
  }
}
