import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin, requireSession } from '@/lib/session';
import { AuthenticationError, ForbiddenError } from '@/lib/errors';
import {
  applyAiRecommendation,
  loadAiRecommendationHistory,
} from '@/lib/strategy-hub/services/strategyAiService';

export const dynamic = 'force-dynamic';

type RouteContext = { params: Promise<{ id: string }> };

/**
 * GET /api/strategies/[id]/ai/recommendations — recommendation history
 */
export async function GET(_req: NextRequest, context: RouteContext) {
  try {
    await requireSession();
    const { id } = await context.params;
    const history = await loadAiRecommendationHistory({ strategyId: id, limit: 100 });
    return NextResponse.json({ ok: true, history });
  } catch (e) {
    if (e instanceof AuthenticationError) {
      return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
    }
    return NextResponse.json({ ok: false, error: 'Failed to load recommendation history' }, { status: 500 });
  }
}

/**
 * POST /api/strategies/[id]/ai/recommendations — apply recommendation (admin)
 * Body: { recKey: string }
 */
export async function POST(req: NextRequest, context: RouteContext) {
  try {
    const admin = await requireAdmin();
    const { id } = await context.params;
    const body = await req.json().catch(() => ({}));
    const recKey = String(body.recKey ?? '');
    if (!recKey) {
      return NextResponse.json({ ok: false, error: 'recKey required' }, { status: 400 });
    }

    const result = await applyAiRecommendation({
      strategyId: id,
      recKey,
      userId: admin.id,
      actor: admin.email ?? `user:${admin.id}`,
    });

    return NextResponse.json({ ok: result.ok, ...result }, { status: result.ok ? 200 : 400 });
  } catch (e) {
    if (e instanceof AuthenticationError) {
      return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
    }
    if (e instanceof ForbiddenError) {
      return NextResponse.json({ ok: false, error: 'Forbidden' }, { status: 403 });
    }
    return NextResponse.json({ ok: false, error: 'Failed to apply recommendation' }, { status: 500 });
  }
}
