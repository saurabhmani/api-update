import { NextRequest, NextResponse } from 'next/server';
import { requireSession, requireAdmin } from '@/lib/session';
import { enforceRateLimit, RATE_LIMITS } from '@/lib/security/rateLimiter';
import {
  listSecurityAudit,
  listAuditLogsUnified,
  listConsentLogs,
} from '@/lib/security/repository/securityRepository';
import { hasPermissionAsync } from '@/lib/security/rbac';

export const dynamic = 'force-dynamic';

/** GET /api/audit — unified audit trail */
export async function GET(req: NextRequest) {
  try {
    await enforceRateLimit(req, RATE_LIMITS.security);
    const user = await requireSession();
    const limit = Math.min(200, parseInt(req.nextUrl.searchParams.get('limit') ?? '100', 10));
    const all = req.nextUrl.searchParams.get('all') === 'true';

    const canViewAll = user.role === 'admin' || await hasPermissionAsync(user.role, 'admin:audit');
    const userId = all && canViewAll ? undefined : user.id;

    const [security, legacy, consents] = await Promise.all([
      listSecurityAudit({ userId, limit }),
      listAuditLogsUnified({ userId, limit }),
      listConsentLogs(userId, Math.min(limit, 50)),
    ]);

    if (all && !canViewAll) {
      return NextResponse.json({ ok: false, error: 'Forbidden' }, { status: 403 });
    }

    return NextResponse.json({
      ok: true,
      securityAudit: security,
      auditLogs: legacy,
      consentLogs: consents,
      total: security.length + legacy.length,
    });
  } catch (e: unknown) {
    const status = e && typeof e === 'object' && 'statusCode' in e
      ? Number((e as { statusCode: number }).statusCode) : 401;
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : 'Unauthorized' },
      { status },
    );
  }
}

/** POST /api/audit — admin query with filters */
export async function POST(req: NextRequest) {
  try {
    await enforceRateLimit(req, RATE_LIMITS.security);
    await requireAdmin();
    const body = await req.json().catch(() => ({}));
    const limit = Math.min(200, body.limit ?? 100);
    const entries = await listSecurityAudit({ userId: body.userId, limit });
    return NextResponse.json({ ok: true, entries });
  } catch {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }
}
