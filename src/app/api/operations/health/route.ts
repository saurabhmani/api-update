// GET /api/operations/health — Production health monitoring (Phase 5)
import { NextResponse } from 'next/server';
import { requireSession } from '@/lib/session';
import { collectProductionHealth } from '@/lib/operations/productionHealthCollector';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET() {
  try {
    await requireSession();
  } catch {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const health = await collectProductionHealth();
    return NextResponse.json({ ok: true, health });
  } catch (err) {
    return NextResponse.json({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    }, { status: 500 });
  }
}
