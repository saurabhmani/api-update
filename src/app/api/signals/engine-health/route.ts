// ════════════════════════════════════════════════════════════════
//  GET /api/signals/engine-health
//
//  Phase 5 — Engine Health Map & Process Observability API.
//
//  Reads indexed DB summaries directly, then builds the health map. Pure
//  builder lives in src/lib/signals/engineHealthMap.ts.
//
//  Performance (2026-08):
//    - Does NOT fan out to /api/signals/daily-report or
//      /api/signals/backtest (each re-fetched /api/signals and raced
//      a 10s+ candles COUNT(*)/COUNT(DISTINCT) probe for pool slots).
//    - Daily report node uses signals.dailyReportPreview.
//    - Backtest readiness uses the cheap candle warehouse MAX(ts) probe.
//    - Candle probe is TTL-cached + in-flight coalesced.
//
//  Safety:
//   - Signal state comes from a strict-timeout direct DB probe; no engine runs.
//   - When the signals envelope is unavailable, candle + learning probes
//     still populate Data Feed / Learning cards.
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
import { probeSignalEngineHealthDirect } from '@/lib/maintenance/engineHealthProbe';
import {
  buildEngineHealthMap,
  type EngineHealthContext,
  type EngineHealthMap,
}                                      from '@/lib/signals/engineHealthMap';
import { probeLearningPersistence }    from '@/lib/learning/learningPersistenceProbe';
import { probeCandleWarehouse }        from '@/lib/monitor/candleWarehouseProbe';
import {
  engineDebugger,
  runWithEngineDebugAsync,
}                                      from '@/lib/engineDebug/engineDebugger';

export const dynamic    = 'force-dynamic';
export const revalidate = 0;

const arr = <T,>(v: unknown): T[] => Array.isArray(v) ? (v as T[]) : [];

// ── Per-upstream timeout budgets ──────────────────────────────
//
// Tuned to the worst-case latency of each route under realistic load.
// Keeping them tight ensures the health map itself never appears to
// hang from the operator's perspective.
//
// PERF (2026-08): daily-report + backtest sibling HTTP removed from the
// critical path. They each re-fetched /api/signals (~6–22s) and contended
// with the candle warehouse probe for pool slots. Daily report status now
// comes from signals.dailyReportPreview; backtest readiness from the
// cheap candle warehouse probe.
const TIMEOUT = {
  // /api/signals is heavy — lite=true keeps health aggregation under budget.
  signals:       1_500,
  candleProbe:   2_000,
  learningProbe: 3_000,
} as const;

/** Minimal context when the signals envelope is unavailable or the
 *  handler throws — still renders a usable health map from DB probes. */
function buildFallbackHealthContext(
  candleCoverage: {
    latestCandleDate: string | null;
    candleCount:      number;
    distinctSymbols:  number;
  },
  market = getMarketStatus(),
): EngineHealthContext {
  return {
    generatedAt: new Date().toISOString(),
    marketStatus: {
      isOpen: market.isOpen,
      label:  market.label,
      state:  market.state,
    },
    feed: {
      provider:         candleCoverage.candleCount > 0 ? 'candles_warehouse' : null,
      lastSuccessAt:    null,
      lastApiRequestAt: null,
      isBootstrap:      false,
      isFallback:       false,
      staleMinutes:     null,
      freshnessLabel:   null,
      coveragePercent:  null,
      symbolsRequested: null,
      symbolsReturned:  null,
      candleAgeHours:   null,
      candleCoverage,
    },
    transport: {
      signalsAvailable:     false,
      signalsTimedOut:      true,
      signalsErrorMessage:  'signals envelope unavailable',
      dailyReportAvailable: false,
      backtestAvailable:    false,
    },
    pipeline: {
      lastPipelineRunAt:     null,
      lastConfirmedSignalAt: null,
      latestBatchId:         null,
      latestBatchEngineKind: null,
      scanCoveragePercent:   null,
      totalScanned:          null,
      totalPersisted:        null,
      universeSize:          null,
      inProgressCount:       null,
      validationStatus:      null,
    },
    signals: {
      approved: [], highPotential: [], watchlist: [], developing: [],
      scannerCandidates: [], riskRestricted: [], rejected: [],
    },
    counters: {
      approvedTotal: 0, approvedBuy: 0, approvedSell: 0,
      highPotentialTotal: 0, watchlistTotal: 0, rejectedTotal: 0, candidateTotal: 0,
    },
    dueDiligenceSummary: null,
    dailyReport:  { available: false },
    backtest:     { available: false },
    learningPersistence: {
      tableExists: false, observationCount: 0, distinctStrategies: 0, lastReviewedAt: null,
    },
  };
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
  const requestId =
    req.headers.get('x-request-id')
    ?? req.nextUrl.searchParams.get('request_id')
    ?? `engine-health-${Date.now().toString(36)}`;

  return runWithEngineDebugAsync(
    {
      requestId,
      engine: 'engine-health',
      file: 'src/app/api/signals/engine-health/route.ts',
      function: 'GET',
      route: 'GET /api/signals/engine-health',
    },
    () => getEngineHealth(req, requestId),
  );
}

async function getEngineHealth(req: NextRequest, requestId: string) {
  const routeSpan = engineDebugger.routeStart({
    route: 'GET /api/signals/engine-health',
    function: 'GET',
    requestId,
    engine: 'engine-health',
    file: 'src/app/api/signals/engine-health/route.ts',
  });

  // MODULE-API-RESILIENCE-2026-05 — session check must never throw out
  // of this handler. A failed `requireSession()` (expired cookie, etc.)
  // would otherwise bubble as an unhandled rejection → 500 → dashboard
  // shows "Engine Health: fetch failed".
  try { await requireSession(); }
  catch (err) {
    logModuleFail('requireSession', err);
    routeSpan.error(err, { stage: 'requireSession' });
    routeSpan.end(401);
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

  // Fan-out — signals + cheap warehouse probes only.
  // daily-report / backtest sibling HTTP removed: they each re-hit
  // /api/signals and raced the candle COUNT(*) probe for pool slots
  // (see engine-debug.log requestId=engine-health-msnc2f1g).
  const [signalsRes, candleProbeSettled, learningProbeSettled] = await Promise.allSettled([
    Promise.race([
      probeSignalEngineHealthDirect().then((data) => ({ ok: true, status: 200, data,
        error: null, timedOut: false, elapsedMs: 0, timeoutMs: TIMEOUT.signals })),
      new Promise<any>((resolve) => setTimeout(() => resolve({ ok: false, status: 0, data: null,
        error: 'direct DB probe timed out', timedOut: true, elapsedMs: TIMEOUT.signals,
        timeoutMs: TIMEOUT.signals }), TIMEOUT.signals)),
    ]),
    Promise.race([
      probeCandleWarehouse(),
      new Promise<{ latestCandleDate: null; candleCount: 0; distinctSymbols: 0 }>(
        (resolve) => setTimeout(
          () => resolve({ latestCandleDate: null, candleCount: 0, distinctSymbols: 0 }),
          TIMEOUT.candleProbe,
        ),
      ),
    ]),
    Promise.race([
      probeLearningPersistence(),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), TIMEOUT.learningProbe)),
    ]),
  ]);

  const signals = signalsRes.status === 'fulfilled' ? signalsRes.value
    : { ok: false, status: 0, data: null, error: 'settled-rejected', timedOut: false, elapsedMs: 0, timeoutMs: TIMEOUT.signals, url: '' };
  const candleCoverage = candleProbeSettled.status === 'fulfilled'
    ? candleProbeSettled.value
    : { latestCandleDate: null, candleCount: 0, distinctSymbols: 0 };
  const learningPersistence = learningProbeSettled.status === 'fulfilled'
    ? learningProbeSettled.value
    : null;

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

  const payload = signals.data ?? null;

  // Daily report: reuse lightweight preview already on the signals
  // envelope — avoids a second /api/signals round-trip via daily-report.
  const preview = payload?.dailyReportPreview as {
    reportStatus?: 'COMPLETE' | 'PARTIAL' | 'PENDING' | 'INSUFFICIENT_DATA';
    reportDate?: string;
    insufficientReason?: string | null;
  } | null | undefined;
  const hasDailyPreview = preview != null && typeof preview === 'object';

  // Backtest readiness: candle warehouse presence (optional node).
  // Does not claim COMPLETE — that requires the full backtest preview.
  const hasCandleWarehouse =
    (candleCoverage.candleCount ?? 0) > 0 || candleCoverage.latestCandleDate != null;

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
      coveragePercent:    typeof payload?.coverage_percent === 'number'
                            ? payload.coverage_percent
                            : null,
      symbolsRequested:   payload?.freshness?.universe_size
                            ?? payload?.freshness?.total_scanned
                            ?? null,
      symbolsReturned:    payload?.freshness?.total_persisted
                            ?? payload?.freshness?.latest_batch_symbols
                            ?? null,
      candleAgeHours:     payload?.freshness?.candle_age_hours ?? null,
      liveFeedQuality:    (payload?.freshness?.live_feed_quality as EngineHealthContext['feed']['liveFeedQuality'])
                            ?? null,
      candleCoverage,
    },
    transport: {
      signalsAvailable:     signals.ok,
      signalsTimedOut:      signals.timedOut,
      signalsErrorMessage:  signals.ok ? null : (signals.error ?? null),
      dailyReportAvailable: hasDailyPreview,
      backtestAvailable:    hasCandleWarehouse,
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
    manipulationGateImpact: payload?.manipulationGateImpact ?? null,
    manipulationRiskMeta:   payload?.manipulationRiskMeta ?? null,
    learningPersistence,
  };

  if (hasDailyPreview) {
    ctx.dailyReport = {
      available:    true,
      reportStatus: preview?.reportStatus,
      generatedAt:  preview?.reportDate
        ? `${preview.reportDate}T00:00:00.000Z`
        : (payload?.generatedAt ?? null),
      warnings:     preview?.insufficientReason
        ? [String(preview.insufficientReason)]
        : [],
    };
  } else {
    ctx.dailyReport = { available: false };
  }

  // Warehouse readiness only — full outcome coverage requires /api/signals/backtest.
  // PARTIAL + readiness warning maps to HEALTHY in buildBacktestingHealthNode
  // (not "outcome data unavailable"). INSUFFICIENT_DATA = no EOD bars.
  ctx.backtest = hasCandleWarehouse
    ? {
        available:       true,
        status:          'PARTIAL',
        window:          '7D',
        generatedAt:     candleCoverage.latestCandleDate
          ? `${candleCoverage.latestCandleDate}T00:00:00.000Z`
          : null,
        symbolsWithData: candleCoverage.distinctSymbols || null,
        totalSymbols:    null,
        warnings:        [
          'Engine-health uses candle warehouse readiness — open Backtesting for the full preview.',
        ],
      }
    : {
        available:       true,
        status:          'INSUFFICIENT_DATA',
        window:          '7D',
        generatedAt:     null,
        symbolsWithData: 0,
        totalSymbols:    null,
        warnings:        ['No EOD candles in warehouse — import historical candle data.'],
      };

  const healthSpan = engineDebugger.start({
    function: 'buildEngineHealthMap',
    engine: 'engine-health',
    file: 'src/lib/signals/engineHealthMap.ts',
    meta: {
      isFallback: ctx.feed.isFallback,
      isBootstrap: ctx.feed.isBootstrap,
      marketOpen: ctx.marketStatus.isOpen,
      signalsOk: signals.ok,
    },
  });
  const health: EngineHealthMap = buildEngineHealthMap(ctx);
  healthSpan.end(health.overallStatus, {
    overallStatus: health.overallStatus,
    canGenerateCandidates: health.pipelineReadiness.canGenerateCandidates,
    canGenerateApprovedSignals: health.pipelineReadiness.canGenerateApprovedSignals,
    degradedCount: health.degradedCount,
  });

  routeSpan.end(200, { overallStatus: health.overallStatus });
  return NextResponse.json(
    {
      ok:           true,
      generatedAt:  health.generatedAt,
      health,
      warnings,
      sourceStatus: {
        signals:     { ok: signals.ok,  status: signals.status,  timedOut: signals.timedOut,  elapsedMs: signals.elapsedMs,  timeoutMs: signals.timeoutMs },
        dailyReport: { ok: hasDailyPreview, source: hasDailyPreview ? 'signals.dailyReportPreview' : 'unavailable' },
        backtest:    { ok: true, source: 'candleWarehouseProbe', hasCandleWarehouse },
        candleProbe: candleCoverage,
      },
      verbose:      verbose ? { signalPayload: payload } : undefined,
    },
    { headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate' } },
  );
  } catch (err) {
    // MODULE-API-RESILIENCE-2026-05 — never return health:null on throws.
    // Build a probe-based map so /signals/engine-health always renders.
    logModuleFail('GET-handler', err);
    routeSpan.error(err, { stage: 'GET-handler' });
    let candleCoverage = { latestCandleDate: null as string | null, candleCount: 0, distinctSymbols: 0 };
    let learningPersistence = {
      tableExists: false, observationCount: 0, distinctStrategies: 0, lastReviewedAt: null,
    };
    try {
      candleCoverage = await probeCandleWarehouse();
    } catch { /* keep zero-shape */ }
    try {
      learningPersistence = await probeLearningPersistence();
    } catch { /* keep zero-shape */ }
    const fallbackHealth = buildEngineHealthMap({
      ...buildFallbackHealthContext(candleCoverage),
      learningPersistence,
    });
    const errMsg = err instanceof Error ? err.message : 'internal error';
    routeSpan.end(200, { overallStatus: fallbackHealth.overallStatus, degraded: true });
    return NextResponse.json(
      {
        ok:           true,
        generatedAt:  fallbackHealth.generatedAt,
        health:       fallbackHealth,
        warnings:     [
          `Engine health built from fallback probes (${errMsg}).`,
          'Signal Engine summary was unavailable for this refresh — retry or open Signal Engine.',
        ],
        sourceStatus: { candleProbe: candleCoverage },
        degraded:     true,
      },
      { status: 200, headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate' } },
    );
  }
}
