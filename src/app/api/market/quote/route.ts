import { NextRequest, NextResponse } from 'next/server';
import { logger } from '@/lib/logger';
import { ensureUniverseReady } from '@/lib/startup/ensureUniverseReady';
import {
  instrumentFromQuery,
  isMarketApiGateResponse,
  mapBrokerFetchError,
  providerDataJson,
  refreshFeedStatus,
  resolveUserMarketDataContext,
} from '@/lib/broker/connections';
import { BrokerMarketDataError } from '@/lib/marketData/brokerProvider/types';
import { recordLiveFeedTick } from '@/lib/marketData/liveFeedState';

const log = logger.child({ route: '/api/market/quote' });

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/market/quote?symbol=RELIANCE
 *
 * auth → active provider → broker adapter → normalize → respond
 */
export async function GET(req: NextRequest): Promise<Response> {
  const resolved = await resolveUserMarketDataContext();
  if (isMarketApiGateResponse(resolved)) return resolved;

  const symbol = req.nextUrl.searchParams.get('symbol');
  if (!symbol) {
    return NextResponse.json(
      { error: 'symbol query param is required' },
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
    const quotes = await resolved.provider.fetchQuote(resolved.ctx, [instrument]);
    const quote = quotes[0] ?? null;

    if (quote && Number.isFinite(quote.ltp) && quote.ltp > 0) {
      recordLiveFeedTick(Date.now(), quote.asOfMs, {
        userId: String(resolved.user.id),
        provider: resolved.providerName,
      });
    }

    const status = refreshFeedStatus(resolved.user.id, resolved.providerName);
    return providerDataJson(resolved.providerName, status, {
      symbol: instrument.symbol,
      instrumentKey: instrument.instrumentKey,
      quote,
      quotes,
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
    log.error('quote route error', {
      symbol,
      userId: resolved.user.id,
      provider: resolved.providerName,
      code: mapped.code,
      error: mapped.message,
    });
    return providerDataJson(
      resolved.providerName,
      mapped.code,
      { error: mapped.message, code: mapped.code },
      { status: http },
    );
  }
}
