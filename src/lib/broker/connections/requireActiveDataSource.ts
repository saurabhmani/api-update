/**
 * Gate user-facing market APIs on an authenticated user with an
 * explicit active data source. Never guesses from MARKET_DATA_PROVIDER.
 */

import { NextResponse } from 'next/server';
import { requireSession, type SessionUser } from '@/lib/session';
import { AuthenticationError } from '@/lib/errors';
import {
  ActiveDataSourceError,
  getUserActiveDataSource,
  type UserActiveDataSource,
} from '@/lib/broker/connections';

const NO_STORE = { 'Cache-Control': 'no-store' } as const;

export interface AuthenticatedActiveDataSource {
  user: SessionUser;
  active: UserActiveDataSource;
}

export async function requireAuthenticatedActiveDataSource(): Promise<
  AuthenticatedActiveDataSource | NextResponse
> {
  try {
    const user = await requireSession();
    const active = await getUserActiveDataSource(user.id);

    if (active.needsSelection) {
      return NextResponse.json(
        {
          error: 'Select an active data source',
          code: 'needs_selection',
          redirectTo: '/data-source?reason=select_data_source',
          connectedProviders: active.connectedProviders,
        },
        { status: 409, headers: NO_STORE },
      );
    }

    if (!active.provider || !active.isConnected) {
      return NextResponse.json(
        {
          error: 'No active broker connection',
          code: 'not_connected',
          redirectTo: '/data-source',
        },
        { status: 403, headers: NO_STORE },
      );
    }

    return { user, active };
  } catch (err) {
    if (err instanceof AuthenticationError) {
      return NextResponse.json(
        { error: 'Unauthorized', code: 'unauthorized' },
        { status: 401, headers: NO_STORE },
      );
    }
    if (err instanceof ActiveDataSourceError) {
      return NextResponse.json(
        { error: err.message, code: err.code },
        { status: 403, headers: NO_STORE },
      );
    }
    throw err;
  }
}

export function isNextResponse(value: unknown): value is NextResponse {
  return value instanceof NextResponse;
}
