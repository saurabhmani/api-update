import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/lib/session';
import { AuthenticationError } from '@/lib/errors';
import { loadConfigurationHistory } from '@/lib/strategy-hub/services/configurationService';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

type RouteContext = { params: Promise<{ id: string }> };

/**
 * GET /api/strategies/[id]/config/history — configuration version history
 */
export async function GET(req: NextRequest, context: RouteContext) {
  try {
    await requireSession();
    const { id } = await context.params;
    const limitRaw = Number(req.nextUrl.searchParams.get('limit') ?? 30);
    const limit = Number.isFinite(limitRaw) ? limitRaw : 30;
    const history = await loadConfigurationHistory(id, limit);
    return NextResponse.json({ ok: true, history });
  } catch (e) {
    if (e instanceof AuthenticationError) {
      return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
    }
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }
}
