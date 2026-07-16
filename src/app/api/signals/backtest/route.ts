// ════════════════════════════════════════════════════════════════
//  GET /api/signals/backtest
//
//  Phase 4 — Daily Backtesting Engine API.
//
//  Query parameters:
//    ?window=INTRADAY | 1D | 7D | 30D | 90D
//    ?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD   (CUSTOM window)
//
//  Performance (2026-07):
//    - Batch candle SQL (getHistoricalCandlesBatch) replaces per-symbol
//      sequential queries — was the dominant latency source in prod.
//    - Shared short-TTL signals payload cache + 4s nested budget so
//      parent 8s callers (dashboard / engine-health) do not abort.
//    - Sargable candle predicates + preview symbol cap.
//    - Structured [API_PERF] logging via apiPerf.ts.
// ════════════════════════════════════════════════════════════════

import { NextRequest, NextResponse }    from 'next/server';
import { requireSession }               from '@/lib/session';
import { createApiPerfTracker }           from '@/lib/api/apiPerf';
import {
  parseBacktestWindow,
  runSignalsBacktestFromPayload,
}                                       from '@/lib/signals/signalsBacktestHandler';
import { fetchEngineSignalsPayload }    from '@/lib/signals/engineSignalsPayload';

export const dynamic    = 'force-dynamic';
export const revalidate = 0;

/** Stay under parent 8s abort (engine-health); dashboard uses 5s for 1D. */
const RESPONSE_BUDGET_MS = 7_500;

const isoDate = (s?: string | null): string | null => {
  if (!s) return null;
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
};

export async function GET(req: NextRequest) {
  const perf = createApiPerfTracker('/api/signals/backtest');
  const startedAt = Date.now();

  try {
    await requireSession();
    perf.mark('session');

    const url    = new URL(req.url);
    const window = parseBacktestWindow(url.searchParams.get('window'));
    const customStart = isoDate(url.searchParams.get('startDate'));
    const customEnd   = isoDate(url.searchParams.get('endDate'));

    const cookieHeader = req.headers.get('cookie') ?? '';
    const signalsFetch = await fetchEngineSignalsPayload(
      req,
      cookieHeader,
      perf,
      'backtest',
    );

    const warnings: string[] = [];
    let payload: any = null;
    if (signalsFetch.ok) payload = signalsFetch.data;
    else warnings.push(
      signalsFetch.timedOut
        ? 'Internal /api/signals timed out.'
        : `Internal /api/signals returned ${signalsFetch.status || signalsFetch.error}.`,
    );

    if (!payload) {
      const totalMs = Date.now() - startedAt;
      perf.setMeta('under8s', totalMs < 8_000);
      perf.finish({ ok: true, partial: true, totalMs });
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

    const result = await runSignalsBacktestFromPayload({
      window,
      customStart,
      customEnd,
      signalsPayload: payload,
      perf,
      startedAt,
      deadlineMs: RESPONSE_BUDGET_MS,
      symbolCap: (window === '30D' || window === '90D' || window === 'CUSTOM') ? 80 : 40,
    });

    perf.setMeta('symbolsQueried', result.meta?.symbolsQueried ?? 0);
    perf.setMeta('symbolsWithCandles', result.meta?.symbolsWithCandles ?? 0);
    const totalMs = Date.now() - startedAt;
    perf.setMeta('under8s', totalMs < 8_000);
    perf.finish({ ok: true, window, totalMs });

    return NextResponse.json(
      {
        ok:          result.ok,
        source:      result.source,
        generatedAt: result.generatedAt,
        backtest:    result.backtest,
        warnings:    [...warnings, ...result.warnings],
        meta:        result.meta,
      },
      { headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate' } },
    );
  } catch (err) {
    perf.finish({ ok: false, error: (err as Error).message, totalMs: Date.now() - startedAt });
    throw err;
  }
}
