import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/lib/session';
import { setAdminOverride } from '@/lib/billing';

export const dynamic = 'force-dynamic';

/** POST /api/billing/admin/override — admin plan/credit override */
export async function POST(req: NextRequest) {
  try {
    const user = await requireSession();
    if (user.role !== 'admin') {
      return NextResponse.json({ ok: false, error: 'Admin only' }, { status: 403 });
    }
    const body = await req.json().catch(() => ({}));
    const targetUserId = Number(body.userId);
    const overrideType = String(body.overrideType ?? body.type);
    const overrideValue = String(body.overrideValue ?? body.value);
    if (!targetUserId || !overrideType || !overrideValue) {
      return NextResponse.json(
        { ok: false, error: 'userId, overrideType, overrideValue required' },
        { status: 400 },
      );
    }
    await setAdminOverride(
      targetUserId,
      overrideType,
      overrideValue,
      user.email,
      body.reason,
      body.expiresAt,
    );
    return NextResponse.json({ ok: true, message: 'Override applied' });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Override failed';
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
