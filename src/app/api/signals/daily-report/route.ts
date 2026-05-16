// ════════════════════════════════════════════════════════════════
//  GET /api/signals/daily-report
//
//  Phase 3 — Daily Signal Intelligence Report API.
//
//  Reads today's signal pools from the same /api/signals endpoint
//  the dashboard consumes, runs the pure `buildDailySignalReport`
//  builder, and returns a structured report envelope.
//
//  ?date=YYYY-MM-DD — optional. Currently restricted to today; a
//  historical report requires persisted snapshots which Phase 3
//  ships as a proposal only (see migration file
//  010_q365_daily_signal_reports.sql.proposal). When ?date is past,
//  the route returns ok=true with reportStatus='INSUFFICIENT_DATA'
//  and an explicit warning.
//
//  No threshold changes. No fabricated data. Missing data is
//  surfaced as INSUFFICIENT_DATA in the report body.
// ════════════════════════════════════════════════════════════════

import { NextRequest, NextResponse } from 'next/server';
import { requireSession }            from '@/lib/session';
import { getMarketStatus }           from '@/lib/marketData/marketHours';
import {
  buildDailySignalReport,
  type DailyReportInput,
}                                    from '@/lib/signals/dailySignalReport';

export const dynamic    = 'force-dynamic';
export const revalidate = 0;

const isoDate = (s?: string | null): string => {
  if (s && /^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  return new Date().toISOString().slice(0, 10);
};

const todayISO = (): string => new Date().toISOString().slice(0, 10);

export async function GET(req: NextRequest) {
  // Auth — same predicate as /api/signals.
  await requireSession();

  const url = new URL(req.url);
  const requestedDate = isoDate(url.searchParams.get('date'));
  const today         = todayISO();
  const warnings:     string[] = [];

  // Historical reports are not stored yet; the proposal migration
  // sketches q365_daily_signal_reports. Honour ?date= for today only.
  if (requestedDate !== today) {
    warnings.push(
      `Historical daily reports are not persisted yet (requested ${requestedDate}, today is ${today}). `
      + 'See migrations/postgres/010_q365_daily_signal_reports.sql.proposal.',
    );
  }

  // Pull the same payload the dashboard polls so the report is
  // computed off the exact production state. This keeps the report
  // honest — no separate query path that could drift from the page.
  let payload: any = null;
  try {
    const origin = `${url.protocol}//${url.host}`;
    const internalUrl = `${origin}/api/signals?action=all&limit=20&request_id=daily-report-${Date.now()}`;
    const cookieHeader = req.headers.get('cookie') ?? '';
    const res = await fetch(internalUrl, {
      cache:   'no-store',
      headers: cookieHeader ? { cookie: cookieHeader } : {},
    });
    if (res.ok) payload = await res.json();
    else warnings.push(`Internal /api/signals returned ${res.status}.`);
  } catch (e) {
    warnings.push(`Failed to read /api/signals internally: ${(e as Error).message ?? 'unknown error'}.`);
  }

  if (!payload) {
    // Emit an explicit empty / partial report rather than a 500.
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
    };
    const partial = buildDailySignalReport(fallbackInput);
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

  // Build the report input from the live payload. The pools are
  // already filtered + ranked by the signal-engine response, so we
  // reuse them verbatim.
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
  };

  const report = buildDailySignalReport(reportInput);

  // ── PHASE_4_BACKTESTING_2026-05 ──
  // Attach a backtest preview when /api/signals/backtest succeeds.
  // Fire-and-forget — a backtest failure must NEVER block the daily
  // report. The route catches everything and surfaces a warning.
  try {
    const origin = `${url.protocol}//${url.host}`;
    const cookieHeader = req.headers.get('cookie') ?? '';
    const btRes = await fetch(`${origin}/api/signals/backtest?window=1D`, {
      cache: 'no-store',
      headers: cookieHeader ? { cookie: cookieHeader } : {},
    });
    if (btRes.ok) {
      const btPayload = await btRes.json();
      const bt = btPayload?.backtest;
      if (bt) {
        report.backtestPreview = {
          status:                  bt.status,
          window:                  bt.window,
          totalTested:             bt.universe?.symbolsTested ?? 0,
          winRate:                 bt.performance?.winRate ?? null,
          approvedWinRate:         bt.tierPerformance?.approved?.winRate ?? null,
          highPotentialWinRate:    bt.tierPerformance?.highPotential?.winRate ?? null,
          topIndicator:            bt.indicatorPerformance?.[0]?.indicator ?? null,
          weakestIndicator:        bt.indicatorPerformance?.[bt.indicatorPerformance.length - 1]?.indicator ?? null,
          dataSufficiency:         bt.status === 'COMPLETE' ? 'COMPLETE'
                                  : bt.status === 'PARTIAL'  ? 'PARTIAL'
                                  : 'INSUFFICIENT_DATA',
          warnings:                Array.isArray(bt.warnings) ? bt.warnings.slice(0, 5) : [],
        };
      } else {
        warnings.push('Backtest preview unavailable — no backtest result returned.');
      }
    } else {
      warnings.push(`Backtest preview unavailable — /api/signals/backtest returned ${btRes.status}.`);
    }
  } catch (e) {
    warnings.push(`Backtest preview unavailable — ${(e as Error).message ?? 'unknown error'}.`);
  }

  // Warnings from the report itself (data-quality, partial sections).
  if (Array.isArray(report.warnings)) warnings.push(...report.warnings);

  return NextResponse.json(
    {
      ok:           true,
      report,
      generatedAt:  new Date().toISOString(),
      source:       'computed', // persisted reports come in Phase 3B / Phase 4
      warnings,
    },
    { headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate' } },
  );
}
