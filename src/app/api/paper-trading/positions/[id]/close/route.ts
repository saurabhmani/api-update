import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/lib/session';
import { closePaperPosition } from '@/lib/paper-trading';
import { invalidatePaperTradingCaches } from '@/lib/cache/cacheInvalidation';

export const dynamic = 'force-dynamic';

/** POST /api/paper-trading/positions/[id]/close */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireSession();
    const { id } = await params;
    const body = await req.json().catch(() => ({}));
    const result = await closePaperPosition(user.id, id, body.referencePrice);
    if (!result.ok) {
      return NextResponse.json({ ok: false, error: result.error }, { status: 422 });
    }
    await invalidatePaperTradingCaches(user.id);
    return NextResponse.json({ ok: true, position: result.position });
  } catch {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }
}
