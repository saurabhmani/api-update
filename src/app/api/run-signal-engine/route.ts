/**
 * POST /api/run-signal-engine
 *
 * Phase 1 cutover adapter.
 *
 * Historically this route ran the legacy src/services/signalPipeline
 * generator. It now forwards to the phase-based engine
 * (generatePhase4Signals) so the visible app flow produces new-engine
 * rows with full provenance, Phase 3 artifacts, and Phase 4 context.
 *
 * The UI (signals page, intelligence page) does not read this route's
 * response body — both pages call this endpoint, ignore the response,
 * then reload from /api/signals or /api/intelligence, which now read
 * q365_signals via src/lib/signal-engine/repository/readSignals (the
 * reader-side cutover is complete). So the adapter only needs to:
 *   1. produce the same persistence side effects (rows in q365_signals
 *      + Phase 3/4 audit tables)
 *   2. return a legacy-shaped envelope for any non-UI caller that does
 *      read the body
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/lib/session';
import { db } from '@/lib/db';
import { migrateSignalEngine } from '@/lib/db/migrateSignalEngine';
import { ensureSignalEngineSchemas } from '@/lib/signal-engine/repository/ensureSchemas';
import {
  generatePhase4Signals,
  DEFAULT_PHASE3_CONFIG,
} from '@/lib/signal-engine';
import type { CandleProvider, PortfolioSnapshot, Candle } from '@/lib/signal-engine';
import { checkCandleFreshness } from '@/lib/signal-engine/live/candleFreshnessGuard';
import { refreshDailyCandles } from '@/lib/marketData/candleIngest';
import {
  fetchDailyCandlesWithFallback,
  resetCandleSourceCounters,
  getCandleSourceCounters,
} from '@/lib/marketData/candleFallbackChain';
import { DEFAULT_PHASE1_CONFIG } from '@/lib/signal-engine/constants/signalEngine.constants';
import { getMarketStatus, isMarketOverrideEnabled } from '@/lib/marketData/marketHours';
import { getCandleRefreshAgeMs } from '@/lib/workers/candleRefreshScheduler';
// invalidateSignalsCache (HTTP route) retired — its SWR store was
// permanently empty after buildFreshnessProbe was deleted; the call
// was a no-op. invalidateStreamSignalsCache moved out of the SSE
// route file into @/lib/signals/streamSignalsCache (Next.js export
// rules — TS2344 in .next/types).
import { invalidateStreamSignalsCache } from '@/lib/signals/streamSignalsCache';
import { getProviderReport } from '@/lib/marketData/providerReport';
import {
  tryClaimManualRun,
  completeManualRun,
  failManualRun,
  getManualRunStatus,
  isManualOverrideEnabled,
  recoverStaleManualRun,
  heartbeatManualRun,
  tryAcquireExecutionLock,
  releaseExecutionLock,
  heartbeatExecutionLock,
  recoverStaleExecutionLock,
  getLockRow,
} from '@/lib/pipeline/runLockRepo';
import { markPipelineHeartbeat } from '@/lib/marketData/providers/batchScheduler';
import {
  getProgress as getScannerProgress,
  isInFlight  as isScannerInFlight,
  setInFlight as setScannerInFlight,
  clearProgress as clearScannerProgress,
  getInFlightStartedAt as getScannerInFlightStartedAt,
  getInFlightElapsedMs as getScannerInFlightElapsedMs,
  isInFlightStale            as isScannerInFlightStale,
  isInFlightStaleByNoProgress as isScannerInFlightStaleByNoProgress,
  forceClearInFlight    as forceClearScannerInFlight,
  PIPELINE_STALE_INFLIGHT_MS,
} from '@/lib/scanner/scannerState';
import {
  getApiUsage,
  beginPerRunBudget,
  endPerRunBudget,
  INDIANAPI_PER_RUN_LIMIT,
} from '@/providers/adapters/IndianAPIAdapter';
import { ensureUniverseReady } from '@/lib/startup/ensureUniverseReady';
import { getRunCount, incrementRunCount } from '@/lib/scanner/runCounter';

// Spec "SMART ROTATION" — per-run universe cap with runCount-based
// chunk rotation. Each run scans CHUNK_SIZE = SIGNAL_RUN_UNIVERSE_CAP
// symbols (default 100). The starting offset is
// (runCount * CHUNK_SIZE) % universe.length, so consecutive runs walk
// the full universe in fixed-size strides and wrap cleanly.
//
// Budget math @ default CHUNK_SIZE=100:
//   100 calls/run × 20 runs/day = 2,000 calls vs 2,500 daily cap
//   = ~80% utilisation, ~500 calls/day headroom for quote/ad-hoc.
//   Monthly: 2,000 × 22 trading days ≈ 44,000 calls vs 70k cap.
//
// The full ~503-symbol NIFTY 500 universe is covered every
// ceil(503/100) = 6 runs (~18 min at a 3-min schedule, 6 hr at hourly).
const RUN_UNIVERSE_CAP = (() => {
  const raw = Number(process.env.SIGNAL_RUN_UNIVERSE_CAP);
  if (Number.isFinite(raw) && raw >= 1) return Math.floor(raw);
  return 100;
})();

/**
 * Spec "AUTO THROTTLE" — shrink the per-run cap as the daily budget
 * approaches the limit. Returns the cap for THIS run based on what's
 * already been consumed today. Logged once per call so an operator
 * sees when throttling kicks in.
 *
 * Bands (vs INDIANAPI_DAILY_LIMIT):
 *   <60%   → full cap
 *   60–80% → 75% of cap (floor 60)
 *   80–95% → 50% of cap (floor 40)
 *   ≥95%   → 25% of cap (floor 20)
 *
 * The route still refuses to start when daily_exceeded fires (already
 * handled at the budget gate below, returns 429). This helper covers
 * the "approaching limit" zone where we want fewer symbols per run
 * but still some signal coverage.
 */
function computeThrottledCap(baseCap: number, dailyUsed: number, dailyLimit: number): {
  cap:        number;
  band:       'normal' | 'warn' | 'throttle' | 'critical';
  pct:        number;
} {
  if (dailyLimit <= 0) return { cap: baseCap, band: 'normal', pct: 0 };
  const pct = Math.round((dailyUsed / dailyLimit) * 1000) / 10;
  if (pct >= 95) return { cap: Math.max(20, Math.floor(baseCap * 0.25)), band: 'critical', pct };
  if (pct >= 80) return { cap: Math.max(40, Math.floor(baseCap * 0.5)),  band: 'throttle', pct };
  if (pct >= 60) return { cap: Math.max(60, Math.floor(baseCap * 0.75)), band: 'warn',     pct };
  return { cap: baseCap, band: 'normal', pct };
}

/**
 * Spec "PRE-FILTER BEFORE API CALL" — drop ineligible symbols using
 * data ALREADY in the local market_data_daily cache. Zero upstream
 * API spend: one indexed GROUP BY query reads bars from the past 30
 * days and produces (latest close, avg 20d volume) per symbol.
 *
 * Filters:
 *   price < ₹50            — NSE delivery floor; sub-₹50 names also
 *                            tend to dominate manipulation watchlists.
 *   avg 20d volume < 50,000 — below this slippage on a 1% position
 *                            eats a 1.3:1 setup's expected edge.
 *   volatility > 6%        — daily close-to-close stddev / mean close
 *                            over last 30d. Above 6% the ATR-based
 *                            stop is wider than the rejection-engine's
 *                            stop-distance gate accepts, so the row is
 *                            rejected anyway downstream — drop it
 *                            before we burn a candle fetch on it.
 *
 * Symbols with no DB data pass through (the candle fetch chain will
 * either fall back or skip them during validation).
 *
 * All three floors are env-tunable:
 *   SIGNAL_PREFILTER_MIN_PRICE       (default 50, 0=off)
 *   SIGNAL_PREFILTER_MIN_AVG_VOLUME  (default 50000, 0=off)
 *   SIGNAL_PREFILTER_MAX_VOLATILITY  (default 6.0, 0=off)
 */
async function preFilterByDbCache(symbols: readonly string[]): Promise<{
  eligible: string[];
  dropped:  Array<{ symbol: string; reason: string }>;
  unknown:  number;
}> {
  if (symbols.length === 0) return { eligible: [], dropped: [], unknown: 0 };

  const MIN_PRICE = (() => {
    const raw = Number(process.env.SIGNAL_PREFILTER_MIN_PRICE);
    return Number.isFinite(raw) && raw >= 0 ? raw : 50;
  })();
  const MIN_AVG_VOLUME = (() => {
    const raw = Number(process.env.SIGNAL_PREFILTER_MIN_AVG_VOLUME);
    return Number.isFinite(raw) && raw >= 0 ? raw : 50_000;
  })();
  const MAX_VOLATILITY = (() => {
    const raw = Number(process.env.SIGNAL_PREFILTER_MAX_VOLATILITY);
    return Number.isFinite(raw) && raw >= 0 ? raw : 6.0;
  })();
  if (MIN_PRICE === 0 && MIN_AVG_VOLUME === 0 && MAX_VOLATILITY === 0) {
    return { eligible: [...symbols], dropped: [], unknown: 0 };
  }

  const upperSet = symbols.map((s) => s.toUpperCase());
  const placeholders = upperSet.map(() => '?').join(',');
  // Volatility = STDDEV(close)/AVG(close)*100 over the 30-day window.
  // Approximation of ATR%; cheaper to compute purely in SQL than
  // pulling per-symbol bars and computing daily true range. A symbol
  // sitting at >6% close-to-close stddev would also fail the rejection
  // engine's stop_distance gate (max 3 ATR) — pre-emptive drop.
  type Row = {
    symbol: string;
    last_close: number | null;
    avg_vol_20d: number | null;
    volatility_pct: number | null;
  };
  const dataMap = new Map<string, {
    close: number | null;
    vol: number | null;
    vol_pct: number | null;
  }>();
  try {
    const { rows } = await db.query<Row>(
      `SELECT symbol,
              (SELECT close FROM market_data_daily t2
                WHERE t2.symbol = t.symbol ORDER BY ts DESC LIMIT 1) AS last_close,
              AVG(volume) AS avg_vol_20d,
              CASE WHEN AVG(close) > 0
                   THEN (STDDEV_POP(close) / AVG(close)) * 100
                   ELSE NULL
              END AS volatility_pct
         FROM market_data_daily t
        WHERE symbol IN (${placeholders})
          AND ts >= DATE_SUB(NOW(), INTERVAL 30 DAY)
        GROUP BY symbol`,
      [...upperSet],
    );
    for (const r of rows) {
      dataMap.set(String(r.symbol).toUpperCase(), {
        close:   r.last_close == null      ? null : Number(r.last_close),
        vol:     r.avg_vol_20d == null     ? null : Number(r.avg_vol_20d),
        vol_pct: r.volatility_pct == null  ? null : Number(r.volatility_pct),
      });
    }
  } catch (err: any) {
    console.warn('[PREFILTER] DB read failed — passing universe through unfiltered:', err?.message);
    return { eligible: [...symbols], dropped: [], unknown: symbols.length };
  }

  const eligible: string[] = [];
  const dropped:  Array<{ symbol: string; reason: string }> = [];
  let unknown = 0;
  for (const sym of symbols) {
    const m = dataMap.get(sym.toUpperCase());
    if (!m) {
      // No DB data — pass through. Candle fetch chain owns this case.
      eligible.push(sym);
      unknown++;
      continue;
    }
    if (MIN_PRICE > 0 && (m.close == null || m.close < MIN_PRICE)) {
      dropped.push({ symbol: sym, reason: `price ${m.close ?? 'null'} < ${MIN_PRICE}` });
      continue;
    }
    if (MIN_AVG_VOLUME > 0 && (m.vol == null || m.vol < MIN_AVG_VOLUME)) {
      dropped.push({ symbol: sym, reason: `avg_vol ${m.vol == null ? 'null' : Math.round(m.vol)} < ${MIN_AVG_VOLUME}` });
      continue;
    }
    // Volatility null → unknown, fall through (let the per-symbol gate
    // below catch it). Only drop when we have a value above ceiling.
    if (
      MAX_VOLATILITY > 0
      && m.vol_pct != null
      && Number.isFinite(m.vol_pct)
      && m.vol_pct > MAX_VOLATILITY
    ) {
      dropped.push({
        symbol: sym,
        reason: `volatility ${m.vol_pct.toFixed(1)}% > ${MAX_VOLATILITY}%`,
      });
      continue;
    }
    eligible.push(sym);
  }
  return { eligible, dropped, unknown };
}
interface ChunkPick {
  symbols:    string[];
  startIndex: number;
  runCount:   number;
  wrapped:    boolean;
}

/** Smart-rotation chunk picker. Returns CHUNK_SIZE consecutive symbols
 *  starting at offset (runCount * CHUNK_SIZE) % universe.length. When
 *  the slice would run off the end, wraps around to symbol 0 — so
 *  every run still gets a full chunk and no symbol is skipped at the
 *  universe boundary. */
function pickRotatingChunk(all: readonly string[], cap: number): ChunkPick {
  const runCount = getRunCount();
  if (cap <= 0 || all.length === 0) {
    return { symbols: [], startIndex: 0, runCount, wrapped: false };
  }
  if (all.length <= cap) {
    return { symbols: [...all], startIndex: 0, runCount, wrapped: false };
  }
  const startIndex = (runCount * cap) % all.length;
  const endIndex   = startIndex + cap;
  if (endIndex <= all.length) {
    return {
      symbols:    all.slice(startIndex, endIndex),
      startIndex,
      runCount,
      wrapped:    false,
    };
  }
  const head = all.slice(startIndex);
  const tail = all.slice(0, endIndex - all.length);
  return {
    symbols:    [...head, ...tail],
    startIndex,
    runCount,
    wrapped:    true,
  };
}

// Max wall-clock age (ms) of the per-process "last candle refresh"
// timestamp before we consider DB bars stale for signal generation.
// Daily bar `ts` is always stamped at market open, so we measure
// age from refresh wall-clock, not from the bar's own ts field.
//
// Held in lockstep with candleRefreshScheduler's INTERVAL_MS
// (default 15 min). 20 min = 15-min interval + 5-min headroom for
// a single missed cycle (rate-limit retry, network blip). If you
// tune CANDLE_REFRESH_INTERVAL_MS, raise ENGINE_STALE_SKIP_MS by
// the same delta or the engine will reject signals as "stale" at
// the tail of every refresh window.
const STALE_SKIP_AGE_MS =
  Math.max(60_000, Number(process.env.ENGINE_STALE_SKIP_MS) || 20 * 60_000);

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// Ensure base tables + provenance columns exist on first call.
let migrated = false;

// In-flight guard. The Phase-4 pipeline + Yahoo refresh over the full
// 2,767-symbol universe is multi-minute work. Without this guard a
// double-click on Run Pipeline (or two operators clicking it) would
// fire two parallel runs that contend on Yahoo, the DB connection
// pool, and the q365_signals UNIQUE keys. Coalesce into one run; the
// second caller gets a 409 with the running batch's progress.
//
// `inFlight` is the route-scope metadata (batch id + startedAt). The
// authoritative liveness flag lives on scannerState via setInFlight()
// — same global the /api/signals auto-recovery checks — so a manual
// /api/run-signal-engine click and an auto-recovery can never run
// simultaneously, and either path's 409/skip envelope can read the
// other's running batch.
let inFlight: { batchId: string; startedAt: string } | null = null;

// Spec "FIX PIPELINE CONCURRENCY" §1+§8 — single source of truth for
// the progress envelope shipped on the 409 (and on GET ?status=true).
// Reads scannerState's per-symbol counter (set by Phase 1 inside
// generatePhase4Signals) and computes percent + ETA. Returns null
// when no scan is running OR the scan is in candle warmup / imports
// (Phase 1 hasn't started ticking yet).
//
// `started_at` is preferred from the route's inFlight handle (the
// pipeline's actual start, including candle warmup) and falls back
// to the progress.startedAt (Phase 1's start) when no handle is
// passed in (e.g., the auto-recovery is running, not this route).
function buildPipelineProgress(opts: {
  startedAtMs: number | null;
}): {
  scanned:         number;
  total:           number;
  percent:         number;
  last_symbol:     string | null;
  started_at:      string | null;
  updated_at:      string | null;
  elapsed_seconds: number | null;
  eta_seconds:     number | null;
} | null {
  const p = getScannerProgress();
  if (!p) return null;
  const total   = p.total > 0 ? p.total : 0;
  const scanned = Math.min(p.done, total || p.done);
  const percent = total > 0 ? Math.round((scanned / total) * 1000) / 10 : 0;
  const now = Date.now();
  const startedAtMs = opts.startedAtMs ?? p.startedAt;
  const elapsedMs = Math.max(0, now - startedAtMs);
  let etaSec: number | null = null;
  if (scanned > 0 && total > 0 && scanned < total) {
    const elapsedSinceProgress = Math.max(1, now - p.startedAt);
    const msPerSymbol          = elapsedSinceProgress / scanned;
    etaSec = Math.max(1, Math.round((msPerSymbol * (total - scanned)) / 1000));
  }
  return {
    scanned,
    total,
    percent,
    last_symbol:     p.lastSymbol,
    started_at:      new Date(startedAtMs).toISOString(),
    updated_at:      new Date(p.updatedAt).toISOString(),
    elapsed_seconds: Math.round(elapsedMs / 1000),
    eta_seconds:     etaSec,
  };
}

// Spec "FIX PIPELINE CONCURRENCY" §8 — frontend-friendly running
// envelope. Returned by both the 409 (POST while a run is active)
// and GET ?status=true so the dashboard can render progress without
// special-casing the response shape per endpoint.
function buildRunningEnvelope(opts: {
  batchId:     string | null;
  startedAtMs: number | null;
}): {
  running:          boolean;
  status:           'running' | 'idle';
  batch_id:         string | null;
  started_at:       string | null;
  elapsed_ms:       number | null;
  percent_complete: number;
  eta_seconds:      number | null;
  progress: ReturnType<typeof buildPipelineProgress>;
} {
  const progress = buildPipelineProgress({ startedAtMs: opts.startedAtMs });
  const now = Date.now();
  const elapsedMs =
    opts.startedAtMs != null ? Math.max(0, now - opts.startedAtMs) : null;
  return {
    running:          true,
    status:           'running',
    batch_id:         opts.batchId,
    started_at:       opts.startedAtMs != null ? new Date(opts.startedAtMs).toISOString() : null,
    elapsed_ms:       elapsedMs,
    percent_complete: progress?.percent ?? 0,
    eta_seconds:      progress?.eta_seconds ?? null,
    progress,
  };
}

// Candle provider — walks the unified fallback chain (DB-fast →
// IndianAPI live → NSE direct → DB-thin → throw) so a symbol with
// any source returning data flows into Phase 3.
//
// Spec "ALLOW MARKET CLOSED FETCH" + "FORCE MIN DATA GUARANTEE":
// the legacy `if (market.isOpen && refreshAgeMs > STALE_SKIP_AGE_MS) return []`
// branch was deleted. Returning an empty array silently turned every
// symbol into a Phase-3 rejection during market hours when a candle
// refresh was lagging — exactly the failure the user reported.
// Stale data is now passed through; Phase 3's own validateCandleSeries
// gate decides whether the bars are usable.
//
// `STALE_SKIP_AGE_MS` is no longer referenced from the read path; it
// remains in scope as documentation of the historical threshold and
// is still consumed by upstream freshness reporting.
void STALE_SKIP_AGE_MS;
const dbCandleProvider: CandleProvider = {
  async fetchDailyCandles(symbol: string): Promise<Candle[]> {
    const result = await fetchDailyCandlesWithFallback(symbol);
    const rows = result.candles;
    const latest = rows[rows.length - 1] ?? null;
    const latestTs = latest?.ts ? new Date(latest.ts).getTime() : null;

    // "ageMinutes" is measured against the candle scheduler's last
    // refresh wall clock, NOT the daily bar's `ts`. Yahoo's daily bar
    // is stamped at market open so its ts age is always multi-hour
    // during the session — measuring refresh age is the honest
    // "how fresh is the data we wrote?" metric.
    const refreshAgeMs = getCandleRefreshAgeMs();
    const ageMinutes =
      refreshAgeMs != null ? Math.round((refreshAgeMs / 60_000) * 10) / 10 : null;

    console.log('CANDLE DEBUG:', {
      symbol,
      latest: latest
        ? {
            time:   latestTs ? new Date(latestTs).toISOString() : null,
            open:   latest.open,
            high:   latest.high,
            low:    latest.low,
            close:  latest.close,
            volume: latest.volume,
          }
        : null,
      ageMinutes,
      bars:        rows.length,
      source:      result.source,
      hit_upstream: result.hitUpstream,
      latency_ms:  result.latencyMs,
    });

    return rows;
  },
};

// Portfolio snapshot loader — mirrors /api/signal-engine route.
async function loadPortfolioSnapshot(userId: number): Promise<PortfolioSnapshot> {
  const fallback: PortfolioSnapshot = {
    capital: DEFAULT_PHASE3_CONFIG.defaultCapital,
    cashAvailable: DEFAULT_PHASE3_CONFIG.defaultCapital,
    openPositions: [],
    pendingSignals: [],
  };
  try {
    const { rows: pRows } = await db.query(
      `SELECT id FROM portfolios WHERE user_id = ? LIMIT 1`,
      [userId],
    );
    if (!pRows.length) return fallback;

    const portfolioId = (pRows[0] as any).id;
    const { rows: pos } = await db.query(
      `SELECT pp.tradingsymbol AS symbol, pp.quantity, pp.buy_price, pp.current_price,
              COALESCE(i.sector, 'Other') AS sector
       FROM portfolio_positions pp
       LEFT JOIN instruments i ON pp.instrument_id = i.id
       WHERE pp.portfolio_id = ?`,
      [portfolioId],
    );

    const positions = (pos as any[]).map((p) => ({
      symbol: p.symbol,
      side: 'long' as const,
      sector: p.sector || 'Other',
      grossValue: (p.quantity || 0) * (p.current_price || p.buy_price || 0),
      riskAllocated: (p.quantity || 0) * (p.buy_price || 0) * 0.005,
    }));

    const totalGross = positions.reduce((s, p) => s + p.grossValue, 0);
    const capital = DEFAULT_PHASE3_CONFIG.defaultCapital;

    return {
      capital,
      cashAvailable: Math.max(0, capital - totalGross),
      openPositions: positions,
      pendingSignals: [],
    };
  } catch {
    return fallback;
  }
}

// runScanInner — actual pipeline body. Extracted so POST can fire it
// either awaited (sync mode) or fire-and-forget (async mode).
//
// Returns the legacy response envelope on success, or { error, ... }
// on failure. Async callers ignore the return value and check status
// via /api/signals (which reads the q365_signals table directly).
async function runScanInner(
  user: { id: number },
  batchId: string,
  start: number,
  opts: { skipCandleRefresh?: boolean } = {},
): Promise<any> {
  // [PIPELINE START] — single-line greppable trace tag emitted at the
  // top of every run-signal-engine invocation. Held in lock-step with
  // the matching marker emitted by /api/signals' runAutoScanRecovery
  // so an operator can pivot between the two pipeline entry points
  // by grepping `[PIPELINE START]`.
  console.log('🔥 PIPELINE START');
  console.log(
    `[PIPELINE START] reason="api:run-signal-engine" batch=${batchId} ` +
    `started_at=${new Date(start).toISOString()} ` +
    `skip_candle_refresh=${!!opts.skipCandleRefresh}`,
  );
  // Spec "TRACK USAGE" — single greppable budget snapshot at PIPELINE
  // START so an operator can correlate this run with what's already
  // been consumed today/this month BEFORE the candle refresh fan-out
  // burns more quota.
  {
    const u = getApiUsage();
    console.log(
      `[API USAGE] daily=${u.daily}/${u.daily_limit} (${u.daily_percent}%) ` +
      `monthly=${u.monthly}/${u.monthly_limit} (${u.monthly_percent}%) ` +
      `per_run_limit=${u.per_run_limit}`,
    );
  }
  if (isMarketOverrideEnabled()) {
    console.log('[MARKET OVERRIDE] forcing pipeline run');
  }
  // ── Stage A: Candle refresh ────────────────────────────────
  // The slowest part of the pipeline. Bypassed when the caller passes
  // ?skipCandleRefresh=true — useful when DB candles are already fresh
  // (e.g. the in-proc 10-min regen cron just ran) and the operator
  // just wants Phase 4 over the existing bars in seconds.
  //
  // Spec "OPTIMIZE API USAGE PER RUN" §3 — universe cap. The full
  // NIFTY 500 universe is 503 symbols; with `force: true` that's
  // ~503 IndianAPI candle calls per run, blowing through a 2500/day
  // budget in five clicks. Cap to RUN_UNIVERSE_CAP (default 250)
  // with hash-rotation, so consecutive runs cover the other half.
  const fullUniverse  = DEFAULT_PHASE1_CONFIG.universe;

  // Spec INSTITUTIONAL §C — full-universe scan mode. Default ON per
  // operator spec ("EVERY cycle must evaluate all 500 symbols"). When
  // enabled, the prefilter still runs (telemetry — `dropped[]` array
  // tells the operator which symbols would have been cut on data-quality
  // grounds) BUT its filtered output is NOT used to size the run.
  // Phase 3 receives the full universe and applies its own per-symbol
  // gates (candle validity, feature quality, strategy match) — those
  // are the spec-correct rejection points.
  //
  // Set SIGNAL_FULL_UNIVERSE_SCAN=false to revert to the prefilter-
  // sized universe (the previous behaviour, useful for cost-constrained
  // staging environments).
  const fullUniverseScan = (() => {
    const raw = (process.env.SIGNAL_FULL_UNIVERSE_SCAN ?? 'true').trim().toLowerCase();
    return raw === 'true' || raw === '1' || raw === 'yes' || raw === 'on';
  })();
  console.log(
    `[FULL_UNIVERSE_SCAN] enabled=${fullUniverseScan} ` +
    `universe=${fullUniverse.length} mode=${fullUniverseScan ? 'all-symbols' : 'prefilter-eligible-only'}`,
  );

  // Spec "PRE-FILTER BEFORE API CALL" — drop ineligible symbols using
  // local DB data (zero upstream API cost) so the per-run cap is spent
  // on names that can actually clear the floor checks. The dropped
  // count is reported for observability; an operator can trace which
  // symbol was excluded via the per-symbol `dropped` array. When
  // SIGNAL_FULL_UNIVERSE_SCAN is on, this is telemetry only — the
  // dropped symbols still flow into Phase 3.
  const prefilterStart = Date.now();
  const prefilter      = await preFilterByDbCache(fullUniverse);
  const prefilterMs    = Date.now() - prefilterStart;
  console.log(
    `[PREFILTER] full=${fullUniverse.length} eligible=${prefilter.eligible.length} ` +
    `dropped=${prefilter.dropped.length} unknown=${prefilter.unknown} ` +
    `elapsed_ms=${prefilterMs} ` +
    `mode=${fullUniverseScan ? 'TELEMETRY_ONLY' : 'ENFORCED'}`,
  );
  if (prefilter.dropped.length > 0 && prefilter.dropped.length <= 20) {
    console.log('[PREFILTER DROPPED]', prefilter.dropped);
  } else if (prefilter.dropped.length > 20) {
    console.log(
      '[PREFILTER DROPPED]',
      prefilter.dropped.slice(0, 10),
      `(+${prefilter.dropped.length - 10} more)`,
    );
  }

  // Spec "AUTO THROTTLE" — shrink the per-run cap as today's IndianAPI
  // budget approaches the daily limit. Logs only when a band other than
  // 'normal' kicks in so steady-state runs stay quiet.
  const usageBeforeRun = getApiUsage();
  const throttle       = computeThrottledCap(
    RUN_UNIVERSE_CAP, usageBeforeRun.daily, usageBeforeRun.daily_limit,
  );
  if (throttle.band !== 'normal') {
    console.warn(
      `[API THROTTLE] band=${throttle.band} daily_used=${throttle.pct}% ` +
      `cap=${RUN_UNIVERSE_CAP}→${throttle.cap}`,
    );
  }

  // Spec INSTITUTIONAL §C — universe sizing. When SIGNAL_FULL_UNIVERSE_SCAN
  // is on (default), the run consumes the FULL universe regardless of
  // prefilter outcome. When off, runs use the prefilter-eligible subset
  // (legacy behaviour). The safety fallback ("never run with zero
  // universe") still applies in either mode.
  const runUniverseSource = fullUniverseScan
    ? fullUniverse
    : (prefilter.eligible.length > 0 ? prefilter.eligible : fullUniverse);

  // pickRotatingChunk retained for telemetry — its slice is NOT used
  // when fullUniverseScan is on. Operators can correlate the would-be
  // rotation offset with the symbol set actually scanned.
  const chunk       = pickRotatingChunk(runUniverseSource, throttle.cap);
  const runUniverse = runUniverseSource;
  console.log(
    `[SCAN_LIMIT] universe=${fullUniverse.length} ` +
    `prefilter_eligible=${prefilter.eligible.length} ` +
    `run_universe=${runUniverse.length} ` +
    `cap=${throttle.cap} band=${throttle.band} ` +
    `chunk_size_logged=${chunk.symbols.length} ` +
    `chunk_used=${fullUniverseScan ? 'no (full-scan mode)' : 'yes (legacy mode)'} ` +
    `api_per_run_limit=${INDIANAPI_PER_RUN_LIMIT}`,
  );
  // Single-grep carve-point trace. When `out` < `in`, the bottleneck is
  // either fullUniverseScan=false (prefilter slice in effect) or the
  // universe itself is short (q365_universe(is_active=1) row count).
  console.log('[UNIVERSE_CARVE]', {
    stage:               'run_signal_engine_select',
    in:                  fullUniverse.length,
    prefilter_eligible:  prefilter.eligible.length,
    out:                 runUniverse.length,
    full_scan:           fullUniverseScan,
  });
  // Spec INSTITUTIONAL §C — when the run would scan less than 95% of
  // the loaded universe, log a warning so the operator sees the gap
  // immediately (typically caused by SIGNAL_FULL_UNIVERSE_SCAN=false
  // OR prefilter cutting the eligible set below the universe).
  if (runUniverse.length < Math.floor(fullUniverse.length * 0.95)) {
    console.warn(
      `[SCAN_LIMIT] PARTIAL — run will scan ${runUniverse.length}/${fullUniverse.length} ` +
      `(${Math.round((runUniverse.length / fullUniverse.length) * 100)}%). ` +
      `${fullUniverseScan
        ? 'SIGNAL_FULL_UNIVERSE_SCAN is on but the universe itself is short. Investigate q365_universe.'
        : 'Set SIGNAL_FULL_UNIVERSE_SCAN=true (or remove the env var) for 100% coverage.'}`,
    );
  }
  console.log(
    `[SCAN_CHUNK] would_be_chunk_offset=${chunk.startIndex} ` +
    `would_be_chunk_size=${chunk.symbols.length} ` +
    `run_count=${chunk.runCount} ` +
    `wrapped=${chunk.wrapped} ` +
    `note="chunk slice ${fullUniverseScan ? 'IGNORED — full universe scanned' : 'APPLIED — legacy mode'}"`,
  );

  // Spec "DEBUG OUTPUT" — required scan lines so an operator can
  // confirm full-universe coverage at a glance.
  console.log('📊 TOTAL STOCKS:', fullUniverse.length);
  console.log('TOTAL UNIVERSE:', fullUniverse.length);
  console.log('FETCHING THIS RUN:', runUniverse.length);
  console.log('ROTATION OFFSET:', chunk.startIndex);

  console.log(
    `[RunSignalEngine] full-universe scan — full=${fullUniverse.length} ` +
    `eligible=${runUniverseSource.length} picked=${runUniverse.length} ` +
    `api_per_run_cap=${INDIANAPI_PER_RUN_LIMIT} (band=${throttle.band}) ` +
    `run_count=${chunk.runCount} (rotation disabled — pinned full pass)`,
  );

  // Spec "API USAGE CONTROL" — reset the per-run candle-source counters
  // here so debug_scan reflects ONLY this run's NSE / IndianAPI / failed
  // tallies. beginPerRunBudget (in the route's lock claim) already
  // handles IndianAPI's daily/monthly counter slice.
  resetCandleSourceCounters();
  const candleStartedAt = Date.now();
  if (opts.skipCandleRefresh) {
    console.log('[RunSignalEngine] skipCandleRefresh=true — running Phase 4 against existing market_data_daily bars');
  } else {
    try {
      const refresh = await refreshDailyCandles({
        symbols: runUniverse,
        // Spec "OPTIMIZE API USAGE PER RUN" §1+§2 — drop force=true.
        // The freshness window in candleIngest skips per-symbol when
        // stored bars are <10 min old, which on a typical day means
        // the second run of the day touches ~0 candles. force=true
        // would burn the entire universe regardless. CANDLE_FRESH_IF_WITHIN_MIN
        // overrides the default 10-min window.
        force: false,
      });
      console.log(
        `[RunSignalEngine] refresh done  refreshed=${refresh.refreshed}/${refresh.staleCount}  ` +
        `bars=${refresh.barsIngested}  failed=${refresh.failed.length}  ` +
        `before=${refresh.latestTsBefore} (${refresh.ageHoursBefore}h)  ` +
        `after=${refresh.latestTsAfter} (${refresh.ageHoursAfter}h)`
      );
    } catch (err) {
      console.error(
        '[RunSignalEngine] refresh failed (continuing on DB bars):',
        (err as Error)?.message,
      );
    }
  }
  const candleElapsedMs = Date.now() - candleStartedAt;
  console.log(`[PERF] run-signal-engine candle_refresh_ms=${candleElapsedMs} skipped=${!!opts.skipCandleRefresh}`);

  const freshness = await checkCandleFreshness();
  console.log(
    `[RunSignalEngine] candle probe  market=${freshness.marketLabel}  ` +
    `latest=${freshness.latestCandleTs}  age=${freshness.ageHours}h  ` +
    `gap=${freshness.gapDays}d  cutoff=${freshness.maxGapDays}d  ok=${freshness.ok}`
  );
  if (!freshness.ok) {
    console.warn(
      '[RunSignalEngine] ⚠ candles still flagged as stale — running anyway:',
      freshness.reason,
    );
  }

  console.log('ENGINE STARTED:', {
    user_id: user.id,
    batch_id: batchId,
    universe_size: DEFAULT_PHASE1_CONFIG.universe.length,
    candle_latest: freshness.latestCandleTs,
    candle_age_hours: freshness.ageHours,
  });
  // Spec FULL-SCAN-2026-05 — canonical [FULL_SCAN_*] tags across both
  // entry points (cron:signal-generation in workers/scheduler.ts and
  // api:run-signal-engine here) so SRE has a single grep family.
  console.log('[FULL_SCAN_START]', {
    stage:           'api:run-signal-engine',
    batch_id:        batchId,
    universe_size:   DEFAULT_PHASE1_CONFIG.universe.length,
    run_universe:    runUniverse.length,
    started_at:      new Date().toISOString(),
  });
  try {
    const m = await import('@/lib/monitor/institutionalHealth');
    m.recordFullScanStart({ universe_size: DEFAULT_PHASE1_CONFIG.universe.length });
  } catch { /* monitor optional */ }
  const portfolio = await loadPortfolioSnapshot(user.id);

  // ── Stage B: Phase 4 ──────────────────────────────────────
  // Pass a Phase-1 config whose `universe` is the throttled+pre-filtered
  // `runUniverse` (not the full DEFAULT_PHASE1_CONFIG.universe), so
  // Phase 3's candle prefetch fan-out is sized to the same set the
  // route already refreshed. Without this, Phase 3 would prefetch
  // candles for the FULL 503-symbol universe regardless of the cap,
  // burning DB I/O on names that aren't in this run's slot.
  const phase1ConfigForRun: typeof DEFAULT_PHASE1_CONFIG = {
    ...DEFAULT_PHASE1_CONFIG,
    universe: runUniverse,
  };
  const phase4StartedAt = Date.now();
  const result = await generatePhase4Signals(
    dbCandleProvider,
    portfolio,
    undefined, undefined,
    phase1ConfigForRun,
    undefined,
    { generationSource: 'api:run-signal-engine:adapter' },
  );
  const phase4ElapsedMs = Date.now() - phase4StartedAt;
  console.log(
    `[PERF] run-signal-engine phase4_ms=${phase4ElapsedMs} ` +
    `scanned=${result.meta.scanned} approved=${result.signals.length} ` +
    `rejected=${result.meta.rejected}`,
  );
  const providerCoveragePct = runUniverse.length > 0
    ? Math.round((result.meta.scanned / runUniverse.length) * 1000) / 10
    : null;
  console.log('[FULL_SCAN_COMPLETE]', {
    stage:           'api:run-signal-engine',
    batch_id:        batchId,
    universe_size:   DEFAULT_PHASE1_CONFIG.universe.length,
    run_universe:    runUniverse.length,
    scanned:         result.meta.scanned,
    approved:        result.signals.length,
    rejected:        result.meta.rejected,
    elapsed_ms:      phase4ElapsedMs,
    ok:              true,
    provider_coverage_pct: providerCoveragePct,
  });
  try {
    const m = await import('@/lib/monitor/institutionalHealth');
    m.recordFullScanComplete({
      ok:        true,
      scanned:   result.meta.scanned,
      approved:  result.signals.length,
      rejected:  result.meta.rejected,
      elapsed_ms: phase4ElapsedMs,
      provider_coverage_pct: providerCoveragePct,
    });
  } catch { /* monitor optional */ }

  // Per-signal validation log (light — kept since async mode means no
  // operator is staring at the response).
  const validationAgeMs = getCandleRefreshAgeMs();
  for (const s of result.signals) {
    console.log('SIGNAL DEBUG:', {
      symbol:       s.symbol,
      latestCandle: freshness.latestCandleTs,
      timestamp:    new Date().toISOString(),
      confidence:   s.adjustedConfidenceScore,
      entry:        s.tradePlan.entryZoneHigh,
      refreshAgeMin: validationAgeMs != null
        ? Math.round((validationAgeMs / 60_000) * 10) / 10
        : null,
    });
  }

  // Tag this batch's rows with the legacy batch_id.
  // [BATCH_ID_STAMP] log makes a 0-row UPDATE visible — without it,
  // the route silently completed status=success even when zero rows
  // had been persisted (because saveSignals' rejections / upstream
  // gate refusals don't throw). `affected=0` is the canonical
  // signature of "Phase4 produced no rows reaching saveSignals" —
  // grep that tag and follow it back to the elite/freshness gate.
  const stampStart = Math.floor(start / 1000);
  const stampRes = await db.query(
    `UPDATE q365_signals
       SET batch_id = ?
     WHERE generation_source = 'api:run-signal-engine:adapter'
       AND batch_id IS NULL
       AND created_at >= FROM_UNIXTIME(?)`,
    [batchId, stampStart],
  ).catch((err) => ({ affectedRows: -1, error: err?.message }));
  const stampAffected = (stampRes as any)?.affectedRows ?? '?';
  const stampError    = (stampRes as any)?.error;
  if (stampError) {
    console.warn('[BATCH_ID_STAMP]', {
      batch_id:        batchId,
      affected:        stampAffected,
      gen_source:      'api:run-signal-engine:adapter',
      since_unix:      stampStart,
      error:           stampError,
    });
  } else {
    console.log('[BATCH_ID_STAMP]', {
      batch_id:        batchId,
      affected:        stampAffected,
      gen_source:      'api:run-signal-engine:adapter',
      since_unix:      stampStart,
    });
  }

  // Spec "STICKY SIGNALS" — sticky-visibility window for prior-batch rows.
  //
  // Previously this single UPDATE flipped EVERY non-current-batch
  // active/watchlist/flagged row to 'expired' in one shot. That
  // produced the dashboard flicker the user reported: a symbol that
  // appeared in run N but didn't make the cut in run N+1 vanished
  // immediately, then reappeared in run N+2.
  //
  // New contract: prior-batch rows transition through a 'stale'
  // intermediate state for SIGNAL_STICKY_VISIBILITY_MIN minutes
  // (default 30) before being hidden. The reader (readSignals.ts)
  // includes 'stale' in its result set, so a row stays on the
  // dashboard for the sticky window even when subsequent runs don't
  // re-emit it. After the window elapses, the row is finally
  // expired and drops off.
  //
  // Two UPDATEs (instead of a single CASE-WHEN) so we can log the
  // KEPT-vs-EXPIRED counts the spec asks for. The two row sets are
  // disjoint (the first only touches rows < window_min old; the
  // second only touches rows ≥ window_min old) so there's no
  // double-flip risk.
  const stickyWindowMin = Math.max(
    1,
    Number(process.env.SIGNAL_STICKY_VISIBILITY_MIN) || 30,
  );

  const keptStaleRes = await db.query(
    `UPDATE q365_signals
       SET status = 'stale'
     WHERE generation_source = 'api:run-signal-engine:adapter'
       AND status IN ('active', 'watchlist', 'flagged')
       AND created_at >= DATE_SUB(NOW(), INTERVAL ? MINUTE)
       AND (
         (batch_id IS NOT NULL AND batch_id <> ?)
         -- Orphan NULL-batch rows from earlier crashed/aborted runs.
         -- Guarded by created_at so a row inserted by THIS run that
         -- raced past the batch_id tagging update is never trampled.
         OR (batch_id IS NULL AND created_at < FROM_UNIXTIME(?))
       )`,
    [stickyWindowMin, batchId, Math.floor(start / 1000)],
  ).catch((err) => ({ affectedRows: -1, error: err?.message } as any));

  const expiredOldRes = await db.query(
    `UPDATE q365_signals
       SET status = 'expired'
     WHERE generation_source = 'api:run-signal-engine:adapter'
       AND status IN ('active', 'watchlist', 'flagged', 'stale')
       AND created_at < DATE_SUB(NOW(), INTERVAL ? MINUTE)
       AND (
         (batch_id IS NOT NULL AND batch_id <> ?)
         OR (batch_id IS NULL AND created_at < FROM_UNIXTIME(?))
       )`,
    [stickyWindowMin, batchId, Math.floor(start / 1000)],
  ).catch((err) => ({ affectedRows: -1, error: err?.message } as any));

  // Spec "DEBUG LOGS" — operator-visible per-batch lifecycle counts.
  console.log('SIGNAL KEPT:', {
    batch_id:        batchId,
    affected:        (keptStaleRes as any)?.affectedRows ?? '?',
    status:          'stale',
    sticky_window_min: stickyWindowMin,
  });
  console.log('SIGNAL EXPIRED:', {
    batch_id: batchId,
    affected: (expiredOldRes as any)?.affectedRows ?? '?',
    reason:   `older than ${stickyWindowMin} min`,
  });

  // Drop the SSE SWR cache so the next push re-reads from the DB
  // and reflects the newly-expired pool. The HTTP route's keyed SWR
  // store was retired; the route now reads through its own short-TTL
  // freezeCache which self-expires per request.
  try {
    invalidateStreamSignalsCache();
    console.log('[RunSignalEngine] invalidated SSE cache');
  } catch (err) {
    console.warn('[RunSignalEngine] cache invalidation failed:', (err as any)?.message);
  }

  const approved = result.signals.filter(
    (s) => s.executionReadiness.approvalDecision === 'approved',
  ).length;
  const deferred = result.signals.length - approved;

  // Spec §8 — final-result trace tag. STRICT vs RELAXED counts come
  // straight off the Phase 4 envelope: approved = STRICT (passed every
  // gate); deferred = RELAXED (executable shape, declined by gates).
  console.log('[RESULT]', {
    scanned:        result.meta.scanned,
    strict:         approved,
    relaxed:        deferred,
    final_signals:  result.signals.length,
  });

  const totalElapsedMs = Date.now() - start;
  console.log(
    `[PERF] run-signal-engine total_ms=${totalElapsedMs} ` +
    `candle_refresh_ms=${candleElapsedMs} phase4_ms=${phase4ElapsedMs} ` +
    `skipCandleRefresh=${!!opts.skipCandleRefresh}`,
  );

  // Spec "FIX PIPELINE NOT COMPLETING" §5 — heartbeat MUST be stamped
  // after the saveSignals path inside generatePhase4Signals has
  // committed rows to q365_signals (it just did, above) so the
  // freshness probe in /api/signals always sees a non-null
  // `last_pipeline_run` after a successful manual run. Failure here is
  // non-fatal (the rows are already on disk); we only swallow the
  // error so a Redis blip can't 500 a successful pipeline.
  try {
    await markPipelineHeartbeat('api:run-signal-engine');
  } catch (err) {
    console.warn(
      '[RunSignalEngine] markPipelineHeartbeat failed (non-fatal):',
      (err as Error)?.message,
    );
  }

  console.log(
    `[PIPELINE END] status=success batch=${batchId} elapsed_ms=${totalElapsedMs} ` +
    `scanned=${result.meta.scanned} approved=${approved} rejected=${result.meta.rejected + deferred} ` +
    `signals=${result.signals.length}`,
  );
  console.log(`🔥 PIPELINE END (success, ${result.signals.length} signals, ${totalElapsedMs}ms)`);

  // Spec "FINAL SCAN SUMMARY" — single greppable line mirroring the
  // user-facing debug_scan shape. Coverage % is computed against the
  // FULL universe (not the post-prefilter eligible subset) so an
  // operator can answer "are we scanning all 500?" at a glance.
  const scanCoveragePct = fullUniverse.length > 0
    ? Math.round((result.meta.scanned / fullUniverse.length) * 1000) / 10
    : 0;

  // Spec "DEBUG LOGS" — per-source counters from the candle fallback
  // chain. nse_count / api_count / failed_count are the dominant
  // telemetry the operator wants to see ("did NSE actually serve the
  // majority?"). The 4 required lines are emitted immediately so they
  // land together at the end of every run.
  const sources       = getCandleSourceCounters();
  const nseCount      = sources.nse_used;
  const apiCount      = sources.api_used;
  const failedCount   = sources.failed;
  console.log('📊 TOTAL STOCKS:', fullUniverse.length);
  console.log('📡 NSE SUCCESS:', nseCount);
  console.log('⚡ API USED:', apiCount);
  console.log('❌ FAILED:', failedCount);

  console.log('[SCAN SUMMARY]', {
    universe:        fullUniverse.length,
    eligible:        runUniverseSource.length,
    selected:        runUniverse.length,
    rotation_offset: chunk.startIndex,
    run_count:       chunk.runCount,
    scanned:         result.meta.scanned,
    approved,
    deferred,
    rejected:        result.meta.rejected,
    saved:           result.signals.length,
    coverage_percent: scanCoveragePct,
    nse_used:        nseCount,
    api_used:        apiCount,
    db_used:         sources.db_used,
    failed:          failedCount,
    elapsed_ms:      totalElapsedMs,
  });

  // Spec "SMART ROTATION" — advance the persistent run counter AFTER a
  // successful scan so the next run picks the next chunk. Placed
  // post-saveSignals so a crash mid-pipeline doesn't burn a slot.
  const nextRunCount = incrementRunCount();

  // Spec "API RESPONSE DEBUG" — rotation envelope. `api_calls_used` is
  // the *budget delta* charged to the per-run window (every successful
  // upstream round-trip increments it), not the chunk size — the chunk
  // is the upper bound, but the prefilter / cache-fresh skips can drop
  // it below. `remaining_from_cache` covers the symbols this run did
  // NOT touch via IndianAPI; they're served by the existing fallback
  // chain (DB → Yahoo → NSE direct → cached snapshots).
  const usageAfterRun  = getApiUsage();
  const apiCallsUsed   = Math.max(
    0,
    usageAfterRun.daily - usageBeforeRun.daily,
  );
  return {
    success: true,
    batch_id: batchId,
    total_scanned: result.meta.scanned,
    total_approved: approved,
    total_rejected: result.meta.rejected + deferred,
    universe_size:        fullUniverse.length,
    scanned_this_run:     runUniverse.length,
    api_calls_used:       apiCallsUsed,
    remaining_from_cache: Math.max(0, fullUniverse.length - runUniverse.length),
    rotation: {
      chunk_size:    throttle.cap,
      base_chunk:    RUN_UNIVERSE_CAP,
      start_index:   chunk.startIndex,
      run_count:     chunk.runCount,
      next_run_count: nextRunCount,
      wrapped:       chunk.wrapped,
      throttle_band: throttle.band,
    },
    signals: result.signals.map((s) => ({
      symbol: s.symbol,
      direction: s.executionReadiness.approvalDecision === 'approved' ? 'BUY' : 'WATCH',
      confidence_score: s.adjustedConfidenceScore,
      opportunity_score: s.adjustedConfidenceScore,
      entry_price: s.tradePlan.entryZoneHigh,
      risk_reward: s.tradePlan.rrTarget1,
      scenario_tag: s.signalType,
      conviction_band: s.confidenceBand,
    })),
    duration_ms: totalElapsedMs,
    timings: {
      candle_refresh_ms: candleElapsedMs,
      phase4_ms:         phase4ElapsedMs,
      total_ms:          totalElapsedMs,
      skip_candle_refresh: !!opts.skipCandleRefresh,
    },
    engine: {
      path: 'signal-engine:phase4',
      generation_source: 'api:run-signal-engine:adapter',
    },
    // Spec §6 / §9 — debug envelope. Reads live provider counters
    // populated by the resolver during this run's enrichment passes.
    // `provider_used` reflects what actually served the most recent
    // resolve (or 'db' when the scan ran entirely off the candle
    // table without any live fetch). `fallback_used` is true iff a
    // non-primary provider produced data anywhere in the run.
    debug: (() => {
      const pr = getProviderReport();
      return {
        provider_used:  pr.last_provider ?? 'db',
        fallback_used:  pr.fallback_triggered,
        market_state:   getMarketStatus().isOpen ? 'open' : 'closed',
        symbols_processed: result.meta.scanned,
        scan_status:    'completed',
      };
    })(),
    // Spec "API RESPONSE DEBUG" — hybrid NSE + IndianAPI counters
    // surfaced on the response so dashboards / cron callers can see
    // the cost split for this run.
    debug_scan: {
      universe: fullUniverse.length,
      nse_used: nseCount,
      api_used: apiCount,
      failed:   failedCount,
    },
  };
}

export async function POST(req: NextRequest) {
  // Spec §1 — pipeline entry log. First line of the route handler so
  // EVERY trigger (UI button, cron, curl) lands a visible heartbeat
  // even when later steps short-circuit (auth fail, market closed).
  console.log('[ENGINE] Triggered run-signal-engine');

  let user: { id: number };
  try {
    user = await requireSession();
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Spec STEP 2 — universe init guard. The engine reads
  // DEFAULT_PHASE1_CONFIG.universe further down — if the cache (and
  // therefore TRADEABLE_UNIVERSE) hasn't been hydrated by
  // instrumentation, this awaits the shared promise lock so we run
  // against the real list, not an empty one. 503 beats a 500
  // halfway through the pipeline.
  const universeReady = await ensureUniverseReady();
  if (!universeReady.ok) {
    return NextResponse.json(
      {
        error:  'Universe not ready',
        code:   'UNIVERSE_NOT_READY',
        detail: universeReady.error,
      },
      { status: 503 },
    );
  }

  // Spec INSTITUTIONAL §C — defensive empty-universe gate. Even when
  // ensureUniverseReady reports ok=true, DEFAULT_PHASE1_CONFIG.universe
  // can still be empty if the in-place mutation in initOnce's dynamic
  // import failed silently. Block the run with a 503 + actionable
  // message rather than letting Phase 4 scan zero symbols and write
  // an empty batch.
  if (DEFAULT_PHASE1_CONFIG.universe.length === 0) {
    console.error(
      `[UNIVERSE_FINAL] count=0 — refusing to run pipeline. ` +
      `Either UNIVERSE_AUTO_SEED_FROM_CSV is disabled and q365_universe is empty, ` +
      `or the seed CSV at UNIVERSE_SEED_CSV_PATH (default ./ind_nifty500list.csv) is missing.`,
    );
    return NextResponse.json(
      {
        error:  'Universe is empty',
        code:   'UNIVERSE_EMPTY',
        detail: 'DEFAULT_PHASE1_CONFIG.universe.length=0 after init. ' +
                'Run `npx tsx scripts/loadNifty500.ts` or set UNIVERSE_AUTO_SEED_FROM_CSV=true ' +
                'and place ind_nifty500list.csv at the repo root.',
      },
      { status: 503 },
    );
  }

  // Spec INSTITUTIONAL §C — candle availability probe. Exposes the
  // `market_data_daily` row count + most-recent timestamp so the
  // operator can correlate "[SCANNED] count=0" with the actual candle
  // data state in one log line. Cheap (single COUNT(*) + MAX(ts)).
  try {
    const { rows: candleProbe } = await db.query<{ c: number; latest: Date | string | null }>(
      `SELECT COUNT(*) AS c, MAX(ts) AS latest FROM market_data_daily`,
    );
    const cTotal  = Number(candleProbe[0]?.c ?? 0);
    const cLatest = candleProbe[0]?.latest;
    const ageHrs  = cLatest != null
      ? Math.round(((Date.now() - new Date(cLatest as any).getTime()) / 3_600_000) * 10) / 10
      : null;
    console.log(
      `[CANDLE_DB_COUNT] table=market_data_daily total=${cTotal} ` +
      `latest=${cLatest ?? 'null'} age_hours=${ageHrs ?? 'n/a'}`,
    );
    if (cTotal === 0) {
      console.warn(
        `[CANDLE_DB_COUNT] WARN — market_data_daily is empty. Phase 3 will scan ` +
        `the universe but every symbol will fail "insufficient candles" until ` +
        `the candle ingestion worker (refreshDailyCandles / candleFallbackChain) ` +
        `populates the table.`,
      );
    }
  } catch (err: any) {
    console.warn(`[CANDLE_DB_COUNT] probe failed: ${err?.message}`);
  }

  // Auto-migrate (provenance columns + Phase 2/3/4 schemas) on first call.
  if (!migrated) {
    await migrateSignalEngine().catch((err) =>
      console.warn('[RunSignalEngine] Migration warning:', err.message),
    );
    await ensureSignalEngineSchemas().catch((err) =>
      console.warn('[RunSignalEngine] ensureSchemas warning:', err.message),
    );
    migrated = true;
  }

  // ── Market-closed gate ──────────────────────────────────
  // Spec rule: when NSE cash session is closed we MUST NOT call any
  // upstream provider. Returning 409 here matches the "canonical
  // conflict" verb the rest of this route uses for refusals; the
  // friendly message is the spec-required client-facing string.
  // Operator escape: `?force=true` mirrors the bootstrap override and
  // lets a manual investigation run the engine off-hours.
  // Env escape: FORCE_MARKET_OPEN=true bypasses the gate entirely so
  // scheduled jobs / smoke tests can run Phase 3/4 against the last
  // available candles when the market is closed.
  const forceRun = req.nextUrl.searchParams.get('force') === 'true';
  const overrideMarket = isMarketOverrideEnabled();
  let allowPipelineRun = forceRun;
  if (overrideMarket) {
    allowPipelineRun = true;
    console.log('[MARKET OVERRIDE] forcing pipeline run');
  }
  // Spec §2 — market state log. Always emit, regardless of force flag,
  // so operators can correlate scan outcomes with market state in logs.
  const marketStatus = getMarketStatus();
  console.log('[ENGINE] Market State:', {
    market_open:    marketStatus.isOpen,
    market_state:   marketStatus.state,
    label:          marketStatus.label,
    override:       overrideMarket,
    force_query:    forceRun,
  });
  // Spec "ALLOW MARKET CLOSED FETCH" — the prior `if (!marketStatus.isOpen) return 409`
  // block has been removed. The candle fallback chain (DB-fast →
  // IndianAPI live → NSE → DB-thin → throw) serves the last
  // available bars whether the session is open or closed, so a
  // closed-market run produces signals against last-close data
  // instead of a hard refusal. Scheduled / overnight runs work
  // without `?force=true`.
  //
  // The market state is still LOGGED so the operator can correlate
  // outcomes with session state.
  if (!allowPipelineRun && !marketStatus.isOpen) {
    console.log('[ENGINE] market closed — running anyway against last-available candles', {
      market_state: marketStatus.state,
      market_label: marketStatus.label,
      override:     overrideMarket,
      force_query:  forceRun,
    });
  }

  // ── Weekend block ────────────────────────────────────────
  // Spec "WEEKEND BLOCK" — refuse manual runs on Saturday/Sunday so
  // an idle scheduler / dashboard click cannot burn budget against
  // an unchanged daily bar. The candle table doesn't refresh between
  // Friday close and Monday open, so a weekend re-run produces
  // identical signals at full API cost.
  //
  // Override paths (in priority order):
  //   1. `?force=true`            — operator-acknowledged manual run.
  //   2. `?override_weekend=true` AND PIPELINE_WEEKEND_OVERRIDE=true.
  //   3. FORCE_MARKET_OPEN=true   — the existing market override.
  //
  // Weekday check is done in IST (the NSE trading timezone) regardless
  // of host timezone, so a server running UTC still refuses correctly
  // when it's Saturday/Sunday in Mumbai. `MarketState` from
  // getMarketStatus does not carry a 'weekend' value — it returns
  // 'closed' for both weekends and post-session weekdays — so we
  // detect weekend from the IST weekday directly.
  const weekendOverrideRequested =
    req.nextUrl.searchParams.get('override_weekend') === 'true';
  const weekendOverrideEnv =
    String(process.env.PIPELINE_WEEKEND_OVERRIDE ?? '').trim().toLowerCase() === 'true';
  const weekendOverride =
    weekendOverrideRequested && weekendOverrideEnv;
  const istWeekday = (() => {
    const istNow = new Date(Date.now() + 5.5 * 3_600_000);
    return istNow.getUTCDay();  // 0 = Sun, 6 = Sat
  })();
  const isWeekendNow = istWeekday === 0 || istWeekday === 6;
  if (
    isWeekendNow
    && !forceRun
    && !overrideMarket
    && !weekendOverride
  ) {
    console.warn(
      `[PIPELINE BLOCKED] reason=weekend market_state=${marketStatus.state} ` +
      `label="${marketStatus.label}" override_supported=PIPELINE_WEEKEND_OVERRIDE`,
    );
    return NextResponse.json(
      {
        error:    'Weekend — pipeline runs are disabled',
        code:     'WEEKEND_BLOCKED',
        message:
          'NSE is closed on Saturday and Sunday. The daily bar does not ' +
          'change between Friday close and Monday open, so a weekend re-run ' +
          'burns API budget without producing new signals. ' +
          'Use ?force=true for an operator-acknowledged ad-hoc run, or set ' +
          'PIPELINE_WEEKEND_OVERRIDE=true plus ?override_weekend=true for a ' +
          'controlled bypass.',
        market_state: marketStatus.state,
        market_label: marketStatus.label,
        override_supported: weekendOverrideEnv,
        debug: {
          provider_used:  null,
          fallback_used:  false,
          scan_status:    'blocked_weekend',
        },
      },
      { status: 409 },
    );
  }
  if (isWeekendNow && (forceRun || weekendOverride || overrideMarket)) {
    console.warn(
      `[PIPELINE WEEKEND OVERRIDE] proceeding under explicit override — ` +
      `force=${forceRun} weekend_override=${weekendOverride} market_override=${overrideMarket}`,
    );
  }

  // Spec DISTRIBUTED-LOCK-2026-05 — authoritarian execution lock. 
  // Local inFlight guards work per-process (Next.js), but multiple 
  // PM2 replicas can still race. The distributed lock via MySQL 
  // ensures exactly one executor owns the pipe.
  const batchId = `batch_${Date.now()}`;
  const lockAcquired = await tryAcquireExecutionLock(batchId).catch(() => false);
  
  if (!lockAcquired && !forceRun) {
    const lockRow = await getLockRow('system', '2000-01-01');
    const startedAt = lockRow?.started_at ? new Date(lockRow.started_at).getTime() : Date.now();
    const elapsedMs = Date.now() - startedAt;
    
    console.warn(`[ENGINE_LOCK_SKIPPED] reason=distributed_lock_held batch=${batchId} elapsed_ms=${elapsedMs}`);
    
    return NextResponse.json(
      {
        error: 'Pipeline execution locked by another instance',
        code: 'EXECUTION_LOCKED',
        batch_id: lockRow?.request_source ?? 'unknown',
        started_at: lockRow?.started_at ?? null,
        elapsed_ms: elapsedMs,
        hint: 'Wait for the current run to finish or pass ?force=true to reset.'
      },
      { status: 409 }
    );
  }

  if (forceRun && !lockAcquired) {
    console.warn(`[ENGINE_LOCK_FORCE] force=true — resetting distributed lock`);
    await releaseExecutionLock().catch(() => {});
    const secondTry = await tryAcquireExecutionLock(batchId).catch(() => false);
    if (!secondTry) {
       return NextResponse.json({ error: 'Failed to acquire lock even after force reset' }, { status: 500 });
    }
  }

  const start = Date.now();
  // ── API-usage budget gate ──────────────────────────────────────
  // Spec "OPTIMIZE API USAGE" §5 — refuse a manual run when today's
  // IndianAPI budget is already used up. Each pipeline run dispatches
  // ~503 candle + ~503 quote calls = ~1000-1500 IndianAPI hits; firing
  // one at the budget ceiling either fails immediately at the adapter
  // (every call throws API_BUDGET_EXCEEDED) or, on a paid plan with
  // headroom, silently runs and exhausts tomorrow's budget too. The
  // 409 response carries the live counters so the operator sees the
  // exact ceiling that was hit.
  const usage = getApiUsage();
  if (usage.daily_exceeded || usage.monthly_exceeded) {
    const which = usage.daily_exceeded ? 'daily' : 'monthly';
    console.warn(
      `[PIPELINE BLOCKED] api_budget_exhausted bucket=${which} ` +
      `daily=${usage.daily}/${usage.daily_limit} ` +
      `monthly=${usage.monthly}/${usage.monthly_limit}`,
    );
    return NextResponse.json(
      {
        error:        'API budget exhausted — refusing to run',
        code:         'API_BUDGET_EXCEEDED',
        bucket:       which,
        api_usage:    usage,
        message:      which === 'daily'
          ? `IndianAPI daily budget exhausted (${usage.daily}/${usage.daily_limit}). New scans resume after midnight IST.`
          : `IndianAPI monthly budget exhausted (${usage.monthly}/${usage.monthly_limit}). New scans resume next month or set INDIANAPI_MONTHLY_LIMIT on a paid plan.`,
        debug: {
          provider_used:  null,
          fallback_used:  false,
          scan_status:    'blocked_api_budget',
        },
      },
      { status: 429 },
    );
  }

  // ── Manual-run lock (one frontend run per IST calendar day) ────
  // Scheduled / system runs use a separate run_type and are
  // unaffected. The unique key (run_type, run_date) makes the claim
  // race-safe across processes. Failed runs DO NOT consume today's
  // allowance — the lock repo replaces a 'failed' row on the next
  // claim. Existing 'started' or 'completed' rows block with HTTP
  // 409 Conflict (a state conflict, not rate limiting).
  //
  // Admin override: when PIPELINE_MANUAL_OVERRIDE=true, the request
  // may pass `?override=true` and a non-empty `override_reason` to
  // bypass the block. The reason is persisted in the lock row's
  // `override_reason` column for audit.
  const overrideRequested =
    req.nextUrl.searchParams.get('override') === 'true';
  const overrideReason =
    (req.nextUrl.searchParams.get('override_reason') ?? '').trim() || null;
  // Dev-mode auto-override: in NODE_ENV=development the daily lock
  // exists only as a budget guard. Operators iterating on the
  // pipeline need to be able to click "Run Pipeline" repeatedly
  // without crafting query params each time. PIPELINE_MANUAL_OVERRIDE
  // still gates production explicitly.
  const devAutoOverride =
    process.env.NODE_ENV === 'development' && isManualOverrideEnabled();
  const override =
    devAutoOverride
    || (overrideRequested && isManualOverrideEnabled());
  const effectiveReason =
    overrideReason ?? (devAutoOverride ? 'dev-mode auto override' : null);
  // Step 10 of the budget-fix PR: hard-fail on lock unavailable.
  // The previous .catch(...) swallowed DB errors and let an unbounded
  // run proceed when the lock table was unreachable — exactly the
  // scenario where the lock is most needed.
  // LOCK-STALE-FIX (2026-05) — before attempting a claim, sweep any
  // status='started' row that has been stuck past the watchdog
  // threshold (default 30 min, env PIPELINE_LOCK_STALE_MINUTES). The
  // sweeper flips such rows to 'failed' so tryClaimManualRun's normal
  // "failed → fresh claim" branch can reclaim the daily allowance
  // instead of returning 409 until next IST midnight.
  try { await recoverStaleManualRun(); } catch (err: any) {
    console.warn('[ENGINE_LOCK_STALE_SWEEP_FAILED]', err?.message ?? String(err));
  }
  try { await recoverStaleExecutionLock(); } catch (err: any) {
    console.warn('[EXECUTION_LOCK_STALE_SWEEP_FAILED]', err?.message ?? String(err));
  }
  let claim: Awaited<ReturnType<typeof tryClaimManualRun>>;
  try {
    claim = await tryClaimManualRun({
      requestedBy:    String((user as any)?.email ?? user?.id ?? ''),
      requestSource:  'frontend',
      override,
      overrideReason: override ? effectiveReason : null,
    });
  } catch (err: any) {
    return NextResponse.json(
      {
        error:  'run lock unavailable; refusing to run unbounded',
        detail: err?.message ?? String(err),
      },
      { status: 503 },
    );
  }
  if (!claim.claimed) {
    // ENGINE-LOCK-AUDIT (2026-05) — canonical [ENGINE_LOCK_SKIPPED]
    // log for the cooldown / day-already-used skip. Pairs with
    // [ENGINE_LOCK_ACQUIRED] / [ENGINE_LOCK_RELEASED] so an operator
    // can grep one batch's full lock lifecycle.
    console.warn(
      `[ENGINE_LOCK_SKIPPED] reason=manual_run_used run_date=${claim.row.run_date} ` +
      `last_run_at=${claim.lastRunAt ?? 'null'} next_allowed_at=${claim.nextAllowedAt} ` +
      `requested_by=${String((user as any)?.email ?? user?.id ?? '')}`,
    );
    // Spec §3 — BLOCKED log for the daily-cooldown case.
    console.log('[ENGINE] BLOCKED — reason:', {
      market_closed:   false,
      already_running: false,
      cooldown:        true,
      next_allowed_at: claim.nextAllowedAt,
    });
    return NextResponse.json(
      {
        blocked:         true,
        code:            'MANUAL_RUN_USED',
        last_run_at:     claim.lastRunAt,
        next_allowed_at: claim.nextAllowedAt,
        message:         claim.message,
        override_supported: isManualOverrideEnabled(),
        debug: {
          provider_used:  null,
          fallback_used:  false,
          scan_status:    'blocked_cooldown',
        },
      },
      { status: 409 },
    );
  }

  // start and batchId already defined above in the lock acquisition block

  // ── Async vs sync mode ──────────────────────────────────
  // Pipeline is multi-minute (Yahoo refresh of 2,767 symbols + Phase-4
  // analysis). Behind nginx with a 60s read timeout, sync mode always
  // 504s — even though the scan itself completes in the background.
  //
  // Default = async: return 202 immediately, run in background, frontend
  // polls /api/signals to see new rows appear. Pass ?sync=true to force
  // the legacy synchronous behaviour (cron jobs / admin tools that read
  // the response body).
  const wantsSync = req.nextUrl.searchParams.get('sync') === 'true';
  // Spec — let operators skip the slow IndianAPI candle fan-out and
  // run Phase 4 against existing market_data_daily bars. Drops sync
  // total_ms from ~2-5min to ~10-30s when DB candles are recent
  // (e.g. the in-proc 10-min regen tick just ran). Use this for fast
  // iteration during testing; default behaviour (full refresh) is
  // unchanged.
  const skipCandleRefresh =
    req.nextUrl.searchParams.get('skipCandleRefresh') === 'true';
  const innerOpts = { skipCandleRefresh };

  // Spec "FIX PIPELINE CONCURRENCY" §2 — claim BOTH the route-scope
  // metadata AND the global scannerState flag synchronously, before
  // any await. The release is mirrored in the finally blocks below
  // (sync) and the .finally chain (async) so the lock is ALWAYS
  // cleared, even on uncaught throws inside runScanInner. Without
  // both, a manual run could leak a stuck flag that wedges every
  // subsequent /api/signals auto-recovery into 'skipped_inflight'.
  // ENGINE-LOCK-AUDIT (2026-05) — heartbeat keeps the lock row's
  // started_at fresh while a long-running scan executes, so the
  // stale-watchdog (PIPELINE_LOCK_STALE_MINUTES) never trips on a
  // genuinely-alive run. Fires every PIPELINE_LOCK_HEARTBEAT_MS (default
  // 60s); cleared on releaseLock. Best-effort: a missed heartbeat just
  // means the row ages, which a healthy run never reaches.
  let heartbeatTimer: NodeJS.Timeout | null = null;
  const HEARTBEAT_MS = (() => {
    const raw = Number(process.env.PIPELINE_LOCK_HEARTBEAT_MS);
    if (Number.isFinite(raw) && raw >= 5_000) return Math.floor(raw);
    return 60_000;
  })();

  const claimLock = async () => {
    // Spec "FIX PIPELINE CONCURRENCY" §2 — acquire the distributed execution
    // lock first. This is the global guard across all instances.
    const acquired = await tryAcquireExecutionLock(batchId);
    if (!acquired) {
      throw new Error('EXECUTION_LOCK_HELD');
    }

    inFlight = { batchId, startedAt: new Date(start).toISOString() };
    setScannerInFlight(true);
    // Spec "Per-run API call limit" — open a fresh per-run window
    // BEFORE any IndianAPI call lands so the counter starts at 0.
    // Paired with endPerRunBudget() in releaseLock; the lock pair
    // is the single source of truth for "a pipeline run is active".
    beginPerRunBudget();
    console.log(`[API RUN] start limit=${INDIANAPI_PER_RUN_LIMIT} batch=${batchId}`);
    console.log(
      `[ENGINE_LOCK_ACQUIRED] batch=${batchId} ` +
      `started_at=${new Date(start).toISOString()} ` +
      `heartbeat_ms=${HEARTBEAT_MS} ` +
      `stale_min=${process.env.PIPELINE_LOCK_STALE_MINUTES ?? '30'}`,
    );
    if (heartbeatTimer == null) {
      heartbeatTimer = setInterval(() => {
        heartbeatManualRun().catch((err) =>
          console.warn(`[ENGINE_LOCK_HEARTBEAT_FAILED] batch=${batchId} err=${err?.message ?? String(err)}`),
        );
        heartbeatExecutionLock().catch(() => {});
      }, HEARTBEAT_MS);
      // Allow the process to exit even if the timer is still scheduled.
      heartbeatTimer.unref?.();
    }
  };
  const releaseLock = async () => {
    inFlight = null;
    setScannerInFlight(false);
    if (heartbeatTimer != null) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    
    await releaseExecutionLock().catch((err) => console.warn(`[ENGINE_LOCK_RELEASE_FAILED] ${err?.message}`));
    
    // Phase 1 calls clearProgress() on its own clean exit; this is
    // belt-and-suspenders for the error path where the loop didn't
    // reach `clearProgress` (early throw inside fetchDailyCandles).
    try { clearScannerProgress(); } catch { /* swallow */ }
    try {
      const s = endPerRunBudget();
      console.log(
        `[API RUN] end count=${s.count}/${s.limit} hit=${s.hit} ` +
        `duration_ms=${s.durationMs} batch=${batchId}`,
      );
      console.log(
        `[ENGINE_LOCK_RELEASED] batch=${batchId} ` +
        `duration_ms=${s.durationMs} api_calls=${s.count}/${s.limit} budget_hit=${s.hit}`,
      );
    } catch { /* swallow — must never block lock release */ }
  };

  if (!wantsSync) {
    // Spec "GUARANTEE FINALLY EXECUTION" — if claimLock itself throws
    // halfway (e.g. setScannerInFlight or beginPerRunBudget mutates
    // global state and then errors), releaseLock still runs so the
    // flag never wedges. Without this, a partial-claim throw would
    // bubble out of the route AFTER setScannerInFlight(true) had run,
    // leaking a permanent inFlight=true.
    try {
      await claimLock();
    } catch (err: any) {
      const msg = err?.message ?? String(err);
      if (msg === 'EXECUTION_LOCK_HELD') {
        console.warn(`[ENGINE_LOCK_SKIPPED] reason=execution_lock_held batch=${batchId}`);
        return NextResponse.json(
          buildRunningEnvelope({ batchId: null, startedAtMs: null }),
          { status: 409 },
        );
      }
      console.error(`[PIPELINE FAILED TO START] mode=async batch=${batchId} reason="${msg}"`);
      console.error('[PIPELINE ERROR]', err);
      try { await releaseLock(); } catch { /* swallow */ }
      return NextResponse.json(
        { error: 'Pipeline failed to start', details: msg },
        { status: 500 },
      );
    }
    // Spec "FAIL FAST IF NO EXECUTION" — explicit "we got past the
    // lock, about to invoke" trace tag. If [API RUN] start fires but
    // [PIPELINE INVOKE] does not, claimLock acquired the lock and
    // something between here and runScanInner threw silently.
    console.log(`[PIPELINE INVOKE] mode=async batch=${batchId}`);
    runScanInner(user, batchId, start, innerOpts)
      .then((r) => {
        console.log(
          `[RunSignalEngine] ASYNC done batch=${batchId} ` +
          `scanned=${r.total_scanned} approved=${r.total_approved} ` +
          `rejected=${r.total_rejected} duration=${r.duration_ms}ms`,
        );
        return completeManualRun().catch((err) =>
          console.warn('[RunSignalEngine] completeManualRun failed:', err?.message),
        );
      })
      .catch(async (err) => {
        const msg = err?.message ?? String(err);
        console.error('[PIPELINE ERROR]', err);
        console.error(`[RunSignalEngine] ASYNC failed batch=${batchId}:`, msg);
        console.warn(
          `[PIPELINE END] status=failed batch=${batchId} ` +
          `elapsed_ms=${Date.now() - start} reason="${msg}"`,
        );
        await failManualRun(msg).catch(() => { /* swallow */ });
      })
      .finally(releaseLock);

    return NextResponse.json(
      {
        status:    'started',
        mode:      'async',
        batch_id:  batchId,
        startedAt: new Date(start).toISOString(),
        // Spec "FIX PIPELINE CONCURRENCY" §8 — frontend-friendly
        // running envelope on the 202 reply too, so a poll right
        // after the start sees the same shape it gets back from a
        // 409 or GET ?status=true.
        running:   true,
        progress:  null,
        percent_complete: 0,
        eta_seconds: null,
        hint:      'Poll /api/run-signal-engine?status=true for live progress, or /api/signals after the run completes.',
        debug: {
          provider_used:  'db',
          fallback_used:  false,
          scan_status:    'started',
        },
      },
      { status: 202 },
    );
  }

  // ── Sync mode ────────────────────────────────────────────
  // Used by cron jobs / admin tools that read the legacy response.
  // Be ready for a 1–5 min response. Behind nginx, the upstream read
  // timeout (default 60s) will 504 you — use async mode for the UI.
  //
  // Spec "GUARANTEE FINALLY EXECUTION" — claimLock lives INSIDE the
  // try so any throw inside it (setScannerInFlight, beginPerRunBudget)
  // still routes through `finally → releaseLock` instead of leaking a
  // half-claimed flag.
  try {
    await claimLock();
    // Spec "FAIL FAST IF NO EXECUTION" — explicit "we got past the
    // lock, about to invoke" trace tag. Pairs with [PIPELINE START]
    // emitted at the top of runScanInner; missing the latter while
    // this one fires means runScanInner threw before its first log.
    console.log(`[PIPELINE INVOKE] mode=sync batch=${batchId}`);
    const r = await runScanInner(user, batchId, start, innerOpts);
    await completeManualRun().catch((err) =>
      console.warn('[RunSignalEngine] completeManualRun failed:', err?.message),
    );
    return NextResponse.json(r);
  } catch (err: any) {
    const msg = err?.message ?? String(err);
    console.error('[PIPELINE ERROR]', err);
    console.error('[RunSignalEngine/adapter]', err);
    console.warn(
      `[PIPELINE END] status=failed batch=${batchId} ` +
      `elapsed_ms=${Date.now() - start} reason="${msg}"`,
    );
    await failManualRun(msg).catch(() => { /* swallow */ });
    return NextResponse.json(
      {
        error: 'Pipeline failed',
        details: msg,
        debug: {
          provider_used:  'db',
          fallback_used:  false,
          scan_status:    'failed',
        },
      },
      { status: 500 },
    );
  } finally {
    releaseLock();
  }
}

/**
 * GET handler. Two modes:
 *   - `?status=true` → return the manual-run lock state plus live
 *     progress so the frontend "Run Pipeline" button can render
 *     enabled/disabled AND a progress bar from a single endpoint.
 *   - otherwise → trigger a run (legacy URL-paste convenience).
 *     Same session + lock guards as POST.
 *
 * Spec "FIX PIPELINE CONCURRENCY" §3+§8 — `?status=true` now ships
 * a frontend-friendly running envelope: { running, batch_id,
 * percent_complete, eta_seconds, progress: { scanned, total, ... } }.
 * When no run is active, `running=false` and `progress=null`.
 */
export async function GET(req: NextRequest): Promise<Response> {
  if (req.nextUrl.searchParams.get('status') === 'true') {
    try {
      await requireSession();
    } catch {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const lock = await getManualRunStatus().catch(() => null);
    const lockEnvelope = lock ?? {
      used: false, inProgress: false, row: null, lastRunAt: null, nextAllowedAt: null,
    };
    const globalRunning = isScannerInFlight();
    const startedAtMs   = inFlight ? (Date.parse(inFlight.startedAt) || Date.now()) : null;
    if (inFlight || globalRunning) {
      const env = buildRunningEnvelope({
        batchId:     inFlight?.batchId ?? null,
        startedAtMs,
      });
      return NextResponse.json(
        {
          ...lockEnvelope,
          ...env,
          source:    inFlight ? 'manual' : 'auto-recovery',
          api_usage: getApiUsage(),
        },
        { status: 200 },
      );
    }
    return NextResponse.json(
      {
        ...lockEnvelope,
        running:          false,
        status:           'idle' as const,
        batch_id:         null,
        started_at:       null,
        elapsed_ms:       null,
        percent_complete: 0,
        eta_seconds:      null,
        progress:         null,
        api_usage:        getApiUsage(),
      },
      { status: 200 },
    );
  }
  return POST(req);
}
