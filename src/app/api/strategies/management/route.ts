import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin, requireSession } from '@/lib/session';
import { ForbiddenError, AuthenticationError } from '@/lib/errors';
import {
  loadModeActivity,
  loadStrategyManagementStatus,
  setStrategyMode,
  syncStrategyModesForSignalEngine,
} from '@/lib/strategy-hub/services/modeManagementService';
import { isValidStrategyMode } from '@/lib/strategy-hub/services/strategyModeOverrides';
import type { StrategyMode } from '@/lib/signal-engine/types/signalEngine.types';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * GET /api/strategies/management
 * Strategy management dashboard status + recent mode activity.
 * Auth: any logged-in user (read-only).
 */
export async function GET(req: NextRequest) {
  try {
    const user = await requireSession();
    const strategyId = req.nextUrl.searchParams.get('strategyId') ?? undefined;
    const limitRaw = Number(req.nextUrl.searchParams.get('limit') ?? 30);
    const limit = Number.isFinite(limitRaw) ? limitRaw : 30;

    const [status, activity] = await Promise.all([
      loadStrategyManagementStatus(),
      loadModeActivity({ strategyId, limit }),
    ]);

    return NextResponse.json({
      ok: true,
      status,
      activity,
      canManage: user.role === 'admin',
    });
  } catch (e) {
    if (e instanceof AuthenticationError) {
      return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
    }
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }
}

/**
 * PATCH /api/strategies/management
 * Update a single strategy mode. Admin only.
 * Body: { strategyId, mode, reason?, source? }
 */
export async function PATCH(req: NextRequest) {
  try {
    const admin = await requireAdmin();
    const body = await req.json().catch(() => ({}));
    const strategyId = String(body.strategyId ?? '');
    const mode = body.mode as StrategyMode;
    const reason = body.reason != null ? String(body.reason) : null;
    const source = body.source === 'api' ? 'api' as const : 'ui' as const;

    if (!strategyId) {
      return NextResponse.json({ ok: false, error: 'strategyId required' }, { status: 400 });
    }
    if (!isValidStrategyMode(mode)) {
      return NextResponse.json({
        ok: false,
        error: 'mode must be CONFIRMED_ENABLED, WATCHLIST_ONLY, or DISABLED',
      }, { status: 400 });
    }

    const result = await setStrategyMode({
      strategyId,
      mode,
      userId: admin.id,
      actor: admin.email,
      reason,
      source,
    });

    if (!result.ok) {
      return NextResponse.json({ ok: false, error: result.error ?? 'Mode update failed' }, { status: 400 });
    }

    const sync = await syncStrategyModesForSignalEngine();
    return NextResponse.json({
      ok: true,
      ...result,
      sync,
      message: result.changed
        ? `Strategy mode updated to ${mode}`
        : 'Strategy mode unchanged',
    });
  } catch (e) {
    if (e instanceof ForbiddenError) {
      return NextResponse.json({ ok: false, error: 'Forbidden — admin only' }, { status: 403 });
    }
    if (e instanceof AuthenticationError) {
      return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
    }
    const msg = e instanceof Error ? e.message : 'Mode update failed';
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
