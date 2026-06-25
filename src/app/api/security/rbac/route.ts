import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/session';
import { listRoles, listPermissions, getPermissionsForRoleFromDb } from '@/lib/security/repository/securityRepository';
import { enforceRateLimit, RATE_LIMITS } from '@/lib/security/rateLimiter';
import { NextRequest } from 'next/server';

export const dynamic = 'force-dynamic';

/** GET /api/security/rbac — roles and permissions matrix */
export async function GET(req: NextRequest) {
  try {
    await enforceRateLimit(req, RATE_LIMITS.security);
    await requireAdmin();
    const roles = await listRoles();
    const permissions = await listPermissions();
    const matrix: Record<string, string[]> = {};
    for (const r of roles) {
      matrix[r.name] = await getPermissionsForRoleFromDb(r.name);
    }
    return NextResponse.json({ ok: true, roles, permissions, matrix });
  } catch {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }
}
