import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/session';
import { ForbiddenError, AuthenticationError } from '@/lib/errors';
import {
  bulkSetStrategyModes,
  resolveBulkStrategyIds,
  syncStrategyModesForSignalEngine,
} from '@/lib/strategy-hub/services/modeManagementService';
import { isValidStrategyMode } from '@/lib/strategy-hub/services/strategyModeOverrides';
import type { StrategyMode } from '@/lib/signal-engine/types/signalEngine.types';
import { invalidateStrategyCaches } from '@/lib/cache/cacheInvalidation';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * POST /api/strategies/management/bulk
 * Bulk update strategy modes. Admin only.
 *
 * Body:
 *  {
 *    mode: StrategyMode,
 *    strategyIds?: string[],
 *    category?: string,
 *    regime?: string,
 *    strategyType?: string,
 *    reason?: string
 *  }
 */
export async function POST(req: NextRequest) {
  try {
    const admin = await requireAdmin();
    const body = await req.json().catch(() => ({}));
    const mode = body.mode as StrategyMode;
    const reason = body.reason != null ? String(body.reason) : null;

    if (!isValidStrategyMode(mode)) {
      return NextResponse.json({
        ok: false,
        error: 'mode must be CONFIRMED_ENABLED, WATCHLIST_ONLY, or DISABLED',
      }, { status: 400 });
    }

    const strategyIds = resolveBulkStrategyIds({
      strategyIds: Array.isArray(body.strategyIds)
        ? body.strategyIds.map(String)
        : undefined,
      category: body.category != null ? String(body.category) : null,
      regime: body.regime != null ? String(body.regime) : null,
      strategyType: body.strategyType != null ? String(body.strategyType) : null,
    });

    if (strategyIds.length === 0) {
      return NextResponse.json({
        ok: false,
        error: 'No strategies matched the bulk selection',
      }, { status: 400 });
    }

    if (strategyIds.length > 100) {
      return NextResponse.json({
        ok: false,
        error: 'Bulk selection limited to 100 strategies',
      }, { status: 400 });
    }

    const result = await bulkSetStrategyModes({
      strategyIds,
      mode,
      userId: admin.id,
      actor: admin.email,
      reason,
      source: 'bulk',
    });

    // Final sync to ensure Signal Engine cache is fresh.
    const sync = result.sync ?? await syncStrategyModesForSignalEngine();
    if (result.updated > 0) await invalidateStrategyCaches();

    return NextResponse.json({
      ok: result.ok,
      mode,
      selected: strategyIds.length,
      updated: result.updated,
      failed: result.failed,
      results: result.results,
      sync,
      message: `Updated ${result.updated} of ${strategyIds.length} strategies to ${mode}`,
    });
  } catch (e) {
    if (e instanceof ForbiddenError) {
      return NextResponse.json({ ok: false, error: 'Forbidden — admin only' }, { status: 403 });
    }
    if (e instanceof AuthenticationError) {
      return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
    }
    const msg = e instanceof Error ? e.message : 'Bulk update failed';
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
