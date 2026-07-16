// ════════════════════════════════════════════════════════════════
//  GET /api/signals/daily-report
//
//  Phase 3 — Daily Signal Intelligence Report API.
//
//  Performance (2026-07):
//    - Parallel fetch: market movers + /api/signals (was sequential).
//    - Backtest preview via runSignalsBacktestFromPayload (no nested
//      HTTP to /api/signals/backtest — avoids duplicate signals fetch).
//    - Shared short-TTL signals payload cache + 4s nested budget so
//      parent 8s callers (dashboard / engine-health) do not abort.
//    - Reuse movers in embedded backtest (no second movers SQL).
//    - Structured [API_PERF] logging via apiPerf.ts.
// ════════════════════════════════════════════════════════════════

import { NextRequest, NextResponse } from 'next/server';
import { requireSession }            from '@/lib/session';
import { createApiPerfTracker }      from '@/lib/api/apiPerf';
import { getMarketStatus, toIstCalendarDate } from '@/lib/marketData/marketHours';
import {
  buildDailySignalReport,
  type DailyReportInput,
}                                    from '@/lib/signals/dailySignalReport';
import { getHistoricalMarketMovers } from '@/lib/signals/historicalMarketData';
import {
  backtestToDailyReportPreview,
  runSignalsBacktestFromPayload,
}                                    from '@/lib/signals/signalsBacktestHandler';
import { fetchEngineSignalsPayload } from '@/lib/signals/engineSignalsPayload';

export const dynamic    = 'force-dynamic';
export const revalidate = 0;

/** Stay under parent 8s abort (dashboard / engine-health). */
const RESPONSE_BUDGET_MS = 7_500;
/** Need this much headroom to attempt embedded backtest preview. */
const BACKTEST_MIN_REMAINING_MS = 1_200;

const isoDate = (s?: string | null): string => {
  if (s && /^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  return toIstCalendarDate(new Date());
};

const todayISO = (): string => toIstCalendarDate(new Date());

export async function GET(req: NextRequest) {
  const perf = createApiPerfTracker('/api/signals/daily-report');
  const startedAt = Date.now();

  try {
    await requireSession();
    perf.mark('session');

    const url = new URL(req.url);
    const requestedDate = isoDate(url.searchParams.get('date'));
    const today         = todayISO();
    const warnings:     string[] = [];

    if (requestedDate !== today) {
      warnings.push(
        `Historical daily reports are not persisted yet (requested ${requestedDate}, today is ${today}). `
        + 'See migrations/postgres/010_q365_daily_signal_reports.sql.proposal.',
      );
    }

    const cookieHeader = req.headers.get('cookie') ?? '';

    const [moversResult, signalsFetch] = await Promise.all([
      perf.time('market_movers', () =>
        getHistoricalMarketMovers(requestedDate, { limit: 20 }),
      ),
      fetchEngineSignalsPayload(req, cookieHeader, perf, 'daily-report'),
    ]);

    if (!moversResult.available) {
      warnings.push(...moversResult.warnings);
    }
    const marketMoversInput = moversResult.available
      ? moversResult.movers.map((m) => ({
          symbol:      m.symbol,
          movePercent: m.movePercent,
          direction:   m.direction,
          volume:      m.volume,
          date:        m.date,
        }))
      : undefined;

    let payload: any = null;
    if (signalsFetch.ok) payload = signalsFetch.data;
    else warnings.push(
      signalsFetch.timedOut
        ? 'Internal /api/signals timed out.'
        : `Internal /api/signals returned ${signalsFetch.status || signalsFetch.error}.`,
    );

    if (!payload) {
      const market = getMarketStatus();
      const fallbackInput: DailyReportInput = {
        reportDate:   requestedDate,
        marketStatus: { isOpen: market.isOpen, label: market.label, state: market.state },
        signals: {
          approved:          [], highPotential: [], watchlist: [], developing: [],
          scannerCandidates: [], riskRestricted: [], rejected: [],
        },
        dueDiligenceSummary: null,
        dataQuality: {
          provider: null, lastSuccessAt: null, staleMinutes: null,
          symbolsRequested: null, symbolsReturned: null, coveragePercent: null,
          isBootstrap: false, isFallback: false, freshnessLabel: null,
        },
        marketMovers: marketMoversInput,
      };
      const partial = buildDailySignalReport(fallbackInput);
      perf.finish({ ok: true, partial: true, totalMs: Date.now() - startedAt });
      return NextResponse.json(
        {
          ok:           true,
          report:       partial,
          generatedAt:  new Date().toISOString(),
          source:       'partial',
          warnings,
        },
        { headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate' } },
      );
    }

    const arrayOrEmpty = <T,>(v: unknown): T[] => Array.isArray(v) ? (v as T[]) : [];

    const reportInput: DailyReportInput = {
      reportDate:   requestedDate,
      marketStatus: {
        isOpen: payload?.marketStatus?.isOpen === true,
        label:  payload?.marketStatus?.label ?? 'Unknown',
        state:  payload?.marketStatus?.state ?? null,
      },
      signals: {
        approved:           arrayOrEmpty(payload.approvedSignals      ?? payload.signals),
        highPotential:      arrayOrEmpty(payload.highPotentialSignals ?? payload.high_potential),
        watchlist:          arrayOrEmpty(payload.watchlistSignals     ?? payload.watchlist),
        developing:         arrayOrEmpty(payload.developing),
        scannerCandidates:  arrayOrEmpty(payload.scanner_candidates),
        riskRestricted:     arrayOrEmpty(payload.risk_restricted),
        rejected:           arrayOrEmpty(payload.rejectedSignals     ?? payload.rejected),
      },
      dueDiligenceSummary: payload.dueDiligenceSummary ?? null,
      dataQuality: {
        provider:          typeof payload.provider === 'string' ? payload.provider : null,
        lastSuccessAt:     payload.lastSuccessAt ?? null,
        staleMinutes:      payload?.dataFreshness?.ageMinutes ?? null,
        symbolsRequested:  payload?.freshness?.latest_batch_symbols ?? null,
        symbolsReturned:   typeof payload.main_signals_count === 'number' ? payload.main_signals_count : null,
        coveragePercent:   payload?.freshness?.scan_coverage_percent ?? null,
        isBootstrap:       payload.isBootstrap === true,
        isFallback:        payload.isFallback === true,
        freshnessLabel:    payload?.dataFreshness?.label ?? null,
      },
      marketMovers: marketMoversInput,
    };

    const report = await perf.time('buildDailySignalReport', async () =>
      buildDailySignalReport(reportInput),
    );

    const remainingMs = RESPONSE_BUDGET_MS - (Date.now() - startedAt);
    if (remainingMs >= BACKTEST_MIN_REMAINING_MS) {
      try {
        const btResult = await runSignalsBacktestFromPayload({
          window:         '1D',
          signalsPayload: payload,
          perf,
          marketMovers:   moversResult.available ? moversResult.movers : [],
          startedAt,
          deadlineMs:     RESPONSE_BUDGET_MS,
          symbolCap:      40,
        });
        if (btResult.backtest) {
          report.backtestPreview = backtestToDailyReportPreview(btResult.backtest);
        } else {
          warnings.push('Backtest preview unavailable — no backtest result returned.');
        }
        if (btResult.warnings.length > 0) {
          const previewWarn = btResult.warnings.find((w) =>
            /Historical candle data not available|timed out|budget/i.test(w),
          );
          if (previewWarn) {
            warnings.push(`Backtest preview note — ${previewWarn}`);
          }
        }
      } catch (e) {
        warnings.push(`Backtest preview unavailable — ${(e as Error).message ?? 'unknown error'}.`);
      }
    } else {
      warnings.push(
        `Backtest preview skipped — only ${remainingMs}ms remaining under ${RESPONSE_BUDGET_MS}ms budget.`,
      );
      perf.mark('backtest_preview_skipped_budget', { remainingMs });
    }

    if (Array.isArray(report.warnings)) warnings.push(...report.warnings);

    const totalMs = Date.now() - startedAt;
    perf.setMeta('under8s', totalMs < 8_000);
    perf.finish({ ok: true, source: 'computed', totalMs });

    return NextResponse.json(
      {
        ok:           true,
        report,
        generatedAt:  new Date().toISOString(),
        source:       'computed',
        warnings,
      },
      { headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate' } },
    );
  } catch (err) {
    perf.finish({ ok: false, error: (err as Error).message, totalMs: Date.now() - startedAt });
    throw err;
  }
}
