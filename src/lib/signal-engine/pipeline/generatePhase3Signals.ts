// ════════════════════════════════════════════════════════════════
//  Phase 3 Pipeline — Trade Engine + Risk Engine + Portfolio-Aware
//
//  Signal → Trade Plan → Position Size → Portfolio Fit →
//  Risk Integration → Execution Readiness → Lifecycle → Rank
// ════════════════════════════════════════════════════════════════

import type {
  Candle, QuantSignal, Phase1Config, EnhancedMarketRegime,
  StrategyName, SignalAction, SignalSubtype, MarketContextTag, StrengthTag,
} from '../types/signalEngine.types';
import type {
  ExecutableSignal, Phase3TradePlan, Phase3Config,
  PortfolioSnapshot, PortfolioPosition,
} from '../types/phase3.types';
import { DEFAULT_PHASE1_CONFIG, getStrategyRelaxConfig } from '../constants/signalEngine.constants';
import { DEFAULT_PHASE3_CONFIG, getSector } from '../constants/phase3.constants';
import { createPipelineTracer, setAmbientTracer } from '../tracing/pipelineTracer';
import { detectEnhancedRegime } from '../regime/detectMarketRegime';
import { buildSignalFeatures } from '../features/buildSignalFeatures';
import { runAllStrategies, resetSellDebugAgg, flushSellDebugAgg } from '../strategy-engine/runStrategies';
import { BEARISH_STRATEGIES } from '../types/signalEngine.types';
import { computeRelativeStrength, defaultRelativeStrength } from '../context/relativeStrength';
import { calculatePositionSize } from '../position-sizing/positionSizer';
import { evaluatePortfolioFit } from '../portfolio-fit/evaluatePortfolioFit';
import {
  evaluateExecutionReadiness,
  resetApprovalGateAggregator,
  flushApprovalGateAggregator,
} from '../execution/executionReadiness';
import { computePhase3Risk } from '../risk/phase3Risk';
import { createLifecycle, resolveInitialState } from '../lifecycle/signalLifecycle';
import { buildPhase3TradePlanForStrategy } from '../trade-plan/buildTradePlan';
import { evaluateCorrelationPenalty, buildCorrelationMatrix, type CorrelationMatrix } from '../correlation/correlationEngine';
import { validateCandleSeries } from '../utils/candles';
import { validateFeatures } from '../utils/validation';
import type { CandleProvider } from './generatePhase1Signals';
import { runRejectionEngine, type RejectionInput, type RejectionDecision } from '../core/runRejectionEngine';
import { runPhase4Scoring } from '../scoring/phase4FactorAdapter';

export interface Phase3Result {
  regime: EnhancedMarketRegime;
  signals: ExecutableSignal[];
  scanned: number;
  approved: number;
  deferred: number;
  rejected: number;
  rejectionLog: { symbol: string; reason: string }[];
}

const ACTION_MAP: Record<StrategyName, SignalAction> = {
  bullish_breakout:       'enter_on_strength',
  bullish_pullback:       'enter_on_pullback',
  bearish_breakdown:      'enter_short',
  mean_reversion_bounce:  'enter_on_bounce',
  momentum_continuation:  'enter_on_momentum',
  bullish_divergence:     'enter_on_divergence',
  volume_climax_reversal: 'enter_on_climax',
  gap_continuation:       'enter_on_gap',
  range_breakout:         'enter_on_breakout',
  ema_crossover:          'enter_on_crossover',
  oversold_bounce:        'enter_on_oversold',
  // Both new bearish strategies share 'enter_short' — saveSignals.ts
  // maps enter_short → direction='SELL'. No new action enum needed.
  overbought_reversal:    'enter_short',
  weak_trend_breakdown:   'enter_short',
};

const SUBTYPE_MAP: Record<StrategyName, SignalSubtype> = {
  bullish_breakout:       'fresh_breakout',
  bullish_pullback:       'pullback_entry',
  bearish_breakdown:      'breakdown',
  mean_reversion_bounce:  'reversal_bounce',
  momentum_continuation:  'momentum_ride',
  bullish_divergence:     'divergence_reversal',
  volume_climax_reversal: 'climax_reversal',
  gap_continuation:       'gap_and_go',
  range_breakout:         'range_expansion',
  ema_crossover:          'ema_cross',
  oversold_bounce:        'oversold_reversal',
  overbought_reversal:    'overbought_reversal_entry',
  weak_trend_breakdown:   'weak_trend_entry',
};

type Phase3EntryType = 'breakout_confirmation' | 'pullback_retest' | 'momentum_followthrough' | 'mean_reversion_confirmation';
const ENTRY_TYPE_MAP: Record<StrategyName, Phase3EntryType> = {
  bullish_breakout:       'breakout_confirmation',
  bullish_pullback:       'pullback_retest',
  bearish_breakdown:      'momentum_followthrough',
  mean_reversion_bounce:  'mean_reversion_confirmation',
  momentum_continuation:  'momentum_followthrough',
  bullish_divergence:     'mean_reversion_confirmation',
  volume_climax_reversal: 'mean_reversion_confirmation',
  gap_continuation:       'breakout_confirmation',
  range_breakout:         'breakout_confirmation',
  ema_crossover:          'momentum_followthrough',
  oversold_bounce:        'mean_reversion_confirmation',
  overbought_reversal:    'mean_reversion_confirmation',
  weak_trend_breakdown:   'momentum_followthrough',
};

function contextTag(regime: string): MarketContextTag {
  if (regime === 'Strong Bullish' || regime === 'Bullish') return 'Bullish';
  if (regime === 'Bearish' || regime === 'Weak') return 'Weak';
  return 'Neutral';
}

function strengthTag(confidence: number): StrengthTag {
  if (confidence >= 85) return 'High Conviction';
  if (confidence >= 70) return 'Actionable';
  if (confidence >= 55) return 'Watchlist';
  return 'Avoid';
}

// ── Trading-day-aware stale check helpers ─────────────────────
// Daily NSE bars are stamped at market open (09:15 IST). Wall-clock
// age alone misclassifies Friday's bar as "3 days old" on Monday
// morning, even though it IS the most recent completed session. The
// gate must compare against the IST calendar date of the last
// completed trading session, not raw `Date.now() - bar.ts`.
const IST_OFFSET_MS = 5.5 * 3_600_000;
const MARKET_OPEN_UTC_HHMM = { hour: 3, minute: 45 };  // 09:15 IST
const STALE_HARD_CEILING_DAYS = (() => {
  const raw = Number(process.env.SIGNAL_ENGINE_STALE_CANDLE_HARD_CEILING_DAYS);
  if (Number.isFinite(raw) && raw >= 1 && raw <= 30) return Math.floor(raw);
  return 7;  // never accept a bar older than a full trading week
})();

function istDateKey(ms: number): string {
  const d = new Date(ms + IST_OFFSET_MS);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}` +
         `-${String(d.getUTCDate()).padStart(2, '0')}`;
}

/**
 * Find the IST calendar date of the most recent trading session whose
 * 09:15 IST market open has already occurred. Skips Sat/Sun. Holidays
 * are NOT modelled — when the NSE is closed on a Friday holiday, this
 * returns Thursday, but a holiday Friday's missing bar would still
 * pass the hard-ceiling check (Thursday ≤ 7 days). Adding a holiday
 * calendar is a follow-up.
 *
 * Logic: today's 09:15 may not have passed yet (early-morning scan),
 * so today is only the answer when the timestamp is past 09:15 IST.
 * For any earlier weekday the open has trivially already occurred —
 * just return the most recent prior weekday.
 */
function getLastTradingDayKey(nowMs: number): string {
  const istNow = new Date(nowMs + IST_OFFSET_MS);
  const todayDow = istNow.getUTCDay();
  if (todayDow >= 1 && todayDow <= 5) {
    const todayOpenUtcMs = Date.UTC(
      istNow.getUTCFullYear(), istNow.getUTCMonth(), istNow.getUTCDate(),
      MARKET_OPEN_UTC_HHMM.hour, MARKET_OPEN_UTC_HHMM.minute, 0,
    );
    if (nowMs >= todayOpenUtcMs) return istDateKey(nowMs);
  }
  let cursor = nowMs - 24 * 3_600_000;
  for (let i = 0; i < 10; i++) {
    const ist = new Date(cursor + IST_OFFSET_MS);
    const dow = ist.getUTCDay();
    if (dow >= 1 && dow <= 5) return istDateKey(cursor);
    cursor -= 24 * 3_600_000;
  }
  return istDateKey(nowMs);  // safety fallback (should never hit)
}

function isRecentTradingSession(barMs: number, nowMs: number): boolean {
  return istDateKey(barMs) === getLastTradingDayKey(nowMs);
}

export async function generatePhase3Signals(
  provider: CandleProvider,
  portfolio: PortfolioSnapshot,
  p1Config: Phase1Config = DEFAULT_PHASE1_CONFIG,
  p3Config: Phase3Config = DEFAULT_PHASE3_CONFIG,
): Promise<Phase3Result> {
  const now = new Date().toISOString();
  const rejectionLog: Phase3Result['rejectionLog'] = [];
  let approved = 0, deferred = 0, rejected = 0;

  // ── Tracing ────────────────────────────────────────────────
  const tracer = createPipelineTracer();
  setAmbientTracer(tracer);
  const phaseSpan = tracer.phase('Phase3', {
    universe: p1Config.universe.length,
    capital: portfolio.capital ?? null,
    openPositions: portfolio.openPositions?.length ?? 0,
  });

  // ── Resolve strategy relax config ─────────────────────────
  // Reads SIGNAL_RELAX_MODE + per-gate SIGNAL_ENGINE_* env overrides.
  // Defaults preserve strict behavior when nothing is set. The
  // [STRATEGY-CONFIG] log fires once per Phase 3 invocation when the
  // operator has actively softened a gate, so it's visible in the
  // rejection summary alongside the per-symbol reasons.
  const relax = getStrategyRelaxConfig();
  if (relax.active) {
    console.log(
      `[STRATEGY-CONFIG] active=true relax_mode=${relax.relaxModeFlag} ` +
      `stale_candle_max_days=${relax.staleCandleMaxDays} ` +
      `min_confidence=${relax.minConfidence} min_rr=${relax.minRR} ` +
      `max_risk_score=${relax.maxRiskScore} ` +
      `allow_high_vol_regime=${relax.allowHighVolRegime}`,
    );
  }

  // ── Debug bypass (PRODUCTION-BLOCKED) ─────────────────────
  // Spec "FORCE ACCEPT TEST MODE" + "TEMPORARY RELAX FILTERS":
  // when DEBUG_FORCE_SIGNAL=true, lower the rejection-engine
  // floors AND force-approve the first N candidates that reach
  // the rejection engine. The bypass is loud — every forced
  // approval emits [DEBUG-FORCED-APPROVE] so you can never
  // confuse a debug run with a real one. Production defaults
  // (60 / 1.5 / 70) are NOT touched; the override is applied
  // in-process for this scan only.
  //
  // GOVERNANCE HARDENING (2026-05) — DEBUG_FORCE_SIGNAL is
  // FORCE-DISABLED when NODE_ENV === 'production', regardless of
  // env-var value. The previous behaviour was "loud-but-allowed",
  // which meant a misconfigured prod deploy could ship synthetic
  // BUYs to live operators. The block here is unconditional:
  //   - prod: silent disable; emit [GOVERNANCE] one-liner so the
  //     operator sees the attempted bypass in the log stream.
  //   - dev/test: enable as before, but stamp every scan with a
  //     prominent banner so the developer never misreads a forced
  //     run as a real one.
  const NODE_ENV = String(process.env.NODE_ENV ?? '').toLowerCase();
  const IS_PRODUCTION = NODE_ENV === 'production';
  const debugFlagRequested = process.env.DEBUG_FORCE_SIGNAL === 'true';
  if (debugFlagRequested && IS_PRODUCTION) {
    // Hard governance log — surfaces in every prod log aggregator
    // grep for `[GOVERNANCE]` so the bypass attempt is auditable.
    console.error(
      '[GOVERNANCE] DEBUG_FORCE_SIGNAL blocked in production — ' +
      'force-approve bypass refused. Strict floors remain in effect. ' +
      'If this is intentional, change NODE_ENV (NEVER do this on a ' +
      'live trading deploy). Ignored env: DEBUG_FORCE_SIGNAL=true.',
    );
  }
  const DEBUG_FORCE_SIGNAL = debugFlagRequested && !IS_PRODUCTION;
  const debugMinConfidence = DEBUG_FORCE_SIGNAL ? 30  : relax.minConfidence;
  const debugMinRR         = DEBUG_FORCE_SIGNAL ? 1.0 : relax.minRR;
  const debugMaxRiskScore  = DEBUG_FORCE_SIGNAL ? 90  : relax.maxRiskScore;
  // Spec "GUARANTEE 5-20 SIGNALS" — bump the force-approve budget so
  // the API has a usable filler list even in dead markets. Default 20;
  // tunable via SIGNAL_DEBUG_FORCE_BUDGET (range 1-100).
  const debugForcedBudget  = (() => {
    const raw = Number(process.env.SIGNAL_DEBUG_FORCE_BUDGET);
    if (Number.isFinite(raw) && raw >= 1 && raw <= 100) return Math.floor(raw);
    return 20;
  })();
  let   debugForcedRemaining = DEBUG_FORCE_SIGNAL ? debugForcedBudget : 0;
  if (DEBUG_FORCE_SIGNAL) {
    // Loud dev-mode banner. The triple-emphasised wording is
    // deliberate — a developer running this in dev should never miss
    // that the rejection floors have been lowered and forced approvals
    // are being emitted.
    console.warn(
      '[DEBUG MODE] DEBUG_FORCE_SIGNAL=true — debug-only behavior in this scan:\n' +
      `  - environment: NODE_ENV=${NODE_ENV || 'unset'} (governance gate allows non-prod)\n` +
      `  - loose floors: minConfidence=${debugMinConfidence} minRR=${debugMinRR} maxRiskScore=${debugMaxRiskScore}\n` +
      `  - first ${debugForcedBudget} candidates force-approved at the rejection engine (bypass logged per row)\n` +
      '  - DO NOT ship this flag to production. Production deploys force-disable it regardless of env value.',
    );
  }

  // ── Per-symbol decision logger ────────────────────────────
  // Spec "ADD FULL REJECTION LOGGING" — one [PHASE3] line per
  // symbol with the canonical fields the operator greps for. For
  // a 500-symbol universe this is ~500 lines per scan, which is
  // intentional during debugging but expensive in steady state.
  // Default ON; set LOG_PHASE3_VERBOSE=false to silence.
  const PHASE3_VERBOSE = process.env.LOG_PHASE3_VERBOSE !== 'false';

  // ── Per-stage data-flow trace ─────────────────────────────
  // Spec "TRACE PIPELINE ENTRY / CANDLE / FEATURES / STRATEGY"
  // — emit one log per stage per symbol so the operator can
  // grep for the FIRST stage where a 500-symbol universe drops
  // to zero. ~2,000 lines per scan, so it's gated behind an
  // explicit flag (auto-on in DEBUG_FORCE_SIGNAL mode, off
  // otherwise). Set LOG_PHASE3_TRACE=true to enable in isolation.
  const PHASE3_TRACE =
    DEBUG_FORCE_SIGNAL || process.env.LOG_PHASE3_TRACE === 'true';
  let phase3ConfSum = 0;
  let phase3RrSum   = 0;
  let phase3WithConf = 0;
  let phase3WithRr   = 0;
  let phase3SkippedNoData = 0;
  // Spec "LOG ALL REJECTION REASONS" + "TOP 3 FILTERS" — bucket
  // every non-approved decision by canonical reason key. Keyed on
  // the leading token before the first colon so noisy per-symbol
  // detail (e.g. "stale_candle: 4.2d") collapses into the canonical
  // bucket ("stale_candle"). Surfaced at end of Phase 3 in
  // [PHASE3 REJECTION HISTOGRAM] so the operator can read the top
  // 3 filters straight from logs without grepping.
  const rejReasonCounts: Record<string, number> = {};
  function logPhase3(args: {
    symbol: string;
    confidence: number | null;
    final_score: number | null;
    risk_reward: number | null;
    decision: 'approved' | 'deferred' | 'rejected' | 'skipped';
    rejected_reason: string | null;
  }): void {
    if (typeof args.confidence === 'number' && Number.isFinite(args.confidence)) {
      phase3ConfSum += args.confidence;
      phase3WithConf++;
    }
    if (typeof args.risk_reward === 'number' && Number.isFinite(args.risk_reward)) {
      phase3RrSum += args.risk_reward;
      phase3WithRr++;
    }
    if (args.decision === 'skipped') phase3SkippedNoData++;
    if (args.decision !== 'approved' && args.rejected_reason) {
      // Canonicalise: strip any "[strategy]" prefix and trim to the
      // leading token before the first colon.
      const stripped = args.rejected_reason.replace(/^\[[^\]]+\]\s*/, '');
      const key = (stripped.split(':')[0] ?? stripped).trim() || 'unknown';
      rejReasonCounts[key] = (rejReasonCounts[key] ?? 0) + 1;
    }
    if (PHASE3_VERBOSE) console.log('[PHASE3]', args);
  }

  // ── Step 1: Detect regime ─────────────────────────────────
  // Spec "PIPELINE MUST ALWAYS COMPLETE" — benchmark fetch must NOT
  // abort the entire scan. The historical behavior was to throw on
  // any benchmark failure (provider down, NIFTY 50 not in DB, thin
  // bars), which short-circuited Phase 3 BEFORE the per-symbol loop
  // — so [PHASE3 ENTRY] never logged and the recovery saw scanned=0
  // with no diagnostic trail. Degrade to a 'Sideways' regime instead;
  // every per-symbol scan and stage-attrition log still fires.
  console.log('🔥 Phase3 START');
  console.log('[DEBUG] symbols length:', p1Config.universe.length);
  console.log('[DEBUG] entering Phase3 loop');
  let benchmarkCandles: Candle[] = [];
  let regime: EnhancedMarketRegime;
  try {
    benchmarkCandles = await provider.fetchDailyCandles(p1Config.benchmarkSymbol);
    const benchValid = validateCandleSeries(benchmarkCandles, p1Config.minCandleCount);
    if (!benchValid.valid) {
      throw new Error(`Benchmark invalid: ${benchValid.reason}`);
    }
    regime = detectEnhancedRegime(benchmarkCandles);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(
      `[PHASE3 BENCHMARK FALLBACK] ${msg} — falling back to 'Sideways' regime; scan continues`,
    );
    benchmarkCandles = [];
    regime = {
      label:               'Sideways',
      allowBullishSignals: true,
      strength:            50,
      volatilityRegime:    'Normal',
      trendSlope:          0,
      confidence:          0,  // 0 = degraded fallback
      details: {
        closeVsEma20: 0, closeVsEma50: 0, closeVsEma200: 0,
        ema20VsEma50: 0, ema50VsEma200: 0,
        rsi: 50, atrPct: 0,
      },
    };
  }


  // ── Build correlation matrix from available candle data ────
  // Spec "FIX SLOW SYNC RUN" — the previous implementation did a
  // serial `for...await` over the entire universe (2 × 503 = 1006
  // sequential candle fetches once you count the main loop below).
  // Two surgical fixes:
  //   1. Run the prefetch with bounded concurrency so 503 DB hits
  //      take ~503/N rounds instead of 503 rounds.
  //   2. Reuse the resulting `candleCache` inside the main scan
  //      loop so each symbol is fetched EXACTLY ONCE per Phase 3.
  // For a 503-symbol DB-warm universe this drops Phase 3 from
  // ~5s to <500ms; on a cold-start with upstream fallback the
  // win is >10×.
  // Recalibrated 2026-05: 16 → 4. The IndianAPI adapter's rate
  // limiter serialises every call to ≤1 in flight regardless of
  // caller concurrency, so a higher worker count just lengthens the
  // queue waiting on the limiter. With 16 workers, when the first
  // call 429s and the breaker opens, all 16 then race through the
  // breaker's fail-fast path and hit the resolver fallback chain
  // simultaneously — bursting downstream caches. With 4 workers the
  // queue drains slower and the fallback engages more gracefully.
  // For DB-only candle reads (the common case after warmup), 4 is
  // still more than enough — single-digit ms each. Env-tunable for
  // operators on a paid plan with higher RPS allowance.
  const PHASE3_PREFETCH_CONCURRENCY = (() => {
    const raw = Number(process.env.PHASE3_PREFETCH_CONCURRENCY);
    if (Number.isFinite(raw) && raw >= 1 && raw <= 64) return Math.floor(raw);
    return 4;
  })();
  const candleCache = new Map<string, Candle[]>();
  const candleErrorCache = new Map<string, Error>();
  const prefetchStart = Date.now();
  let prefetchCursor = 0;
  const universeArr = p1Config.universe;
  async function prefetchWorker(): Promise<void> {
    while (true) {
      const i = prefetchCursor++;
      if (i >= universeArr.length) return;
      const sym = universeArr[i];
      try {
        const c = await provider.fetchDailyCandles(sym);
        candleCache.set(sym, c);
      } catch (err) {
        candleErrorCache.set(sym, err instanceof Error ? err : new Error(String(err)));
      }
    }
  }
  await Promise.all(
    Array.from(
      { length: Math.min(PHASE3_PREFETCH_CONCURRENCY, universeArr.length) },
      prefetchWorker,
    ),
  );
  console.log(
    `[PHASE3 PREFETCH] concurrency=${PHASE3_PREFETCH_CONCURRENCY} ` +
    `cached=${candleCache.size}/${universeArr.length} ` +
    `errors=${candleErrorCache.size} ` +
    `elapsed_ms=${Date.now() - prefetchStart}`,
  );
  // Correlation matrix needs ≥30 bars per symbol; build from the
  // subset of cache entries that meet that bar count.
  const correlationCache = new Map<string, Candle[]>();
  for (const [sym, c] of candleCache) {
    if (c.length >= 30) correlationCache.set(sym, c);
  }
  const correlationMatrix = correlationCache.size > 1
    ? buildCorrelationMatrix(correlationCache) : undefined;

  // Mutable portfolio for tracking allocations within this run
  const runPortfolio: PortfolioSnapshot = {
    capital: portfolio.capital,
    cashAvailable: portfolio.cashAvailable,
    openPositions: [...portfolio.openPositions],
    pendingSignals: [...portfolio.pendingSignals],
  };

  const signals: ExecutableSignal[] = [];

  // Reset SELL-generation counters for this batch. The strategy
  // runner accumulates per-symbol counts into a module-level
  // aggregator; we reset here and flush at the end so one Phase 3
  // scan produces exactly one [SELL DEBUG AGG] log line.
  resetSellDebugAgg();
  // Spec INSTITUTIONAL §I — same pattern for the approval funnel.
  resetApprovalGateAggregator();

  // ── Tracing — aggregate counters per engine ───────────────
  // We emit a single span per engine at phase end with summary
  // counts instead of N spans per symbol, so the log stays
  // readable for a 2000-symbol universe.
  const engineCounts = {
    tradePlan:           { ok: 0, fail: 0 },
    positionSize:        { ok: 0, capped: 0, invalid: 0 },
    portfolioFit:        { approved: 0, deferred: 0, rejected: 0 },
    executionReadiness:  { approved: 0, deferred: 0, rejected: 0 },
    manipulationPenalty: { penalized: 0, rejected: 0, clean: 0 },
    canonicalRejection:  { approved: 0, rejected: 0 },
  };

  // [SELL TRACE] — per-stage SELL attrition. Incremented only when
  // the candidate is a bearish strategy. At the end of the scan we
  // emit one roll-up line so the operator can see exactly where
  // SELL candidates are being dropped.
  const sellTrace = {
    after_generation:        0,  // survived runAllStrategies
    after_trade_plan:        0,  // passed stop-width + R:R gates
    after_position_sizing:   0,  // sizing didn't invalidate
    after_portfolio_fit:     0,  // portfolio_fit decision != rejected
    after_execution_ready:   0,  // execution readiness approved
    after_canonical_reject:  0,  // canonical rejection engine approved
    final_saved:             0,  // actually pushed into signals[]
  };

  // ── Step 2: Process each symbol ───────────────────────────
  // Stale-candle rejection threshold. A symbol whose newest daily
  // bar is older than this is skipped — any signal built from stale
  // ticks would reference a week-old close and produce a trade plan
  // that can't be executed. Default 3 days; bump up to 30 via
  // SIGNAL_ENGINE_STALE_CANDLE_MAX_DAYS or set SIGNAL_RELAX_MODE=true
  // (which uses 7d). See getStrategyRelaxConfig for the trade-off.
  const STALE_CANDLE_MAX_AGE_MS = relax.staleCandleMaxDays * 24 * 60 * 60 * 1000;

  // Soft-stale window: when set, candles older than this but younger
  // than STALE_CANDLE_MAX_AGE_MS get through with the per-symbol
  // confidence reduced by `relax.staleCandlePenaltyPct`. Tracked here
  // so the per-symbol scoring loop below can apply the penalty.
  const STALE_CANDLE_SOFT_AGE_MS = relax.staleCandleSoftHours != null
    ? relax.staleCandleSoftHours * 60 * 60 * 1000
    : null;
  let softStaleCount = 0;

  // Spec — emit a [BATCH] progress log every BATCH_LOG_INTERVAL
  // symbols so the operator can see Phase 3 progressing through the
  // full universe (~503 symbols typically). The strategy engine is
  // CPU-bound and runs sequentially per symbol; on a 503-symbol
  // universe a full pass takes 10–30s. Without progress logs an
  // operator can't tell whether the loop has stalled.
  const BATCH_LOG_INTERVAL = 50;
  const TOTAL_TO_SCAN = p1Config.universe.length;
  // Spec "TRACE PIPELINE ENTRY" — canonical "we're about to scan
  // this many symbols" marker. If [PHASE3 ENTRY] symbols=0 fires,
  // the universe never loaded and the entire decision-stage
  // search is moot.
  console.log(`[PHASE3 ENTRY] symbols=${TOTAL_TO_SCAN} regime=${regime.label} trace=${PHASE3_TRACE}`);
  console.log(`[BATCH] Phase 3 scan starting — total=${TOTAL_TO_SCAN}`);
  // Spec OPERATIONAL OBSERVABILITY (2026-05) — canonical pipeline-progress
  // tag. SRE dashboards grep `[PIPELINE_PROGRESS]` regardless of which
  // phase emits it, so every long-running stage reports start / progress
  // / completion through the same tag and field set.
  const phase3StartedAt = Date.now();
  console.log('[PIPELINE_PROGRESS]', {
    stage:       'phase3',
    event:       'start',
    total:       TOTAL_TO_SCAN,
    prefetch_ms: Date.now() - prefetchStart,
    cached:      candleCache.size,
    errors:      candleErrorCache.size,
  });
  // Spec INSTITUTIONAL §C — single greppable "what Phase 3 received".
  // Pairs with the route's [SCAN_LIMIT] line; if [SCAN_LIMIT].run_universe
  // != [PHASE3_RECEIVED].symbols, the universe was truncated between
  // the route and Phase 3 (shouldn't happen — both read p1Config.universe —
  // but the assertion catches a future regression).
  console.log(
    `[PHASE3_RECEIVED] symbols=${TOTAL_TO_SCAN} ` +
    `prefetch_concurrency=${PHASE3_PREFETCH_CONCURRENCY} ` +
    `cached=${candleCache.size} errors=${candleErrorCache.size} ` +
    `regime=${regime.label}`,
  );
  let scannedCount = 0;
  // Spec "FIND FIRST DROP POINT" — per-stage survival counters.
  // The summary at end of scan tells the operator the EXACT stage
  // where the universe drops to zero. If reachedDecisionStage===0
  // we throw [PHASE3_NO_INPUT_DATA] so the pipeline fails loud
  // instead of silently producing zero signals.
  const stageReached = {
    candle_fetch:    0,
    candle_valid:    0,
    not_stale:       0,
    features_valid:  0,
    strategy_match:  0,
    trade_plan_ok:   0,
    decision_stage:  0,
  };
  for (const symbol of p1Config.universe) {
    try {
      stageReached.candle_fetch++;
      // Spec "FIX SLOW SYNC RUN" — the prefetch above populated
      // candleCache for every symbol (or candleErrorCache on failure).
      // Reuse it instead of triggering a second per-symbol fetch.
      // If neither cache has the symbol (shouldn't happen but defensive),
      // fall back to a live fetch.
      let candles: Candle[];
      const cached = candleCache.get(symbol);
      const cachedErr = candleErrorCache.get(symbol);
      if (cached !== undefined) {
        candles = cached;
      } else if (cachedErr !== undefined) {
        throw cachedErr;
      } else {
        candles = await provider.fetchDailyCandles(symbol);
      }
      // Spec "TRACE CANDLE VALIDATION" — emit per-symbol BEFORE
      // the rejection check so the operator can see what data the
      // engine actually got back from the provider, regardless of
      // whether the symbol passed validation.
      if (PHASE3_TRACE) {
        const last = candles?.[candles.length - 1] ?? null;
        console.log('[CANDLE CHECK]', {
          symbol,
          bars: candles?.length ?? 0,
          latest: last
            ? { ts: last.ts, close: last.close, volume: last.volume }
            : null,
        });
      }
      const candleCheck = validateCandleSeries(candles, p1Config.minCandleCount);
      if (!candleCheck.valid) {
        // Spec "VERIFY CANDLE DATA" — loud, greppable [CANDLE INVALID]
        // marker so operators can see whether the universe is reaching
        // Phase 3 with usable bars (vs. an empty / short series from a
        // failed candle refresh).
        console.warn('[CANDLE INVALID]', {
          symbol,
          length: candles?.length ?? 0,
          min_required: p1Config.minCandleCount,
          latest_ts: candles?.[candles.length - 1]?.ts ?? null,
          reason: candleCheck.reason,
        });
        rejectionLog.push({ symbol, reason: candleCheck.reason! });
        logPhase3({
          symbol, confidence: null, final_score: null, risk_reward: null,
          decision: 'skipped', rejected_reason: `candle_invalid: ${candleCheck.reason}`,
        });
        continue;
      }

      stageReached.candle_valid++;

      // Per-symbol stale-candle gate. The batch-level
      // checkCandleFreshness() guards the pipeline as a whole,
      // but individual symbols can still lag when data ingestion
      // is partial — reject them here so stale rows don't reach
      // the strategy engine.
      let isSoftStale = false;
      const newestCandle = candles[candles.length - 1];
      if (newestCandle) {
        const newestTs = new Date(newestCandle.ts as any).getTime();
        if (Number.isFinite(newestTs)) {
          const nowMs = Date.now();
          const ageMs = nowMs - newestTs;
          const ageDaysNum = ageMs / (24 * 60 * 60 * 1000);
          // Trading-day-aware stale check. A bar dated to the last
          // completed IST trading session is the freshest data the
          // market can possibly provide — accept it even when the
          // wall-clock age has crossed staleCandleMaxDays. Mon-morning
          // scans against Friday's close are the canonical case.
          const isLastTradingDay = isRecentTradingSession(newestTs, nowMs);
          const overSoftLimit    = ageMs > STALE_CANDLE_MAX_AGE_MS;
          const overHardCeiling  = ageDaysNum > STALE_HARD_CEILING_DAYS;
          const willReject       = overHardCeiling || (overSoftLimit && !isLastTradingDay);
          if (process.env.LOG_STALE_CHECK !== 'false') {
            console.log('[STALE CHECK]', {
              symbol,
              ageDays: Math.round(ageDaysNum * 10) / 10,
              isLastTradingDay,
              overSoftLimit,
              overHardCeiling,
              rejected: willReject,
            });
          }
          if (willReject) {
            const ageDays = ageDaysNum.toFixed(1);
            const reason = overHardCeiling
              ? `Stale candle data: ${ageDays}d > hard ceiling ${STALE_HARD_CEILING_DAYS}d`
              : `Stale candle data: newest close is ${ageDays}d old (not last trading session)`;
            rejectionLog.push({ symbol, reason });
            logPhase3({
              symbol, confidence: null, final_score: null, risk_reward: null,
              decision: 'skipped',
              rejected_reason: overHardCeiling
                ? `stale_candle_hard_ceiling: ${ageDays}d`
                : `stale_candle: ${ageDays}d`,
            });
            continue;
          }
          // Soft-stale: older than the soft window but still inside the
          // hard reject window. Pass-with-penalty is applied below
          // after the scoring layer produces a confidence.
          //
          // Spec "ALLOW EOD DATA FOR SIGNALS" — when the latest bar's
          // IST calendar date matches the last completed trading
          // session, treat the candle as fresh regardless of
          // wall-clock age. EOD bars are stamped at market open
          // (09:15 IST) so by the time of a 5 pm scan they are 8 h old
          // and would otherwise trip a 12 h soft-stale window. The
          // most recent session's bar IS the freshest data the market
          // can provide; never penalise it.
          if (
            STALE_CANDLE_SOFT_AGE_MS != null
            && ageMs > STALE_CANDLE_SOFT_AGE_MS
            && !isLastTradingDay
          ) {
            isSoftStale = true;
            softStaleCount++;
          }
        }
      }
      stageReached.not_stale++;

      const features = buildSignalFeatures(candles, regime.label, p1Config.minAvgVolume, p1Config.minPrice);
      const featureCheck = validateFeatures(features);
      // Spec "LOG FEATURE GENERATION" — emit per-symbol AFTER
      // indicators are computed regardless of whether they validated.
      // If [FEATURES] shows NaN/0 across the board, the candle data
      // was insufficient for the indicator window (e.g. <14 bars for
      // RSI, <50 for ema50) and the upstream candle fetch is the
      // real culprit even though validateCandleSeries passed.
      if (PHASE3_TRACE) {
        console.log('[FEATURES]', {
          symbol,
          rsi:    features.momentum.rsi14,
          ema20:  features.trend.ema20,
          ema50:  features.trend.ema50,
          ema200: features.trend.ema200,
          atrPct: features.volatility.atrPct,
          adx:    features.momentum.adx,
          volume_vs_20d: features.volume.volumeVs20dAvg,
          valid:  featureCheck.valid,
          reason: featureCheck.reason ?? null,
        });
      }
      if (!featureCheck.valid) {
        rejectionLog.push({ symbol, reason: featureCheck.reason! });
        logPhase3({
          symbol, confidence: null, final_score: null, risk_reward: null,
          decision: 'skipped', rejected_reason: `features_invalid: ${featureCheck.reason}`,
        });
        continue;
      }
      stageReached.features_valid++;

      let rs = defaultRelativeStrength();
      try { rs = computeRelativeStrength(candles, benchmarkCandles); } catch {}

      // ── Step 3: Strategy evaluation ─────────────────────────
      const { candidates, rejections } = runAllStrategies(features, rs);
      for (const r of rejections) rejectionLog.push({ symbol, reason: `[${r.strategy}] ${r.reason}` });
      // Spec "LOG STRATEGY MATCH" — show which strategies (if any)
      // matched this symbol. If matchedStrategies is empty across
      // the universe, no symbol can ever reach the decision stage —
      // the gates below are moot and the bottleneck is in
      // strategy-engine criteria vs. current market features.
      if (PHASE3_TRACE) {
        console.log('[STRATEGY CHECK]', {
          symbol,
          matchedStrategies: candidates.map((c) => c.strategy),
          match_count:   candidates.length,
          reject_count:  rejections.length,
          top_rejection: rejections[0]
            ? `${rejections[0].strategy}: ${rejections[0].reason}`
            : null,
        });
      }
      if (candidates.length === 0) {
        logPhase3({
          symbol, confidence: null, final_score: null, risk_reward: null,
          decision: 'rejected',
          rejected_reason: rejections.length > 0
            ? `no_strategy_match (${rejections.length} strategies tried, top: ${rejections[0]?.reason ?? 'n/a'})`
            : 'no_strategy_match',
        });
        continue;
      }
      stageReached.strategy_match++;

      // ── Best-per-direction emission (Nov 2026 SELL-balance fix) ─
      //
      // Historical bug: `const best = candidates[0]` picked the
      // highest-confidence candidate per symbol regardless of
      // direction. In bull tapes, bullish strategies almost always
      // outscored bearish ones on the same stock, so SELL signals
      // silently lost out at this single line — the #1 cause of
      // "SELL=0 in final output" despite bearish strategies matching
      // at the generation layer (visible in [SELL DEBUG AGG]).
      //
      // New behaviour: pick best bullish AND best bearish. Emit both
      // IFF (a) both exist, (b) secondary score is within 15 points
      // of primary, (c) secondary score ≥ 50. Otherwise emit just
      // the dominant one. No faking — every emitted candidate had to
      // actually match its strategy's criteria.
      const bullishBest = candidates.find((c) => !BEARISH_STRATEGIES.has(c.strategy));
      const bearishBest = candidates.find((c) =>  BEARISH_STRATEGIES.has(c.strategy));
      const toBuild: typeof candidates = [];
      if (bullishBest && bearishBest) {
        const primary   = bullishBest.confidence.finalScore >= bearishBest.confidence.finalScore
          ? bullishBest : bearishBest;
        const secondary = primary === bullishBest ? bearishBest : bullishBest;
        toBuild.push(primary);
        const gap = primary.confidence.finalScore - secondary.confidence.finalScore;
        if (gap <= 15 && secondary.confidence.finalScore >= 50) {
          toBuild.push(secondary);
        }
      } else if (bullishBest) toBuild.push(bullishBest);
      else if (bearishBest)   toBuild.push(bearishBest);

    // Loop-per-direction over the body below. Every downstream
    // step (trade plan, sizing, portfolio fit, rejection engine,
    // signal save) runs once per surviving candidate, so a stock
    // with a clear BUY + a near-parity SELL produces two rows.
    for (const best of toBuild) {
      const isSellCandidate = BEARISH_STRATEGIES.has(best.strategy);
      if (isSellCandidate) sellTrace.after_generation++;
      // Early confidence filter REMOVED. The pipeline used to drop
      // any candidate below minConfidenceToSave here, which meant
      // the API never saw the bottom of the ranked distribution.
      // Now every scored signal flows through to the API layer,
      // which sorts by confidence desc and applies the final
      // top-50 cap. This guarantees the user sees the top 50
      // signals from the entire universe — never fewer just
      // because the cut was applied too early.
      void p1Config;

      // ── Step 3b: Micro-budget extreme-low-confidence early-exit ──
      // Spec "OPTIMIZE API USAGE" / "SKIP LOW QUALITY EARLY". The
      // rejection engine's confidence floor is 55 (recalibrated from
      // 60). A candidate scoring <25 cannot reach approved/deferred
      // regardless of downstream gates, so skip the rest of the
      // per-symbol pipeline (manipulation DB read, Phase-4 scoring,
      // rejection engine, lifecycle creation). CPU-only optimisation —
      // no upstream API call lives downstream of this point.
      //
      // Disabled when DEBUG_FORCE_SIGNAL is set, so the force-approve
      // budget can still pick up extreme-low-conf rows for testing.
      // Threshold env-tunable via SIGNAL_PHASE3_LOW_CONF_EXIT (0–55)
      // — set to 0 to disable.
      const LOW_CONF_EXIT = (() => {
        const raw = Number(process.env.SIGNAL_PHASE3_LOW_CONF_EXIT);
        if (Number.isFinite(raw) && raw >= 0 && raw <= 55) return Math.floor(raw);
        return 25;
      })();
      if (
        !DEBUG_FORCE_SIGNAL
        && LOW_CONF_EXIT > 0
        && best.confidence.finalScore < LOW_CONF_EXIT
      ) {
        rejected++;
        rejectionLog.push({
          symbol,
          reason: `Extreme-low confidence ${best.confidence.finalScore} < ${LOW_CONF_EXIT} (early-exit)`,
        });
        logPhase3({
          symbol,
          confidence:      best.confidence.finalScore,
          final_score:     null,
          risk_reward:     null,
          decision:        'rejected',
          rejected_reason: `confidence_extreme_low: ${best.confidence.finalScore} < ${LOW_CONF_EXIT}`,
        });
        continue;
      }

      // ── Step 4: Build Phase 3 trade plan (strategy-aware target3) ─
      const tradePlan = buildPhase3TradePlanForStrategy(features, best.strategy);

      // ── Step 5: Stop width check ────────────────────────────
      // Spec "GUARANTEE SIGNAL OUTPUT" — when DEBUG_FORCE_SIGNAL is on,
      // record the wide-stop as a warning and let the candidate flow
      // through to the rejection engine's force-approve block.
      // Production behavior unchanged when the flag is off.
      const stopWidthPct = tradePlan.entryZoneHigh > 0
        ? (tradePlan.initialRiskPerUnit / tradePlan.entryZoneHigh) * 100
        : 0;
      let stopWidthWarning: string | null = null;
      if (stopWidthPct > p3Config.stopMaxWidthPct) {
        if (DEBUG_FORCE_SIGNAL) {
          stopWidthWarning =
            `stop_too_wide: ${stopWidthPct.toFixed(1)}% > ${p3Config.stopMaxWidthPct}% ` +
            `(soft-passed by DEBUG_FORCE_SIGNAL)`;
          console.warn(`[DEBUG-SOFT-PASS] ${symbol} ${stopWidthWarning}`);
        } else {
          rejectionLog.push({ symbol, reason: `Stop too wide: ${stopWidthPct.toFixed(1)}% > ${p3Config.stopMaxWidthPct}%` });
          rejected++;
          logPhase3({
            symbol, confidence: best.confidence.finalScore, final_score: null,
            risk_reward: tradePlan.rrTarget1, decision: 'rejected',
            rejected_reason: `stop_too_wide: ${stopWidthPct.toFixed(1)}% > ${p3Config.stopMaxWidthPct}%`,
          });
          continue;
        }
      }

      // ── Step 6: R:R check ───────────────────────────────────
      // Spec "TEMPORARY RELAX FILTERS" — DEBUG_FORCE_SIGNAL=true
      // lowers the RR floor from p3Config.minRewardRisk (typ. 1.5)
      // to debugMinRR (1.0) so symbols with marginal RR survive
      // long enough to reach the rejection-engine force-approval.
      // Even when below debugMinRR, soft-pass under DEBUG_FORCE_SIGNAL
      // so the row reaches the force-approve block.
      const effectiveMinRR = DEBUG_FORCE_SIGNAL
        ? Math.min(p3Config.minRewardRisk, debugMinRR)
        : p3Config.minRewardRisk;
      let rrWarning: string | null = null;
      if (tradePlan.rrTarget1 < effectiveMinRR) {
        if (DEBUG_FORCE_SIGNAL) {
          rrWarning =
            `rr_below_min: ${tradePlan.rrTarget1} < ${effectiveMinRR} ` +
            `(soft-passed by DEBUG_FORCE_SIGNAL)`;
          console.warn(`[DEBUG-SOFT-PASS] ${symbol} ${rrWarning}`);
        } else {
          rejectionLog.push({ symbol, reason: `R:R ${tradePlan.rrTarget1} below min ${effectiveMinRR}` });
          rejected++;
          logPhase3({
            symbol, confidence: best.confidence.finalScore, final_score: null,
            risk_reward: tradePlan.rrTarget1, decision: 'rejected',
            rejected_reason: `rr_below_min: ${tradePlan.rrTarget1} < ${effectiveMinRR}`,
          });
          continue;
        }
      }
      // Park the soft-pass warnings on `best.warnings` so saveSignals
      // persists them and the API/UI can surface the soft-pass label.
      if (stopWidthWarning) best.warnings = [...best.warnings, stopWidthWarning];
      if (rrWarning)        best.warnings = [...best.warnings, rrWarning];
      if (isSellCandidate) sellTrace.after_trade_plan++;
      stageReached.trade_plan_ok++;

      // ── Step 7: Position sizing ─────────────────────────────
      const currentGross = runPortfolio.openPositions.reduce((s, p) => s + p.grossValue, 0);
      const sizing = calculatePositionSize({
        portfolioCapital: runPortfolio.capital,
        riskPerTradePct: p3Config.riskPerTradePct,
        maxGrossExposurePct: p3Config.maxGrossExposurePct,
        entryPrice: tradePlan.entryZoneHigh,
        stopLoss: tradePlan.stopLoss,
        atrPct: features.volatility.atrPct,
        model: features.volatility.atrPct > 3 ? 'volatility_adjusted' : 'fixed_fractional',
        currentGrossExposure: currentGross,
      });
      if (sizing.validationStatus === 'capped')       engineCounts.positionSize.capped++;
      else if (sizing.validationStatus === 'invalid') engineCounts.positionSize.invalid++;
      else                                             engineCounts.positionSize.ok++;

      if (isSellCandidate && sizing.validationStatus !== 'invalid') {
        sellTrace.after_position_sizing++;
      }
      if (isSellCandidate && process.env.DEBUG_SELL_DOWNSTREAM === '1' &&
          sizing.validationStatus === 'invalid') {
        console.log('[SIZE REJECT]', symbol, {
          reason: sizing.warnings[0] ?? 'zero_size',
          entry:  tradePlan.entryZoneHigh,
          stop:   tradePlan.stopLoss,
        });
      }

      // ── Step 8: Portfolio fit ───────────────────────────────
      // Use the shared BEARISH_STRATEGIES Set so new bearish strategies
      // are recognised as SHORT. Prior bug: hardcoded === 'bearish_breakdown'
      // silently produced 'long' direction for new bearish strategies,
      // breaking portfolio fit + position sizing downstream.
      const direction = BEARISH_STRATEGIES.has(best.strategy) ? 'short' as const : 'long' as const;
      const portfolioFit = evaluatePortfolioFit(
        symbol, direction, sizing.grossPositionValue, runPortfolio, p3Config,
      );
      if      (portfolioFit.portfolioDecision === 'rejected') engineCounts.portfolioFit.rejected++;
      else if (portfolioFit.portfolioDecision === 'deferred') engineCounts.portfolioFit.deferred++;
      else                                                     engineCounts.portfolioFit.approved++;

      if (isSellCandidate && portfolioFit.portfolioDecision !== 'rejected') {
        sellTrace.after_portfolio_fit++;
      }
      if (isSellCandidate && process.env.DEBUG_SELL_DOWNSTREAM === '1' &&
          portfolioFit.portfolioDecision === 'rejected') {
        console.log('[PORTFOLIO REJECT]', {
          symbol,
          reason: portfolioFit.penalties[0] ?? 'fit_score_too_low',
          fit_score:      portfolioFit.fitScore,
          direction_impact: portfolioFit.directionImpact,
        });
      }

      // ── Step 8b: Real correlation penalty (upgrades sector proxy) ─
      if (correlationMatrix) {
        const corrResult = evaluateCorrelationPenalty(
          symbol, runPortfolio.openPositions, correlationMatrix, p3Config,
        );
        // Replace sector-proxy correlation with real correlation data
        if (corrResult.correlationPenalty > portfolioFit.correlationPenalty) {
          portfolioFit.fitScore = Math.max(0, portfolioFit.fitScore -
            (corrResult.correlationPenalty - portfolioFit.correlationPenalty));
          portfolioFit.correlationPenalty = corrResult.correlationPenalty;
          portfolioFit.correlationCluster = corrResult.correlationCluster;
          if (corrResult.correlationPenalty > 10) {
            portfolioFit.penalties.push(
              `Correlation cluster "${corrResult.correlationCluster}": ${corrResult.clusterExposureCount} correlated positions`,
            );
          }
          // Re-evaluate decision based on updated fit score
          if (portfolioFit.fitScore < 30) portfolioFit.portfolioDecision = 'rejected';
          else if (portfolioFit.fitScore < 50) portfolioFit.portfolioDecision = 'deferred';
          else if (portfolioFit.fitScore < 70) portfolioFit.portfolioDecision = 'approved_with_penalty';
        }
      }

      // ── Step 9: Phase 3 risk ────────────────────────────────
      const riskBreakdown = computePhase3Risk(best.risk, portfolioFit);

      // ── Step 10: Execution readiness ────────────────────────
      const execution = evaluateExecutionReadiness(
        best.confidence.finalScore, best.confidence.band,
        tradePlan.rrTarget1, portfolioFit, sizing, riskBreakdown, p3Config,
      );
      if      (execution.approvalDecision === 'rejected') engineCounts.executionReadiness.rejected++;
      else if (execution.approvalDecision === 'deferred') engineCounts.executionReadiness.deferred++;
      else                                                 engineCounts.executionReadiness.approved++;

      if (isSellCandidate && execution.approvalDecision !== 'rejected') {
        sellTrace.after_execution_ready++;
      }
      if (isSellCandidate && process.env.DEBUG_SELL_DOWNSTREAM === '1') {
        console.log('[EXECUTION STATE]', {
          symbol,
          status:     execution.status,
          decision:   execution.approvalDecision,
          reason:     execution.reasons[0] ?? null,
        });
      }

      // ── Step 10b: Manipulation check ──────────────────────────
      let manipulationContext: RejectionInput['manipulationContext'] = undefined;
      try {
        const { getManipulationStatusForSymbol } = await import('@/lib/manipulation-engine/api/signalEngineHooks');
        const manipStatus = await getManipulationStatusForSymbol(symbol);
        if (manipStatus.score > 0) {
          if (manipStatus.shouldReject)        engineCounts.manipulationPenalty.rejected++;
          else if (manipStatus.shouldPenalize) engineCounts.manipulationPenalty.penalized++;
          else                                  engineCounts.manipulationPenalty.clean++;
          manipulationContext = {
            score: manipStatus.score,
            band: manipStatus.band,
            shouldPenalize: manipStatus.shouldPenalize,
            shouldReject: manipStatus.shouldReject,
            warning: manipStatus.warning,
          };
          // Apply penalty to confidence. CONTRACT: execution
          // readiness was already computed against the ORIGINAL
          // (pre-penalty) confidence above — the penalty is
          // intentionally additive guidance for the ranking and
          // narrative layers, not a re-gate. The rejection engine
          // below consumes `best.confidence.finalScore` which is
          // the post-penalty number, so low-confidence signals
          // that cross the reject threshold after penalty are
          // still caught there.
          if (manipStatus.shouldPenalize && !manipStatus.shouldReject) {
            const penalty = manipStatus.suggestedPenalty;
            best.confidence = {
              ...best.confidence,
              finalScore: Math.max(0, best.confidence.finalScore - penalty),
            };
          }
        }
      } catch { /* manipulation engine unavailable — continue without penalty */ }

      // ── Soft-stale penalty (spec "FIX ZERO SIGNAL ISSUE" §2) ──
      // When isSoftStale fires, the candle is older than the soft
      // threshold but newer than the hard reject. Reduce confidence
      // by relax.staleCandlePenaltyPct so the signal still flows
      // through but ranks below clean-data signals. The rejection
      // engine below uses the post-penalty score, so low rows that
      // cross minConfidence after penalty are caught there.
      if (isSoftStale && relax.staleCandlePenaltyPct > 0) {
        best.confidence = {
          ...best.confidence,
          finalScore: Math.max(0, best.confidence.finalScore - relax.staleCandlePenaltyPct),
        };
      }

      // ── High-vol regime penalty (spec §4) ───────────────────────
      // When the regime is 'High Volatility Risk' and the operator has
      // opted into allowHighVolRegime, gate 4 in runRejectionEngine
      // soft-passes bullish strategies. Apply a confidence penalty
      // here so soft-passed rows rank below clean-regime signals in
      // the final ordering. Penalty only fires for BULLISH strategies
      // (the ones gate 4 would have rejected without the override).
      const isBullishForPenalty = ![
        'bearish_breakdown',
        'overbought_reversal',
        'weak_trend_breakdown',
        'mean_reversion_bounce',
        'volume_climax_reversal',
      ].includes(best.strategy);
      if (
        relax.allowHighVolRegime
        && relax.highVolConfidencePenalty > 0
        && regime.label === 'High Volatility Risk'
        && isBullishForPenalty
      ) {
        best.confidence = {
          ...best.confidence,
          finalScore: Math.max(0, best.confidence.finalScore - relax.highVolConfidencePenalty),
        };
      }

      // ── Step 10c: Canonical rejection engine ──────────────────
      // Phase-5 stricter thresholds. Defaults (60 / 1.5 / 70) are
      // tighter than the engine's own fallbacks (55 / 1.5 / 80) and
      // match the signals-table spec. Each value can be relaxed via
      // SIGNAL_ENGINE_MIN_CONFIDENCE / SIGNAL_ENGINE_MIN_RR /
      // SIGNAL_ENGINE_MAX_RISK_SCORE, or all at once with
      // SIGNAL_RELAX_MODE=true (which moves to 50 / 1.2 / 80).
      // `allowHighVolRegime` is consumed by gate 4 in
      // runRejectionEngine.ts.
      const strictStanceContext: RejectionInput['stanceContext'] = {
        stance:        'selective',
        conviction:    'medium',
        riskMode:      relax.allowHighVolRegime ? 'normal' : 'strict',
        // Spec "TEMPORARY RELAX FILTERS" — debug floors override the
        // active relax config when DEBUG_FORCE_SIGNAL=true. The
        // baseline relax floors are unchanged; this only widens the
        // engine's own gates for the duration of this debug scan.
        minConfidence: debugMinConfidence,
        minRR:         debugMinRR,
        maxRiskScore:  debugMaxRiskScore,
        allowHighVolRegime: relax.allowHighVolRegime,
      };

      // ── Phase-5 ORDER: scoring FIRST, then rejection ────────────
      // Per spec: runRejectionEngine MUST run after scoring and
      // before persistence. Phase-4 scoring is computed here so its
      // outputs (liquidity score, factor scores, classification)
      // are available to the rejection engine's Phase-5 numeric
      // gates (liquidity_score < 50, manipulation_risk > 60, etc.).
      const phase4 = runPhase4Scoring({
        strategyQuality:    best.confidence.finalScore,
        trendAlignment:     best.confidence.trendScore,
        momentum:           best.confidence.momentumScore,
        volumeConfirmation: best.confidence.volumeScore,
        liquidity:          null,                                  // derived below
        marketRegime:       best.confidence.contextScore ?? null,
        portfolioFit:       portfolioFit.fitScore,
        riskRewardRatio:    tradePlan.rrTarget1,
        volumeVs20dAvg:     features.volume.volumeVs20dAvg ?? null,
        atrPct:             features.volatility.atrPct ?? null,
        manipulationScore:  manipulationContext?.score ?? null,
        ageBars:            0,
        // Phase-3 per-strategy weights — calculateFinalScore uses
        // `strategy_quality 25, volume_confirmation 20, ...` for
        // bullish_breakout, etc. Falls back to global weights for
        // strategies without a preset.
        strategyName:       best.strategy,
        // No upstreamStatus yet — rejection engine has not run.
        // The override is applied AFTER rejection (see below).
      });

      const isBearish = BEARISH_STRATEGIES.has(best.strategy);
      const tradeDirection: 'BUY' | 'SELL' = isBearish ? 'SELL' : 'BUY';

      const rejectionInput: RejectionInput = {
        symbol,
        strategy: best.strategy,
        confidenceScore: best.confidence.finalScore,
        riskScore: riskBreakdown.totalRiskScore,
        rewardRisk: tradePlan.rrTarget1,
        entryPrice: tradePlan.entryZoneHigh,
        stopLoss: tradePlan.stopLoss,
        atrPct: features.volatility.atrPct,
        volume: features.volume.volume,
        regime: regime.label,
        sector: getSector(symbol),
        portfolioFit,
        executionReadiness: execution,
        manipulationContext,
        stanceContext: strictStanceContext,
        // Activate the staleness gate. At generation time age is 0h
        // (trivial pass), but the field records the signal's birth
        // in the audit snapshot and arms the gate for any caller
        // that re-runs the input with a back-dated generatedAt.
        generatedAt: new Date().toISOString(),
        // ── Phase-5 inputs (consume Phase-4 outputs) ────────────
        // Floors held in lock-step with the rejection engine's
        // recalibrated 2026-05 defaults (40 / 40). Bypass via
        // explicit override only — env-tunable thresholds belong
        // upstream in stanceContext, not pinned here.
        liquidityScore:   phase4.factor_scores.liquidity,
        minLiquidityScore: 40,
        minPortfolioFit:  40,
        maxManipulationRisk: 60,
        decayState:       'fresh',  // generation time
        liveInvalidated:  false,    // applyLiveSanity runs at API read time
        currentPrice:     null,     // not available in batch generation
        direction:        tradeDirection,
      };
      // Spec "FAIL LOUD" — increment BEFORE the engine call so a
      // throw inside runRejectionEngine still counts as "reached
      // decision stage" (the data flow got that far).
      stageReached.decision_stage++;
      const rejectionDecision: RejectionDecision = runRejectionEngine(rejectionInput);

      // Spec "FORCE ACCEPT TEST MODE" — DEBUG_FORCE_SIGNAL=true
      // force-approves the first 5 candidates that reach this gate,
      // regardless of what the rejection engine decided. Only the
      // FINAL gate is bypassed — every upstream gate (candle, R:R,
      // stop, sizing, fit) still ran and its result is in the audit
      // log. Loud per-row warning so this is never confused for a
      // real approval.
      if (
        DEBUG_FORCE_SIGNAL
        && debugForcedRemaining > 0
        && (rejectionDecision.finalDecision !== 'approved'
            || execution.approvalDecision !== 'approved')
      ) {
        console.warn('[DEBUG-FORCED-APPROVE]', {
          symbol,
          original_decision:           rejectionDecision.finalDecision,
          original_execution_decision: execution.approvalDecision,
          original_reason:             rejectionDecision.rejectionMessage ?? null,
          confidence:                  best.confidence.finalScore,
          final_score:                 phase4.final_score,
          risk_reward:                 tradePlan.rrTarget1,
          remaining_budget:            debugForcedRemaining - 1,
        });
        // Override BOTH the rejection-engine decision AND the
        // execution readiness decision. Earlier the override only
        // touched rejectionDecision; the post-rejection block below
        // never up-grades execution.approvalDecision, so a forced row
        // would be saved with status='watchlist' →
        // signal_status='DEVELOPING_SETUP' and fail the API's strict
        // filter (signal_status='APPROVED_SIGNAL'). Promoting BOTH
        // here ensures saveSignals stamps APPROVED_SIGNAL so the
        // forced row surfaces in /api/signals.
        //
        // signalStatus must be 'APPROVED_SIGNAL' too (not 'VALID_SIGNAL')
        // — that's the only Phase-3 signalStatus value the q365_signals
        // strict-tier SQL filter recognises.
        (rejectionDecision as any).finalDecision  = 'approved';
        (rejectionDecision as any).signalStatus   = 'APPROVED_SIGNAL';
        execution.approvalDecision                = 'approved';
        execution.status                          = 'approved' as any;
        // Spec "FIX FORCED SIGNAL VISIBILITY" — bumping rejection +
        // execution to 'approved' is not enough on its own. The API
        // read floors (STRICT_CONFIDENCE_FLOOR=55, STRICT_FINAL_FLOOR=60,
        // STRICT_RR_FLOOR=1.2 in confirmedSignalPolicy.ts) STILL filter
        // these rows out at /api/signals because force-approve doesn't
        // touch the underlying confidence/score values. Bump both to a
        // synthetic floor-clearing value so the row actually surfaces
        // in the dashboard. Confidence preserves the original ordering
        // among forced rows by adding the original score as a small
        // tiebreaker.
        const FORCED_CONFIDENCE_FLOOR = 65;
        const FORCED_FINAL_FLOOR      = 70;
        const originalConfidence      = best.confidence.finalScore;
        const originalFinalScore      = phase4.final_score;
        if (originalConfidence < FORCED_CONFIDENCE_FLOOR) {
          best.confidence = {
            ...best.confidence,
            finalScore: FORCED_CONFIDENCE_FLOOR + Math.min(10, originalConfidence / 10),
            band:       'Watchlist',
          };
        }
        if (originalFinalScore < FORCED_FINAL_FLOOR) {
          (phase4 as any).final_score =
            FORCED_FINAL_FLOOR + Math.min(10, originalFinalScore / 10);
        }
        // Spec "FIX FORCED SIGNAL VISIBILITY" §2 — also force the
        // classification. The classification was set by the scoring
        // engine's classify() based on the ORIGINAL low scores, which
        // hit the noTradeConfidence floor (50) → NO_TRADE. Without
        // this override, even after the score bumps land confidence
        // ≥65 and final ≥70, the persisted classification stays
        // NO_TRADE — which earlySignalApproved rejects on
        // raw_classification, hiding the row from /api/signals.
        //
        // Promote to VALID_SIGNAL (the tradeable middle band). Not
        // HIGH_CONVICTION because the bumped score still doesn't
        // reflect a real high-conviction setup; the operator can see
        // the [DEBUG-FORCED-APPROVE] log line to know this row was
        // synthesised from a force-approve, not the engine's organic
        // judgment.
        const originalClassification = phase4.classification;
        if (
          originalClassification === 'NO_TRADE'
          || originalClassification === 'DEVELOPING_SETUP'
        ) {
          (phase4 as any).classification = 'VALID_SIGNAL';
        }
        console.warn(
          `[DEBUG-FORCED-APPROVE] bumped scores+classification so the row clears the API floors: ` +
          `confidence ${originalConfidence}→${best.confidence.finalScore.toFixed(1)} ` +
          `final_score ${originalFinalScore.toFixed(1)}→${phase4.final_score.toFixed(1)} ` +
          `classification ${originalClassification}→${phase4.classification}`,
        );
        debugForcedRemaining--;
      }

      if (rejectionDecision.finalDecision === 'rejected') engineCounts.canonicalRejection.rejected++;
      else                                                 engineCounts.canonicalRejection.approved++;

      // ── Apply post-rejection classification override ──────────
      // calculateFinalScore is purely score-based; if the rejection
      // engine has decided NO_TRADE / DEVELOPING_SETUP, the band
      // must follow.
      let phase4Classification = phase4.classification;
      if (rejectionDecision.signalStatus === 'NO_TRADE')         phase4Classification = 'NO_TRADE';
      else if (rejectionDecision.signalStatus === 'DEVELOPING_SETUP') phase4Classification = 'DEVELOPING_SETUP';

      if (isSellCandidate && rejectionDecision.finalDecision !== 'rejected') {
        sellTrace.after_canonical_reject++;
      }

      // Override execution approval if rejection engine says no
      if (rejectionDecision.finalDecision === 'rejected' && execution.approvalDecision !== 'rejected') {
        execution.approvalDecision = 'rejected';
        execution.status = rejectionDecision.rejectionCode?.includes('manipulation')
          ? 'rejected_due_to_risk' as any
          : 'rejected_due_to_risk' as any;
        execution.reasons = [...execution.reasons, rejectionDecision.rejectionMessage ?? 'Rejection engine'];
      } else if (rejectionDecision.finalDecision === 'deferred' && execution.approvalDecision === 'approved') {
        execution.approvalDecision = 'deferred';
      }

      // ── Step 11: Lifecycle ──────────────────────────────────
      const { state, reason } = resolveInitialState(execution.approvalDecision, execution.status);
      const lifecycle = createLifecycle(state, reason);

      // ── Step 12: Track allocation ───────────────────────────
      if (execution.approvalDecision === 'approved') {
        approved++;
        runPortfolio.openPositions.push({
          symbol, side: direction, sector: getSector(symbol),
          grossValue: sizing.grossPositionValue,
          riskAllocated: sizing.riskBudgetAmount,
        });
        runPortfolio.cashAvailable -= sizing.grossPositionValue;
      } else if (execution.approvalDecision === 'deferred') {
        deferred++;
      } else {
        rejected++;
      }

      // Max approved per run
      if (approved >= p3Config.maxApprovedPerRun && execution.approvalDecision === 'approved') {
        // Don't add more, but still push the signal
      }

      if (isSellCandidate) sellTrace.final_saved++;

      // ── Step 12b: persist with Phase-4 scoring + override ────────
      // phase4 was computed BEFORE the rejection engine (Phase-5
      // order). phase4Classification was overridden above based on
      // the rejection result, so the band reflects the final decision.
      signals.push({
        symbol,
        signalType: best.strategy,
        signalSubtype: SUBTYPE_MAP[best.strategy],
        marketRegime: regime.label,
        confidenceScore: best.confidence.finalScore,
        confidenceBand: best.confidence.band,
        tradePlan,
        positionSizing: sizing,
        portfolioFit,
        executionReadiness: execution,
        riskBreakdown,
        lifecycle,
        // Carry forward for Phase 4 explanation engine
        features,
        confidenceBreakdown: best.confidence,
        standaloneRisk: best.risk,
        // ── Phase-4 scoring output (mandatory) ───────────────────
        final_score:       phase4.final_score,
        classification:    phase4Classification,
        factor_scores:     phase4.factor_scores,
        scoringFinalScore: phase4.final_score,        // legacy alias
        reasons: best.reasons,
        warnings: [...best.warnings, ...sizing.warnings, ...portfolioFit.penalties],
        generatedAt: now,
      });

      // Spec "ADD FULL REJECTION LOGGING" — per-symbol decision
      // record AFTER the row has been pushed so the log captures
      // the truly final approval state (post rejection-engine
      // override, post DEBUG-FORCED-APPROVE).
      logPhase3({
        symbol,
        confidence:      best.confidence.finalScore,
        final_score:     phase4.final_score,
        risk_reward:     tradePlan.rrTarget1,
        decision:        execution.approvalDecision === 'approved' ? 'approved'
                       : execution.approvalDecision === 'deferred' ? 'deferred'
                       : 'rejected',
        rejected_reason:
          execution.approvalDecision === 'approved' ? null
          : (rejectionDecision.rejectionMessage
             ?? execution.reasons[0]
             ?? `engine_decision: ${execution.approvalDecision}`),
      });
    }  // end for (const best of toBuild)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      rejectionLog.push({ symbol, reason: `Error: ${msg}` });
      logPhase3({
        symbol, confidence: null, final_score: null, risk_reward: null,
        decision: 'skipped', rejected_reason: `error: ${msg}`,
      });
    }
    // Per-batch progress for the scan loop.
    scannedCount++;
    if (scannedCount % BATCH_LOG_INTERVAL === 0 || scannedCount === TOTAL_TO_SCAN) {
      console.log(
        `[BATCH] ${scannedCount}/${TOTAL_TO_SCAN} symbols scanned ` +
        `(approved=${approved} deferred=${deferred} rejected=${rejected})`,
      );
      // Canonical pipeline-progress tag: coverage %, throughput, ETA.
      // ETA = (remaining symbols) × (mean ms/symbol so far). Falls back
      // to null in the first batch when elapsed_ms is too small to be
      // meaningful.
      const elapsedMs = Date.now() - phase3StartedAt;
      const remaining = Math.max(0, TOTAL_TO_SCAN - scannedCount);
      const meanMs    = scannedCount > 0 ? elapsedMs / scannedCount : 0;
      const etaMs     = elapsedMs > 1000 ? Math.round(meanMs * remaining) : null;
      const progressPayload = {
        stage:        'phase3',
        event:        'tick',
        scanned:      scannedCount,
        total:        TOTAL_TO_SCAN,
        coverage_pct: Math.round((scannedCount / Math.max(1, TOTAL_TO_SCAN)) * 1000) / 10,
        approved, deferred, rejected,
        elapsed_ms:   elapsedMs,
        eta_ms:       etaMs,
        eta_iso:      etaMs != null ? new Date(Date.now() + etaMs).toISOString() : null,
      };
      console.log('[PIPELINE_PROGRESS]', progressPayload);
      // Spec FULL-SCAN-2026-05 — mirror under the [FULL_SCAN_*] tag
      // family so SRE can grep for full-scan progress separately from
      // the heartbeat tier ([SCAN_COVERAGE] stage='scheduler.heartbeat').
      console.log('[FULL_SCAN_PROGRESS]', progressPayload);
    }
  }
  console.log(
    `[TOTAL FETCHED] Phase 3 complete — scanned=${TOTAL_TO_SCAN} ` +
    `approved=${approved} deferred=${deferred} rejected=${rejected} rejection_log_entries=${rejectionLog.length}`,
  );
  // Canonical scan-coverage tag — single greppable line that tells the
  // operator which fraction of the universe Phase 3 actually evaluated.
  // coverage_pct = scanned / universe; data_coverage_pct accounts for
  // candle-data freshness (skipped_no_data is the universe slice we
  // couldn't even read bars for). The two should track each other —
  // a wide gap means the candle layer is starving the engine.
  const phase3ElapsedMs = Date.now() - phase3StartedAt;
  console.log('[SCAN_COVERAGE]', {
    stage:             'phase3',
    universe:          TOTAL_TO_SCAN,
    scanned:           scannedCount,
    coverage_pct:      Math.round((scannedCount / Math.max(1, TOTAL_TO_SCAN)) * 1000) / 10,
    data_coverage_pct: Math.round(((TOTAL_TO_SCAN - phase3SkippedNoData) / Math.max(1, TOTAL_TO_SCAN)) * 1000) / 10,
    skipped_no_data:   phase3SkippedNoData,
    approved, deferred, rejected,
    elapsed_ms:        phase3ElapsedMs,
  });
  console.log('[PIPELINE_PROGRESS]', {
    stage:      'phase3',
    event:      'complete',
    elapsed_ms: phase3ElapsedMs,
    approved, deferred, rejected,
  });

  // Spec "FIND FIRST DROP POINT" — single-line stage attrition.
  // Reads top-down: each value is the count that SURVIVED that
  // stage. The first stage where the count drops sharply (or to
  // zero) is the bottleneck. e.g. candle_fetch=503 candle_valid=0
  // ⇒ the candle provider returned no usable bars for any symbol.
  console.log('[PHASE3 STAGE ATTRITION]', stageReached);

  // Spec "PIPELINE MUST ALWAYS COMPLETE" — historically this block
  // threw `PHASE3_NO_INPUT_DATA` when zero symbols reached the
  // decision stage. The throw was intended as fail-loud, but it
  // caused the entire pipeline to abort BEFORE Phase 4, BEFORE the
  // heartbeat, and BEFORE any partial-result tracking — so the API
  // surfaced `last_pipeline_run: null` and `total_persisted: null`
  // even though the diagnostic data needed to fix the upstream
  // problem (stage attrition counts) was already in hand. Convert
  // to a loud `[PHASE3_NO_INPUT_DATA]` warning + an entry in
  // rejectionLog so:
  //   • Phase 4 still runs (zero signals, but the run completes)
  //   • markPipelineHeartbeat fires (last_pipeline_run advances)
  //   • the operator sees the same diagnostic message, just
  //     non-fatal, with the first-drop stage and full counters.
  if (stageReached.decision_stage === 0) {
    const firstDrop = (() => {
      const order: (keyof typeof stageReached)[] = [
        'candle_fetch', 'candle_valid', 'not_stale',
        'features_valid', 'strategy_match', 'trade_plan_ok', 'decision_stage',
      ];
      for (let i = 1; i < order.length; i++) {
        if (stageReached[order[i]] === 0 && stageReached[order[i - 1]] > 0) {
          return `${order[i - 1]} → ${order[i]}`;
        }
      }
      return stageReached.candle_fetch === 0 ? 'before candle_fetch' : 'unknown';
    })();
    const warning =
      `[PHASE3_NO_INPUT_DATA] 0 symbols reached the decision stage. ` +
      `First drop: ${firstDrop}. Stage counts: ${JSON.stringify(stageReached)}. ` +
      `Pipeline continues (Phase 4 + heartbeat will still run).`;
    console.warn(warning);
    rejectionLog.push({ symbol: '*', reason: warning });
  }

  // Spec "PRINT SUMMARY" — single greppable aggregate at end of
  // Phase 3. Averages are over symbols where the field could be
  // computed (post-strategy-match), not the full universe — many
  // symbols don't reach the strategy engine at all so their
  // confidence/RR is null.
  const round1 = (n: number): number => Math.round(n * 10) / 10;
  console.log('[PHASE3 SUMMARY]', {
    total:           TOTAL_TO_SCAN,
    scanned:         scannedCount,
    skipped_no_data: phase3SkippedNoData,
    approved,
    deferred,
    rejected,
    avg_confidence:  phase3WithConf > 0 ? round1(phase3ConfSum / phase3WithConf) : null,
    avg_rr:          phase3WithRr   > 0 ? round1(phase3RrSum   / phase3WithRr)   : null,
    rejection_log_entries: rejectionLog.length,
    debug_force_signal: DEBUG_FORCE_SIGNAL,
    debug_forced_used:  DEBUG_FORCE_SIGNAL ? (5 - debugForcedRemaining) : 0,
    floors: {
      min_confidence: debugMinConfidence,
      min_rr:         debugMinRR,
      max_risk_score: debugMaxRiskScore,
    },
  });

  // Spec "LOG ALL REJECTION REASONS" + "TOP 3 FILTERS CAUSING
  // REJECTION" — single greppable line that ranks every rejection
  // bucket by frequency and surfaces the top 3. The operator can
  // spot the dominant filter without parsing 500 per-symbol lines.
  const rejHistEntries = Object.entries(rejReasonCounts)
    .sort((a, b) => b[1] - a[1]);
  const rejHistTotal = rejHistEntries.reduce((s, [, n]) => s + n, 0);
  console.log('[PHASE3 REJECTION HISTOGRAM]', {
    total_rejections: rejHistTotal,
    top3:             rejHistEntries.slice(0, 3).map(([reason, count]) => ({
      reason,
      count,
      pct: rejHistTotal > 0 ? Math.round((count / rejHistTotal) * 1000) / 10 : 0,
    })),
    all:              Object.fromEntries(rejHistEntries),
  });

  // ── Step 13: Rank by execution priority ───────────────────
  signals.sort((a, b) => {
    // Approved first, then deferred, then rejected
    const orderMap = { approved: 0, deferred: 1, rejected: 2 };
    const aOrder = orderMap[a.executionReadiness.approvalDecision] ?? 2;
    const bOrder = orderMap[b.executionReadiness.approvalDecision] ?? 2;
    if (aOrder !== bOrder) return aOrder - bOrder;

    // Within same approval: higher confidence first
    if (b.confidenceScore !== a.confidenceScore) return b.confidenceScore - a.confidenceScore;

    // Then lower risk
    return a.riskBreakdown.totalRiskScore - b.riskBreakdown.totalRiskScore;
  });

  // Assign priority ranks
  signals.forEach((s, i) => { s.executionReadiness.priorityRank = i + 1; });

  console.log(`[Phase3] Complete — ${signals.length} signals: ${approved} approved, ${deferred} deferred, ${rejected} rejected`);
  console.log(`🔥 Phase3 DONE: ${signals.length}`);

  // Emit one summary span per engine so the trace log shows what
  // each engine saw and produced across the full universe.
  for (const [name, counts] of Object.entries(engineCounts)) {
    const span = tracer.engine(name);
    span.input({ universe: p1Config.universe.length });
    span.end(counts as Record<string, number>);
  }

  phaseSpan.end({
    scanned: p1Config.universe.length,
    signals: signals.length,
    approved,
    deferred,
    rejected,
    regime: regime.label,
  });
  // ── [STRATEGY SUMMARY] — BUY/SELL roll-up at generation layer ─
  // Separate from [SELL DEBUG AGG] (which only counts bearish
  // strategy matches/rejections). This counts actual SIGNAL rows
  // produced per direction after Phase 3 has also run position-
  // sizing + portfolio-fit + execution gates. A mismatch between
  // the two — e.g. [SELL DEBUG AGG].matched = 40 but
  // [STRATEGY SUMMARY].sell_generated = 2 — points the operator
  // straight at the downstream gate eating the SELLs.
  let buyGenerated  = 0;
  let sellGenerated = 0;
  for (const s of signals) {
    if (BEARISH_STRATEGIES.has(s.signalType as any)) sellGenerated++;
    else                                             buyGenerated++;
  }
  // [SELL TRACE] — downstream attrition. The bottleneck is wherever
  // the count drops the most between consecutive stages.
  //
  //   generation → trade_plan : R:R or stop-width too wide
  //   trade_plan → sizing     : zero/invalid position size
  //   sizing     → fit        : portfolio fit score < 30
  //                             (direction imbalance now rebalancing-aware,
  //                              so this should be rare for SELLs unless
  //                              sector/correlation clusters bite)
  //   fit        → exec       : risk score > 75 or deferred by fit
  //   exec       → canonical  : canonical rejection engine (manipulation etc.)
  //   canonical  → saved      : always equal — a row past canonical is saved
  console.log('[SELL TRACE]', sellTrace);

  console.log('[STRATEGY SUMMARY]', {
    scanned:          p1Config.universe.length,
    total_generated:  signals.length,
    buy_generated:    buyGenerated,
    sell_generated:   sellGenerated,
    sell_ratio_pct:   signals.length > 0
      ? Math.round((sellGenerated / signals.length) * 100)
      : 0,
    regime:           regime.label,
    hint:
      sellGenerated === 0  ? 'Zero SELL at generation — see [SELL DEBUG AGG] above for bottleneck.' :
      sellGenerated < 10   ? 'Thin SELL pool — downstream auto-relax will kick in at /api/signals.' :
      'Healthy BUY/SELL mix at generation.',
  });

  // Spec INSTITUTIONAL §H — classification-band distribution + factor
  // visibility. When every row lands in WATCHLIST_ONLY / DEVELOPING_SETUP
  // the operator needs to see WHICH factor is dragging the final_score
  // below 65. The roll-up lists per-band counts; the per-factor average
  // tells you the dominant lever.
  if (signals.length > 0) {
    const bandCounts = new Map<string, number>();
    const factorTotals = {
      strategy_quality: 0, trend_alignment: 0, momentum: 0,
      volume_confirmation: 0, risk_reward: 0, liquidity: 0,
      market_regime: 0, portfolio_fit: 0,
    };
    let finalScoreTotal = 0;
    for (const s of signals) {
      const cls = String((s as any).classification ?? 'UNKNOWN');
      bandCounts.set(cls, (bandCounts.get(cls) ?? 0) + 1);
      const fs = (s as any).factor_scores;
      if (fs) {
        for (const k of Object.keys(factorTotals) as Array<keyof typeof factorTotals>) {
          factorTotals[k] += Number(fs[k] ?? 0);
        }
      }
      finalScoreTotal += Number((s as any).final_score ?? 0);
    }
    const avg = (n: number) => Math.round((n / signals.length) * 10) / 10;
    const bandLine = [...bandCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k}=${v}`)
      .join(' ');
    console.log(
      `[PHASE4_BANDS] ${bandLine} (avg_final_score=${avg(finalScoreTotal)})`,
    );
    console.log(
      `[PHASE4_FACTORS] avg over ${signals.length} signals — ` +
      `strategy=${avg(factorTotals.strategy_quality)} ` +
      `trend=${avg(factorTotals.trend_alignment)} ` +
      `momentum=${avg(factorTotals.momentum)} ` +
      `volume=${avg(factorTotals.volume_confirmation)} ` +
      `rr=${avg(factorTotals.risk_reward)} ` +
      `liquidity=${avg(factorTotals.liquidity)} ` +
      `regime=${avg(factorTotals.market_regime)} ` +
      `pfit=${avg(factorTotals.portfolio_fit)}`,
    );
    // If everything bottomed at WATCHLIST_ONLY (35-49 band) or below,
    // surface the diagnostic hint so the operator doesn't have to
    // remember which factor weights to inspect.
    const watchlistOnly = bandCounts.get('WATCHLIST_ONLY') ?? 0;
    const devSetup     = bandCounts.get('DEVELOPING_SETUP') ?? 0;
    const validSignal  = bandCounts.get('VALID_SIGNAL') ?? 0;
    const highConv     = bandCounts.get('HIGH_CONVICTION') ?? 0;
    const instConv     = bandCounts.get('INSTITUTIONAL_HIGH_CONVICTION') ?? 0;
    if (highConv + instConv === 0 && (watchlistOnly + devSetup) > signals.length * 0.5) {
      console.warn(
        `[PHASE4_BANDS] WARN — no HIGH_CONVICTION rows produced, ` +
        `${watchlistOnly} WATCHLIST_ONLY + ${devSetup} DEVELOPING_SETUP + ${validSignal} VALID_SIGNAL. ` +
        `Check the [PHASE4_FACTORS] line above — the lowest-average factor is the bottleneck. ` +
        `Common causes: (a) Phase-1 strategy confidence too low (most signals at conf 50-60 → ` +
        `strategyQuality factor capped at ~55), (b) atrPct > 4% triggering volatility-shock penalty ` +
        `(up to -30 points), (c) marketRegime context score low for current market.`,
      );
    }
  }

  // Flush the SELL generation aggregate — one line per scan that
  // tells the operator EXACTLY how many bearish strategy
  // candidates matched vs. were rejected, and which gate killed
  // them.
  flushSellDebugAgg();
  // Spec INSTITUTIONAL §I — canonical 11-field approval funnel. The
  // upstream-counted refusals (low_final_score / market_regime /
  // volatility / etc.) are derived from the rejectionLog so the line
  // captures every gate even when it lives in a different module.
  // Pattern-match on the message so a new gate added later still
  // surfaces in the right bucket.
  const upstreamCounts = (() => {
    const counts = {
      rejected_low_final_score: 0,
      rejected_market_regime:   0,
      rejected_volatility:      0,
    };
    for (const r of rejectionLog) {
      const t = String(r.reason ?? '').toLowerCase();
      if (/final[_ ]?score/.test(t) || /low score/.test(t)) counts.rejected_low_final_score++;
      if (/regime/.test(t) || /counter[- ]regime/.test(t))   counts.rejected_market_regime++;
      if (/volatility|atr|high vol/.test(t))                 counts.rejected_volatility++;
    }
    return counts;
  })();
  flushApprovalGateAggregator(upstreamCounts);
  if (softStaleCount > 0) {
    console.log(
      `[STRATEGY] soft_stale_passes=${softStaleCount} (candles older than ${relax.staleCandleSoftHours}h but within ${relax.staleCandleMaxDays}d — confidence reduced by ${relax.staleCandlePenaltyPct} pts)`,
    );
  }
  // Spec INSTITUTIONAL §C — per-stage skip counts so an operator can
  // see exactly where the universe attrited. The numbers come from
  // stageReached (incremented at the top of each stage) + the engine
  // counters. Compute deltas so each [PHASE3_SKIPPED] field reads as
  // "how many rows were dropped AT this stage".
  const skippedNoCandles  = TOTAL_TO_SCAN              - stageReached.candle_valid;
  const skippedStaleAge   = stageReached.candle_valid  - stageReached.not_stale;
  const skippedFeatures   = stageReached.not_stale     - stageReached.features_valid;
  const skippedNoStrategy = stageReached.features_valid - stageReached.strategy_match;
  const skippedTradePlan  = stageReached.strategy_match - stageReached.trade_plan_ok;
  const skippedDecision   = stageReached.trade_plan_ok  - stageReached.decision_stage;
  console.log(
    `[PHASE3_SKIPPED] no_candles=${skippedNoCandles} ` +
    `stale_age=${skippedStaleAge} ` +
    `features_invalid=${skippedFeatures} ` +
    `no_strategy_match=${skippedNoStrategy} ` +
    `trade_plan_failed=${skippedTradePlan} ` +
    `pre_decision_drop=${skippedDecision}`,
  );
  // Spec INSTITUTIONAL §C — final completeness marker. operator greps
  // `[PHASE3_COMPLETE]` for the canonical "Phase 3 finished and these
  // are the per-stage survivors" envelope.
  console.log(
    `[PHASE3_COMPLETE] received=${TOTAL_TO_SCAN} scanned=${scannedCount} ` +
    `candle_fetch=${stageReached.candle_fetch} ` +
    `candle_valid=${stageReached.candle_valid} ` +
    `not_stale=${stageReached.not_stale} ` +
    `features_valid=${stageReached.features_valid} ` +
    `strategy_match=${stageReached.strategy_match} ` +
    `trade_plan_ok=${stageReached.trade_plan_ok} ` +
    `decision_stage=${stageReached.decision_stage} ` +
    `signals=${signals.length} approved=${approved} deferred=${deferred} rejected=${rejected}`,
  );
  if (scannedCount < TOTAL_TO_SCAN) {
    console.warn(
      `[SCAN_EXIT] EARLY EXIT — scanned=${scannedCount} of ${TOTAL_TO_SCAN} expected. ` +
      `Investigate the for-of loop body; this should never happen under the ` +
      `synchronous structure.`,
    );
  }
  // Spec "scanned reflects what we processed" — the previous return
  // reported `p1Config.universe.length` regardless of whether the
  // for-loop ran. When benchmark fetch threw upstream, scanned was
  // claimed = N but the loop never executed. Return scannedCount so
  // result.meta.scanned = symbols actually iterated.
  return { regime, signals, scanned: scannedCount, approved, deferred, rejected, rejectionLog };
}
