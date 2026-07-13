import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/session';
import { AuthenticationError, ForbiddenError } from '@/lib/errors';
import { runOptimizationSimulation } from '@/lib/strategy-hub/services/strategyAiService';
import { parseAnalyticsWindow } from '@/lib/strategy-hub/services/strategyAnalyticsService';
import type { SimulationParams } from '@/lib/strategy-hub/ai/types';

export const dynamic = 'force-dynamic';

type RouteContext = { params: Promise<{ id: string }> };

/**
 * POST /api/strategies/[id]/ai/simulate — optimization simulator (admin)
 * Body: { window?, minConfidence?, excludedRegimes?, direction?, approvedOnly? }
 *
 * Read-only: never modifies production configuration.
 */
export async function POST(req: NextRequest, context: RouteContext) {
  try {
    await requireAdmin();
    const { id } = await context.params;
    const body = await req.json().catch(() => ({}));
    const window = parseAnalyticsWindow(body.window ?? null);

    const params: SimulationParams = {
      minConfidence: body.minConfidence != null ? Number(body.minConfidence) : null,
      excludedRegimes: Array.isArray(body.excludedRegimes) ? body.excludedRegimes.map(String) : null,
      direction: body.direction === 'BUY' || body.direction === 'SELL' ? body.direction : null,
      approvedOnly: body.approvedOnly === true,
    };

    const result = await runOptimizationSimulation(id, params, window);
    return NextResponse.json({ ok: true, simulation: result });
  } catch (e) {
    if (e instanceof AuthenticationError) {
      return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
    }
    if (e instanceof ForbiddenError) {
      return NextResponse.json({ ok: false, error: 'Forbidden' }, { status: 403 });
    }
    console.error('[strategies/ai/simulate]', e);
    return NextResponse.json({ ok: false, error: 'Simulation failed' }, { status: 500 });
  }
}
