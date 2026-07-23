import { NextResponse } from 'next/server';
import { requireSession } from '@/lib/session';
import { AuthenticationError } from '@/lib/errors';
import { getSafeBrokerStatus } from '@/lib/broker/connections';

export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store' } as const;

/** GET /api/brokers/status — safe broker connection status (no tokens) */
export async function GET() {
  try {
    const user = await requireSession();
    const status = await getSafeBrokerStatus(user.id);
    return NextResponse.json(status, { status: 200, headers: NO_STORE });
  } catch (err) {
    if (err instanceof AuthenticationError) {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401, headers: NO_STORE },
      );
    }
    return NextResponse.json(
      { error: 'Unable to load broker status' },
      { status: 500, headers: NO_STORE },
    );
  }
}
