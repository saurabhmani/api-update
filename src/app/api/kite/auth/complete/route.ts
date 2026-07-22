import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/lib/session';
import { AuthenticationError } from '@/lib/errors';
import { consumeKiteCompletionCode } from '@/lib/kite/completion-store';

export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store' } as const;

function jsonError(message: string, status: number): NextResponse {
  return NextResponse.json({ ok: false, error: message }, { status, headers: NO_STORE });
}

/** POST /api/kite/auth/complete — redeem a one-time Kite completion code */
export async function POST(request: NextRequest) {
  try {
    const user = await requireSession();
    const quantorusUserId = String(user.id);

    const body: unknown = await request.json().catch(() => null);
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return jsonError('Invalid request body', 400);
    }

    const code = (body as { code?: unknown }).code;
    if (typeof code !== 'string' || !code.trim()) {
      return jsonError('code is required', 400);
    }

    const session = await consumeKiteCompletionCode(code.trim(), quantorusUserId);
    if (!session) {
      return jsonError('Invalid or expired completion code', 401);
    }

    return NextResponse.json(
      {
        kiteUserId: session.kiteUserId,
        accessToken: session.accessToken,
      },
      { status: 200, headers: NO_STORE },
    );
  } catch (err) {
    if (err instanceof AuthenticationError) {
      return jsonError('Unauthorized', 401);
    }

    return jsonError('Unable to complete Kite authentication', 500);
  }
}
