import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/session';
import { AuthenticationError, ForbiddenError } from '@/lib/errors';
import { restoreConfigurationVersion } from '@/lib/strategy-hub/services/configurationService';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

type RouteContext = { params: Promise<{ id: string }> };

/**
 * POST /api/strategies/[id]/config/restore — restore a configuration version (admin only)
 * Body: { versionId: number, reason?: string }
 */
export async function POST(req: NextRequest, context: RouteContext) {
  try {
    const admin = await requireAdmin();
    const { id } = await context.params;
    const body = await req.json().catch(() => ({}));
    const versionId = Number(body.versionId);
    if (!Number.isFinite(versionId) || versionId <= 0) {
      return NextResponse.json({ ok: false, error: 'versionId required' }, { status: 400 });
    }

    const result = await restoreConfigurationVersion({
      strategyId: id,
      versionId,
      userId: admin.id,
      actor: admin.email,
      reason: body.reason != null ? String(body.reason) : null,
    });

    if (!result.ok) {
      return NextResponse.json({ ok: false, error: result.error ?? 'Restore failed' }, { status: 400 });
    }

    return NextResponse.json({
      ok: true,
      config: result.config,
      message: 'Configuration version restored',
    });
  } catch (e) {
    if (e instanceof ForbiddenError) {
      return NextResponse.json({ ok: false, error: 'Forbidden — admin only' }, { status: 403 });
    }
    if (e instanceof AuthenticationError) {
      return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
    }
    const msg = e instanceof Error ? e.message : 'Restore failed';
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
