import { NextRequest, NextResponse } from 'next/server';
import { requireSession, requireAdmin } from '@/lib/session';
import { enforceRateLimit, RATE_LIMITS } from '@/lib/security/rateLimiter';
import { listSecurityEvents } from '@/lib/security/repository/securityRepository';
import { hasPermissionAsync } from '@/lib/security/rbac';

export const dynamic = 'force-dynamic';

/** GET /api/security/events — security event stream */
export async function GET(req: NextRequest) {
  try {
    await enforceRateLimit(req, RATE_LIMITS.security);
    const user = await requireSession();
    const limit = Math.min(200, parseInt(req.nextUrl.searchParams.get('limit') ?? '100', 10));
    const all = req.nextUrl.searchParams.get('all') === 'true';

    const canViewAll = user.role === 'admin' || await hasPermissionAsync(user.role, 'admin:audit');
    if (all && !canViewAll) {
      return NextResponse.json({ ok: false, error: 'Forbidden' }, { status: 403 });
    }

    const events = await listSecurityEvents({
      userId: all && canViewAll ? undefined : user.id,
      limit,
    });

    return NextResponse.json({ ok: true, events, count: events.length });
  } catch (e: unknown) {
    const status = e && typeof e === 'object' && 'statusCode' in e
      ? Number((e as { statusCode: number }).statusCode) : 401;
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : 'Unauthorized' },
      { status },
    );
  }
}
