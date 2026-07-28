/**
 * GET /api/charts
 *
 * Session required. Warehouse candles are always served when present.
 * Active broker is only required to fill empty warehouse series.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getChartData, type ChartInterval, type OhlcvBar } from '@/services/chartService';
import { requireSession } from '@/lib/session';
import { AuthenticationError } from '@/lib/errors';
import {
  instrumentFromQuery,
  isMarketApiGateResponse,
  labelCandleDataOrigin,
  mapBrokerFetchError,
  providerDataJson,
  refreshFeedStatus,
  resolveUserMarketDataContext,
  resolveOptionalUserMarketMeta,
} from '@/lib/broker/connections';
import {
  BrokerMarketDataError,
  type BrokerCandleInterval,
} from '@/lib/marketData/brokerProvider/types';
import { recordLiveFeedPollSuccess } from '@/lib/marketData/liveFeedState';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const VALID_INTERVALS = new Set<ChartInterval>([
  '1minute', '5minute', '15minute', '30minute', '60minute',
  '1day', '1week', '1month',
]);

const INTRADAY_BUCKET = new Set<ChartInterval>([
  '1minute', '5minute', '15minute', '30minute', '60minute',
]);

function toBrokerInterval(interval: ChartInterval): BrokerCandleInterval {
  switch (interval) {
    case '1minute': return '1minute';
    case '5minute': return '5minute';
    case '15minute': return '15minute';
    case '30minute': return '30minute';
    case '60minute': return '60minute';
    case '1week': return 'week';
    case '1month': return 'month';
    default: return 'day';
  }
}

export async function GET(req: NextRequest) {
  try {
    await requireSession();
  } catch (err) {
    if (err instanceof AuthenticationError) {
      return NextResponse.json(
        { error: 'Unauthorized', code: 'unauthorized' },
        { status: 401, headers: { 'Cache-Control': 'no-store' } },
      );
    }
    throw err;
  }

  const { searchParams } = req.nextUrl;
  const instrumentKey = searchParams.get('instrumentKey') ?? '';
  const rawSymbol = searchParams.get('symbol')?.toUpperCase()
    ?? instrumentKey.split('|')[1]?.toUpperCase()
    ?? instrumentKey.toUpperCase();

  if (!rawSymbol) {
    return NextResponse.json(
      { error: 'symbol or instrumentKey required' },
      { status: 400, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  const type = searchParams.get('type') ?? 'historical';
  const rawInterval = searchParams.get('interval') ?? (type === 'intraday' ? '1minute' : '1day');
  const interval: ChartInterval = VALID_INTERVALS.has(rawInterval as ChartInterval)
    ? rawInterval as ChartInterval
    : type === 'intraday' ? '1minute' : '1day';

  const from = searchParams.get('from') ?? undefined;
  const to = searchParams.get('to') ?? undefined;
  const isIntraday = type === 'intraday' || (INTRADAY_BUCKET.has(interval) && interval !== '1day');
  const defaultLimit = interval === '1day' ? 120 : isIntraday ? 500 : 200;
  const limit = Math.min(parseInt(searchParams.get('limit') ?? String(defaultLimit), 10) || defaultLimit, 1000);

  // Warehouse / Yahoo / Kite historical — does not require active live broker
  const warehouse = await getChartData(rawSymbol, interval, from, to, limit);

  let candles: OhlcvBar[] = warehouse.candles;
  let instrument_key = warehouse.instrument_key;
  let symbol = warehouse.symbol;
  let source: string = warehouse.source;
  let cached = warehouse.cached;

  const meta = await resolveOptionalUserMarketMeta();
  const metaOk = !isMarketApiGateResponse(meta);
  const providerName = metaOk ? meta.provider : null;
  const feedStatus = metaOk ? meta.status : 'not_connected';

  // Broker fill only when warehouse is empty AND a live provider is available
  if (candles.length === 0) {
    const resolved = await resolveUserMarketDataContext();
    if (!isMarketApiGateResponse(resolved)) {
      try {
        await resolved.provider.connect(resolved.ctx);
        const instrument = instrumentFromQuery(instrumentKey || rawSymbol);
        const toDate = to ? new Date(to) : new Date();
        const fromDate = from
          ? new Date(from)
          : new Date(toDate.getTime() - (isIntraday ? 2 : 120) * 86_400_000);
        const brokerCandles = await resolved.provider.fetchHistoricalCandles(resolved.ctx, {
          instrument,
          interval: toBrokerInterval(interval),
          from: fromDate,
          to: toDate,
          limit,
        });
        if (brokerCandles.length > 0) {
          recordLiveFeedPollSuccess({
            userId: String(resolved.user.id),
            provider: resolved.providerName,
          });
          candles = brokerCandles.map((c) => ({
            ts: c.ts,
            open: c.open,
            high: c.high,
            low: c.low,
            close: c.close,
            volume: c.volume,
            oi: 0,
          }));
          instrument_key = instrument.instrumentKey;
          symbol = instrument.symbol;
          source = resolved.providerName;
          cached = false;
        }
      } catch (err) {
        const mapped = mapBrokerFetchError(resolved.providerName, err);
        if (
          err instanceof BrokerMarketDataError &&
          (err.code === 'session_expired' || mapped.code === 'login_required')
        ) {
          // Still return warehouse-shaped empty payload rather than blocking the page
          console.warn('[/api/charts] broker fill login required:', mapped.message);
        } else {
          console.warn('[/api/charts] broker fill failed:', mapped.message);
        }
      }
    }
  }

  const status = metaOk && providerName
    ? refreshFeedStatus(meta.user.id, providerName)
    : feedStatus;
  const origin = labelCandleDataOrigin(source);

  return providerDataJson(
    providerName,
    status,
    {
      candles,
      instrument_key,
      symbol,
      interval,
      count: candles.length,
      source,
      cached,
      note: candles.length === 0
        ? 'No candle data in warehouse. Connect a data source or wait for the candle job.'
        : origin.fallbackUsed
          ? `Candles from ${origin.fallbackSource ?? 'warehouse'}; not live ticks from active broker`
          : undefined,
    },
    {
      dataOrigin: origin.dataOrigin,
      fallbackUsed: origin.fallbackUsed,
      fallbackSource: origin.fallbackSource,
    },
  );
}
