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
//   - Every internal call is wrapped in `internalFetch` with a strict
//     timeout, so a slow upstream never hangs this route and the UI
//     never sees a raw "fetch failed" message.
//   - When the signals envelope is unavailable, we still probe the
//     `candles` warehouse directly so the Data Feed Engine card
//     reflects the real state of the system instead of defaulting to
//     "No provider activity recorded."
//   - Returns ok=true even when downstream calls fail; affected
//     engines are marked NOT_CONFIGURED / INSUFFICIENT_DATA / STALE
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
import { db }                          from '@/lib/db';
import { internalFetch }               from '@/lib/api/internalFetch';
import {
  buildEngineHealthMap,
  type EngineHealthContext,
  type EngineHealthMap,
}                                      from '@/lib/signals/engineHealthMap';

export const dynamic    = 'force-dynamic';
export const revalidate = 0;

const arr = <T,>(v: unknown): T[] => Array.isArray(v) ? (v as T[]) : [];

// ── Per-upstream timeout budgets ──────────────────────────────
//
// Tuned to the worst-case latency of each route under realistic load.
// Keeping them tight ensures the health map itself never appears to
// hang from the operator's perspective.
const TIMEOUT = {
  signals:      10_000,
  dailyReport:   6_000,
  backtest:      6_000,
  candleProbe:   3_000,
} as const;

/** Direct DB probe — used as a fallback when /api/signals is unavailable
 *  so the Data Feed Engine card can show the real warehouse state.
 *  Pure read, single aggregate query, time-budget enforced by the
 *  caller via Promise.race. */
async function probeCandleWarehouse(): Promise<{
  latestCandleDate: string | null;
  candleCount:      number;
  distinctSymbols:  number;
}> {
  try {
    const { rows } = await db.query<{
      cnt:     number | string;
      latest:  string | Date | null;
      symbols: number | string;
    }>(
      `SELECT COUNT(*)                    AS cnt,
              MAX(ts)                     AS latest,
              COUNT(DISTINCT instrument_key) AS symbols
         FROM candles
        WHERE candle_type='eod' AND interval_unit='1day'`,
    );
    const r = rows?.[0];
    if (!r) return { latestCandleDate: null, candleCount: 0, distinctSymbols: 0 };
    const rawLatest = r.latest ?? null;
    const latestCandleDate = rawLatest == null
      ? null
      : typeof rawLatest === 'string'
        ? rawLatest.split('T')[0]
        : new Date(rawLatest).toISOString().split('T')[0];
    return {
      latestCandleDate,
      candleCount:     Number(r.cnt ?? 0),
      distinctSymbols: Number(r.symbols ?? 0),
    };
  } catch {
    // Fresh DB without the candles table — soft-fail.
    return { latestCandleDate: null, candleCount: 0, distinctSymbols: 0 };
  }
}

// MODULE-API-RESILIENCE-2026-05 — common safe-fallback envelope so the
// dashboard never sees a raw 500 / fetch-failed when this module degrades.
// The shape mirrors a normal success payload (`ok` + `health` skeleton)
// so the engine-health-map renderer keeps working with status fields
// instead of crashing on undefined.
const FALLBACK_HEALTH_PAYLOAD = {
  ok:           true,
  generatedAt:  null as string | null,
  health:       null,
  warnings:     [] as string[],
  sourceStatus: null,
  degraded:     true,
};
function logModuleFail(stage: string, err: unknown, extra: Record<string, unknown> = {}): void {
  const e = err instanceof Error ? err : new Error(String(err));
  console.error('[MODULE_API_FAIL]', {
    route:   '/api/signals/engine-health',
    stage,
    message: e.message,
    stack:   e.stack?.split('\n').slice(0, 6).join('\n'),
    ...extra,
  });
}

export async function GET(req: NextRequest) {
  // MODULE-API-RESILIENCE-2026-05 — session check must never throw out
  // of this handler. A failed `requireSession()` (expired cookie, etc.)
  // would otherwise bubble as an unhandled rejection → 500 → dashboard
  // shows "Engine Health: fetch failed".
  try { await requireSession(); }
  catch (err) {
    logModuleFail('requireSession', err);
    return NextResponse.json(
      { ...FALLBACK_HEALTH_PAYLOAD, generatedAt: new Date().toISOString(),
        warnings: ['Authentication required for engine health'] },
      { status: 401, headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate' } },
    );
  }

  // Outer try/catch ensures any later throw still ships a safe payload.
  try {

  const url     = new URL(req.url);
  const verbose = url.searchParams.get('verbose') === 'true';
  const warnings: string[] = [];
  const cookieHeader = req.headers.get('cookie') ?? '';

  // Fan-out — every upstream is independent so we run them in parallel
  // and tolerate individual failures via Promise.allSettled.
  const [signalsRes, dailyRes, backtestRes, candleProbeSettled] = await Promise.allSettled([
    internalFetch<any>(req, `/api/signals?action=all&limit=20&request_id=health-${Date.now()}`, {
      cookieHeader, timeoutMs: TIMEOUT.signals,
    }),
    internalFetch<any>(req, `/api/signals/daily-report`, {
      cookieHeader, timeoutMs: TIMEOUT.dailyReport,
    }),
    internalFetch<any>(req, `/api/signals/backtest?window=1D`, {
      cookieHeader, timeoutMs: TIMEOUT.backtest,
    }),
    // The candle probe never throws (it returns a zero-shape on
    // failure) but we still budget it via Promise.race so a hung DB
    // can't pin the health route.
    Promise.race([
      probeCandleWarehouse(),
      new Promise<{ latestCandleDate: null; candleCount: 0; distinctSymbols: 0 }>(
        (resolve) => setTimeout(
          () => resolve({ latestCandleDate: null, candleCount: 0, distinctSymbols: 0 }),
          TIMEOUT.candleProbe,
        ),
      ),
    ]),
  ]);

  const signals = signalsRes.status === 'fulfilled' ? signalsRes.value
    : { ok: false, status: 0, data: null, error: 'settled-rejected', timedOut: false, elapsedMs: 0, timeoutMs: TIMEOUT.signals, url: '' };
  const daily   = dailyRes.status === 'fulfilled' ? dailyRes.value
    : { ok: false, status: 0, data: null, error: 'settled-rejected', timedOut: false, elapsedMs: 0, timeoutMs: TIMEOUT.dailyReport, url: '' };
  const backtest = backtestRes.status === 'fulfilled' ? backtestRes.value
    : { ok: false, status: 0, data: null, error: 'settled-rejected', timedOut: false, elapsedMs: 0, timeoutMs: TIMEOUT.backtest, url: '' };
  const candleCoverage = candleProbeSettled.status === 'fulfilled'
    ? candleProbeSettled.value
    : { latestCandleDate: null, candleCount: 0, distinctSymbols: 0 };

  // Operator-facing warnings — these become the "Open Issues" + the
  // banner under the overall summary card. We deliberately convert
  // raw transport errors ("fetch failed") into structured language.
  if (!signals.ok) {
    warnings.push(
      signals.timedOut
        ? `Signal Engine summary did not respond within ${Math.round(signals.timeoutMs / 1000)}s — health map is using fallback candle warehouse readings.`
        : `Signal Engine summary unavailable (status ${signals.status || 'network'}). Health map will fall back to direct database probes.`,
    );
  }
  if (!daily.ok) {
    warnings.push(
      daily.timedOut
        ? `Daily Report summary did not respond within ${Math.round(daily.timeoutMs / 1000)}s.`
        : `Daily Report summary unavailable (status ${daily.status || 'network'}).`,
    );
  }
  if (!backtest.ok) {
    warnings.push(
      backtest.timedOut
        ? `Backtest preview did not respond within ${Math.round(backtest.timeoutMs / 1000)}s.`
        : `Backtest preview unavailable (status ${backtest.status || 'network'}).`,
    );
  }

  const payload = signals.data ?? null;

  // Build the context the pure engineHealthMap builder needs. When the
  // signals envelope is missing, the fields below resolve to null and
  // the builder uses the `transport` + `candleCoverage` hints to
  // distinguish "delayed" from "never configured".
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
      candleCoverage,
    },
    transport: {
      signalsAvailable:     signals.ok,
      signalsTimedOut:      signals.timedOut,
      signalsErrorMessage:  signals.ok ? null : (signals.error ?? null),
      dailyReportAvailable: daily.ok,
      backtestAvailable:    backtest.ok,
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

  if (daily.ok && daily.data) {
    const drJson = daily.data;
    ctx.dailyReport = {
      available:    true,
      reportStatus: drJson?.report?.reportStatus,
      generatedAt:  drJson?.report?.generatedAt ?? drJson?.generatedAt ?? null,
      warnings:     Array.isArray(drJson?.warnings) ? drJson.warnings : [],
    };
  } else {
    ctx.dailyReport = { available: false };
  }

  if (backtest.ok && backtest.data) {
    const bt = backtest.data?.backtest;
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
  }

  const health: EngineHealthMap = buildEngineHealthMap(ctx);

  return NextResponse.json(
    {
      ok:           true,
      generatedAt:  health.generatedAt,
      health,
      warnings,
      sourceStatus: {
        signals:     { ok: signals.ok,  status: signals.status,  timedOut: signals.timedOut,  elapsedMs: signals.elapsedMs,  timeoutMs: signals.timeoutMs },
        dailyReport: { ok: daily.ok,    status: daily.status,    timedOut: daily.timedOut,    elapsedMs: daily.elapsedMs,    timeoutMs: daily.timeoutMs },
        backtest:    { ok: backtest.ok, status: backtest.status, timedOut: backtest.timedOut, elapsedMs: backtest.elapsedMs, timeoutMs: backtest.timeoutMs },
        candleProbe: candleCoverage,
      },
      verbose:      verbose ? { signalPayload: payload } : undefined,
    },
    { headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate' } },
  );
  } catch (err) {
    // MODULE-API-RESILIENCE-2026-05 — any unhandled throw in the body
    // above lands here. Returning a structured 200 with `degraded: true`
    // keeps the dashboard's engine-health card alive (it renders a
    // "degraded" badge instead of "fetch failed").
    logModuleFail('GET-handler', err);
    return NextResponse.json(
      {
        ...FALLBACK_HEALTH_PAYLOAD,
        generatedAt: new Date().toISOString(),
        warnings:    [
          err instanceof Error
            ? `Engine Health degraded: ${err.message}`
            : 'Engine Health degraded (internal error)',
        ],
      },
      { status: 200, headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate' } },
    );
  }
}
