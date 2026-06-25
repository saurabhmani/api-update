import { NextRequest, NextResponse } from 'next/server';
import { requireSession, requireAdmin } from '@/lib/session';
import { getSecurityAuditLog } from '@/lib/security';
import { enforceRateLimit, RATE_LIMITS } from '@/lib/security/rateLimiter';

export const dynamic = 'force-dynamic';

/** GET /api/security/audit — security audit log (own or admin all) */
export async function GET(req: NextRequest) {
  try {
    await enforceRateLimit(req, RATE_LIMITS.security);
    const user = await requireSession();
    const limit = Math.min(200, parseInt(req.nextUrl.searchParams.get('limit') ?? '50', 10));
    const allUsers = req.nextUrl.searchParams.get('all') === 'true';

    if (allUsers) {
      await requireAdmin();
      const entries = await getSecurityAuditLog({ limit });
      return NextResponse.json({ ok: true, entries });
    }

    const entries = await getSecurityAuditLog({ userId: user.id, limit });
    return NextResponse.json({ ok: true, entries });
  } catch (e: unknown) {
    const status = e && typeof e === 'object' && 'statusCode' in e
      ? Number((e as { statusCode: number }).statusCode) : 401;
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : 'Unauthorized' },
      { status },
    );
  }
}
