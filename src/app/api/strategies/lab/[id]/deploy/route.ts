import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/lib/session';
import { requestPaperDeployment } from '@/lib/strategy-lab';

export const dynamic = 'force-dynamic';

/** POST /api/strategies/lab/[id]/deploy — paper trading deployment (gated) */
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireSession();
    const { id } = await params;
    const result = await requestPaperDeployment(id, user.email);

    if (!result.approved) {
      return NextResponse.json({
        ok: false,
        error: 'Deployment gates not met',
        issues: result.issues,
      }, { status: 403 });
    }

    return NextResponse.json({ ok: true, deployment: 'paper', message: 'Paper trading deployment approved' });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Deploy failed';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
