/**
 * GET /api/dashboard
 *
 * Quantorus365 Command Center aggregator.
 *
 * Aggregates lightweight summaries from every intelligence module so the
 * dashboard can render a single-screen executive overview without
 * polling each module independently:
 *
 *   - /api/signals                              → approved/highPotential/watchlist/rejected pools, nearest signals
 *   - /api/signals/engine-health                → pipeline readiness, overall engine status
 *   - /api/signals/daily-report                 → regime, executive summary, block reasons
 *   - /api/signals/backtest?window=1D           → signal-engine backtest preview (best/avoid setups)
 *   - /api/news-engine?action=summary           → news pipeline status, source coverage
 *   - /api/manipulation?action=health           → freshness, severe risk symbols, warning-only mode
 *   - /api/options/intelligence?symbol=NIFTY    → option-chain configuration probe
 *   - /api/backtests                            → latest queued/completed runs
 *
 * Every upstream call is wrapped in Promise.allSettled so a single
 * failed module never blocks the dashboard response. Failures are
 * normalized via `classifyModule()` into actionable statuses:
 *
 *   HEALTHY / WARNING / STALE / DEGRADED / PARTIAL / TIMEOUT /
 *   NOT_CONFIGURED / INSUFFICIENT_DATA / AUTH_REQUIRED / BROKEN / UNKNOWN
 *
 * "TIMEOUT" is distinguished from "BROKEN" so the UI never surfaces the
 * raw "This operation was aborted" string from AbortController.
 *
 * No threshold changes, no fabricated data, no live-scoring logic in
 * this route — pure aggregation + Trust Score derivation.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireSession }            from '@/lib/session';
import { getMarketStatus }           from '@/lib/marketData/marketHours';

export const dynamic    = 'force-dynamic';
export const revalidate = 0;

// ── Types (wire shape) ──────────────────────────────────────────

type FusionStatus =
  | 'HEALTHY'
  | 'WARNING'
  | 'PARTIAL'
  | 'STALE'
  | 'DEGRADED'
  | 'TIMEOUT'
  | 'BROKEN'
  | 'AUTH_REQUIRED'
  | 'NOT_CONFIGURED'
  | 'INSUFFICIENT_DATA'
  | 'RUNNING'
  | 'UNKNOWN';

type TrustLabel = 'HIGH' | 'MEDIUM' | 'LOW' | 'INSUFFICIENT_DATA';
type ActionPriority = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

interface IntelligenceFusionItem {
  status:       FusionStatus;
  label:        string;
  detail:       string;
  reason:       string;
  action:       string;
  href:         string;
  lastUpdated:  string | null;
}

interface NearestOpportunityRow {
  symbol:            string;
  direction:         string | null;
  finalScore:        number | null;
  confidenceScore:   number | null;
  riskReward:        number | null;
  approvalGap:       number | null;
  reason:            string | null;
  status:            string | null;
  manipulationRisk:  string | null;
  newsImpact:        string | null;
}

interface RecommendedAction {
  title:    string;
  reason:   string;
  priority: ActionPriority;
  href:     string;
}

interface FetchResult<T> {
  ok:         boolean;
  status:     number;
  data:       T | null;
  error:      string | null;
  /** True when the upstream call exceeded the per-module timeout
   *  (AbortController fired). Distinguishes "slow" from "broken". */
  timedOut:   boolean;
  /** Wall-clock duration in ms — useful for source diagnostics. */
  elapsedMs:  number;
  /** Per-module timeout budget that was applied. */
  timeoutMs:  number;
}

// ── Helpers ────────────────────────────────────────────────────

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};

const str = (v: unknown): string | null => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s.length > 0 ? s : null;
};

const arr = <T,>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);

async function fetchInternal<T = any>(
  origin: string,
  path: string,
  cookieHeader: string,
  timeoutMs = 8_000,
): Promise<FetchResult<T>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const t0 = Date.now();
  try {
    const res = await fetch(`${origin}${path}`, {
      cache: 'no-store',
      headers: cookieHeader ? { cookie: cookieHeader } : {},
      signal: controller.signal,
    });
    clearTimeout(timer);
    const elapsedMs = Date.now() - t0;
    if (!res.ok) {
      // Still try to parse JSON body for richer error context.
      let bodyErr: string | null = null;
      try {
        const body = await res.clone().json();
        bodyErr = body?.error ?? body?.message ?? null;
      } catch { /* non-JSON error body */ }
      return {
        ok: false, status: res.status, data: null,
        error: bodyErr ?? `HTTP ${res.status}`,
        timedOut: false, elapsedMs, timeoutMs,
      };
    }
    const data = (await res.json()) as T;
    return {
      ok: true, status: res.status, data, error: null,
      timedOut: false, elapsedMs, timeoutMs,
    };
  } catch (e) {
    clearTimeout(timer);
    const elapsedMs = Date.now() - t0;
    const raw = e instanceof Error ? e.message : String(e);
    // AbortController surfaces a few different messages depending on
    // runtime — match the common shapes so we can flip `timedOut`.
    const timedOut =
      controller.signal.aborted ||
      raw.toLowerCase().includes('aborted') ||
      raw.toLowerCase().includes('operation was aborted');
    return {
      ok: false, status: 0, data: null,
      error: timedOut ? 'TIMEOUT' : raw,
      timedOut, elapsedMs, timeoutMs,
    };
  }
}

/**
 * Convert a raw upstream FetchResult into an operator-facing
 * `(status, reason)` pair. Module-specific success classification is
 * still done inline by each fusion builder — this helper only handles
 * the universal failure modes (timeout, auth, broken).
 */
function classifyTransport(
  r: FetchResult<any>,
  moduleLabel: string,
): { status: FusionStatus; reason: string } | null {
  if (r.ok) return null; // success — let caller derive semantic status
  if (r.timedOut) {
    return {
      status: 'TIMEOUT',
      reason: `${moduleLabel} did not respond within ${Math.round(r.timeoutMs / 1000)}s.`,
    };
  }
  if (r.status === 401 || r.status === 403) {
    return {
      status: 'AUTH_REQUIRED',
      reason: `${moduleLabel} returned ${r.status} — session may have expired.`,
    };
  }
  if (r.status === 404) {
    return {
      status: 'NOT_CONFIGURED',
      reason: `${moduleLabel} endpoint not available (404).`,
    };
  }
  return {
    status: 'BROKEN',
    reason: r.error
      ? `${moduleLabel}: ${r.error}`
      : `${moduleLabel} returned ${r.status || 'an error'}.`,
  };
}

// ── GET ────────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  try { await requireSession(); }
  catch { return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 }); }

  const url           = new URL(req.url);
  const origin        = `${url.protocol}//${url.host}`;
  const cookieHeader  = req.headers.get('cookie') ?? '';
  const warnings: string[] = [];
  const sourceStatus: Record<string, {
    ok: boolean; status: number; error: string | null;
    timedOut: boolean; elapsedMs: number; timeoutMs: number;
  }> = {};

  // ── Per-module timeout budgets ───────────────────────────────
  //
  // Tuned from the operator-facing spec. The signal engine path
  // (`/api/signals?action=top`) is the heaviest call here — it runs
  // the full confirmed-snapshot bundle on each request and used to
  // abort at the previous 8s default. Everything else is either a
  // lightweight summary or a pure DB read.
  const TIMEOUT = {
    signals:       12_000, // primary signal engine — heavy aggregation
    engineHealth:   8_000, // pipeline readiness summary
    dailyReport:    8_000, // regime + executive summary
    backtestPrev:   5_000, // /signals/backtest?window=1D preview
    newsSummary:    5_000, // /news-engine?action=summary — DB read + env probe
    manipulation:   5_000, // /manipulation?action=health — DB COUNT queries
    options:        4_000, // /options/intelligence — provider probe
    backtestsList:  5_000, // /backtests list
  } as const;

  // Fire all upstream calls concurrently. Each is independent — one
  // failure must never block the response.
  const [
    signalsRes,
    engineHealthRes,
    dailyReportRes,
    backtestRes,
    newsSummaryRes,
    manipulationRes,
    optionsRes,
    backtestsListRes,
  ] = await Promise.allSettled([
    fetchInternal<any>(origin, `/api/signals?action=top&limit=20&request_id=dash-${Date.now()}`, cookieHeader, TIMEOUT.signals),
    fetchInternal<any>(origin, `/api/signals/engine-health`,                                     cookieHeader, TIMEOUT.engineHealth),
    fetchInternal<any>(origin, `/api/signals/daily-report`,                                      cookieHeader, TIMEOUT.dailyReport),
    fetchInternal<any>(origin, `/api/signals/backtest?window=1D`,                                cookieHeader, TIMEOUT.backtestPrev),
    fetchInternal<any>(origin, `/api/news-engine?action=summary`,                                cookieHeader, TIMEOUT.newsSummary),
    fetchInternal<any>(origin, `/api/manipulation?action=health`,                                cookieHeader, TIMEOUT.manipulation),
    fetchInternal<any>(origin, `/api/options/intelligence?symbol=NIFTY`,                         cookieHeader, TIMEOUT.options),
    fetchInternal<any>(origin, `/api/backtests`,                                                 cookieHeader, TIMEOUT.backtestsList),
  ]);

  const rejectedShim: FetchResult<any> = {
    ok: false, status: 0, data: null, error: 'settled-rejected',
    timedOut: false, elapsedMs: 0, timeoutMs: 0,
  };
  const settled = <T,>(r: PromiseSettledResult<FetchResult<T>>): FetchResult<T> =>
    r.status === 'fulfilled' ? r.value : (rejectedShim as FetchResult<T>);

  const signals       = settled(signalsRes);
  const engineHealth  = settled(engineHealthRes);
  const dailyReport   = settled(dailyReportRes);
  const backtest      = settled(backtestRes);
  const newsSummary   = settled(newsSummaryRes);
  const manipulation  = settled(manipulationRes);
  const options       = settled(optionsRes);
  const backtestsList = settled(backtestsListRes);

  const recordSource = (key: string, r: FetchResult<any>) => {
    sourceStatus[key] = {
      ok: r.ok, status: r.status, error: r.error,
      timedOut: r.timedOut, elapsedMs: r.elapsedMs, timeoutMs: r.timeoutMs,
    };
  };
  recordSource('signals',       signals);
  recordSource('engineHealth',  engineHealth);
  recordSource('dailyReport',   dailyReport);
  recordSource('backtest',      backtest);
  recordSource('newsEngine',    newsSummary);
  recordSource('manipulation',  manipulation);
  recordSource('options',       options);
  recordSource('backtests',     backtestsList);

  // ── Market status ─────────────────────────────────────────────
  const market = getMarketStatus();
  const marketStatus = {
    status: (market.isOpen ? 'OPEN' : 'CLOSED') as 'OPEN' | 'CLOSED' | 'UNKNOWN',
    label:  market.label,
    lastClose: market.sessionCloseIst ?? null,
    nextOpen:  market.sessionOpenIst  ?? null,
  };

  // ── Signal summary ────────────────────────────────────────────
  const sigPayload = signals.data ?? {};
  const counters   = (sigPayload.counters && typeof sigPayload.counters === 'object') ? sigPayload.counters : {};
  const approvedSignals      = arr<any>(sigPayload.approvedSignals      ?? sigPayload.signals);
  const highPotentialSignals = arr<any>(sigPayload.highPotentialSignals ?? sigPayload.high_potential);
  const watchlistSignals     = arr<any>(sigPayload.watchlistSignals     ?? sigPayload.watchlist);
  const rejectedSignals      = arr<any>(sigPayload.rejectedSignals      ?? sigPayload.rejected);
  const nearestSignals       = arr<any>(sigPayload.nearestSignals       ?? sigPayload.closestToApproval?.signals);

  const approvedBuy  = approvedSignals.filter((s) => String(s.direction ?? s.signal_type ?? '').toUpperCase() === 'BUY').length;
  const approvedSell = approvedSignals.filter((s) => String(s.direction ?? s.signal_type ?? '').toUpperCase() === 'SELL').length;

  const dueDiligenceSummary = sigPayload.dueDiligenceSummary ?? null;
  const topBlockReason = dueDiligenceSummary?.topBlockReasons?.[0]?.reason ?? null;

  // Latest confirmed signal timestamp — fall back through several
  // candidate fields the engine ships.
  const latestSignalAt: string | null =
    str(sigPayload.lastConfirmedSignalAt) ??
    str(sigPayload.last_pipeline_run) ??
    str(sigPayload.lastSuccessAt) ??
    null;

  const signalSummary = {
    approvedTotal:        num(counters.approvedTotal)      ?? approvedSignals.length,
    approvedBuy:          num(counters.approvedBuy)        ?? approvedBuy,
    approvedSell:         num(counters.approvedSell)       ?? approvedSell,
    highPotentialTotal:   num(counters.highPotentialTotal) ?? highPotentialSignals.length,
    watchlistTotal:       num(counters.watchlistTotal)     ?? watchlistSignals.length,
    rejectedTotal:        num(counters.rejectedTotal)      ?? rejectedSignals.length,
    candidateTotal:       num(counters.candidateTotal)     ?? (highPotentialSignals.length + watchlistSignals.length + rejectedSignals.length),
    topBlockingReason:    topBlockReason,
    latestSignalAt,
  };

  // ── Nearest opportunities (top 5) ─────────────────────────────
  const manipulationRiskMap = new Map<string, string>();
  const newsImpactMap       = new Map<string, string>();
  for (const s of [...approvedSignals, ...highPotentialSignals, ...watchlistSignals]) {
    const sym = str(s.symbol ?? s.tradingsymbol);
    if (!sym) continue;
    const mr = s.manipulationRisk?.suspicionBand ?? s.manipulationRisk?.band ?? null;
    if (mr) manipulationRiskMap.set(sym, String(mr).toUpperCase());
    const ni = s.newsImpact?.label ?? s.newsImpact?.bias ?? null;
    if (ni) newsImpactMap.set(sym, String(ni));
  }

  const nearestPool: any[] = nearestSignals.length > 0
    ? nearestSignals
    : [...highPotentialSignals, ...watchlistSignals].slice(0, 10);

  const nearestOpportunities: NearestOpportunityRow[] = nearestPool.slice(0, 5).map((s) => {
    const sym = str(s.symbol ?? s.tradingsymbol) ?? 'UNKNOWN';
    // Phase 3 + 5 + 6 institutional decision gate — when the enricher
    // demoted the row, the user-facing status MUST be the effective
    // one. Raw fields remain readable for diagnostics but the card no
    // longer shows APPROVED for a row the gate has restricted.
    const effectiveStatus = str(s.effectiveApprovalStatus ?? s.effective_approval_status);
    const effectiveAction = str(s.effectiveAction ?? s.effective_action);
    return {
      symbol:           sym,
      direction:        effectiveAction ?? str(s.direction ?? s.signal_type),
      finalScore:       num(s.final_score ?? s.opportunity_score),
      confidenceScore:  num(s.confidence_score ?? s.confidence),
      riskReward:       num(s.risk_reward),
      approvalGap:      num(s.approvalGap),
      reason:           str(s.demotionReason ?? s.demotion_reason ?? s.dueDiligence?.gateSummary ?? s.reason ?? (Array.isArray(s.missingApprovalFactors) && s.missingApprovalFactors.length > 0 ? s.missingApprovalFactors.join(', ') : null)),
      status:           effectiveStatus ?? str(s.status ?? s.signal_status ?? s.effective_signal_status),
      manipulationRisk: manipulationRiskMap.get(sym) ?? null,
      newsImpact:       newsImpactMap.get(sym) ?? null,
    };
  });

  // ── Risk summary ──────────────────────────────────────────────
  const manipulationPayload = manipulation.data ?? {};
  const severeRiskSymbols   = num(manipulationPayload?.totals?.severeRiskSymbols) ?? 0;
  const staleRiskSymbols    = num(manipulationPayload?.totals?.staleRiskSymbols)  ?? 0;
  const manipulationStale   = manipulationPayload?.staleWarningOnlyMode === true || manipulationPayload?.warningOnlyMode === true;

  const newsPayload = newsSummary.data ?? {};
  const newsRiskCount = 0; // not exposed by /summary; module page surfaces severities.

  const dataFreshness = sigPayload.dataFreshness ?? null;
  const isStaleData = dataFreshness?.isStale === true ||
    (typeof dataFreshness?.ageMinutes === 'number' && dataFreshness.ageMinutes > 240);

  const rejectedTopReasons = arr<any>(dueDiligenceSummary?.topBlockReasons).slice(0, 5).map((r) => ({
    reason: String(r.reason ?? 'UNSPECIFIED'),
    count:  Number(r.count ?? 0),
  }));

  const riskSummary = {
    staleData:               !!isStaleData,
    manipulationWarningCount: severeRiskSymbols + staleRiskSymbols,
    newsRiskCount,
    optionRiskStatus:        options.ok && options.data && (options.data.intelligence !== null)
                              ? 'AVAILABLE'
                              : 'NOT_CONFIGURED',
    rejectedTopReasons,
  };

  // ── Intelligence fusion (normalized) ──────────────────────────
  const engineHealthPayload = engineHealth.data?.health ?? null;
  const engineOverallStatus = (engineHealthPayload?.overallStatus ?? 'UNKNOWN') as FusionStatus;

  // Helper that builds the final IntelligenceFusionItem given the
  // transport-level classification (TIMEOUT/AUTH/BROKEN) or, when the
  // call succeeded, the semantic status derived by the module.
  const buildItem = (
    label: string,
    href: string,
    transport: ReturnType<typeof classifyTransport>,
    onSuccess: () => Omit<IntelligenceFusionItem, 'label' | 'href'>,
  ): IntelligenceFusionItem => {
    if (transport) {
      const actionByStatus: Partial<Record<FusionStatus, string>> = {
        TIMEOUT:        `Open ${label}`,
        BROKEN:         `Open ${label}`,
        AUTH_REQUIRED:  'Re-authenticate',
        NOT_CONFIGURED: `Configure ${label}`,
      };
      return {
        label, href,
        status:      transport.status,
        detail:      transport.reason,
        reason:      transport.reason,
        action:      actionByStatus[transport.status] ?? `Open ${label}`,
        lastUpdated: null,
      };
    }
    return { label, href, ...onSuccess() };
  };

  const signalEngineFusion = buildItem(
    'Signal Engine', '/signals',
    classifyTransport(signals, 'Signal Engine'),
    () => {
      const preview = sigPayload.healthPreview;
      const overall = preview?.overallStatus ?? engineOverallStatus;
      let status: FusionStatus;
      if      (overall === 'HEALTHY')  status = 'HEALTHY';
      else if (overall === 'WARNING')  status = 'WARNING';
      else if (overall === 'DEGRADED') status = 'DEGRADED';
      else if (overall === 'BROKEN')   status = 'BROKEN';
      else                             status = 'UNKNOWN';
      const detail = preview?.primaryBlockingReason
        ?? `${signalSummary.approvedTotal} approved · ${signalSummary.candidateTotal} candidates`;
      return {
        status, detail, reason: detail,
        action: signalSummary.approvedTotal > 0 ? 'Review approved signals' : 'Open Signals',
        lastUpdated: latestSignalAt,
      };
    },
  );

  const newsFusion = buildItem(
    'News Intelligence', '/news-intelligence',
    classifyTransport(newsSummary, 'News Intelligence'),
    () => {
      const configuredCount = Number(newsPayload.configuredCount ?? 0);
      const activeSources   = arr<any>(newsPayload.activeSources);
      const activeCount     = activeSources.length;
      const totalCount      = Number(newsPayload.totalCount ?? configuredCount);

      // Distinguish the four real states the summary endpoint returns:
      // FRESH / PARTIAL / STALE / NO_DATA — and only map NO_DATA to
      // NOT_CONFIGURED when *zero* sources are configured (env keys
      // missing). When sources are configured but the pipeline has not
      // run, that's INSUFFICIENT_DATA, not NOT_CONFIGURED.
      let status: FusionStatus;
      if (newsPayload.status === 'FRESH') {
        status = activeCount === configuredCount ? 'HEALTHY' : 'PARTIAL';
      } else if (newsPayload.status === 'PARTIAL') {
        status = 'PARTIAL';
      } else if (newsPayload.status === 'STALE') {
        status = 'STALE';
      } else if (configuredCount === 0) {
        status = 'NOT_CONFIGURED';
      } else {
        status = 'INSUFFICIENT_DATA';
      }

      const failedCount = Math.max(0, configuredCount - activeCount);
      const detail = configuredCount === 0
        ? 'No news sources configured.'
        : failedCount === 0
          ? `${activeCount}/${configuredCount} sources active`
          : `${activeCount} active, ${failedCount} silent (${totalCount} total)`;

      const reason =
        status === 'HEALTHY'           ? `All ${activeCount} configured news sources returned data.` :
        status === 'PARTIAL'           ? `Some news sources are silent (${activeCount}/${configuredCount}).` :
        status === 'STALE'             ? 'Pipeline ran but no new events were ingested.' :
        status === 'INSUFFICIENT_DATA' ? 'News sources are configured but no pipeline run has succeeded.' :
                                         'No news sources configured.';

      return {
        status, detail, reason,
        action: status === 'NOT_CONFIGURED' ? 'Configure news sources' : 'Open News Intelligence',
        lastUpdated: newsPayload.latestNewsPublishedAt ?? newsPayload.latestPipelineRunAt ?? null,
      };
    },
  );

  const manipulationFusion = buildItem(
    'Manipulation Watch', '/manipulation',
    classifyTransport(manipulation, 'Manipulation Watch'),
    () => {
      const freshnessStatus = manipulationPayload?.freshness?.status as string | undefined;
      const eodNeverRan = manipulationPayload?.eodIngestionStatus?.status === 'NEVER_RAN';
      let status: FusionStatus = 'UNKNOWN';
      let reason  = 'Status nominal.';
      if      (freshnessStatus === 'FRESH')   { status = 'HEALTHY';           reason = `Latest event ${manipulationPayload?.latestEventDate ?? 'recent'}.`; }
      else if (freshnessStatus === 'STALE')   { status = 'STALE';             reason = 'Manipulation Watch is stale — running in warning-only mode.'; }
      else if (freshnessStatus === 'PARTIAL') { status = 'PARTIAL';           reason = 'Manipulation Watch has partial coverage.'; }
      else if (freshnessStatus === 'NO_DATA' || eodNeverRan) {
        status = 'INSUFFICIENT_DATA';
        reason = eodNeverRan
          ? 'EOD ingestion has not run — manipulation engine has no candles.'
          : 'No manipulation events on record yet.';
      }

      const detail = manipulationStale
        ? `Warning-only mode · ${severeRiskSymbols} severe`
        : `${severeRiskSymbols} severe risk symbol${severeRiskSymbols === 1 ? '' : 's'}`;

      const action =
        status === 'STALE' || status === 'INSUFFICIENT_DATA'
          ? 'Run EOD ingestion / Daily Scan'
          : 'Open Manipulation Watch';

      return {
        status, detail, reason, action,
        lastUpdated: manipulationPayload?.latestScanAt ?? manipulationPayload?.latestEventDate ?? null,
      };
    },
  );

  const optionsFusion = buildItem(
    'Option Intelligence', '/options/chain',
    // For options, treat 401/timeout/broken via classifyTransport;
    // a 200 response with `intelligence: null` is the documented
    // "no provider configured" shape — handled in onSuccess.
    classifyTransport(options, 'Option Intelligence'),
    () => {
      const has = options.data?.intelligence !== null && options.data?.intelligence !== undefined;
      return {
        status: has ? 'HEALTHY' : 'NOT_CONFIGURED',
        detail: has ? 'Option-chain confirmation active' : 'No F&O confirmation applied.',
        reason: has ? 'Option-chain provider is responding.' : 'Option-chain provider is not configured.',
        action: has ? 'Open Option Chain' : 'Configure option-chain provider',
        lastUpdated: null,
      };
    },
  );

  // Backtesting fusion blends two upstream signals:
  //   • /api/signals/backtest?window=1D — derived setup performance
  //   • /api/backtests                  — most recent run lifecycle
  // We surface the run lifecycle first because that's the
  // operator-facing reality (RUNNING / FAILED / INSUFFICIENT_DATA).
  const backtestData = backtest.data?.backtest ?? null;
  const backtestStatus = backtestData?.status as string | undefined;
  const runsList = arr<any>(backtestsList.data?.runs);
  const latestRun = runsList[0] ?? null;
  const latestRunStatus = String(latestRun?.status ?? '').toLowerCase();
  const latestRunError  = str(latestRun?.error);

  const backtestFusion = buildItem(
    'Backtesting', '/backtesting',
    // If BOTH calls timed out / failed, surface that. If just one
    // failed and the other succeeded, prefer the success path.
    backtest.ok || backtestsList.ok ? null
      : classifyTransport(backtest, 'Backtesting'),
    () => {
      // Live run lifecycle takes precedence — if there's an in-flight
      // run, that's the most useful state for the operator.
      if (latestRunStatus === 'running' || latestRunStatus === 'queued') {
        return {
          status: 'RUNNING',
          detail: `Latest run ${latestRunStatus.toUpperCase()} · ${Number(latestRun?.progress_percent ?? 0)}%`,
          reason: 'A backtest is currently executing in the queue.',
          action: 'Open Backtesting',
          lastUpdated: latestRun?.started_at ?? null,
        };
      }
      if (latestRunStatus === 'failed') {
        // Map insufficient-candle failures to INSUFFICIENT_DATA so
        // the operator sees the actionable cause, not a generic break.
        const insufficient = !!latestRunError && /insufficient historical candles/i.test(latestRunError);
        return {
          status: insufficient ? 'INSUFFICIENT_DATA' : 'DEGRADED',
          detail: insufficient
            ? 'Historical candles missing for backtest universe.'
            : 'Last backtest run failed.',
          reason: latestRunError ?? 'Backtest run failed.',
          action: insufficient ? 'Run EOD ingestion' : 'Open Backtesting',
          lastUpdated: latestRun?.completed_at ?? latestRun?.started_at ?? null,
        };
      }

      // Fall back to the /signals/backtest preview when we don't have
      // a richer signal from the run history.
      let status: FusionStatus = 'UNKNOWN';
      if      (backtestStatus === 'COMPLETE')          status = 'HEALTHY';
      else if (backtestStatus === 'PARTIAL')           status = 'PARTIAL';
      else if (backtestStatus === 'INSUFFICIENT_DATA') status = 'INSUFFICIENT_DATA';
      else if (backtestStatus === 'FAILED')            status = 'DEGRADED';
      else if (latestRunStatus === 'completed')        status = 'HEALTHY';

      const wr = backtestData?.performance?.winRate;
      const detail = status === 'HEALTHY' && typeof wr === 'number'
        ? `${Math.round(wr * 100)}% win rate (${backtestData?.universe?.symbolsTested ?? 0} tested)`
        : status === 'INSUFFICIENT_DATA'
          ? 'Backtesting data insufficient.'
          : status === 'HEALTHY'
            ? `Latest run COMPLETED ${latestRun?.completed_at ? '' : ''}`.trim()
            : `Status: ${backtestStatus ?? latestRunStatus.toUpperCase() ?? 'UNKNOWN'}`;
      const reason =
        status === 'INSUFFICIENT_DATA' ? 'Historical EOD candles are missing — backtests cannot run.' :
        status === 'HEALTHY'           ? 'Latest backtest run completed successfully.' :
        status === 'PARTIAL'           ? 'Backtest completed with partial coverage.' :
                                          'Backtest status unavailable.';

      return {
        status, detail, reason,
        action: status === 'INSUFFICIENT_DATA' ? 'Run EOD ingestion' : 'Open Backtesting',
        lastUpdated: backtestData?.generatedAt ?? latestRun?.completed_at ?? latestRun?.started_at ?? null,
      };
    },
  );

  const engineHealthFusion = buildItem(
    'Engine Health', '/signals/engine-health',
    engineHealthPayload && engineHealth.ok ? null : classifyTransport(engineHealth, 'Engine Health'),
    () => {
      const status: FusionStatus =
          engineOverallStatus === 'HEALTHY'  ? 'HEALTHY'
        : engineOverallStatus === 'WARNING'  ? 'WARNING'
        : engineOverallStatus === 'DEGRADED' ? 'DEGRADED'
        : engineOverallStatus === 'BROKEN'   ? 'BROKEN'
        :                                      'UNKNOWN';
      const primary = engineHealthPayload?.pipelineReadiness?.blockingReasons?.[0]
        ?? engineHealthPayload?.overallSummary
        ?? 'Status nominal';
      return {
        status, detail: primary, reason: primary,
        action: 'Open Engine Health',
        lastUpdated: engineHealthPayload?.generatedAt ?? null,
      };
    },
  );

  const intelligenceFusion = {
    signalEngine:       signalEngineFusion,
    newsIntelligence:   newsFusion,
    manipulationWatch:  manipulationFusion,
    optionIntelligence: optionsFusion,
    backtesting:        backtestFusion,
    engineHealth:       engineHealthFusion,
  };

  // ── Warnings (operator-facing copy) ───────────────────────────
  //
  // Replaces the raw "operation was aborted" / "HTTP 500" strings with
  // human-readable lines derived from the normalized fusion items.
  // Counts are summarized so the UI can render
  // "2 module timeouts · 1 stale · 1 not configured".
  const moduleStatusList: Array<{ label: string; status: FusionStatus; reason: string }> = [
    { label: 'Signal Engine',       status: signalEngineFusion.status,   reason: signalEngineFusion.reason  },
    { label: 'Engine Health',       status: engineHealthFusion.status,   reason: engineHealthFusion.reason  },
    { label: 'News Intelligence',   status: newsFusion.status,           reason: newsFusion.reason          },
    { label: 'Manipulation Watch',  status: manipulationFusion.status,   reason: manipulationFusion.reason  },
    { label: 'Backtesting',         status: backtestFusion.status,       reason: backtestFusion.reason      },
    { label: 'Option Intelligence', status: optionsFusion.status,        reason: optionsFusion.reason       },
  ];

  // Per-status counts for the UI summary bar.
  const moduleStatusCounts = {
    timeout:           moduleStatusList.filter((m) => m.status === 'TIMEOUT').length,
    broken:            moduleStatusList.filter((m) => m.status === 'BROKEN' || m.status === 'AUTH_REQUIRED').length,
    stale:             moduleStatusList.filter((m) => m.status === 'STALE').length,
    notConfigured:     moduleStatusList.filter((m) => m.status === 'NOT_CONFIGURED').length,
    insufficient:      moduleStatusList.filter((m) => m.status === 'INSUFFICIENT_DATA').length,
    partial:           moduleStatusList.filter((m) => m.status === 'PARTIAL' || m.status === 'WARNING' || m.status === 'DEGRADED').length,
  };

  for (const m of moduleStatusList) {
    if (m.status === 'HEALTHY' || m.status === 'RUNNING' || m.status === 'UNKNOWN') continue;
    warnings.push(m.reason);
  }
  // Daily report timeout is silent in the fusion grid (the dashboard
  // doesn't surface a dedicated card for it) but still worth a single
  // warning line if it failed.
  if (!dailyReport.ok) {
    const c = classifyTransport(dailyReport, 'Daily Report');
    if (c) warnings.push(c.reason);
  }

  // ── Strategy snapshot ─────────────────────────────────────────
  const drReport = dailyReport.data?.report ?? null;
  const regimeReview = drReport?.marketRegimeReview ?? null;

  // Direction bias from approved signal distribution.
  let directionBias: 'BULLISH' | 'BEARISH' | 'NEUTRAL' | 'UNKNOWN' = 'UNKNOWN';
  if (signalSummary.approvedTotal > 0) {
    if (signalSummary.approvedBuy > signalSummary.approvedSell * 1.4) directionBias = 'BULLISH';
    else if (signalSummary.approvedSell > signalSummary.approvedBuy * 1.4) directionBias = 'BEARISH';
    else directionBias = 'NEUTRAL';
  } else if (signalSummary.candidateTotal > 0) {
    const buyCand  = [...highPotentialSignals, ...watchlistSignals].filter((s) => String(s.direction ?? '').toUpperCase() === 'BUY').length;
    const sellCand = [...highPotentialSignals, ...watchlistSignals].filter((s) => String(s.direction ?? '').toUpperCase() === 'SELL').length;
    if (buyCand > sellCand * 1.4) directionBias = 'BULLISH';
    else if (sellCand > buyCand * 1.4) directionBias = 'BEARISH';
    else if (buyCand + sellCand > 0) directionBias = 'NEUTRAL';
  }

  const strategySnapshot = {
    marketRegime:             str(regimeReview?.detectedRegime) ?? 'UNKNOWN',
    directionBias,
    bestStrategy:             str(regimeReview?.bestStrategyForRegime) ?? null,
    weakStrategy:             str(regimeReview?.weakStrategyForRegime) ?? null,
    backtestSupportedSetup:   backtestStatus === 'COMPLETE' && backtestData?.indicatorPerformance?.[0]?.indicator
                              ? String(backtestData.indicatorPerformance[0].indicator)
                              : null,
    avoidSetup:               backtestStatus === 'COMPLETE' && backtestData?.indicatorPerformance?.length
                              ? String(backtestData.indicatorPerformance[backtestData.indicatorPerformance.length - 1]?.indicator ?? '') || null
                              : null,
  };

  // ── Trust score ───────────────────────────────────────────────
  //
  // Two-tier weighting:
  //   • Core         — Signal Engine, Engine Health, Data Freshness, Approved signals
  //                    Trust collapses to INSUFFICIENT_DATA only when the
  //                    core tier is BROKEN (not merely TIMEOUT/PARTIAL).
  //   • Supporting   — News, Manipulation, Backtesting, Options
  //                    Each one knocks trust down a bit but never to zero.
  //
  // Every contributing or detracting condition appends to `reasons[]`
  // so the operator can see exactly why the trust label landed where
  // it did.
  const reasons: string[] = [];
  let trustPoints = 0;
  let maxPoints   = 0;

  // ── Core: Signal Engine (30) ──
  maxPoints += 30;
  if (signalEngineFusion.status === 'HEALTHY') {
    trustPoints += 30;
    reasons.push('Signal Engine healthy');
  } else if (signalEngineFusion.status === 'WARNING' || signalEngineFusion.status === 'DEGRADED') {
    trustPoints += 15;
    reasons.push('Signal Engine in warning state');
  } else if (signalEngineFusion.status === 'TIMEOUT') {
    trustPoints += 8;
    reasons.push('Signal Engine response timed out');
  } else if (signalEngineFusion.status === 'BROKEN' || signalEngineFusion.status === 'AUTH_REQUIRED') {
    reasons.push('Signal Engine unreachable');
  }

  // ── Core: Data Freshness (15) ──
  maxPoints += 15;
  if (!isStaleData && (sigPayload.isBootstrap !== true) && (sigPayload.isFallback !== true)) {
    trustPoints += 15;
    reasons.push('Data feed fresh');
  } else if (sigPayload.isBootstrap === true || sigPayload.isFallback === true) {
    trustPoints += 4;
    reasons.push('Bootstrap / fallback data in use');
  } else if (isStaleData) {
    reasons.push('Data feed stale');
  }

  // ── Core: Approved signals (10) ──
  maxPoints += 10;
  if (signalSummary.approvedTotal > 0) {
    trustPoints += 10;
    reasons.push(`${signalSummary.approvedTotal} approved signals available`);
  } else if (signalSummary.candidateTotal > 0) {
    trustPoints += 5;
    reasons.push('Candidates available — none approved yet');
  } else if (signalEngineFusion.status === 'HEALTHY') {
    trustPoints += 2;
    reasons.push('No approved signals — engine ready');
  } else {
    reasons.push('No approved signals or candidates');
  }

  // ── Core: Due diligence (10) ──
  maxPoints += 10;
  if (dueDiligenceSummary) {
    trustPoints += 10;
    reasons.push('Due diligence active');
  } else {
    reasons.push('Due diligence unavailable');
  }

  // ── Core: Engine Health overall (10) ──
  maxPoints += 10;
  if (engineHealthFusion.status === 'HEALTHY') {
    trustPoints += 10;
    reasons.push('Engine health nominal');
  } else if (engineHealthFusion.status === 'WARNING') {
    trustPoints += 5;
    reasons.push('Engine health warning');
  } else if (engineHealthFusion.status === 'TIMEOUT') {
    trustPoints += 3;
    reasons.push('Engine Health response timed out');
  } else if (engineHealthFusion.status === 'DEGRADED' || engineHealthFusion.status === 'BROKEN') {
    reasons.push('Engine health degraded');
  }

  // ── Supporting: Backtesting (10) — partial credit when STALE/INSUFFICIENT ──
  maxPoints += 10;
  if (backtestFusion.status === 'HEALTHY') {
    trustPoints += 10;
    reasons.push('Backtest data complete');
  } else if (backtestFusion.status === 'RUNNING') {
    trustPoints += 6;
    reasons.push('Backtest is running');
  } else if (backtestFusion.status === 'PARTIAL' || backtestFusion.status === 'WARNING') {
    trustPoints += 4;
    reasons.push('Backtest partial');
  } else if (backtestFusion.status === 'INSUFFICIENT_DATA') {
    reasons.push('Backtest insufficient data');
  }

  // ── Supporting: Manipulation Watch (8) ──
  maxPoints += 8;
  if (manipulationFusion.status === 'HEALTHY') {
    trustPoints += 8;
    reasons.push('Manipulation Watch fresh');
  } else if (manipulationFusion.status === 'STALE') {
    trustPoints += 3;
    reasons.push('Manipulation Watch stale');
  } else if (manipulationFusion.status === 'PARTIAL') {
    trustPoints += 2;
    reasons.push('Manipulation Watch partial');
  } else if (manipulationFusion.status === 'INSUFFICIENT_DATA') {
    reasons.push('Manipulation Watch has no data');
  }

  // ── Supporting: News Intelligence (5) ──
  maxPoints += 5;
  if (newsFusion.status === 'HEALTHY') {
    trustPoints += 5;
    reasons.push('News coverage healthy');
  } else if (newsFusion.status === 'PARTIAL' || newsFusion.status === 'WARNING') {
    trustPoints += 2;
    reasons.push('News coverage partial');
  } else if (newsFusion.status === 'NOT_CONFIGURED') {
    reasons.push('News Intelligence not configured');
  } else if (newsFusion.status === 'INSUFFICIENT_DATA') {
    reasons.push('News pipeline has not run yet');
  }

  // ── Supporting: Option Intelligence (2 — optional) ──
  // Worth a small bonus when configured; not having it doesn't drag
  // the trust score down much.
  maxPoints += 2;
  if (optionsFusion.status === 'HEALTHY') {
    trustPoints += 2;
    reasons.push('Option intelligence active');
  } else if (optionsFusion.status === 'NOT_CONFIGURED') {
    reasons.push('Option chain provider not configured');
  }

  // The trust label only collapses to INSUFFICIENT_DATA when the
  // *core* signal engine path is unreachable (BROKEN or AUTH_REQUIRED).
  // A TIMEOUT or DEGRADED core still produces a numeric score so the
  // operator can see how badly things have slipped.
  const coreBroken =
    signalEngineFusion.status === 'BROKEN' ||
    signalEngineFusion.status === 'AUTH_REQUIRED';

  const trustScoreRaw = maxPoints > 0 ? Math.round((trustPoints / maxPoints) * 100) : 0;
  const trustLabel: TrustLabel = coreBroken
    ? 'INSUFFICIENT_DATA'
    : trustScoreRaw >= 75 ? 'HIGH'
    : trustScoreRaw >= 50 ? 'MEDIUM'
    : 'LOW';

  const trustScore = {
    score:   coreBroken ? null : trustScoreRaw,
    label:   trustLabel,
    reasons: reasons.slice(0, 10),
  };

  // ── Recommended actions ───────────────────────────────────────
  const actions: RecommendedAction[] = [];

  if (signalSummary.approvedTotal === 0 && signalSummary.candidateTotal > 0) {
    actions.push({
      title:    'Review nearest-to-approval candidates',
      reason:   `${nearestOpportunities.length} candidates within striking distance of approval thresholds.`,
      priority: 'HIGH',
      href:     '/signals',
    });
  }

  if (signalEngineFusion.status === 'TIMEOUT') {
    actions.push({
      title:    'Open Signals — engine responded slowly',
      reason:   'Signal Engine summary timed out. Live data may still be valid; refresh once the engine settles.',
      priority: 'HIGH',
      href:     '/signals',
    });
  }

  if (engineHealthFusion.status === 'DEGRADED' || engineHealthFusion.status === 'BROKEN' || engineHealthFusion.status === 'TIMEOUT') {
    actions.push({
      title:    'Open Engine Health',
      reason:   engineHealthFusion.reason,
      priority: engineHealthFusion.status === 'TIMEOUT' ? 'MEDIUM' : 'CRITICAL',
      href:     '/signals/engine-health',
    });
  }

  if (isStaleData) {
    actions.push({
      title:    'Run Pipeline / Refresh Data',
      reason:   'Data freshness flagged stale — engine is operating on aged candles.',
      priority: 'HIGH',
      href:     '/admin/pipeline',
    });
  }

  if (manipulationFusion.status === 'STALE' || manipulationFusion.status === 'INSUFFICIENT_DATA') {
    actions.push({
      title:    'Run Daily Manipulation Scan',
      reason:   manipulationFusion.reason,
      priority: 'MEDIUM',
      href:     '/manipulation',
    });
  }

  if (optionsFusion.status === 'NOT_CONFIGURED') {
    actions.push({
      title:    'Configure Option Chain Provider',
      reason:   'No F&O confirmation applied to signals — provider missing.',
      priority: 'LOW',
      href:     '/options/chain',
    });
  }

  if (newsFusion.status === 'PARTIAL' || newsFusion.status === 'STALE' || newsFusion.status === 'INSUFFICIENT_DATA') {
    actions.push({
      title:    'Review News Source Status',
      reason:   newsFusion.reason,
      priority: newsFusion.status === 'STALE' ? 'MEDIUM' : 'LOW',
      href:     '/news-intelligence',
    });
  }

  if (backtestFusion.status === 'INSUFFICIENT_DATA') {
    actions.push({
      title:    'Run EOD Ingestion for Backtesting',
      reason:   'Historical EOD candles missing — backtest cannot validate setups.',
      priority: 'MEDIUM',
      href:     '/backtesting',
    });
  }

  if (signalSummary.approvedTotal > 0) {
    actions.unshift({
      title:    `Review ${signalSummary.approvedTotal} approved signal${signalSummary.approvedTotal === 1 ? '' : 's'}`,
      reason:   `${signalSummary.approvedBuy} buy · ${signalSummary.approvedSell} sell ready for execution review.`,
      priority: 'HIGH',
      href:     '/signals',
    });
  }

  const recommendedActions = actions.slice(0, 5);

  return NextResponse.json(
    {
      ok:                true,
      generatedAt:       new Date().toISOString(),
      marketStatus,
      trustScore,
      signalSummary,
      nearestOpportunities,
      riskSummary,
      intelligenceFusion,
      strategySnapshot,
      engineHealth: engineHealthPayload
        ? {
            overallStatus:                engineHealthPayload.overallStatus,
            overallSummary:               engineHealthPayload.overallSummary,
            canGenerateApprovedSignals:   engineHealthPayload.pipelineReadiness?.canGenerateApprovedSignals ?? false,
            canGenerateCandidates:        engineHealthPayload.pipelineReadiness?.canGenerateCandidates ?? false,
            primaryBlockingReason:        engineHealthPayload.pipelineReadiness?.blockingReasons?.[0] ?? null,
            criticalIssues:               engineHealthPayload.criticalIssues ?? [],
            warningIssues:                engineHealthPayload.warningIssues ?? [],
            topBrokenEngine:              (engineHealthPayload.nodes ?? [])
                                            .filter((n: any) => n.status === 'BROKEN' || n.status === 'DEGRADED')
                                            .map((n: any) => n.name)[0] ?? null,
          }
        : null,
      recommendedActions,
      warnings,
      moduleStatusCounts,
      sourceStatus,
    },
    { headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate' } },
  );
}
