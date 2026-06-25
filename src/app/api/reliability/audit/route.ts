import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/session';
import { getReliabilityAuditLog, logReliabilityAction } from '@/lib/reliability';

export const dynamic = 'force-dynamic';

/** GET /api/reliability/audit — reliability audit log */
export async function GET(req: NextRequest) {
  try {
    await requireAdmin();
    const limit = Math.min(200, parseInt(req.nextUrl.searchParams.get('limit') ?? '100', 10));
    const entries = await getReliabilityAuditLog(limit);
    return NextResponse.json({ ok: true, entries });
  } catch {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }
}

/** POST /api/reliability/audit — record SRE action */
export async function POST(req: NextRequest) {
  try {
    const user = await requireAdmin();
    const body = await req.json();
    await logReliabilityAction({
      actorId: user.id,
      actorEmail: user.email,
      action: body.action ?? 'unknown',
      resource: body.resource,
      detail: body.detail,
      ipAddress: req.headers.get('x-forwarded-for') ?? req.headers.get('x-real-ip'),
    });
    return NextResponse.json({ ok: true });
  } catch (e: unknown) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : 'Failed' },
      { status: 401 },
    );
  }
}
