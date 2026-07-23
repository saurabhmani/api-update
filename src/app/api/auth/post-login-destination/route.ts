import { NextResponse } from 'next/server';
import { requireSession } from '@/lib/session';
import { AuthenticationError } from '@/lib/errors';
import { resolvePostLoginDestination } from '@/lib/broker/connections';

export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store' } as const;

/**
 * GET /api/auth/post-login-destination
 * Returns where an authenticated Quant user should land.
 */
export async function GET() {
  try {
    const user = await requireSession();
    const dest = await resolvePostLoginDestination(user.id);
    const redirectTo =
      dest.path === '/data-source' && dest.reason
        ? `/data-source?reason=${dest.reason}`
        : dest.path;

    return NextResponse.json(
      { redirectTo, ...dest },
      { status: 200, headers: NO_STORE },
    );
  } catch (err) {
    if (err instanceof AuthenticationError) {
      return NextResponse.json(
        { error: 'Unauthorized', redirectTo: '/login' },
        { status: 401, headers: NO_STORE },
      );
    }
    return NextResponse.json(
      { redirectTo: '/data-source' },
      { status: 200, headers: NO_STORE },
    );
  }
}
