// ════════════════════════════════════════════════════════════════
//  Quantorus365 Signal Engine — Phase 1 Constants
// ════════════════════════════════════════════════════════════════

import type { Phase1Config } from '../types/signalEngine.types';
import { initOnce } from '@/lib/marketData/nifty500Universe';

// ── Indicator Periods ────────────────────────────────────────
export const EMA_FAST = 20;
export const EMA_MID = 50;
export const EMA_SLOW = 200;
export const RSI_PERIOD = 14;
export const MACD_FAST = 12;
export const MACD_SLOW = 26;
export const MACD_SIGNAL = 9;
export const ATR_PERIOD = 14;
export const ROC_SHORT = 5;
export const ROC_LONG = 20;
export const VOLUME_AVG_PERIOD = 20;
export const STRUCTURE_LOOKBACK = 20;
export const STOCHASTIC_K_PERIOD = 14;
export const STOCHASTIC_D_PERIOD = 3;
export const BOLLINGER_PERIOD = 20;
export const BOLLINGER_STD_DEV = 2;
export const ADX_PERIOD = 14;
export const OBV_SLOPE_PERIOD = 10;
export const VWAP_PERIOD = 20;
export const VOLUME_CLIMAX_THRESHOLD = 3.0;
export const DIVERGENCE_LOOKBACK = 10;

// ── Breakout ─────────────────────────────────────────────────
export const BREAKOUT_BUFFER = 1.002;
export const MAX_BREAKOUT_EXTENSION_PCT = 5.0;
export const MAX_GAP_PCT = 4.0;
export const MAX_ATR_PCT = 6.0;

// ── Strategy Thresholds ──────────────────────────────────────
export const MIN_VOLUME_EXPANSION = 1.5;
export const RSI_LOWER_BOUND = 55;
export const RSI_UPPER_BOUND = 72;
export const MAX_DISTANCE_FROM_EMA20_PCT = 8.0;

// ── Liquidity Filters ────────────────────────────────────────
export const MIN_AVG_VOLUME = 100_000;
export const MIN_PRICE = 50;

// ── Confidence Scoring Weights ───────────────────────────────
export const CONFIDENCE_WEIGHTS = {
  trend: 25,
  momentum: 20,
  volume: 20,
  structure: 20,
  context: 15,
} as const;

// ── Confidence Bands ─────────────────────────────────────────
//
// Spec INSTITUTIONAL §H (calibrated 2026-05) — Watchlist→Actionable
// boundary lowered 70→60 so production confidence values in the
// 60-69 band are eligible for approval. The previous 70 floor caused
// the executionReadiness gate to defer ~93% of matched signals into
// DEVELOPING_SETUP because the typical Phase-1 strategy confidence
// distribution centres on 55-65 (rare to exceed 70 outside breakouts
// in trending markets).
//
// Quality is preserved by the rejection-engine downstream gates
// (RR≥1.5, risk_score≤75, portfolio_fit≥40, manipulation_risk≤60)
// which still hold the institutional bar.
//
// Env knobs (clamped 0..100):
//   CONFIDENCE_BAND_HIGH_CONVICTION   default 85
//   CONFIDENCE_BAND_ACTIONABLE        default 60  (was hardcoded 70)
//   CONFIDENCE_BAND_WATCHLIST         default 55
function envBand(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  if (!Number.isFinite(raw)) return fallback;
  return Math.max(0, Math.min(100, Math.floor(raw)));
}
export const CONFIDENCE_HIGH_CONVICTION = envBand('CONFIDENCE_BAND_HIGH_CONVICTION', 85);
export const CONFIDENCE_ACTIONABLE      = envBand('CONFIDENCE_BAND_ACTIONABLE',      60);
export const CONFIDENCE_WATCHLIST       = envBand('CONFIDENCE_BAND_WATCHLIST',       55);

// ── Risk Bands ───────────────────────────────────────────────
export const RISK_LOW = 30;
export const RISK_MODERATE = 55;
export const RISK_ELEVATED = 75;

// ── Pipeline Defaults ────────────────────────────────────────
// MIN_CANDLE_COUNT: 80 candles is the absolute minimum for our
// indicator stack (longest lookback = 50-day SMA + buffer).
//
// MIN_CONFIDENCE_TO_SAVE: kept as a constant for backward compat
// with old config consumers, but the pipeline NO LONGER uses it
// as an early drop filter. Every scored signal flows through to
// the API which sorts by confidence desc and slices the top 50.
// The actual quality floor is now applied at API output time
// via FINAL_CONFIDENCE_FLOOR below.
// ════════════════════════════════════════════════════════════════
//  Strategy relax config — env-overridable trading gates.
//
//  Per spec "FIX ZERO SIGNAL GENERATION", operators occasionally
//  need to soften the engine's strict gates without a code change.
//  These constants centralise the values that gate Phase 3 rejection
//  + the candle staleness check, exposing them via env so the
//  trading-threshold decision is EXPLICIT (env var set) rather than
//  silent (constant edit).
//
//  Two layers of override:
//
//    1. `SIGNAL_RELAX_MODE=true` (meta-flag) — applies relaxed
//       defaults to every gate at once. Use this when you want the
//       full degraded-mode behavior in one switch.
//
//    2. Individual `SIGNAL_ENGINE_*` envs — override specific gates
//       only. These win over the meta-flag.
//
//  Defaults preserve the institutional strict behavior. The relax
//  values are documented in the helper below so a code reader can
//  see the trade-off being made.
// ════════════════════════════════════════════════════════════════
export interface StrategyRelaxConfig {
  staleCandleMaxDays:  number;
  /** Soft-stale window in HOURS. When a candle's newest bar is older
   *  than this but still within `staleCandleMaxDays`, the row is NOT
   *  rejected — instead, the per-symbol confidence score is reduced
   *  by `staleCandlePenaltyPct` and the row is flagged with the
   *  `is_stale_candidate` marker. Set to null/0 to disable (default
   *  behavior — staleness is binary up to maxDays). Per spec
   *  "FIX ZERO SIGNAL ISSUE" §2: degrade-don't-reject for partial
   *  candle freshness. */
  staleCandleSoftHours:    number | null;
  /** Confidence-score reduction (in points) when soft-stale or
   *  high-vol soft-pass fires. 10–15 per spec; default 12. */
  staleCandlePenaltyPct:   number;
  highVolConfidencePenalty: number;
  minConfidence:       number;
  minRR:               number;
  maxRiskScore:        number;
  allowHighVolRegime:  boolean;
  /** True when SIGNAL_RELAX_MODE is on OR any individual override is
   *  active. Used by the boot log to flag degraded behavior. */
  active:              boolean;
  /** True when SIGNAL_RELAX_MODE specifically is on. */
  relaxModeFlag:       boolean;
}

function envBool(name: string): boolean | null {
  const raw = (process.env[name] ?? '').trim().toLowerCase();
  if (raw === '') return null;
  if (raw === 'true' || raw === '1' || raw === 'yes' || raw === 'on') return true;
  if (raw === 'false' || raw === '0' || raw === 'no' || raw === 'off') return false;
  return null;
}
function envNum(name: string, lo: number, hi: number): number | null {
  const raw = Number(process.env[name]);
  if (!Number.isFinite(raw)) return null;
  return Math.max(lo, Math.min(hi, raw));
}

/**
 * Resolve the active strategy-relax config from env. Read every time
 * (cheap — handful of env reads) so an operator who flips
 * SIGNAL_RELAX_MODE doesn't need a process restart in dev.
 */
export function getStrategyRelaxConfig(): StrategyRelaxConfig {
  const relaxMode = envBool('SIGNAL_RELAX_MODE') === true;

  // STRICT defaults (institutional baseline, recalibrated 2026-05).
  //   staleCandleMaxDays:   3  — older bars produce trade plans against
  //                              stale prices that can't be executed.
  //   staleCandleSoftHours: 12 — within 12h–3d, accept with confidence
  //                              penalty so partial-freshness lags do
  //                              NOT empty the output pool.
  //   minConfidence:        55 — recalibrated from 60. The Phase-3 score
  //                              distribution centers ~50–70; a 60 floor
  //                              cut into the meat of the band and was
  //                              the #1 cause of "engine produces zero".
  //                              55 = the watchlist boundary (V2.10).
  //   minRR:                1.3 — recalibrated from 1.5. The Phase-3
  //                              internal floor is 1.2; the rejection
  //                              engine's 1.5 was a second cut on top
  //                              that disqualified clean 1.3 setups.
  //   maxRiskScore:         70 — risk above 70 = position sizing
  //                              dominates over edge.
  //   allowHighVolRegime:   true — soft-warn (with confidence penalty)
  //                              instead of hard-reject. Bearish regime
  //                              still blocks bullish entries; the high-
  //                              vol case is now a calibrated pass.
  let staleCandleMaxDays  = 3;
  let staleCandleSoftHours: number | null = 12;       // 12h–3d soft-stale window
  let staleCandlePenaltyPct = 12;
  let highVolConfidencePenalty = 12;
  let minConfidence       = 55;
  let minRR               = 1.3;
  let maxRiskScore        = 70;
  let allowHighVolRegime  = true;

  // RELAXED defaults (when SIGNAL_RELAX_MODE=true). Each value moves
  // ONE notch off strict — we don't go to "anything goes" because
  // that produces noise, not signals.
  if (relaxMode) {
    staleCandleMaxDays   = 7;     // accept up to a week of staleness
    staleCandleSoftHours = 12;    // 12h–7d range = soft, with penalty
    minConfidence        = 30;    // Spec "FIX ZERO SIGNALS" — lowered
                                   // 50→30 so weak-but-present setups
                                   // surface in the empty-pool fallback
                                   // path. 30 is below institutional
                                   // calibration; pair only with
                                   // SIGNAL_RELAX_MODE for testing /
                                   // bootstrap scenarios.
    minRR                = 1.2;   // matches the Phase 3 internal floor
    maxRiskScore         = 80;    // allow higher-risk setups through
    allowHighVolRegime   = true;  // soft-warn instead of hard-reject
                                   // bullish strategies in vol regimes
  }

  // Individual overrides win over the meta-flag, in case the operator
  // wants to relax ONE gate but keep the rest strict.
  staleCandleMaxDays = envNum('SIGNAL_ENGINE_STALE_CANDLE_MAX_DAYS', 1, 30) ?? staleCandleMaxDays;
  // Soft-stale window in hours (0 disables). Defaults to null in
  // strict mode, 12 in relax mode. Operators tune via env.
  const softHoursOverride = envNum('SIGNAL_ENGINE_STALE_CANDLE_SOFT_HOURS', 0, 24 * 30);
  if (softHoursOverride !== null) {
    staleCandleSoftHours = softHoursOverride > 0 ? softHoursOverride : null;
  }
  staleCandlePenaltyPct = envNum('SIGNAL_ENGINE_STALE_CANDLE_PENALTY', 0, 50) ?? staleCandlePenaltyPct;
  highVolConfidencePenalty = envNum('SIGNAL_ENGINE_HIGH_VOL_PENALTY',  0, 50) ?? highVolConfidencePenalty;
  minConfidence      = envNum('SIGNAL_ENGINE_MIN_CONFIDENCE',       0, 100) ?? minConfidence;
  minRR              = envNum('SIGNAL_ENGINE_MIN_RR',             0.5, 5.0) ?? minRR;
  maxRiskScore       = envNum('SIGNAL_ENGINE_MAX_RISK_SCORE',       0, 100) ?? maxRiskScore;
  const overrideHighVol = envBool('SIGNAL_ENGINE_ALLOW_HIGH_VOL_REGIME');
  if (overrideHighVol !== null) allowHighVolRegime = overrideHighVol;

  // Compare against strict defaults to decide whether the config is
  // actually doing something. Used by the boot log. Defaults updated
  // 2026-05 — see strict-defaults block above.
  const active =
    relaxMode ||
    staleCandleMaxDays !== 3 ||
    staleCandleSoftHours !== 12 ||
    minConfidence      !== 55 ||
    minRR              !== 1.3 ||
    maxRiskScore       !== 70 ||
    allowHighVolRegime !== true;

  return {
    staleCandleMaxDays,
    staleCandleSoftHours,
    staleCandlePenaltyPct,
    highVolConfidencePenalty,
    minConfidence,
    minRR,
    maxRiskScore,
    allowHighVolRegime,
    active,
    relaxModeFlag: relaxMode,
  };
}

/**
 * Minimum number of daily bars a symbol must have before the strategy
 * engine will score it. Default 80 — that's the bar window the
 * indicators (longer-period EMAs, ATR, regime classifier) need to
 * produce a stable reading. Going below 80 means some indicators run
 * on truncated history and can mis-classify regime / volatility.
 *
 * Env override: SIGNAL_ENGINE_MIN_CANDLE_COUNT. Floored at 30 (below
 * which most multi-EMA setups produce garbage) and ceilinged at 250
 * (one trading year — anything more is wasted history).
 *
 * Per spec "FULL SYSTEM FIX" §3, operators may drop this to 50 when
 * the dev plan's /historical_data is partial. Be aware that setting
 * this lower trades recall against signal quality — short-history
 * symbols may produce false breakouts the engine couldn't have
 * detected with proper depth.
 */
export const MIN_CANDLE_COUNT = (() => {
  const raw = Number(process.env.SIGNAL_ENGINE_MIN_CANDLE_COUNT);
  if (Number.isFinite(raw) && raw >= 30 && raw <= 250) return Math.trunc(raw);
  return 80;
})();
export const MIN_CONFIDENCE_TO_SAVE = 0;

// API-output confidence floor. Signals below this score are
// dropped at READ time (not generation time). Set to 0 so the
// API always returns the top 50 by confidence regardless of
// score — the user explicitly wants SIGNALS=50 every render,
// and this is the only way to guarantee that without
// fabricating data. UI ConfBar still shows per-row confidence
// so weak signals are visually distinguishable.
export const FINAL_CONFIDENCE_FLOOR = 0;

export const STOP_ATR_MULTIPLIER = 1.5;
export const TARGET1_R_MULTIPLE = 1.5;
export const TARGET2_R_MULTIPLE = 2.5;

// ── Allowed Regimes for Bullish Breakout ─────────────────────
export const BULLISH_ALLOWED_REGIMES = ['Strong Bullish', 'Bullish'] as const;

// ── Default Phase 1 Config — universe is q365_universe-locked ──
//
// NIFTY500_LOCK_ENABLED contract: the universe is sourced EXCLUSIVELY
// from `q365_universe WHERE is_active = 1` via the DB-backed loader
// in @/lib/marketData/nifty500Universe. The CSV (`ind_nifty500list.csv`)
// is a SEED file used only by `scripts/loadNifty500.ts` and is never
// read at runtime. The legacy `nseUniverse.json` seed is also dropped.
//
// `TRADEABLE_UNIVERSE` is intentionally an empty `string[]` at module
// load. `loadTradeableUniverse()` (called from instrumentation.ts at
// boot) hydrates it from the DB and mutates the array IN PLACE so
// every consumer that already holds a reference to
// `DEFAULT_PHASE1_CONFIG.universe` sees the populated list on first
// read after boot. Touching the array before boot is intentional
// undefined behaviour — the in-process universe loader will throw
// from its sync getters in that case, which is the correct fail-fast.
const TRADEABLE_UNIVERSE: string[] = [];

/** Hydrate `TRADEABLE_UNIVERSE` from `q365_universe(is_active=1)` and
 *  return the populated array. Idempotent + race-safe — repeated /
 *  concurrent callers share the same in-flight Promise via
 *  `initOnce()`'s shared lock. Throws when the DB returns fewer than
 *  NIFTY500_MIN_SIZE symbols (the in-process loader's fail-fast
 *  contract); the caller (instrumentation.ts in production) MUST let
 *  that throw propagate so Next refuses to boot rather than scan a
 *  degraded universe.
 *
 *  Note: `initOnce()` itself also mutates this array in place after
 *  a successful DB load, so any entry-point guard that calls
 *  `initOnce()` directly (e.g. /api/signals) leaves TRADEABLE_UNIVERSE
 *  populated too. This wrapper is kept for the existing
 *  instrumentation + scheduler call sites and acts as the canonical
 *  superset entry point for code paths that explicitly need the
 *  array reference back. */
export async function loadTradeableUniverse(): Promise<string[]> {
  const { symbols } = await initOnce();
  // Defensive — initOnce already mutates TRADEABLE_UNIVERSE on first
  // success via dynamic import, but re-mutate here for the case
  // where it couldn't (the dynamic import inside initOnce is
  // best-effort and logs a warning on failure).
  if (TRADEABLE_UNIVERSE.length !== symbols.length) {
    TRADEABLE_UNIVERSE.length = 0;
    for (const s of symbols) TRADEABLE_UNIVERSE.push(s);
  }
  return TRADEABLE_UNIVERSE;
}

export const DEFAULT_PHASE1_CONFIG: Phase1Config = {
  universe: TRADEABLE_UNIVERSE,
  benchmarkSymbol: 'NIFTY 50',
  timeframe: 'daily',
  minCandleCount: MIN_CANDLE_COUNT,
  breakoutBuffer: BREAKOUT_BUFFER,
  minAvgVolume: MIN_AVG_VOLUME,
  minPrice: MIN_PRICE,
  minConfidenceToSave: MIN_CONFIDENCE_TO_SAVE,
};
