// ════════════════════════════════════════════════════════════════
//  GET /api/kite/login
//
//  Requires a live app session (q200_session cookie). Redirects to
//  Kite's OAuth login page. After the user authorises, Kite will
//  redirect back to /api/kite/callback on this host, which uses the
//  same session cookie to link the issued access_token to this
//  logged-in user in the kite_tokens table.
// ════════════════════════════════════════════════════════════════

import { NextRequest, NextResponse } from 'next/server';
import { getKiteLoginUrl } from '@/lib/marketData/kiteSession';
import { getSession } from '@/lib/session';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(req: NextRequest) {
  const user = await getSession();
  if (!user) {
    const loginUrl = new URL('/login', req.url);
    loginUrl.searchParams.set('from', '/api/kite/login');
    return NextResponse.redirect(loginUrl);
  }

  try {
    const url = getKiteLoginUrl();
    console.log(`[GET /api/kite/login] user=${user.id} redirecting to ${url}`);
    return NextResponse.redirect(url);
  } catch (err: any) {
    return NextResponse.json(
      { error: err?.message ?? 'kite login url generation failed' },
      { status: 500 },
    );
  }
}
