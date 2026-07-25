/**
 * GET /api/chart-data
 *
 * auth → active provider → OHLCV candles (warehouse, broker fill on miss)
 */
import { NextRequest, NextResponse } from 'next/server';
import { getChartData, type ChartInterval, type OhlcvBar } from '@/services/chartService';
import {
  instrumentFromQuery,
  isMarketApiGateResponse,
  labelCandleDataOrigin,
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
export const revalidate = 0;

const VALID_INTERVALS = new Set<ChartInterval>([
  '1minute', '5minute', '15minute', '30minute', '60minute',
  '1day', '1week', '1month',
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
  const resolved = await resolveUserMarketDataContext();
  if (isMarketApiGateResponse(resolved)) return resolved;

  const { searchParams } = req.nextUrl;
  const rawSymbol = searchParams.get('symbol')?.trim().toUpperCase() ?? '';
  const rawInterval = (searchParams.get('interval') ?? '1day') as ChartInterval;
  const from = searchParams.get('from') ?? undefined;
  const to = searchParams.get('to') ?? undefined;
  const rawLimit = parseInt(searchParams.get('limit') ?? '100', 10);

  if (!rawSymbol) {
    return NextResponse.json(
      { error: 'symbol is required', example: '/api/chart-data?symbol=RELIANCE' },
      { status: 400, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  const symbol = rawSymbol.replace(/^(NSE|BSE):/, '');
  const interval = VALID_INTERVALS.has(rawInterval) ? rawInterval : '1day';
  const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), 1000) : 100;

  if (from && isNaN(Date.parse(from))) {
    return NextResponse.json({ error: `Invalid 'from' date: ${from}` }, { status: 400 });
  }
  if (to && isNaN(Date.parse(to))) {
    return NextResponse.json({ error: `Invalid 'to' date: ${to}` }, { status: 400 });
  }

  try {
    const warehouse = await getChartData(symbol, interval, from, to, limit);
    let candles: OhlcvBar[] = warehouse.candles;
    let instrument_key = warehouse.instrument_key;
    let outSymbol = warehouse.symbol;
    let source: string = warehouse.source;
    let cached = warehouse.cached;

    if (candles.length === 0) {
      try {
        await resolved.provider.connect(resolved.ctx);
        const instrument = instrumentFromQuery(symbol);
        const toDate = to ? new Date(to) : new Date();
        const fromDate = from
          ? new Date(from)
          : new Date(toDate.getTime() - 120 * 86_400_000);
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
          outSymbol = instrument.symbol;
          source = resolved.providerName;
          cached = false;
        }
      } catch (err) {
        const mapped = mapBrokerFetchError(resolved.providerName, err);
        if (
          err instanceof BrokerMarketDataError &&
          (err.code === 'session_expired' || mapped.code === 'login_required')
        ) {
          return providerDataJson(
            resolved.providerName,
            mapped.code,
            { error: mapped.message, code: mapped.code },
            { status: 401 },
          );
        }
        if (candles.length === 0) {
          return providerDataJson(
            resolved.providerName,
            mapped.code,
            { error: mapped.message, code: mapped.code, candles: [], source: null },
            { status: mapped.code === 'login_required' ? 401 : 502 },
          );
        }
      }
    }

    const status = refreshFeedStatus(resolved.user.id, resolved.providerName);
    const origin = labelCandleDataOrigin(source);
    return providerDataJson(
      resolved.providerName,
      status,
      {
        symbol: outSymbol,
        instrument_key,
        interval,
        from: warehouse.from,
        to: warehouse.to,
        candles,
        count: candles.length,
        source,
        cached,
        ...(candles.length === 0
          ? {
              note: 'No candle data found. Candles are populated by the scheduler each market session, or from the active broker on first access.',
            }
          : origin.fallbackUsed
            ? {
                note: `Candles from ${origin.fallbackSource ?? 'warehouse'}; not live ticks from active broker`,
              }
            : {}),
      },
      {
        dataOrigin: origin.dataOrigin,
        fallbackUsed: origin.fallbackUsed,
        fallbackSource: origin.fallbackSource,
      },
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[/api/chart-data] ${symbol}:`, message);
    return NextResponse.json(
      { error: 'Failed to fetch chart data', details: message },
      { status: 500, headers: { 'Cache-Control': 'no-store' } },
    );
  }
}
