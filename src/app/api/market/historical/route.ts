import { NextRequest, NextResponse } from 'next/server';
import type { HistoricalRange } from '@/types/market';
import { ensureUniverseReady } from '@/lib/startup/ensureUniverseReady';
import {
  instrumentFromQuery,
  isMarketApiGateResponse,
  mapBrokerFetchError,
  providerDataJson,
  refreshFeedStatus,
  resolveUserMarketDataContext,
} from '@/lib/broker/connections';
import {
  BrokerMarketDataError,
  type BrokerCandleInterval,
} from '@/lib/marketData/brokerProvider/types';
import { recordLiveFeedPollSuccess } from '@/lib/marketData/liveFeedState';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const VALID_RANGES: HistoricalRange[] = ['1d', '5d', '1mo', '3mo', '6mo', '1y', '5y'];

function rangeWindow(range: HistoricalRange): {
  from: Date;
  to: Date;
  interval: BrokerCandleInterval;
} {
  const to = new Date();
  const from = new Date(to);
  switch (range) {
    case '1d':
      from.setDate(from.getDate() - 1);
      return { from, to, interval: '5minute' };
    case '5d':
      from.setDate(from.getDate() - 5);
      return { from, to, interval: '15minute' };
    case '1mo':
      from.setMonth(from.getMonth() - 1);
      return { from, to, interval: 'day' };
    case '3mo':
      from.setMonth(from.getMonth() - 3);
      return { from, to, interval: 'day' };
    case '6mo':
      from.setMonth(from.getMonth() - 6);
      return { from, to, interval: 'day' };
    case '1y':
      from.setFullYear(from.getFullYear() - 1);
      return { from, to, interval: 'day' };
    case '5y':
      from.setFullYear(from.getFullYear() - 5);
      return { from, to, interval: 'day' };
    default:
      from.setMonth(from.getMonth() - 1);
      return { from, to, interval: 'day' };
  }
}

/**
 * GET /api/market/historical?symbol=RELIANCE&range=1mo
 *
 * auth → active provider → broker adapter historical → normalize → respond
 */
export async function GET(req: NextRequest): Promise<Response> {
  const resolved = await resolveUserMarketDataContext();
  if (isMarketApiGateResponse(resolved)) return resolved;

  const symbol = req.nextUrl.searchParams.get('symbol');
  const range = (req.nextUrl.searchParams.get('range') ?? '1mo') as HistoricalRange;
  if (!symbol) {
    return NextResponse.json(
      { error: 'symbol required' },
      { status: 400, headers: { 'Cache-Control': 'no-store' } },
    );
  }
  if (!VALID_RANGES.includes(range)) {
    return NextResponse.json(
      { error: `invalid range, one of: ${VALID_RANGES.join(',')}` },
      { status: 400, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  const universeReady = await ensureUniverseReady();
  if (!universeReady.ok) {
    return NextResponse.json(
      { error: 'Universe not ready', code: 'UNIVERSE_NOT_READY', detail: universeReady.error },
      { status: 503, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  try {
    await resolved.provider.connect(resolved.ctx);
    const instrument = instrumentFromQuery(symbol);
    const window = rangeWindow(range);
    const candles = await resolved.provider.fetchHistoricalCandles(resolved.ctx, {
      instrument,
      interval: window.interval,
      from: window.from,
      to: window.to,
    });

    if (candles.length > 0) {
      recordLiveFeedPollSuccess({
        userId: String(resolved.user.id),
        provider: resolved.providerName,
      });
    }

    const status = refreshFeedStatus(resolved.user.id, resolved.providerName);
    return providerDataJson(resolved.providerName, status, {
      symbol: instrument.symbol,
      instrumentKey: instrument.instrumentKey,
      range,
      interval: window.interval,
      candles,
      count: candles.length,
    });
  } catch (err) {
    const mapped = mapBrokerFetchError(resolved.providerName, err);
    if (err instanceof BrokerMarketDataError && err.code === 'instrument_unresolved') {
      return providerDataJson(
        resolved.providerName,
        mapped.code,
        { error: mapped.message, code: err.code },
        { status: 404 },
      );
    }
    const http = mapped.code === 'login_required' ? 401 : 502;
    return providerDataJson(
      resolved.providerName,
      mapped.code,
      { error: mapped.message, code: mapped.code },
      { status: http },
    );
  }
}
