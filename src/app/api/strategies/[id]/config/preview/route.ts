import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/session';
import { AuthenticationError, ForbiddenError } from '@/lib/errors';
import { previewConfigurationChangeAsync } from '@/lib/strategy-hub/services/configurationService';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

type RouteContext = { params: Promise<{ id: string }> };

/**
 * POST /api/strategies/[id]/config/preview — preview configuration changes (admin only)
 * Body: { values: Record<string, unknown>, resetKeys?: string[] }
 */
export async function POST(req: NextRequest, context: RouteContext) {
  try {
    await requireAdmin();
    const { id } = await context.params;
    const body = await req.json().catch(() => ({}));
    const values = body.values ?? {};
    const resetKeys = Array.isArray(body.resetKeys) ? body.resetKeys.map(String) : undefined;

    const preview = await previewConfigurationChangeAsync({
      strategyId: id,
      patch: values as Record<string, unknown>,
      resetKeys,
    });

    return NextResponse.json({ ok: true, preview });
  } catch (e) {
    if (e instanceof ForbiddenError) {
      return NextResponse.json({ ok: false, error: 'Forbidden — admin only' }, { status: 403 });
    }
    if (e instanceof AuthenticationError) {
      return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
    }
    const msg = e instanceof Error ? e.message : 'Preview failed';
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
