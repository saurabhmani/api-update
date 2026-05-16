// ════════════════════════════════════════════════════════════════
//  GET /api/signals/engine-health
//
//  Phase 5 — Engine Health Map & Process Observability API.
//
//  Reads the same /api/signals envelope the dashboard polls, then
//  augments it with optional daily-report + backtest signals so the
//  health map can mark those engines accordingly. Pure builder lives
//  in src/lib/signals/engineHealthMap.ts.
//
//  Safety:
//   - Returns ok=true even when downstream calls fail; the affected
//     engine is marked NOT_CONFIGURED / INSUFFICIENT_DATA / BROKEN
//     with explicit warnings, never fabricated as HEALTHY.
//   - No threshold changes, no scoring writes.
//
//  Query params:
//    ?verbose=true   — include the full /api/signals payload too.
//    ?date=YYYY-MM-DD — accepted for forward-compatibility; today only.
// ════════════════════════════════════════════════════════════════

import { NextRequest, NextResponse }   from 'next/server';
import { requireSession }              from '@/lib/session';
import { getMarketStatus }             from '@/lib/marketData/marketHours';
import {
  buildEngineHealthMap,
  type EngineHealthContext,
  type EngineHealthMap,
}                                      from '@/lib/signals/engineHealthMap';

export const dynamic    = 'force-dynamic';
export const revalidate = 0;

const arr = <T,>(v: unknown): T[] => Array.isArray(v) ? (v as T[]) : [];

export async function GET(req: NextRequest) {
  await requireSession();

  const url     = new URL(req.url);
  const verbose = url.searchParams.get('verbose') === 'true';
  const warnings: string[] = [];

  // Pull /api/signals so the health map evaluates the EXACT state
  // the operator's dashboard is reading.
  let payload: any = null;
  try {
    const origin = `${url.protocol}//${url.host}`;
    const cookieHeader = req.headers.get('cookie') ?? '';
    const res = await fetch(
      `${origin}/api/signals?action=all&limit=20&request_id=health-${Date.now()}`,
      { cache: 'no-store', headers: cookieHeader ? { cookie: cookieHeader } : {} },
    );
    if (res.ok) payload = await res.json();
    else warnings.push(`Internal /api/signals returned ${res.status}.`);
  } catch (e) {
    warnings.push(`Failed to read /api/signals internally: ${(e as Error).message ?? 'unknown error'}.`);
  }

  // When the signal payload is missing we still emit a structured
  // health map so the operator sees WHY everything is unknown.
  const marketDefault = getMarketStatus();
  const ctx: EngineHealthContext = {
    generatedAt: new Date().toISOString(),
    marketStatus: {
      isOpen: payload?.marketStatus?.isOpen === true,
      label:  payload?.marketStatus?.label  ?? marketDefault.label,
      state:  payload?.marketStatus?.state  ?? marketDefault.state,
    },
    feed: {
      provider:           typeof payload?.provider === 'string' ? payload.provider : null,
      lastSuccessAt:      payload?.lastSuccessAt    ?? null,
      lastApiRequestAt:   payload?.lastApiRequestAt ?? null,
      isBootstrap:        payload?.isBootstrap === true,
      isFallback:         payload?.isFallback  === true,
      staleMinutes:       payload?.dataFreshness?.ageMinutes ?? null,
      freshnessLabel:     payload?.dataFreshness?.label ?? null,
      coveragePercent:    payload?.freshness?.scan_coverage_percent ?? null,
      symbolsRequested:   payload?.freshness?.latest_batch_symbols ?? null,
      symbolsReturned:    typeof payload?.main_signals_count === 'number' ? payload.main_signals_count : null,
      candleAgeHours:     payload?.freshness?.candle_age_hours ?? null,
    },
    pipeline: {
      lastPipelineRunAt:     payload?.lastPipelineRunAt        ?? payload?.freshness?.last_pipeline_run ?? null,
      lastConfirmedSignalAt: payload?.lastConfirmedSignalAt    ?? payload?.freshness?.signal_latest_generated ?? null,
      latestBatchId:         payload?.latest_batch_id          ?? payload?.freshness?.latest_batch_id ?? null,
      latestBatchEngineKind: payload?.freshness?.latest_batch_engine_kind ?? null,
      scanCoveragePercent:   payload?.freshness?.scan_coverage_percent ?? null,
      totalScanned:          payload?.freshness?.total_scanned ?? null,
      totalPersisted:        payload?.freshness?.total_persisted ?? null,
      universeSize:          payload?.freshness?.universe_size ?? null,
      inProgressCount:       payload?.freshness?.in_progress_count ?? null,
      validationStatus:      typeof payload?.validation_status === 'string' ? payload.validation_status : null,
    },
    signals: {
      approved:           arr(payload?.approvedSignals      ?? payload?.signals),
      highPotential:      arr(payload?.highPotentialSignals ?? payload?.high_potential),
      watchlist:          arr(payload?.watchlistSignals     ?? payload?.watchlist),
      developing:         arr(payload?.developing),
      scannerCandidates:  arr(payload?.scanner_candidates),
      riskRestricted:     arr(payload?.risk_restricted),
      rejected:           arr(payload?.rejectedSignals      ?? payload?.rejected),
    },
    counters: payload?.counters && typeof payload.counters === 'object' ? payload.counters : {
      approvedTotal: 0, approvedBuy: 0, approvedSell: 0,
      highPotentialTotal: 0, watchlistTotal: 0, rejectedTotal: 0, candidateTotal: 0,
    },
    dueDiligenceSummary: payload?.dueDiligenceSummary ?? null,
  };

  // Daily-report + backtest are best-effort: pull from their own
  // routes so the health map can mark them accurately, but never
  // fail the health response if they error.
  try {
    const origin = `${url.protocol}//${url.host}`;
    const cookieHeader = req.headers.get('cookie') ?? '';
    const drRes = await fetch(`${origin}/api/signals/daily-report`, {
      cache: 'no-store', headers: cookieHeader ? { cookie: cookieHeader } : {},
    });
    if (drRes.ok) {
      const drJson = await drRes.json();
      ctx.dailyReport = {
        available:     true,
        reportStatus:  drJson?.report?.reportStatus,
        generatedAt:   drJson?.report?.generatedAt ?? drJson?.generatedAt ?? null,
        warnings:      Array.isArray(drJson?.warnings) ? drJson.warnings : [],
      };
    } else {
      ctx.dailyReport = { available: false };
      warnings.push(`Daily report fetch returned ${drRes.status}.`);
    }
  } catch (e) {
    ctx.dailyReport = { available: false };
    warnings.push(`Daily report fetch failed: ${(e as Error).message ?? 'unknown error'}.`);
  }

  try {
    const origin = `${url.protocol}//${url.host}`;
    const cookieHeader = req.headers.get('cookie') ?? '';
    const btRes = await fetch(`${origin}/api/signals/backtest?window=1D`, {
      cache: 'no-store', headers: cookieHeader ? { cookie: cookieHeader } : {},
    });
    if (btRes.ok) {
      const btJson = await btRes.json();
      const bt = btJson?.backtest;
      ctx.backtest = bt
        ? {
            available:        true,
            status:           bt.status,
            window:           bt.window,
            generatedAt:      bt.generatedAt,
            symbolsWithData:  bt.universe?.symbolsTested ?? null,
            totalSymbols:     bt.universe?.symbolsTested ?? null,
            warnings:         Array.isArray(bt.warnings) ? bt.warnings : [],
          }
        : { available: false };
    } else {
      ctx.backtest = { available: false };
      warnings.push(`Backtest fetch returned ${btRes.status}.`);
    }
  } catch (e) {
    ctx.backtest = { available: false };
    warnings.push(`Backtest fetch failed: ${(e as Error).message ?? 'unknown error'}.`);
  }

  const health: EngineHealthMap = buildEngineHealthMap(ctx);

  return NextResponse.json(
    {
      ok:           true,
      generatedAt:  health.generatedAt,
      health,
      warnings,
      verbose:      verbose ? { signalPayload: payload } : undefined,
    },
    { headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate' } },
  );
}
