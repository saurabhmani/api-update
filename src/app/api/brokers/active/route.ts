import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/lib/session';
import { AuthenticationError } from '@/lib/errors';
import {
  ActiveDataSourceError,
  isDataSourceBroker,
  setUserActiveDataSource,
  resolveUserFeedMeta,
  withProviderMeta,
} from '@/lib/broker/connections';
import { resolveAppBaseUrl } from '@/lib/broker/oauth/appBaseUrl';

export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store' } as const;

function isTrustedOrigin(request: NextRequest): boolean {
  let base: string;
  try {
    base = resolveAppBaseUrl();
  } catch {
    return process.env.NODE_ENV !== 'production';
  }
  const origin = request.headers.get('origin');
  const referer = request.headers.get('referer');
  if (!origin && !referer) return process.env.NODE_ENV !== 'production';
  if (origin && origin.replace(/\/$/, '') === base) return true;
  if (referer && referer.startsWith(`${base}/`)) return true;
  return false;
}

/**
 * POST /api/brokers/active
 * Body: { broker: 'zerodha' | 'shoonya' }
 * Persists the user's explicit active data-source preference.
 */
export async function POST(request: NextRequest) {
  try {
    const user = await requireSession();
    if (!isTrustedOrigin(request)) {
      return NextResponse.json(
        { error: 'Invalid request origin' },
        { status: 403, headers: NO_STORE },
      );
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json(
        { error: 'Invalid JSON body' },
        { status: 400, headers: NO_STORE },
      );
    }

    const brokerRaw =
      body && typeof body === 'object' && 'broker' in body
        ? String((body as { broker?: unknown }).broker ?? '').trim().toLowerCase()
        : '';

    if (!isDataSourceBroker(brokerRaw)) {
      return NextResponse.json(
        { error: 'broker must be zerodha or shoonya' },
        { status: 400, headers: NO_STORE },
      );
    }

    const active = await setUserActiveDataSource(user.id, brokerRaw);
    const feedMeta = await resolveUserFeedMeta(user.id);
    return NextResponse.json(
      withProviderMeta(
        {
          ok: true,
          activeDataSource: active.provider,
          needsSelection: active.needsSelection,
          connectedProviders: active.connectedProviders,
        },
        { provider: feedMeta.provider, status: feedMeta.status },
      ),
      { status: 200, headers: NO_STORE },
    );
  } catch (err) {
    if (err instanceof AuthenticationError) {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401, headers: NO_STORE },
      );
    }
    if (err instanceof ActiveDataSourceError) {
      return NextResponse.json(
        { error: err.message, code: err.code },
        { status: err.code === 'not_connected' ? 409 : 400, headers: NO_STORE },
      );
    }
    return NextResponse.json(
      { error: 'Unable to set active data source' },
      { status: 500, headers: NO_STORE },
    );
  }
}
