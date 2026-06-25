import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/session';
import { collectReliabilityDashboard } from '@/lib/reliability';

export const dynamic = 'force-dynamic';

/** GET /api/reliability/status — full SRE dashboard payload */
export async function GET() {
  try {
    await requireAdmin();
    const dashboard = await collectReliabilityDashboard();
    return NextResponse.json({ ok: true, dashboard });
  } catch (e: unknown) {
    const status = e && typeof e === 'object' && 'statusCode' in e
      ? Number((e as { statusCode: number }).statusCode)
      : 401;
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : 'Unauthorized' },
      { status: status === 403 ? 403 : 401 },
    );
  }
}
