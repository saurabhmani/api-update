import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/lib/session';
import { AuthenticationError } from '@/lib/errors';
import {
  disconnectDataSourceBroker,
  getBrokerConnectionByUserAndBroker,
  isDataSourceBroker,
} from '@/lib/broker/connections';
import { disconnectBrokerAccount } from '@/lib/broker/repository/brokerRepository';
import { resolveAppBaseUrl } from '@/lib/broker/oauth/appBaseUrl';

export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store' } as const;

type RouteContext = { params: Promise<{ broker: string }> };

function isTrustedOrigin(request: NextRequest): boolean {
  let base: string;
  try {
    base = resolveAppBaseUrl();
  } catch {
    return process.env.NODE_ENV !== 'production';
  }

  const origin = request.headers.get('origin');
  const referer = request.headers.get('referer');
  if (!origin && !referer) {
    return process.env.NODE_ENV !== 'production';
  }
  if (origin && origin.replace(/\/$/, '') === base) return true;
  if (referer && referer.startsWith(`${base}/`)) return true;
  return false;
}

/**
 * POST /api/brokers/:broker/disconnect
 * Clears legacy broker_connections rows only — no SDK/ticker teardown.
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

    const result = await disconnectDataSourceBroker(user.id, broker);

    if (broker === 'zerodha') {
      try {
        await disconnectBrokerAccount(user.id, 'kite');
      } catch { /* optional legacy paper account row */ }
    }

    return NextResponse.json(
      {
        ok: true,
        broker,
        status: 'disconnected',
        needsSelection: result.needsSelection,
        remainingConnected: result.remainingConnected,
        redirectTo: result.redirectTo,
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
