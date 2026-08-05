/**
 * Soft gate for user-facing market APIs.
 *
 * Brokers are optional — IndianAPI is the market-data warehouse.
 * Still requires an authenticated session. When a broker is connected
 * and needs an explicit selection, return 409 so the UI can prompt;
 * otherwise allow through without a broker.
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

    // Soft: only block when the user has multiple connected brokers and
    // must pick one for *trading* / account features — not for market data.
    // Market-data product paths work without any broker.
    if (active.needsSelection && active.connectedProviders.length > 1) {
      return NextResponse.json(
        {
          error: 'Select an active data source',
          code: 'needs_selection',
          redirectTo: '/data-source?reason=select_data_source',
          connectedProviders: active.connectedProviders,
          marketDataAvailable: true,
          note: 'Market data uses IndianAPI; broker selection is optional for quotes/signals.',
        },
        { status: 409, headers: NO_STORE },
      );
    }

    // Allow dashboard / market APIs without a connected broker.
    return { user, active };
  } catch (err) {
    if (err instanceof AuthenticationError) {
      return NextResponse.json(
        { error: 'Unauthorized', code: 'unauthorized' },
        { status: 401, headers: NO_STORE },
      );
    }
    if (err instanceof ActiveDataSourceError) {
      // Soften: do not hard-block product use for missing broker.
      if (err.code === 'none' || err.code === 'not_connected') {
        try {
          const user = await requireSession();
          const active = await getUserActiveDataSource(user.id);
          return { user, active };
        } catch {
          return NextResponse.json(
            { error: 'Unauthorized', code: 'unauthorized' },
            { status: 401, headers: NO_STORE },
          );
        }
      }
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
