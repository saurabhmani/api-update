// ════════════════════════════════════════════════════════════════
//  GET /api/signals/backtest
//
//  Phase 4 — Daily Backtesting Engine API.
//
//  Query parameters:
//    ?window=INTRADAY | 1D | 7D | 30D | 90D
//    ?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD   (CUSTOM window)
//
//  The route pulls today's signal pools from the existing
//  /api/signals envelope, attempts to load historical candle series
//  from the MySQL `candles` table via historicalMarketData adapters,
//  and feeds everything into the pure `runDailyBacktest` builder.
//
//  Safety: when historical data is unavailable the route still
//  returns ok=true with status=INSUFFICIENT_DATA / PARTIAL and
//  explicit warnings. No fake outcomes, no live-threshold changes.
// ════════════════════════════════════════════════════════════════

import { NextRequest, NextResponse }    from 'next/server';
import { requireSession }               from '@/lib/session';
import {
  runDailyBacktest,
  type BacktestResult,
  type BacktestWindow,
  type SignalForBacktest,
  type RunBacktestInput,
}                                       from '@/lib/signals/dailyBacktestEngine';
import {
  getHistoricalCandles,
  getMarketMovers,
  type HistoricalCandle,
}                                       from '@/lib/signals/historicalMarketData';

export const dynamic    = 'force-dynamic';
export const revalidate = 0;

const VALID_WINDOWS = new Set<BacktestWindow>(['INTRADAY', '1D', '7D', '30D', '90D', 'CUSTOM']);

const isoDate = (s?: string | null): string | null => {
  if (!s) return null;
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
};

const todayISO = (): string => new Date().toISOString().slice(0, 10);

const subtractDaysISO = (iso: string, days: number): string => {
  const d = new Date(iso);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
};

const resolveWindow = (
  window: BacktestWindow,
  customStart: string | null,
  customEnd:   string | null,
): { startDate: string; endDate: string } => {
  const end = customEnd ?? todayISO();
  if (window === 'CUSTOM') {
    return { startDate: customStart ?? end, endDate: end };
  }
  if (window === 'INTRADAY' || window === '1D') return { startDate: end, endDate: end };
  if (window === '7D')  return { startDate: subtractDaysISO(end, 6),  endDate: end };
  if (window === '30D') return { startDate: subtractDaysISO(end, 29), endDate: end };
  if (window === '90D') return { startDate: subtractDaysISO(end, 89), endDate: end };
  return { startDate: end, endDate: end };
};

const intervalForWindow = (window: BacktestWindow): '1day' | '5minute' | '15minute' =>
    window === 'INTRADAY' ? '5minute'
  : window === '1D'       ? '15minute'
  :                         '1day';

export async function GET(req: NextRequest) {
  await requireSession();

  const url    = new URL(req.url);
  const rawWin = (url.searchParams.get('window') ?? '1D').toUpperCase() as BacktestWindow;
  const window: BacktestWindow = VALID_WINDOWS.has(rawWin) ? rawWin : '1D';
  const customStart = isoDate(url.searchParams.get('startDate'));
  const customEnd   = isoDate(url.searchParams.get('endDate'));
  const { startDate, endDate } = resolveWindow(window, customStart, customEnd);
  const warnings: string[] = [];

  // Pull today's signal pools from the dashboard's own endpoint so
  // the backtest evaluates EXACTLY what the live system surfaced.
  let payload: any = null;
  try {
    const origin = `${url.protocol}//${url.host}`;
    const cookieHeader = req.headers.get('cookie') ?? '';
    const res = await fetch(
      `${origin}/api/signals?action=all&limit=20&request_id=backtest-${Date.now()}`,
      { cache: 'no-store', headers: cookieHeader ? { cookie: cookieHeader } : {} },
    );
    if (res.ok) payload = await res.json();
    else warnings.push(`Internal /api/signals returned ${res.status}.`);
  } catch (e) {
    warnings.push(`Failed to read /api/signals internally: ${(e as Error).message ?? 'unknown error'}.`);
  }

  if (!payload) {
    return NextResponse.json(
      {
        ok:           true,
        source:       'partial',
        generatedAt:  new Date().toISOString(),
        backtest:     null,
        warnings:     [...warnings, 'No signal pool available — backtest skipped.'],
      },
      { headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate' } },
    );
  }

  const arr = <T,>(v: unknown): T[] => Array.isArray(v) ? (v as T[]) : [];
  const approved      = arr<SignalForBacktest>(payload.approvedSignals      ?? payload.signals);
  const highPotential = arr<SignalForBacktest>(payload.highPotentialSignals ?? payload.high_potential);
  const watchlistRaw  = arr<SignalForBacktest>(payload.watchlistSignals     ?? payload.watchlist);
  const developing    = arr<SignalForBacktest>(payload.developing);
  const scanner       = arr<SignalForBacktest>(payload.scanner_candidates);
  const rejected      = arr<SignalForBacktest>(payload.rejectedSignals      ?? payload.rejected);
  const watchlist     = [...watchlistRaw, ...developing, ...scanner];

  const allSymbols = new Set<string>();
  for (const r of [...approved, ...highPotential, ...watchlist, ...rejected]) {
    const s = String(r.symbol ?? r.tradingsymbol ?? '').trim();
    if (s) allSymbols.add(s);
  }

  // Load historical candles per symbol from MySQL. Skip gracefully if
  // table empty / row count zero — adapter already returns
  // `available=false` with a warning we surface to the operator.
  const candleSeriesBySymbol = new Map<string, HistoricalCandle[]>();
  let symbolsWithCandles = 0;
  const interval = intervalForWindow(window);
  // Defensive cap to keep DB load bounded on large universes.
  const symbolCap = Math.min(allSymbols.size, 200);
  const symbolList = Array.from(allSymbols).slice(0, symbolCap);
  if (symbolCap < allSymbols.size) {
    warnings.push(`Symbol pool capped to ${symbolCap} for the historical query — extend cap when scaling.`);
  }
  for (const sym of symbolList) {
    const r = await getHistoricalCandles(sym, `${startDate} 00:00:00`, `${endDate} 23:59:59`, interval);
    if (r.available && r.candles.length > 0) {
      candleSeriesBySymbol.set(sym, r.candles);
      symbolsWithCandles++;
    } else if (r.warnings.length > 0) {
      // Aggregate "no data" warnings into one — too noisy to push per symbol.
    }
  }
  if (symbolsWithCandles === 0) {
    warnings.push('Historical candle data not available for any backtest symbol. See historicalMarketData.ts for adapter wiring.');
  } else if (symbolsWithCandles < symbolList.length) {
    warnings.push(`Historical candle data available for ${symbolsWithCandles}/${symbolList.length} symbols.`);
  }

  // Market movers — Phase 4B: adapter currently returns empty with a
  // warning so the missed-opportunity backtest stays honest.
  const moversResult = await getMarketMovers(endDate);
  if (!moversResult.available) warnings.push(...moversResult.warnings);

  const input: RunBacktestInput = {
    window,
    startDate,
    endDate,
    signals: { approved, highPotential, watchlist, rejected },
    candleSeriesBySymbol,
    marketMovers: moversResult.movers,
    warnings,
  };
  const result: BacktestResult = runDailyBacktest(input);

  return NextResponse.json(
    {
      ok:          true,
      source:      'computed',
      generatedAt: result.generatedAt,
      backtest:    result,
      warnings:    result.warnings,
    },
    { headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate' } },
  );
}
