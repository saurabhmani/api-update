import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/lib/session';
import { listUserSessions, revokeSession, revokeAllSessions } from '@/lib/security';
import { enforceRateLimit, RATE_LIMITS } from '@/lib/security/rateLimiter';

export const dynamic = 'force-dynamic';

/** GET /api/security/sessions — list active sessions */
export async function GET(req: NextRequest) {
  try {
    await enforceRateLimit(req, RATE_LIMITS.security);
    const user = await requireSession();
    const sessions = await listUserSessions(user.id);
    return NextResponse.json({ ok: true, sessions });
  } catch {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }
}

/** DELETE /api/security/sessions — revoke session(s) */
export async function DELETE(req: NextRequest) {
  try {
    await enforceRateLimit(req, RATE_LIMITS.security);
    const user = await requireSession();
    const body = await req.json().catch(() => ({}));

    if (body.all) {
      const count = await revokeAllSessions(user.id, true, user.email);
      return NextResponse.json({ ok: true, revoked: count });
    }

    if (body.sessionId) {
      const ok = await revokeSession(Number(body.sessionId), user.id, user.email);
      if (!ok) return NextResponse.json({ ok: false, error: 'Session not found' }, { status: 404 });
      return NextResponse.json({ ok: true });
    }

    return NextResponse.json({ ok: false, error: 'sessionId or all required' }, { status: 400 });
  } catch {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }
}
