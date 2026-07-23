import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/lib/session';
import { AuthenticationError } from '@/lib/errors';
import {
  getBrokerConnectionByUserAndBroker,
  isDataSourceBroker,
  markBrokerConnectionStatus,
} from '@/lib/broker/connections';
import { clearActiveKiteSession } from '@/lib/kite/active-session-store';
import { resetKiteClient } from '@/lib/kite/client';
import { disconnectBrokerAccount } from '@/lib/broker/repository/brokerRepository';
import { resolveAppBaseUrl } from '@/lib/broker/oauth/shoonya';

export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store' } as const;

type RouteContext = { params: Promise<{ broker: string }> };

function isTrustedOrigin(request: NextRequest): boolean {
  // SameSite=lax cookies already block most cross-site POSTs. Additionally
  // require Origin/Referer to match the configured app base when present.
  let base: string;
  try {
    base = resolveAppBaseUrl();
  } catch {
    return process.env.NODE_ENV !== 'production';
  }

  const origin = request.headers.get('origin');
  const referer = request.headers.get('referer');
  if (!origin && !referer) {
    // Non-browser clients (same-site fetch usually sends Origin). Reject in prod.
    return process.env.NODE_ENV !== 'production';
  }
  if (origin && origin.replace(/\/$/, '') === base) return true;
  if (referer && referer.startsWith(`${base}/`)) return true;
  return false;
}

/**
 * POST /api/brokers/:broker/disconnect
 * Invalidates stored credentials and marks the connection disconnected.
 */
export async function POST(request: NextRequest, context: RouteContext) {
  try {
    const user = await requireSession();

    if (!isTrustedOrigin(request)) {
      return NextResponse.json(
        { error: 'Invalid request origin' },
        { status: 403, headers: NO_STORE },
      );
    }

    const { broker: raw } = await context.params;
    const broker = raw?.trim().toLowerCase();

    if (!broker || !isDataSourceBroker(broker)) {
      return NextResponse.json(
        { error: 'Unknown broker' },
        { status: 400, headers: NO_STORE },
      );
    }

    const conn = await getBrokerConnectionByUserAndBroker(user.id, broker);
    if (!conn || conn.userId !== user.id) {
      return NextResponse.json(
        { error: 'No broker connection found' },
        { status: 404, headers: NO_STORE },
      );
    }

    await markBrokerConnectionStatus(user.id, broker, 'disconnected', true);

    if (broker === 'zerodha') {
      try {
        await clearActiveKiteSession();
        resetKiteClient();
      } catch { /* optional */ }
      try {
        await disconnectBrokerAccount(user.id, 'kite');
      } catch { /* optional */ }
    }

    return NextResponse.json(
      {
        ok: true,
        broker,
        status: 'disconnected',
        redirectTo: '/data-source',
      },
      { status: 200, headers: NO_STORE },
    );
  } catch (err) {
    if (err instanceof AuthenticationError) {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401, headers: NO_STORE },
      );
    }
    return NextResponse.json(
      { error: 'Unable to disconnect broker' },
      { status: 500, headers: NO_STORE },
    );
  }
}
