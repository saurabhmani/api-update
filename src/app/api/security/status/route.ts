import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/lib/session';
import { getComplianceStatus, getRbacMatrix } from '@/lib/security';
import { enforceRateLimit, RATE_LIMITS } from '@/lib/security/rateLimiter';

export const dynamic = 'force-dynamic';

/** GET /api/security/status — RBAC, MFA, sessions, consent overview */
export async function GET(req: NextRequest) {
  try {
    await enforceRateLimit(req, RATE_LIMITS.security);
    const user = await requireSession();
    const status = await getComplianceStatus(user.id, user.role);
    return NextResponse.json({
      ok: true,
      status,
      rbac: { role: user.role, permissions: status.permissions, matrix: getRbacMatrix() },
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
