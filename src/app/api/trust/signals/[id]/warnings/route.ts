import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/lib/session';
import { resolveSignalWarnings } from '@/lib/trust-layer';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await requireSession();
    const { id } = await params;
    const snapshotId = Number(id);
    if (!Number.isFinite(snapshotId)) {
      return NextResponse.json({ ok: false, error: 'Invalid signal id' }, { status: 400 });
    }
    const result = await resolveSignalWarnings(snapshotId);
    if (!result) {
      return NextResponse.json({ ok: false, error: 'Signal not found' }, { status: 404 });
    }
    return NextResponse.json({ ok: true, data: result });
  } catch {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }
}
