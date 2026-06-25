import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/lib/session';
import { getLabStrategy, getLabAudit } from '@/lib/strategy-lab';

export const dynamic = 'force-dynamic';

/** GET /api/strategies/lab/[id] */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await requireSession();
    const { id } = await params;
    const strategy = await getLabStrategy(id);
    if (!strategy) {
      return NextResponse.json({ ok: false, error: 'Not found' }, { status: 404 });
    }
    const audit = await getLabAudit(id);
    return NextResponse.json({ ok: true, strategy, audit });
  } catch {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }
}
