// ════════════════════════════════════════════════════════════════
//  Signal Maturity Scorer
//
//  Pure scoring function. Takes the latest scanner row for a
//  (symbol, direction) plus the rolling history captured by the
//  maturity tracker, and returns a 0-100 maturity score with
//  per-factor breakdown.
//
//  Design principle (from the spec): an experienced discretionary
//  trader with systematic discipline. We do NOT optimise for the
//  earliest signal. We optimise for the trustworthy one. A score
//  of 85+ requires evidence of:
//    - persistence across multiple scanner cycles
//    - stability of the trade plan (entry/stop/target don't drift)
//    - confluence of factors (multi-factor agreement)
//    - regime support (don't fade the regime without strong reason)
//    - decay headroom (signal is fresh, not stale)
//
//  Each of the ten scoring factors below maps to one of the bullets
//  in the spec. Every factor outputs a 0-1 partial score, weighted
//  into the composite.
// ════════════════════════════════════════════════════════════════

export type MaturityStage =
  | 'candidate'
  | 'developing'
  | 'mature'
  | 'promoted'
  | 'terminated';

export type ConvictionLevel = 'MEDIUM' | 'HIGH' | 'INSTITUTIONAL';

/**
 * One snapshot of the scanner row at evaluation time. Persisted in
 * the tracker's stability_history_json so the scorer can reason
 * about drift across cycles.
 */
export interface StabilitySnapshot {
  cycle:          number;       // 1-based
  ts:             number;       // ms epoch when this cycle was recorded
  entry_price:    number;
  stop_loss:      number;
  target1:        number;
  confidence:     number;       // 0-100
  final_score:    number | null;
  decay_state:    string | null;
}

/** Live state from the latest q365_signals row for this (symbol, dir). */
export interface MaturityScorerInput {
  symbol:               string;
  direction:            'BUY' | 'SELL';
  /** Current scanner-row state. */
  current: {
    entry_price:        number;
    stop_loss:          number;
    target1:            number;
    confidence:         number;
    final_score:        number | null;
    decay_state:        string | null;
    classification:     string | null;
    factor_scores:      Record<string, number> | null;
    market_regime:      string | null;
    pct_change:         number | null;
    /** Optional: news/event shock magnitude in [0,1]. Higher = bigger shock. */
    news_shock:         number | null;
  };
  /** Tracker rolling state. */
  tracker: {
    first_detected_at:  number; // ms epoch
    last_seen_at:       number; // ms epoch
    cycles:             number;
    history:            StabilitySnapshot[];
  };
  /** Server time for age calc. Defaults to Date.now(). */
  now?: number;
}

export interface MaturityFactor {
  name:        string;
  weight:      number;      // 0-1, sums to 1 across factors
  raw:         number;      // factor's own 0-1 score
  contribution: number;     // weight * raw * 100, summed → composite
}

/** The scorer only ever emits one of the three primary stages.
 *  'promoted' / 'terminated' are tracker-row-only states applied by
 *  the worker / lifecycle, not the scorer. */
export type ComputedMaturityStage = 'candidate' | 'developing' | 'mature';

export interface MaturityScorerOutput {
  score:           number;            // 0-100, composite
  stage:           ComputedMaturityStage;
  stable:          boolean;           // drift within tolerance across cycles?
  convictionLevel: ConvictionLevel;
  factors:         MaturityFactor[];
  /** Minutes since first_detected_at — drives the seasoning gate. */
  signalAgeMinutes: number;
  /** Each rejection-style reason that pushed the score down. Useful
   *  for the UI's "why is this still developing?" tooltip. */
  reasons:         string[];
}

// ════════════════════════════════════════════════════════════════
//  Tunables
//
//  MATURATION_AUDIT_2026-05 — calibrated for actual Indian market
//  conditions. The previous defaults were unreachable in practice:
//    • 1.5% price drift / 8-pt confidence drift killed stability for
//      almost every row (Indian stocks routinely move 1-2% intraday;
//      Phase 4 confidence naturally swings 5-15 pts across cycles).
//    • 85-pt mature threshold required the 16-pt stability factor to
//      be near-perfect; with stability halved on instability, no row
//      could reach 85.
//  All thresholds are env-tunable so an operator can re-tighten
//  without editing constants.
// ════════════════════════════════════════════════════════════════
function tunable(envName: string, fallback: number, lo: number, hi: number): number {
  const raw = Number(process.env[envName]);
  if (!Number.isFinite(raw)) return fallback;
  return Math.max(lo, Math.min(hi, raw));
}
const STAGE_DEVELOPING_THRESHOLD = tunable('MATURITY_DEVELOPING_THRESHOLD', 55, 30,  90);
// MATURATION_AUDIT_2026-05 — default 75 → 70. The operator's APPROVED
// acceptance criteria is "maturity ≥ 70 + cycles ≥ 3 + stable + conf ≥
// 70 + composite_final_score ≥ 60 → graduate to APPROVED". The previous
// 75 floor kept rows that satisfied every other criterion stuck in
// stage='developing' (the maturity scorer's own per-cycle output), so
// isPromotable returned false and the maturity worker never invoked
// insertConfirmedSnapshotIfEligible — the row never even reached the
// snapshot writer's gate stack. Aligning the default with the operator
// criteria lets stage='mature' fire at the user-specified bar; env
// override (MATURITY_MATURE_THRESHOLD) still raises it for ops who want
// the legacy stricter bar.
const STAGE_MATURE_THRESHOLD     = tunable('MATURITY_MATURE_THRESHOLD',     70, 60, 100);
const CONVICTION_INSTITUTIONAL_THRESHOLD = tunable('MATURITY_CONVICTION_INSTITUTIONAL_THRESHOLD', 88, 80, 100);

/** Drift tolerance for a "stable" trade plan. % of entry. Was 1.5%
 *  — too tight for Indian intraday volatility. 2.5% accepts the
 *  natural noise without admitting truly redrawn plans. */
const STABILITY_DRIFT_TOLERANCE = tunable('MATURITY_PRICE_DRIFT_TOLERANCE', 0.025, 0.005, 0.10);

/** Confidence drift tolerance — points on a 0-100 scale. Was 8 — too
 *  tight given Phase 4 confidence's natural per-cycle variance. 15
 *  accepts genuine confidence stability without rewarding random
 *  oscillation. */
const STABILITY_CONFIDENCE_TOLERANCE = tunable('MATURITY_CONF_DRIFT_TOLERANCE', 15, 3, 50);

/** Stability raw-score threshold for the smooth promotion gate. The
 *  legacy `isPromotable` required hard `stable=true` (binary), which
 *  vetoed promotion on a single drift event regardless of score.
 *  The smooth gate accepts mostly-stable plans (raw ≥ 0.55) so a row
 *  with one minor drift in three cycles still graduates. Range
 *  [0, 1]; default 0.55 ≈ "more than half the drift budget unused". */
const STABILITY_RAW_PROMOTION_FLOOR = tunable('MATURITY_STABILITY_RAW_FLOOR', 0.55, 0, 1);

// Factor weights — must sum to 1.0. Tuned so persistence + stability
// + multi-factor agreement dominate, with regime / decay / shock as
// disqualifiers rather than primary drivers.
const W_PERSISTENCE          = 0.16;
const W_STABILITY            = 0.16;
const W_TREND_CONTINUATION   = 0.12;
const W_VOLUME_PERSISTENCE   = 0.10;
const W_BREAKOUT_HOLD        = 0.08;
const W_FALSE_SIGNAL_PENALTY = 0.08;
const W_MULTI_FACTOR         = 0.12;
const W_REGIME_ALIGNMENT     = 0.08;
const W_NEWS_SHOCK_PENALTY   = 0.04;
const W_DECAY_RISK           = 0.06;
// Sum: 1.00

// ════════════════════════════════════════════════════════════════
//  Per-factor scorers — each returns a 0-1 partial.
// ════════════════════════════════════════════════════════════════

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

/**
 * Persistence — how many cycles the signal has survived. Capped at
 * 6 cycles so a 6+ cycle signal isn't double-rewarded over a 3-cycle
 * one (after that the marginal benefit is small; stability and
 * trend-continuation pick up the slack).
 */
function scorePersistence(cycles: number): number {
  if (cycles <= 0) return 0;
  if (cycles >= 6) return 1;
  return cycles / 6;
}

/**
 * Stability — drift in entry/stop/target/confidence across cycles.
 * Returns 1 when the trade plan hasn't moved meaningfully, 0 when
 * it's been redrawn between cycles. Single-cycle signals score 0.5
 * (we haven't seen enough to judge stability either way).
 */
function scoreStability(history: StabilitySnapshot[]): { raw: number; stable: boolean } {
  if (history.length < 2) return { raw: 0.5, stable: false };

  const entries     = history.map((h) => h.entry_price).filter((v) => Number.isFinite(v) && v > 0);
  const stops       = history.map((h) => h.stop_loss).filter((v) => Number.isFinite(v) && v > 0);
  const targets     = history.map((h) => h.target1).filter((v) => Number.isFinite(v) && v > 0);
  const confidences = history.map((h) => h.confidence).filter((v) => Number.isFinite(v));

  if (entries.length < 2) return { raw: 0.5, stable: false };

  const entryAvg = entries.reduce((a, b) => a + b, 0) / entries.length;
  const driftEntry  = Math.max(...entries.map((v) => Math.abs(v - entryAvg) / entryAvg));
  const driftStop   = stops.length   >= 2 ? Math.max(...stops.map((v)   => Math.abs(v - stops[0])   / Math.max(1, stops[0])))   : 0;
  const driftTarget = targets.length >= 2 ? Math.max(...targets.map((v) => Math.abs(v - targets[0]) / Math.max(1, targets[0]))) : 0;
  const driftConf   = confidences.length >= 2
    ? Math.max(...confidences.map((v) => Math.abs(v - confidences[0])))
    : 0;

  const priceWithinTol = driftEntry  <= STABILITY_DRIFT_TOLERANCE
                      && driftStop   <= STABILITY_DRIFT_TOLERANCE * 1.5
                      && driftTarget <= STABILITY_DRIFT_TOLERANCE * 1.5;
  const confWithinTol  = driftConf <= STABILITY_CONFIDENCE_TOLERANCE;
  const stable = priceWithinTol && confWithinTol;

  // Smooth scoring: 1 at zero drift, falling to 0 at 3x tolerance.
  const priceFactor = clamp01(1 - (driftEntry / (STABILITY_DRIFT_TOLERANCE * 3)));
  const confFactor  = clamp01(1 - (driftConf / (STABILITY_CONFIDENCE_TOLERANCE * 3)));
  const raw = (priceFactor * 0.7) + (confFactor * 0.3);
  return { raw, stable };
}

/**
 * Trend continuation — direction of final_score across cycles. A
 * signal whose final_score is rising is being reinforced by the
 * dynamic ranker (freshness + post-signal validation + regime
 * tailwinds). A falling final_score is decaying.
 */
function scoreTrendContinuation(history: StabilitySnapshot[], currentFinalScore: number | null): number {
  const series = [
    ...history.map((h) => h.final_score).filter((v): v is number => v != null && Number.isFinite(v)),
    ...(currentFinalScore != null && Number.isFinite(currentFinalScore) ? [currentFinalScore] : []),
  ];
  if (series.length < 2) return 0.5;

  const first = series[0];
  const last  = series[series.length - 1];
  const delta = last - first;

  // +5 points across cycles → 1.0; -5 points → 0.0; flat → 0.5.
  return clamp01(0.5 + (delta / 10));
}

/**
 * Volume persistence — uses factor_scores.volume if present.
 * "Persistence" not just "magnitude" — a high volume score in cycle
 * 1 that drops to half by cycle 3 is a one-bar spike, not a trend.
 */
function scoreVolumePersistence(
  current: MaturityScorerInput['current'],
  history: StabilitySnapshot[],
): number {
  const cur = current.factor_scores?.volume ?? current.factor_scores?.volume_score ?? null;
  if (cur == null || !Number.isFinite(cur)) return 0.5;

  // Magnitude — clamp to [0, 100] then map to [0, 1].
  const magnitude = clamp01(Number(cur) / 100);

  // We don't store factor_scores per cycle in the tracker (it would
  // bloat history), so persistence here is a one-shot read of the
  // latest factor with cycle count as proxy. After ≥3 cycles, a
  // sustained high-volume score is more credible than a single read.
  const cycleBonus = history.length >= 3 ? 0.15 : 0;
  return clamp01(magnitude + cycleBonus);
}

/**
 * Breakout hold quality — measures whether price has sustained above
 * (BUY) / below (SELL) the entry across cycles. Uses the entry_price
 * field across history as a proxy: when entries are converging
 * upward for a BUY (price trended up), the breakout is holding.
 */
function scoreBreakoutHold(
  direction: 'BUY' | 'SELL',
  history: StabilitySnapshot[],
  current: MaturityScorerInput['current'],
): number {
  if (history.length < 2) return 0.5;
  const series = [...history.map((h) => h.entry_price), current.entry_price]
    .filter((v) => Number.isFinite(v) && v > 0);
  if (series.length < 2) return 0.5;

  const first = series[0];
  const last  = series[series.length - 1];
  const pct   = (last - first) / first;

  if (direction === 'BUY')  return clamp01(0.5 + pct * 10);  // +5% → 1.0, -5% → 0
  /* SELL */                 return clamp01(0.5 - pct * 10);  // -5% → 1.0, +5% → 0
}

/**
 * False-signal probability penalty. Heuristic combination of:
 *   - cycle count (more cycles = lower false-signal odds)
 *   - confidence (higher = lower)
 *   - decay state (fresh = lower)
 *   - hyper-reactive intraday move (large pct_change with low cycles
 *     = punished)
 */
function scoreFalseSignalPenalty(
  current: MaturityScorerInput['current'],
  cycles: number,
): number {
  const cycleFactor = Math.min(1, cycles / 5);
  const confFactor  = clamp01(current.confidence / 100);
  const decay = String(current.decay_state ?? '').toLowerCase();
  const decayFactor = decay === 'fresh' ? 1 : decay === 'actionable_but_aging' ? 0.7 : decay === 'stale' ? 0.3 : 0;

  // Hyper-reactive penalty: |pct_change| > 4% with < 2 cycles = noisy.
  let hyperPenalty = 0;
  const pct = Math.abs(Number(current.pct_change ?? 0));
  if (pct > 4 && cycles < 2) hyperPenalty = 0.4;
  else if (pct > 6 && cycles < 3) hyperPenalty = 0.2;

  return clamp01((cycleFactor * 0.4 + confFactor * 0.3 + decayFactor * 0.3) - hyperPenalty);
}

/**
 * Multi-factor agreement — count of factor_scores values above 60.
 * 4+ aligned factors → 1.0, 0 aligned → 0.0.
 */
function scoreMultiFactorAgreement(current: MaturityScorerInput['current']): number {
  const fs = current.factor_scores;
  if (!fs || typeof fs !== 'object') return 0.4;
  const values = Object.values(fs).filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  if (values.length === 0) return 0.4;
  const aligned = values.filter((v) => v >= 60).length;
  return clamp01(aligned / 4);
}

/**
 * Regime alignment — BUY in a bull regime is +1, BUY in a bear
 * regime is 0, neutral regime is 0.5. Mirror for SELL.
 */
function scoreRegimeAlignment(direction: 'BUY' | 'SELL', regime: string | null): number {
  const r = String(regime ?? '').toUpperCase();
  if (direction === 'BUY') {
    if (r.includes('STRONG_BULL')) return 1.0;
    if (r.includes('BULL'))         return 0.85;
    if (r.includes('STRONG_BEAR')) return 0.10;
    if (r.includes('BEAR'))         return 0.30;
    return 0.55;
  }
  // SELL
  if (r.includes('STRONG_BEAR')) return 1.0;
  if (r.includes('BEAR'))         return 0.85;
  if (r.includes('STRONG_BULL')) return 0.10;
  if (r.includes('BULL'))         return 0.30;
  return 0.55;
}

/**
 * News/event shock penalty — when the news engine reports a recent
 * shock for this symbol, lower the maturity. Pure penalty: shock=0
 * → 1.0; shock=1 → 0.0.
 */
function scoreNewsShockPenalty(newsShock: number | null): number {
  if (newsShock == null || !Number.isFinite(newsShock)) return 0.7;
  return clamp01(1 - Number(newsShock));
}

/**
 * Signal decay risk — direct read of the dynamic ranker's decay
 * state. fresh = 1.0, stale/expired = 0.
 */
function scoreDecayRisk(decayState: string | null): number {
  const d = String(decayState ?? '').toLowerCase();
  if (d === 'fresh')                  return 1.0;
  if (d === 'actionable_but_aging')   return 0.7;
  if (d === 'stale')                  return 0.25;
  if (d === 'expired')                return 0;
  return 0.5;
}

// ════════════════════════════════════════════════════════════════
//  Stage / Conviction mappers
// ════════════════════════════════════════════════════════════════
function stageFromScore(score: number): ComputedMaturityStage {
  if (score >= STAGE_MATURE_THRESHOLD)     return 'mature';
  if (score >= STAGE_DEVELOPING_THRESHOLD) return 'developing';
  return 'candidate';
}

// HIGH conviction requires BOTH a mature score AND ≥4 validation
// cycles. Promotion already gates cycles ≥3; this raises the bar
// for the HIGH badge specifically. Reasoning: cycle 3 is the minimum
// for "this setup has held its plan more than once" — it's enough
// to confirm, but not enough to call it high-conviction. Cycle 4
// adds one more independent confirmation, which is what the operator
// reads "High" as. Snapshots at cycle 3 promote with MEDIUM and
// upgrade to HIGH once the tracker advances them.
const CONVICTION_HIGH_MIN_CYCLES = 4;

// V2.10 institutional-tier qualifier: maturity score ≥ 92 is no
// longer enough on its own. The tier now ALSO requires the
// underlying signal confidence to be ≥ 85 — without that, a
// signal can have high maturity (price plan held across cycles)
// while the engine itself was not confident in the setup, which
// is exactly the false-positive shape V2.10 is built to suppress.
const CONVICTION_INSTITUTIONAL_MIN_CONFIDENCE = 85;

function convictionFromScoreAndClass(
  score: number,
  classification: string | null,
  cycles: number,
  confidence: number = 0,
): ConvictionLevel {
  const klass = String(classification ?? '').toUpperCase();
  if (score >= CONVICTION_INSTITUTIONAL_THRESHOLD
      && klass === 'INSTITUTIONAL_HIGH_CONVICTION'
      && cycles >= CONVICTION_HIGH_MIN_CYCLES
      && confidence >= CONVICTION_INSTITUTIONAL_MIN_CONFIDENCE) return 'INSTITUTIONAL';
  if (score >= STAGE_MATURE_THRESHOLD
      && cycles >= CONVICTION_HIGH_MIN_CYCLES) return 'HIGH';
  return 'MEDIUM';
}

// ════════════════════════════════════════════════════════════════
//  Public scorer
// ════════════════════════════════════════════════════════════════
export function scoreMaturity(input: MaturityScorerInput): MaturityScorerOutput {
  const now = input.now ?? Date.now();
  const ageMinutes = Math.max(0, Math.round((now - input.tracker.first_detected_at) / 60_000));

  const fPersistence    = scorePersistence(input.tracker.cycles);
  const fStability      = scoreStability(input.tracker.history);
  const fTrendCont      = scoreTrendContinuation(input.tracker.history, input.current.final_score);
  const fVolumePers     = scoreVolumePersistence(input.current, input.tracker.history);
  const fBreakoutHold   = scoreBreakoutHold(input.direction, input.tracker.history, input.current);
  const fFalseSignal    = scoreFalseSignalPenalty(input.current, input.tracker.cycles);
  const fMultiFactor    = scoreMultiFactorAgreement(input.current);
  const fRegimeAlign    = scoreRegimeAlignment(input.direction, input.current.market_regime);
  const fNewsShock      = scoreNewsShockPenalty(input.current.news_shock);
  const fDecayRisk      = scoreDecayRisk(input.current.decay_state);

  const factors: MaturityFactor[] = [
    { name: 'persistence',          weight: W_PERSISTENCE,          raw: fPersistence,    contribution: W_PERSISTENCE          * fPersistence    * 100 },
    { name: 'stability',            weight: W_STABILITY,            raw: fStability.raw,  contribution: W_STABILITY            * fStability.raw  * 100 },
    { name: 'trend_continuation',   weight: W_TREND_CONTINUATION,   raw: fTrendCont,      contribution: W_TREND_CONTINUATION   * fTrendCont      * 100 },
    { name: 'volume_persistence',   weight: W_VOLUME_PERSISTENCE,   raw: fVolumePers,     contribution: W_VOLUME_PERSISTENCE   * fVolumePers     * 100 },
    { name: 'breakout_hold',        weight: W_BREAKOUT_HOLD,        raw: fBreakoutHold,   contribution: W_BREAKOUT_HOLD        * fBreakoutHold   * 100 },
    { name: 'false_signal_penalty', weight: W_FALSE_SIGNAL_PENALTY, raw: fFalseSignal,    contribution: W_FALSE_SIGNAL_PENALTY * fFalseSignal    * 100 },
    { name: 'multi_factor',         weight: W_MULTI_FACTOR,         raw: fMultiFactor,    contribution: W_MULTI_FACTOR         * fMultiFactor    * 100 },
    { name: 'regime_alignment',     weight: W_REGIME_ALIGNMENT,     raw: fRegimeAlign,    contribution: W_REGIME_ALIGNMENT     * fRegimeAlign    * 100 },
    { name: 'news_shock_penalty',   weight: W_NEWS_SHOCK_PENALTY,   raw: fNewsShock,      contribution: W_NEWS_SHOCK_PENALTY   * fNewsShock      * 100 },
    { name: 'decay_risk',           weight: W_DECAY_RISK,           raw: fDecayRisk,      contribution: W_DECAY_RISK           * fDecayRisk      * 100 },
  ];

  const score = Math.round(factors.reduce((acc, f) => acc + f.contribution, 0) * 100) / 100;
  const stage = stageFromScore(score);
  const convictionLevel = convictionFromScoreAndClass(
    score,
    input.current.classification,
    input.tracker.cycles,
    input.current.confidence,
  );

  const reasons: string[] = [];
  if (input.tracker.cycles < 3)              reasons.push(`only ${input.tracker.cycles} validation cycle(s) — needs ≥3`);
  if (ageMinutes < 10)                       reasons.push(`signal age ${ageMinutes}m — needs ≥10m seasoning`);
  if (!fStability.stable && input.tracker.history.length >= 2) reasons.push('trade plan drifted between cycles');
  if (fTrendCont < 0.45)                     reasons.push('final_score trending down across cycles');
  if (fRegimeAlign < 0.4)                    reasons.push('trade direction fights the regime');
  if (fDecayRisk < 0.4)                      reasons.push('signal aging — decay risk elevated');
  if (fFalseSignal < 0.4)                    reasons.push('high false-signal probability (low conf or hyper-reactive)');
  if (fMultiFactor < 0.4)                    reasons.push('insufficient factor confluence');

  return {
    score,
    stage,
    stable: fStability.stable,
    convictionLevel,
    factors,
    signalAgeMinutes: ageMinutes,
    reasons,
  };
}

// ════════════════════════════════════════════════════════════════
//  Promotion eligibility — combines maturity score, cycles, age.
//
//  Strategy-specific seasoning: different setups need different
//  amounts of time to prove themselves. A breakout either holds
//  within ~15 minutes or it fades; a pullback needs longer to
//  confirm the bounce; mean-reversion needs the longest because
//  the move against the prevailing direction has to actually
//  reverse rather than just chop.
//
//  Mapping is sourced from the scenario_tag column on q365_signals
//  (set by saveSignals via STRATEGY_TO_SCENARIO). Anything not
//  listed here falls back to MATURITY_MIN_AGE_MINUTES (default 10),
//  which preserves the original conservative bar for unfamiliar
//  strategies.
// ════════════════════════════════════════════════════════════════

const STRATEGY_SEASONING_MIN: Record<string, number> = {
  BREAKOUT_CONTINUATION:    15,
  PULLBACK_IN_TREND:        25,
  MEAN_REVERSION:           35,
};

export interface PromotionRules {
  minCycles:    number;
  minAgeMin:    number;
  minScore:     number;
}

export function defaultPromotionRules(): PromotionRules {
  const minCycles = clampInt(process.env.MATURITY_MIN_CYCLES, 3, 1, 10);
  const minAgeMin = clampInt(process.env.MATURITY_MIN_AGE_MINUTES, 10, 1, 240);
  const minScore  = clampInt(process.env.MATURITY_PROMOTE_THRESHOLD, STAGE_MATURE_THRESHOLD, 60, 100);
  return { minCycles, minAgeMin, minScore };
}

/**
 * Promotion rules tailored to a specific strategy. The base rules
 * (cycles, score) come from defaultPromotionRules; only the age
 * floor is overridden when the strategy has a longer seasoning
 * requirement. Env overrides still apply via MATURITY_MIN_AGE_MINUTES
 * — when the env-configured floor is HIGHER than the strategy
 * default, we honour the env (conservative bias).
 */
export function promotionRulesForStrategy(strategy: string | null | undefined): PromotionRules {
  const base = defaultPromotionRules();
  const key  = String(strategy ?? '').toUpperCase();
  const strategyFloor = STRATEGY_SEASONING_MIN[key];
  if (strategyFloor == null) return base;
  return {
    ...base,
    // Conservative: always take the larger of (env / strategy).
    minAgeMin: Math.max(base.minAgeMin, strategyFloor),
  };
}

function clampInt(envVal: string | undefined, fallback: number, lo: number, hi: number): number {
  const n = Number(envVal);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.max(lo, Math.min(hi, Math.floor(n)));
}

export function isPromotable(
  result: MaturityScorerOutput,
  cycles: number,
  rules: PromotionRules = defaultPromotionRules(),
): boolean {
  // MATURATION_AUDIT_2026-05 — stability gate softened from a hard
  // boolean to a smooth raw-score floor. The legacy `result.stable`
  // check vetoed promotion on a single drift event regardless of
  // score; institutionally that's wrong because a 3-cycle plan with
  // ONE minor drift is still a stable thesis. The smooth gate accepts
  // rows whose stability factor scored ≥ STABILITY_RAW_PROMOTION_FLOOR
  // (default 0.55 — i.e., more than half the drift budget unused).
  // Rows with `result.stable === true` always pass; rows with raw ≥
  // floor pass even if `stable === false`.
  const stabilityFactor = result.factors.find((f) => f.name === 'stability');
  const stabilityRaw = stabilityFactor?.raw ?? 0;
  const stabilityOk = result.stable || stabilityRaw >= STABILITY_RAW_PROMOTION_FLOOR;
  return result.stage === 'mature'
      && result.score >= rules.minScore
      && cycles >= rules.minCycles
      && result.signalAgeMinutes >= rules.minAgeMin
      && stabilityOk;
}
