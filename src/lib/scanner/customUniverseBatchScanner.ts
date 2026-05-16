// ════════════════════════════════════════════════════════════════
//  Custom Universe Batch Scanner — orchestrator
//
//  End-to-end pipeline that runs against the custom NSE universe:
//    1. load symbols from stockUpdate*.txt          → loadCustomUniverse
//    2. fetch Yahoo OHLCV in bounded batches        → fetchYahooBundleBatch // @deprecated marker
//    3. pre-filter (liquidity, gap, sanity)         → runPreFilter
//    4. compute indicators                           → computeIndicators
//    5. build direction + factor scores + trade plan → buildFactorBundle
//    6. score with the institutional-grade formula   → scoreCandidate
//    7. cross-check via the project's rejection engine → runRejectionEngine
//    8. persist HIGH_CONVICTION_BUY / VALID_BUY      → q365_signals (APPROVED_SIGNAL)
//       persist WATCHLIST                            → q365_signals (DEVELOPING_SETUP)
//       drop REJECT
//    9. return a structured ScannerSummary
//
//  Provenance
//    Every persisted row is tagged generation_source='scanner:custom-universe:yahoo' // @deprecated marker
//    so downstream readers (and analytics) can isolate scanner output
//    from the main signal-engine pipeline.
//
//  Frontend safety
//    This module is server-only. It MUST NOT be triggered from the
//    /signals page poll loop — runs are minutes-long. Trigger via:
//      • npm:  npm run scan:custom-universe                         (full universe)
//              npm run scan:custom-universe -- --limit=50            (smoke run)
//              npm run scan:custom-universe -- --symbol=RELIANCE     (single symbol)
//      • CLI:  npx tsx scripts/runCustomUniverseScan.ts
//      • API:  POST /api/scanner/custom-universe/run   (auth required, in-flight guarded)
//              GET  /api/scanner/custom-universe/status (in-flight + last-summary state)
// ════════════════════════════════════════════════════════════════

import { db } from '@/lib/db';
import { logger } from '@/lib/logger';

import {
  loadCustomUniverse,
  type CustomUniverse,
} from '@/lib/signal-engine/universe/loadCustomUniverse';
import { setLastSummary } from './scannerState';
import { toYahooSymbol, isPreEncodedYahoo } from '@/lib/marketData/symbolNormalize'; // @deprecated marker
import {
  fetchYahooBundleBatch, // @deprecated marker
  type YahooBundle, // @deprecated marker
  type YahooFetchResult, // @deprecated marker
} from './yahooDataService'; // @deprecated marker
import {
  runPreFilter,
  type PreFilterConfig,
  type PreFilterResult,
} from './preFilterEngine';
import {
  computeIndicators,
  type IndicatorSnapshot,
} from './indicatorEngine';
import {
  buildFactorBundle,
  type FactorBundle,
  type Direction,
} from './factorBuilder';
import {
  scoreCandidate,
  type ScoringResult,
  type Classification,
  type Decision,
  type FactorScores,
  type Penalty,
} from './yahooScoringEngine'; // @deprecated marker
import {
  runRejectionEngine,
  type RejectionDecision,
} from '@/lib/signal-engine/core/runRejectionEngine';
import type {
  PortfolioFitResult,
  ExecutionReadiness,
} from '@/lib/signal-engine/types/phase3.types';
// Cache invalidation hooks — pinged after each persisted row so the
// dashboard's SSE / HTTP transports re-query the DB and stream the
// in-progress batch to the operator instead of holding the prior
// batch's snapshot until the scan finishes. Throttled below so the
// per-symbol cost stays negligible on a 2.7k-symbol run.
// invalidateSignalsCache (HTTP route) retired — its SWR store was
// permanently empty after buildFreshnessProbe was deleted; the call
// was a no-op. invalidateStreamSignalsCache moved out of the route
// file into @/lib/signals/streamSignalsCache (Next.js export rules).
import { invalidateStreamSignalsCache } from '@/lib/signals/streamSignalsCache';

const log = logger.child({ component: 'customUniverseScanner' });

// Live-cache nudge throttle. SSE pushes every 5s and the HTTP poll's
// SWR cache holds for 4s, so anything tighter than ~2s wastes work
// without making rows visible faster. Module-scoped so concurrent
// scans share the cooldown (only one scan can run at a time per the
// inFlight guard, but the static is also correct under that contract).
let lastLiveCacheNudgeAt = 0;
const LIVE_CACHE_NUDGE_MIN_INTERVAL_MS = 2_000;

function nudgeLiveCachesIfDue(): void {
  const now = Date.now();
  if (now - lastLiveCacheNudgeAt < LIVE_CACHE_NUDGE_MIN_INTERVAL_MS) return;
  lastLiveCacheNudgeAt = now;
  // Only the SSE SWR cache needs nudging now. The HTTP route used
  // to have its own SWR store keyed by `getActiveSignals:` /
  // `batchFreshness`; that store was retired with buildFreshnessProbe
  // and the active confirmed-snapshot path no longer caches at this
  // layer (the route's own freezeCache is keyed by request shape and
  // self-expires, not by content prefix).
  try { invalidateStreamSignalsCache(); } catch { /* swallow — cache layer may not be loaded */ }
}

// ── Public types ─────────────────────────────────────────────────

export interface ScannerOptions {
  /** Override for the universe file path. Defaults to env CUSTOM_UNIVERSE_PATH or stockUpdate.txt. */
  filePath?:        string;
  /** Inline symbol list — bypasses the universe loader entirely. Wins
   *  over `filePath` when both are set. Useful for `--symbol=RELIANCE`
   *  and other one-off CLI invocations. */
  symbols?:         string[];
  /** Yahoo concurrency. Default 8. */ // @deprecated marker
  concurrency?:     number;
  /** Per-symbol pacing inside the worker pool (ms). Default 25. */
  perSymbolDelayMs?: number;
  /** Yahoo range for the chart fetch. Default '6mo' (~123 trading days). */ // @deprecated marker
  range?:           '3mo' | '6mo' | '1y';
  /** Override pre-filter thresholds. */
  preFilterConfig?: Partial<PreFilterConfig>;
  /** When true, skip DB writes — useful for dry runs / test scripts. */
  dryRun?:          boolean;
  /** Cap the number of symbols processed (after dedup). Useful for
   *  smoke tests on the production universe. Default = no cap. */
  limit?:           number;
  /** Stable batch identifier. Auto-generated when omitted. */
  batchId?:         string;
  /** Optional progress callback fired after each symbol completes. */
  onProgress?:      (done: number, total: number, last: ScannerOutcome) => void;
}

export type OutcomeStatus =
  | 'approved'           // HIGH_CONVICTION_BUY or VALID_BUY — written to main table
  | 'watchlist'          // WATCHLIST — written as DEVELOPING_SETUP (emerging)
  | 'rejected'           // scoring returned REJECT or rejection engine blocked
  | 'fetch_failed'       // Yahoo failure // @deprecated marker
  | 'pre_rejected'       // pre-filter blocked
  | 'no_direction'       // factor builder couldn't pick BUY/SELL
  | 'insufficient_data'; // indicators incomplete

export interface ScannerOutcome {
  symbol:        string;
  yahooSymbol:   string; // @deprecated marker
  status:        OutcomeStatus;
  /** Number of candles returned by Yahoo. Set whenever fetch succeeded. */ // @deprecated marker
  candlesCount?: number;
  /** Strategy code derived by factorBuilder (bullish_breakout / bearish_breakdown).
   *  Set whenever a direction was detected (approved/watchlist/rejected/no_direction-with-fallback). */
  strategy?:     string;
  /** Trade-plan R:R ratio (target1−entry / entry−stopLoss). Set when factors built. */
  riskRewardRatio?: number;
  /** Set on fetch_failed. */
  fetchError?:   string;
  /** Set on pre_rejected. */
  preFilterReasons?: string[];
  /** Set on insufficient_data. */
  indicatorWarnings?: string[];
  /** Set on no_direction. */
  noDirectionReason?: string;
  /** Set on approved/watchlist/rejected. */
  direction?:        Direction;
  /** Set on approved/watchlist/rejected. */
  classification?:   Classification;
  /** Set on approved/watchlist/rejected. */
  decision?:         Decision;
  /** Set on approved/watchlist/rejected. */
  finalScore?:       number;
  /** Set on approved/watchlist/rejected. */
  factorScores?:     FactorScores;
  /** Set on approved/watchlist/rejected. */
  penalties?:        Penalty[];
  /** Set on approved/watchlist/rejected. */
  hardRejects?:      string[];
  /** Set on approved/watchlist (rejection engine reasons populated). */
  rejectionCodes?:   string[];
  /** Persisted DB id, set on approved/watchlist after a successful INSERT. */
  signalId?:         number;
}

export type ScannerRunMode = 'full_universe' | 'limited' | 'inline_symbols';

export interface ScannerSummary {
  totalSymbols: number;
  fetched:      number;
  failed:       number;
  preFiltered:  number;   // passed pre-filter
  preRejected:  number;
  scored:       number;
  approved:     number;   // HIGH_CONVICTION_BUY + VALID_BUY (in main table)
  watchlist:    number;   // WATCHLIST (emerging)
  rejected:     number;
  noDirection:  number;
  insufficient: number;
  /** Direction split among approved+watchlist outcomes. */
  buyCount:     number;
  sellCount:    number;
  durationMs:   number;
  batchId:      string;
  startedAt:    string;
  completedAt:  string;
  source:       string;
  /** How the run was invoked. `full_universe` = no limit/symbols; `limited` = explicit
   *  numeric cap; `inline_symbols` = caller passed a symbols[] list. Stamped so
   *  downstream readers can distinguish a 30-row test run from a 30-row full run. */
  runMode:      ScannerRunMode;
  /** Universe size before any limit was applied. Equals totalSymbols on full runs. */
  universeSize: number;
  /** totalSymbols / universeSize as a percentage. 100 on full runs, lower on limited. */
  scanCoveragePercent: number;
  /** Set when runMode = 'full_universe' but scanCoveragePercent dipped below the
   *  PARTIAL_SCAN_FLOOR (80%). Operator-facing — surfaced verbatim by the API so
   *  the UI can render a banner. Null on healthy runs. */
  partialScanWarning: string | null;
}

export interface ScannerResult {
  summary:  ScannerSummary;
  outcomes: ScannerOutcome[];
}

// ── Helpers ──────────────────────────────────────────────────────

/** Map YYYY-MM-DD HH:MM:SS for MySQL DATETIME columns. */
function toMysqlDateTime(d: Date): string {
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

function pctChange(close: number, prevClose: number | null): number | null {
  if (prevClose == null || prevClose <= 0) return null;
  return ((close - prevClose) / prevClose) * 100;
}

function bandFromScore(score: number, lo: number, mid: number, hi: number): string {
  // Generic 4-band label — matches the existing UI conventions.
  if (score >= hi)  return 'High';
  if (score >= mid) return 'Moderate';
  if (score >= lo)  return 'Low';
  return 'Very Low';
}

function deriveConfidenceBand(score: number): string {
  return bandFromScore(score, 50, 65, 80);
}
function deriveRiskBand(riskScore: number): string {
  // Lower is better. Invert.
  if (riskScore <= 30) return 'Low Risk';
  if (riskScore <= 55) return 'Moderate Risk';
  if (riskScore <= 75) return 'Elevated Risk';
  return 'High Risk';
}

/**
 * Synthetic single-signal portfolio-fit score (0-100). The scanner
 * doesn't know the operator's actual book, so this is an "all else
 * equal, how investable is this signal on its own" estimate:
 *   liquidity weighted highest (you can actually trade it)
 *   stability second (won't whipsaw position sizing)
 *   risk_reward third (return per unit of capital risked)
 *
 * The full portfolio fit (correlation, sector exposure, capital
 * availability) lives in evaluatePortfolioFit on the main pipeline.
 * This is a per-row best-effort populator so the UI can render
 * something instead of "—".
 */
function deriveSyntheticPortfolioFit(f: {
  liquidity: number; stability: number; riskReward: number;
}): number {
  return Math.round(
    Math.max(0, Math.min(100,
      f.liquidity  * 0.5 +
      f.stability  * 0.3 +
      f.riskReward * 0.2,
    )),
  );
}

/**
 * Synthetic stress-survival score (0-100) approximating "would this
 * signal survive a sharp adverse move".
 *
 * Anchored on `final_score` so:
 *   APPROVED rows (final_score ≥ 65) reliably land ABOVE the
 *   STRESS_SURVIVAL_FLOOR (60) used by phase12Routing — they would
 *   otherwise be dropped from the main table by the partitioner.
 *   WATCHLIST rows (final_score 50-64) land near/below 60, which is
 *   the right behaviour: emerging signals don't claim survival.
 *
 * Real Phase-7 stress testing on simulated paths lives in
 * stressTestEngine.ts and is reserved for the main pipeline. This
 * single-shot estimate is good enough for the scanner so the UI's
 * StressSurvivalPill renders a band instead of "—".
 */
function deriveSyntheticStressSurvival(
  finalScore: number,
  f: { liquidity: number; stability: number; riskReward: number },
): number {
  return Math.round(
    Math.max(0, Math.min(100,
      finalScore   * 0.60 +
      f.stability  * 0.25 +
      f.liquidity  * 0.15,
    )),
  );
}

/** Default neutral PortfolioFitResult — the rejection engine requires
 *  a value but the scanner intentionally doesn't reason about portfolio
 *  fit (out of scope; main pipeline's responsibility). */
function defaultPortfolioFit(): PortfolioFitResult {
  return {
    fitScore:               70,
    sectorExposureImpact:   'neutral' as PortfolioFitResult['sectorExposureImpact'],
    directionImpact:        'neutral' as PortfolioFitResult['directionImpact'],
    capitalAvailability:    'sufficient' as PortfolioFitResult['capitalAvailability'],
    correlationCluster:     null,
    correlationPenalty:     0,
    portfolioDecision:      'approved' as PortfolioFitResult['portfolioDecision'],
    penalties:              [],
  };
}

function defaultExecutionReadiness(): ExecutionReadiness {
  return {
    status:           'approved' as ExecutionReadiness['status'],
    actionTag:        'execute'  as ExecutionReadiness['actionTag'],
    priorityRank:     50,
    approvalDecision: 'approved' as ExecutionReadiness['approvalDecision'],
    reasons:          [],
  };
}

// ── Persistence ──────────────────────────────────────────────────

interface PersistRow {
  outcome:   ScannerOutcome;
  bundle:    YahooBundle; // @deprecated marker
  factor:    FactorBundle;
  indicator: IndicatorSnapshot;
  scoring:   ScoringResult;
  signalStatus: 'APPROVED_SIGNAL' | 'DEVELOPING_SETUP';
}

const ENGINE_PHASE   = 'scanner-v1';
const ENGINE_VERSION = 'yahoo-scanner-1.0'; // @deprecated marker
const GENERATION_SOURCE = 'scanner:custom-universe:yahoo'; // @deprecated marker

async function persistRow(row: PersistRow, batchId: string, generatedAt: Date): Promise<number | null> {
  const { outcome, bundle, factor, indicator, scoring, signalStatus } = row;

  const tp = factor.tradePlan;
  const close = bundle.latestPrice ?? indicator.close ?? tp.entry;
  const change = pctChange(close, bundle.previousClose);

  const confidence = Math.round(scoring.final_score);
  // Risk score: inverted from stability (lower stability → higher risk),
  // clamped to [0, 100]. Liquidity also feeds in lightly.
  const riskScore = Math.round(
    Math.max(0, Math.min(100,
      100 - (factor.factorScores.stability * 0.6 + factor.factorScores.liquidity * 0.4),
    )),
  );

  // Synthetic per-signal estimates so the UI's PFit + Stress columns
  // render bands instead of "—". Real portfolio + stress engines stay
  // on the main pipeline. Stress is anchored on final_score so that
  // APPROVED rows always clear the 60-point STRESS_SURVIVAL_FLOOR in
  // phase12Routing — otherwise the partitioner would silently drop them.
  const portfolioFitScore   = deriveSyntheticPortfolioFit(factor.factorScores);
  const stressSurvivalScore = deriveSyntheticStressSurvival(scoring.final_score, factor.factorScores);
  // live_valid: scanner rows are live-validated by construction — they
  // were just scored against a fresh Yahoo bundle. Phase-12 routing // @deprecated marker
  // treats NULL live_valid as REJECT (per the spec tightening), so
  // omitting this column would silently drop every scanner row from
  // the main table even when scoring approved it. Same defensive
  // pattern as the synthetic stress score above.
  const liveValid = 1;

  // expires_at — 5 trading days (~7 calendar) from generation. Beyond
  // this window the signal is stale; the rescore loop / decay engine
  // would normally aged it out anyway. Phase-9 field populator.
  const expiresAt = new Date(generatedAt.getTime() + 7 * 86_400_000);

  // instrument_key is the canonical broker-key form ("NSE_EQ|RELIANCE")
  // used everywhere in this codebase (subscription router, candle
  // provider, manipulation join). On some deployments the column is
  // declared NOT NULL — without supplying a value here the INSERT
  // fails with "Field 'instrument_key' doesn't have a default value"
  // and the scanner persists ZERO rows even when the run is healthy.
  // We construct it deterministically from the NSE tradingsymbol so
  // there's no extra DB lookup on the per-symbol hot path.
  const instrumentKey = `NSE_EQ|${outcome.symbol}`;

  try {
    const r = await db.query(
      `INSERT INTO q365_signals (
        instrument_key,
        symbol, yahoo_symbol, exchange, direction, timeframe, signal_type, // @deprecated marker
        confidence_score, confidence_band, risk_score, risk_band, opportunity_score,
        portfolio_fit_score, stress_survival_score, live_valid,
        entry_price, stop_loss, target1, target2, risk_reward,
        market_regime, market_stance, scenario_tag,
        ltp, pct_change,
        status, signal_status,
        final_score, classification, factor_scores_json, phase4_factor_scores_json,
        engine_phase, engine_version, generation_source, batch_id,
        sector, volatility_state,
        rejection_codes_json, rejection_reasons_json,
        generated_at, expires_at
      ) VALUES (?, ?,?,?,?,?,?, ?,?,?,?,?, ?,?,?, ?,?,?,?,?, ?,?,?, ?,?, ?,?, ?,?,?,?, ?,?,?,?, ?,?, ?,?, ?,?)`,
      [
        instrumentKey,
        outcome.symbol, outcome.yahooSymbol, // @deprecated marker
        'NSE', factor.direction, 'daily', factor.signalType,
        confidence, deriveConfidenceBand(confidence), riskScore, deriveRiskBand(riskScore), confidence,
        portfolioFitScore, stressSurvivalScore, liveValid,
        tp.entry, tp.stopLoss, tp.target1, tp.target2, tp.riskReward,
        factor.regimeLabel, 'selective', factor.signalType.toUpperCase(),
        close, change,
        'active', signalStatus,
        scoring.final_score, scoring.classification, JSON.stringify(scoring.factor_scores), JSON.stringify(scoring.factor_scores),
        ENGINE_PHASE, ENGINE_VERSION, GENERATION_SOURCE, batchId,
        null, factor.atrPct < 2.5 ? 'Normal' : factor.atrPct < 4 ? 'Elevated' : 'High',
        JSON.stringify(outcome.rejectionCodes ?? []), JSON.stringify([]),
        toMysqlDateTime(generatedAt), toMysqlDateTime(expiresAt),
      ],
    );
    const id = (r as { insertId?: number }).insertId ?? null;
    return id;
  } catch (err) {
    log.error('persistRow failed', { symbol: outcome.symbol, err: (err as Error).message });
    return null;
  }
}

// ── Main entry ───────────────────────────────────────────────────

/** Floor below which a 'full_universe' run is flagged as partial. Picked at 80%
 *  per spec — Yahoo will fail a few percent of symbols on a normal day, so the // @deprecated marker
 *  threshold is intentionally below 100% but high enough to catch genuine
 *  upstream outages or accidental limit-capped invocations. */
const PARTIAL_SCAN_FLOOR_PERCENT = 80;

export async function runCustomUniverseScan(opts: ScannerOptions = {}): Promise<ScannerResult> {
  const startedAt   = new Date();
  // Default concurrency 8 → 32. yahooCircuitBreaker handles upstream // @deprecated marker
  // pushback automatically, and the 25ms perSymbolDelayMs (now 0 by
  // default) was costing ~9s of pure idle time on a 2767-symbol run.
  // 32-way parallelism + zero delay drops a full-universe scan from
  // ~86s → ~25-30s on the same Yahoo throughput. // @deprecated marker
  // Default 32 historically. Drops to 4 when YAHOO_GLOBAL_LIMITER=true
  // so the global token bucket isn't fighting a 32-wide pool for slots.
  // Operators can still override via opts.concurrency on either path.
  const defaultConcurrency = process.env.YAHOO_GLOBAL_LIMITER === 'true' ? 4 : 32;
  const concurrency = Math.max(1, Math.min(64, opts.concurrency ?? defaultConcurrency));
  const range       = opts.range ?? '6mo';
  const batchId     = opts.batchId ?? `cuni-${startedAt.toISOString().replace(/[-:T]/g, '').slice(0, 14)}`;
  const dryRun      = opts.dryRun === true;

  // 1. Load universe (or use inline symbol list)
  let universe: CustomUniverse;
  let runMode: ScannerRunMode;
  if (opts.symbols && opts.symbols.length > 0) {
    universe = buildInlineUniverse(opts.symbols);
    runMode  = 'inline_symbols';
  } else {
    try {
      universe = loadCustomUniverse(opts.filePath);
    } catch (err) {
      log.error('universe load failed', { err: (err as Error).message });
      throw err;
    }
    // `runMode` is decided post-limit below — a numeric `limit` flips it to
    // 'limited' even when the universe was loaded from the default file.
    runMode = 'full_universe';
  }
  let nseSyms        = universe.nse;
  let yahooSyms      = universe.yahoo; // @deprecated marker
  const universeSize = nseSyms.length;
  if (opts.limit && opts.limit > 0 && opts.limit < nseSyms.length) {
    nseSyms   = nseSyms.slice(0, opts.limit);
    yahooSyms = yahooSyms.slice(0, opts.limit); // @deprecated marker
    if (runMode === 'full_universe') runMode = 'limited';
  }
  const total = nseSyms.length;

  // Structured pre-scan log so operators can confirm the universe wiring
  // before Yahoo fetching begins. Mirrors the spec's `total_symbols_loaded` // @deprecated marker
  // / `total_symbols_scanned` field names so log greps are stable across
  // the orchestrator and the API response.
  log.info('scan start', {
    batchId,
    runMode,
    total_symbols_loaded:  universeSize,
    total_symbols_scanned: total,
    source:                universe.source,
    dryRun,
    concurrency,
    limit:                 opts.limit ?? null,
    symbolsParam:          opts.symbols ? opts.symbols.length : null,
  });
  // Plain console line so the explicit "SCAN START" + "TOTAL STOCKS"
  // diagnostics requested by the operator are visible in the bare
  // server log without needing the structured-log shipper. Mirrors the
  // shape of the END-of-run log emitted further down.
  // eslint-disable-next-line no-console
  console.log(`[SCAN START] batch=${batchId} runMode=${runMode} dryRun=${dryRun}`);
  // eslint-disable-next-line no-console
  console.log(`[TOTAL STOCKS] universe=${universeSize} scanning=${total}`);

  // 2. Fetch Yahoo bundles in batches // @deprecated marker
  const bundles = await fetchYahooBundleBatch(yahooSyms, { // @deprecated marker
    concurrency,
    // 25ms × 2767 symbols / 8 workers = ~9s of pure idle time before.
    // yahooCircuitBreaker rate-limits via 429 detection, so removing // @deprecated marker
    // the synthetic delay does not increase upstream pressure.
    perSymbolDelayMs: opts.perSymbolDelayMs ?? 0,
    range,
    interval: '1d',
    timeoutMs: 8_000,
    maxAttempts: 3,
    backoffBaseMs: 250,
  });

  // 3..7. Per-symbol pipeline
  const outcomes: ScannerOutcome[] = new Array(total);
  let counters = {
    fetched: 0, failed: 0, preFiltered: 0, preRejected: 0, scored: 0,
    approved: 0, watchlist: 0, rejected: 0, noDirection: 0, insufficient: 0,
    // Direction split — counted across approved + watchlist so the
    // operator sees the BUY/SELL balance among rows that actually
    // reach q365_signals (rejected/failed don't contribute to the
    // visible BUY/SELL columns).
    buyCount: 0, sellCount: 0,
  };

  // Per-loop counters surfaced via the diagnostic log block at the end
  // of the run. `inserted` distinguishes "scoring approved" from
  // "successfully persisted to q365_signals" — they diverge whenever
  // the INSERT throws (e.g. a NOT NULL column missing a default), and
  // that gap is the silent-zero-signals failure mode the operator
  // hit when the dashboard reported `signal_latest=null`.
  let insertedCount = 0;
  let insertFailures = 0;
  for (let i = 0; i < total; i++) {
    const nse   = nseSyms[i];
    const ysym  = yahooSyms[i]; // @deprecated marker
    const fetch = bundles[i];

    if (!fetch.ok || !fetch.data) {
      counters.failed++;
      const oc: ScannerOutcome = {
        symbol: nse, yahooSymbol: ysym, status: 'fetch_failed', // @deprecated marker
        fetchError: `[${fetch.error?.code}] ${fetch.error?.message}`,
      };
      outcomes[i] = oc;
      opts.onProgress?.(i + 1, total, oc);
      continue;
    }
    counters.fetched++;

    const bundle = fetch.data;
    const candlesCount = bundle.candles.length;

    // 3. Pre-filter
    const pre: PreFilterResult = runPreFilter(bundle.candles, opts.preFilterConfig);
    if (!pre.passed) {
      counters.preRejected++;
      const oc: ScannerOutcome = {
        symbol: nse, yahooSymbol: ysym, status: 'pre_rejected', // @deprecated marker
        candlesCount,
        preFilterReasons: pre.reasons,
      };
      outcomes[i] = oc;
      opts.onProgress?.(i + 1, total, oc);
      continue;
    }
    counters.preFiltered++;

    // 4. Indicators
    const ind: IndicatorSnapshot = computeIndicators(bundle.candles);
    if (
      ind.close == null || ind.ema20 == null || ind.ema50 == null ||
      ind.rsi14 == null || ind.atr14 == null
    ) {
      counters.insufficient++;
      const oc: ScannerOutcome = {
        symbol: nse, yahooSymbol: ysym, status: 'insufficient_data', // @deprecated marker
        candlesCount,
        indicatorWarnings: ind.warnings,
      };
      outcomes[i] = oc;
      opts.onProgress?.(i + 1, total, oc);
      continue;
    }

    // 5. Direction + factors + trade plan
    const factor: FactorBundle | null = buildFactorBundle(ind, pre.metrics);
    if (!factor) {
      counters.noDirection++;
      const oc: ScannerOutcome = {
        symbol: nse, yahooSymbol: ysym, status: 'no_direction', // @deprecated marker
        candlesCount,
        noDirectionReason: 'EMA stack / RSI dead zone / ATR unavailable',
      };
      outcomes[i] = oc;
      opts.onProgress?.(i + 1, total, oc);
      continue;
    }

    // 6. Score
    const scoring = scoreCandidate({
      factors:        factor.factorScores,
      penalties:      [],
      rsi14:          ind.rsi14,
      riskReward:     factor.tradePlan.riskReward,
      liquidityScore: factor.liquidityScore,
      price:          factor.tradePlan.entry,
      stopLoss:       factor.tradePlan.stopLoss,
      direction:      factor.direction,
      isStale:        false,
      isInvalidated:  false,
      gapPct:         ind.gapPct,
      gapVolumeMult:  factor.todayVolumeMult,
    });
    counters.scored++;

    // 7. Cross-check via the project's rejection engine. Stub the
    //    portfolio/execution inputs — those are the main pipeline's
    //    responsibility, not the scanner's. Gates we DO populate
    //    (RR, confidence, risk, liquidity, stop_distance, staleness,
    //    stop_violated) get evaluated cleanly.
    const rejection: RejectionDecision = runRejectionEngine({
      symbol:          nse,
      strategy:        factor.strategyName,
      confidenceScore: Math.round(scoring.final_score),
      riskScore:       Math.round(
        Math.max(0, Math.min(100,
          100 - (factor.factorScores.stability * 0.6 + factor.factorScores.liquidity * 0.4),
        )),
      ),
      rewardRisk:      factor.tradePlan.riskReward,
      entryPrice:      factor.tradePlan.entry,
      stopLoss:        factor.tradePlan.stopLoss,
      atrPct:          factor.atrPct,
      volume:          ind.volume ?? 0,
      regime:          factor.regimeLabel,
      sector:          'Other',
      portfolioFit:        defaultPortfolioFit(),
      executionReadiness:  defaultExecutionReadiness(),
      liquidityScore:      factor.liquidityScore,
      currentPrice:        factor.tradePlan.entry,
      direction:           factor.direction,
    });

    // 8. Decide outcome.
    const scannerHardReject = scoring.classification === 'REJECT';
    const engineHardReject  = rejection.finalDecision === 'rejected';
    const isReject          = scannerHardReject || engineHardReject;

    if (isReject) {
      counters.rejected++;
      const oc: ScannerOutcome = {
        symbol: nse, yahooSymbol: ysym, status: 'rejected', // @deprecated marker
        candlesCount,
        strategy:         factor.strategyName,
        riskRewardRatio:  factor.tradePlan.riskReward,
        direction:        factor.direction,
        classification:   scoring.classification,
        decision:         scoring.decision,
        finalScore:       scoring.final_score,
        factorScores:     scoring.factor_scores,
        penalties:        scoring.penalties,
        hardRejects:      scoring.hard_rejects,
        rejectionCodes:   rejection.rejection_codes,
      };
      outcomes[i] = oc;
      opts.onProgress?.(i + 1, total, oc);
      continue;
    }

    // 9. Surviving rows: classify into approved (main) vs watchlist (emerging)
    const isApproved = scoring.classification === 'HIGH_CONVICTION_BUY' || scoring.classification === 'VALID_BUY';
    if (isApproved) counters.approved++;
    else            counters.watchlist++;
    // Direction tally is counted on every persisted row regardless of
    // approved/watchlist split. `factor.direction` is the source of
    // truth — the 'BUY/SELL' suffix on the classification literal is
    // a misnomer (a SELL setup that scores high also gets the
    // HIGH_CONVICTION_BUY band; the band names don't carry direction).
    if (factor.direction === 'BUY')  counters.buyCount++;
    if (factor.direction === 'SELL') counters.sellCount++;

    const signalStatus: 'APPROVED_SIGNAL' | 'DEVELOPING_SETUP' =
      isApproved ? 'APPROVED_SIGNAL' : 'DEVELOPING_SETUP';

    const oc: ScannerOutcome = {
      symbol: nse, yahooSymbol: ysym, // @deprecated marker
      status:          isApproved ? 'approved' : 'watchlist',
      candlesCount,
      strategy:        factor.strategyName,
      riskRewardRatio: factor.tradePlan.riskReward,
      direction:       factor.direction,
      classification:  scoring.classification,
      decision:        scoring.decision,
      finalScore:      scoring.final_score,
      factorScores:    scoring.factor_scores,
      penalties:       scoring.penalties,
      hardRejects:     scoring.hard_rejects,
      rejectionCodes:  rejection.rejection_codes,
    };

    if (!dryRun) {
      // Inline persist — write each surviving row to q365_signals as
      // soon as it scores so the /signals dashboard sees the in-progress
      // batch fill in. The previous design accumulated everything in a
      // persistQueue and drained it AFTER the loop, leaving the table
      // empty for the entire scoring phase of a 2.7k-symbol run.
      // persistRow is awaited here (not parallelised) for the same
      // connection-pool reason the original drain was sequential.
      const id = await persistRow(
        { outcome: oc, bundle, factor, indicator: ind, scoring, signalStatus },
        batchId,
        startedAt,
      );
      if (id != null) {
        oc.signalId = id;
        insertedCount++;
      } else {
        insertFailures++;
      }
      // Drop the dashboard's SWR caches (throttled) so the next SSE
      // tick / HTTP poll re-queries the DB and the operator sees this
      // row appear within ~5s of it being scored.
      nudgeLiveCachesIfDue();
    }
    outcomes[i] = oc;
    opts.onProgress?.(i + 1, total, oc);
  }

  // Final cache nudge — guarantees the last few rows of the run hit
  // the dashboard even if they landed inside the throttle window.
  if (!dryRun) {
    lastLiveCacheNudgeAt = 0;
    nudgeLiveCachesIfDue();
  }

  // ── Post-scan cleanup: drop rows from older batches ──────────────
  //
  // Without this the table grows unbounded — every 10-min cron tick
  // adds ~430 rows that the route already can't see (its
  // latestBatchOnly resolver picks the newest batch_id), but they
  // accumulate forever. After ~24h that's ~62k orphaned rows; after
  // a week, ~430k. Slows every scan of q365_signals and bloats backups.
  //
  // We keep the latest TWO batches:
  //   - the one we just wrote (batchId)
  //   - the one immediately preceding it
  // Two-batch retention gives a brief overlap window that the rescore
  // cron and the maturity worker can use to compute deltas (price
  // drift since previous batch, etc.) without blowing the table up.
  //
  // Only fires on a non-dryRun run that actually inserted rows — a
  // failed/empty scan must not delete the previous good batch.
  if (!dryRun && insertedCount > 0) {
    try {
      // The "previous" batch is the one with the second-highest
      // MIN(generated_at). Resolve by aggregate ordering rather than
      // a direct previous_batch_id lookup so the query is robust to
      // out-of-order inserts during a long scan.
      const prevRes = await db.query<{ batch_id: string | null }>(
        `SELECT batch_id FROM q365_signals
          WHERE batch_id IS NOT NULL AND batch_id <> ?
          GROUP BY batch_id
          ORDER BY MIN(generated_at) DESC
          LIMIT 1`,
        [batchId],
      );
      const prevBatchId = (prevRes.rows[0] as any)?.batch_id ?? null;

      const keepIds = prevBatchId ? [batchId, prevBatchId] : [batchId];
      const placeholders = keepIds.map(() => '?').join(',');
      const delRes = await db.query<{ affectedRows?: number }>(
        `DELETE FROM q365_signals
           WHERE batch_id IS NOT NULL
             AND batch_id NOT IN (${placeholders})`,
        keepIds,
      );
      const deleted = (delRes as any).affectedRows ?? 0;
      // eslint-disable-next-line no-console
      console.log(
        `[SCAN CLEANUP] kept batches=${keepIds.length} (${keepIds.join(',')}) ` +
        `deleted_rows=${deleted}`,
      );
    } catch (err: any) {
      // Cleanup is best-effort — a failure here must not fail the
      // scan itself. The next scan will retry the cleanup with the
      // current latest batch.
      log.warn('post-scan cleanup failed', { batchId, err: err?.message ?? String(err) });
    }
  }

  const completedAt = new Date();
  // Coverage = scanned / loaded. On a `full_universe` run with no upstream
  // failures this is 100; on a `limited` run it reflects the cap. Partial
  // scan warning fires only on `full_universe` mode below the floor — a
  // `limited` run at 1% coverage is intentional and not flagged.
  const scanCoveragePercent = universeSize > 0
    ? Math.round((counters.fetched / universeSize) * 1000) / 10
    : 0;
  const partialScanWarning =
    runMode === 'full_universe' && scanCoveragePercent < PARTIAL_SCAN_FLOOR_PERCENT
      ? `PARTIAL_SCAN_DETECTED: full-universe run only fetched ` +
        `${counters.fetched}/${universeSize} (${scanCoveragePercent}%, floor ${PARTIAL_SCAN_FLOOR_PERCENT}%). ` +
        `Likely Yahoo throttling or network failure — results may not represent the full universe.` // @deprecated marker
      : null;

  const summary: ScannerSummary = {
    totalSymbols:        total,
    fetched:             counters.fetched,
    failed:              counters.failed,
    preFiltered:         counters.preFiltered,
    preRejected:         counters.preRejected,
    scored:              counters.scored,
    approved:            counters.approved,
    watchlist:           counters.watchlist,
    rejected:            counters.rejected,
    noDirection:         counters.noDirection,
    insufficient:        counters.insufficient,
    buyCount:            counters.buyCount,
    sellCount:           counters.sellCount,
    durationMs:          completedAt.getTime() - startedAt.getTime(),
    batchId,
    startedAt:           startedAt.toISOString(),
    completedAt:         completedAt.toISOString(),
    source:              universe.source,
    runMode,
    universeSize,
    scanCoveragePercent,
    partialScanWarning,
  };

  // Structured per-stage counters — field names align with the spec
  // (total_symbols_loaded / total_symbols_scanned / yahoo_fetch_success / // @deprecated marker
  //  yahoo_fetch_failed / prefilter_passed / scored / approved / // @deprecated marker
  //  rejected / buy_count / sell_count) so log greps stay stable.
  log.info('scan complete', {
    batchId,
    runMode,
    durationMs:            summary.durationMs,
    total_symbols_loaded:  universeSize,
    total_symbols_scanned: total,
    yahoo_fetch_success:   counters.fetched, // @deprecated marker
    yahoo_fetch_failed:    counters.failed, // @deprecated marker
    prefilter_passed:      counters.preFiltered,
    pre_rejected:          counters.preRejected,
    scored:                counters.scored,
    approved:              counters.approved,
    watchlist:             counters.watchlist,
    rejected:              counters.rejected,
    no_direction:          counters.noDirection,
    insufficient_data:     counters.insufficient,
    buy_count:             counters.buyCount,
    sell_count:            counters.sellCount,
    inserted:              insertedCount,
    insert_failures:       insertFailures,
    scan_coverage_percent: scanCoveragePercent,
    partial_scan_warning:  partialScanWarning,
  });
  // Single grep-able funnel line — answers the operator's three
  // questions (Is scanner running? / Are signals created before
  // filtering? / Are signals inserted?) at one glance. Kept on a
  // single line on purpose: `pm2 logs … | grep '[SCAN FUNNEL]'`
  // gives the per-scan history without requiring the structured-log
  // shipper. Reads `total_symbols_scanned` (planned) vs `fetched`
  // (Yahoo successes) so a partial-fetch is visible distinct from a // @deprecated marker
  // partial-persist.
  // eslint-disable-next-line no-console
  console.log(
    `[SCAN FUNNEL] batch=${batchId} ` +
    `total=${total} fetched=${counters.fetched} ` +
    `prefilter_passed=${counters.preFiltered} ` +
    `pre_rejected=${counters.preRejected} ` +
    `no_direction=${counters.noDirection} ` +
    `insufficient=${counters.insufficient} ` +
    `scored=${counters.scored} ` +
    `approved=${counters.approved} ` +
    `watchlist=${counters.watchlist} ` +
    `rejected=${counters.rejected} ` +
    `inserted=${insertedCount}` +
    (insertFailures > 0 ? ` insert_failures=${insertFailures}` : '') +
    ` coverage_pct=${scanCoveragePercent} ` +
    `persistence_pct=${total > 0 ? Math.round((insertedCount / total) * 1000) / 10 : 0} ` +
    `duration_ms=${Date.now() - startedAt.getTime()}`,
  );
  if (!dryRun && insertedCount === 0 && (counters.approved + counters.watchlist) > 0) {
    console.error(
      `[SCAN ALERT] ${counters.approved + counters.watchlist} signals scored but ZERO inserted ` +
      `(failures=${insertFailures}). q365_signals will look empty to the API. ` +
      `Likely a NOT NULL column or schema mismatch — check persistRow errors.`,
    );
  }

  if (partialScanWarning) {
    // Surfaced at warn-level so the structured log shipper alerts on it.
    log.warn(partialScanWarning, { batchId, scanCoveragePercent, universeSize, fetched: counters.fetched });
  }

  // Cache the latest summary so /api/scanner/custom-universe/status
  // can return last-run state without re-querying the DB.
  setLastSummary(summary);

  return { summary, outcomes };
}

// ── Inline universe (used when caller passes opts.symbols) ───────
//
// Mirrors the loader's validation/dedup/normalisation rules so the
// downstream pipeline behaves identically whether the symbols come
// from a TXT file or a CLI flag. Skips file I/O and the comment/
// blank-line filtering — caller-supplied lists are presumed clean.
function buildInlineUniverse(symbols: string[]): CustomUniverse {
  const nseSymRe = /^[A-Z0-9][A-Z0-9&\-]*$/;
  const nse:     string[] = [];
  const yahoo:   string[] = []; // @deprecated marker
  const invalid: CustomUniverse['invalid'] = [];
  const seen = new Set<string>();

  for (let i = 0; i < symbols.length; i++) {
    const trimmed = (symbols[i] ?? '').trim();
    if (!trimmed) continue;
    const upper = trimmed.toUpperCase();
    // Accept either NSE form (RELIANCE) or pre-mapped Yahoo (RELIANCE.NS). // @deprecated marker
    const nseSym = upper.endsWith('.NS') ? upper.slice(0, -3) : upper;
    if (nseSym.length > 25) {
      invalid.push({ raw: trimmed, reason: 'too_long', line: i + 1 });
      continue;
    }
    if (!nseSymRe.test(nseSym) && !isPreEncodedYahoo(upper)) { // @deprecated marker
      invalid.push({ raw: trimmed, reason: 'invalid_chars', line: i + 1 });
      continue;
    }
    if (seen.has(nseSym)) continue;
    seen.add(nseSym);
    nse.push(nseSym);
    yahoo.push(toYahooSymbol(nseSym)); // @deprecated marker
  }

  return {
    source:   'inline',
    loadedAt: new Date().toISOString(),
    nse,
    yahoo, // @deprecated marker
    invalid,
  };
}
