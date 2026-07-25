import { NextResponse } from 'next/server';
import { StaleDataError } from '@/types/market';
import { ensureUniverseReady } from '@/lib/startup/ensureUniverseReady';
import {
  isMarketApiGateResponse,
  providerDataJson,
  refreshFeedStatus,
  resolveUserMarketDataContext,
} from '@/lib/broker/connections';
import { logger } from '@/lib/logger';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const log = logger.child({ route: '/api/market/movers' });

const EMPTY_ENVELOPE = {
  gainers: [] as unknown[],
  losers: [] as unknown[],
  mostActive: [] as unknown[],
};

/**
 * GET /api/market/movers
 *
 * Auth + active provider required. Movers are warehouse-ranked (product-
 * supported deliberate fallback) — never silent kite/yahoo live cascade
 * stamped as the user's broker. Response labels dataOrigin=database.
 */
export async function GET(): Promise<Response> {
  const resolved = await resolveUserMarketDataContext();
  if (isMarketApiGateResponse(resolved)) return resolved;

  const universeReady = await ensureUniverseReady();
  if (!universeReady.ok) {
    return NextResponse.json(
      { error: 'Universe not ready', code: 'UNIVERSE_NOT_READY', detail: universeReady.error },
      { status: 503, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  const status = refreshFeedStatus(resolved.user.id, resolved.providerName);

  try {
    // Warehouse movers only — do not call MarketDataProvider (kite/yahoo cascade).
    const { getMoversFromWarehouse } = await import('@/lib/marketData/moversWarehouse');
    const resp = await getMoversFromWarehouse();
    return providerDataJson(
      resolved.providerName,
      status,
      {
        gainers: resp.gainers,
        losers: resp.losers,
        mostActive: resp.mostActive,
        source: 'warehouse',
        data_quality: resp.data_quality ?? 'stored',
        fetched_at: resp.fetched_at,
        note: 'Movers ranking is warehouse-backed; not live ticks from the active broker',
      },
      {
        dataOrigin: 'database',
        fallbackUsed: true,
        fallbackSource: 'warehouse',
      },
    );
  } catch (err) {
    if (err instanceof StaleDataError) {
      const payload =
        err.response && typeof err.response === 'object' && 'data' in err.response
          ? (err.response as { data?: typeof EMPTY_ENVELOPE }).data
          : undefined;
      return providerDataJson(
        resolved.providerName,
        status,
        {
          ...EMPTY_ENVELOPE,
          ...(payload && typeof payload === 'object' ? payload : {}),
          stale: true,
          source: 'warehouse',
          note: 'Movers ranking is warehouse-backed; not live ticks from the active broker',
        },
        {
          dataOrigin: 'database',
          fallbackUsed: true,
          fallbackSource: 'warehouse',
        },
      );
    }
    log.warn('movers warehouse unavailable', {
      error: err instanceof Error ? err.message : String(err),
    });
    return providerDataJson(
      resolved.providerName,
      status,
      {
        ...EMPTY_ENVELOPE,
        source: 'warehouse',
        unavailable: true,
        note: 'Warehouse movers unavailable; refusing silent cross-provider live cascade',
      },
      {
        dataOrigin: 'database',
        fallbackUsed: true,
        fallbackSource: 'warehouse',
      },
    );
  }
}
