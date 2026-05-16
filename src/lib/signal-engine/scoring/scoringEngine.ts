// ════════════════════════════════════════════════════════════════
//  Scoring Engine
//
//  Transparent, weighted scorer that converts the already-computed
//  per-dimension scores (confidence, risk, portfolio fit, regime
//  alignment, freshness, risk-reward) into a single normalized
//  `final_score` in [0, 100] plus a product-facing classification
//  band.
//
//  Separation of concerns vs. existing scoring files:
//
//    confidenceScorer.ts  → how good is the setup pattern?
//    riskScorer.ts        → how much can this trade lose?
//    phase3Risk.ts        → combined standalone + portfolio risk
//    dynamicRanker.ts     → order-of-the-list score (with freshness
//                           decay applied per rescore tick)
//    scoringEngine.ts     → THIS FILE: cross-dimension composite
//                           score + classification band. A pure
//                           function the rejection engine, API, and
//                           UI can all agree on.
//
//  Classification bands (product-facing tri-state + one upgrade):
//
//    HIGH_CONVICTION   — finalScore ≥ 75 AND confidence ≥ 70 AND
//                        riskReward ≥ 2.0. "Execute without
//                        hesitation — every dimension lines up."
//    VALID_SIGNAL      — finalScore ≥ 50. Meets the signals-table
//                        gate (conf ≥ 60, risk ≤ 70, R:R ≥ 1.5,
//                        final ≥ 50) but doesn't clear high-
//                        conviction. "Take with standard position
//                        sizing."
//    DEVELOPING_SETUP  — finalScore in [30, 50) OR upstream tagged
//                        signalStatus === 'DEVELOPING_SETUP'.
//                        "Watch, don't trade — wait for
//                        confirmation."
//    NO_TRADE          — finalScore < 30 OR confidence < 50 OR
//                        riskReward < 1.0 OR upstream
//                        signalStatus === 'NO_TRADE'. "Structural
//                        reject. Do not act."
//
//  This engine is stateless, synchronous, and IO-free. It is
//  intended to be safely importable from any layer (pipeline,
//  API, UI serialization) without creating new coupling.
// ════════════════════════════════════════════════════════════════

export type ClassificationBand =
  | 'HIGH_CONVICTION'
  | 'VALID_SIGNAL'
  | 'DEVELOPING_SETUP'
  | 'NO_TRADE';

/** Upstream tri-state (from rejection engine). When supplied, a
 *  'NO_TRADE' or 'DEVELOPING_SETUP' classification is inherited
 *  so this engine never upgrades a rejected row. */
export type UpstreamSignalStatus =
  | 'APPROVED_SIGNAL'
  | 'DEVELOPING_SETUP'
  | 'NO_TRADE';

// ── Inputs ──────────────────────────────────────────────────────
//
// Every field is expected to already be in [0, 100] (except
// riskReward, which is a ratio ≥ 0). Nulls mean "not available" —
// the scorer substitutes a neutral default so a missing dimension
// cannot silently tank the final score.
export interface ScoringInput {
  /** 0-100, produced by confidenceScorer / candidate.confidence */
  confidenceScore:  number;
  /** 0-100, LOWER is better. Risk quality is derived as 100-riskScore. */
  riskScore:        number;
  /** Ratio, 0..∞. 1.5 is the signals-table floor; 3.0 saturates the score. */
  riskReward:       number;
  /** 0-100, from evaluatePortfolioFit. null → neutral 50. */
  portfolioFit:     number | null;
  /** 0-100, from regime engine. null → neutral 50. */
  regimeAlignment:  number | null;
  /** 0-100, from freshnessEngine. null → 100 (no decay). */
  freshnessScore:   number | null;
  /** Optional upstream status to inherit for NO_TRADE / DEVELOPING_SETUP. */
  signalStatus?:    UpstreamSignalStatus;
}

// ── Weights ─────────────────────────────────────────────────────
//
// MUST sum to exactly 1.0. The scorer normalizes if it doesn't —
// that's a belt-and-braces against a future tuning mistake — but
// the intent is to keep this transparent. The weights reflect the
// spec's emphasis: confidence + risk quality together carry more
// than half the decision; R:R is the next most important; context
// (portfolio fit, regime, freshness) each carry 10%.
export interface ScoringWeights {
  confidence:      number;
  riskQuality:     number;
  rewardRisk:      number;
  portfolioFit:    number;
  regimeAlignment: number;
  freshness:       number;
}

export const DEFAULT_SCORING_WEIGHTS: ScoringWeights = {
  confidence:      0.35,
  riskQuality:     0.20,
  rewardRisk:      0.15,
  portfolioFit:    0.10,
  regimeAlignment: 0.10,
  freshness:       0.10,
};

// ── Classification thresholds ───────────────────────────────────
//
// Aligned to the /api/signals strict hard gate:
//   - VALID_SIGNAL floor (50) matches the gate's final_score ≥ 50.
//   - HIGH_CONVICTION requires a top-quartile finalScore PLUS
//     confidence ≥ 70 and R:R ≥ 2.0 — a stricter bar than the
//     /signals table enforces, so a row here is always also
//     eligible for the main display.
//   - NO_TRADE is inherited from upstream OR triggered by a
//     confidence/R:R floor that no trading system should breach
//     regardless of other dimensions.
export interface ClassificationThresholds {
  highConvictionFinal:     number;   // finalScore cutoff for HIGH_CONVICTION
  highConvictionConfidence:number;   // confidenceScore cutoff for HIGH_CONVICTION
  highConvictionRewardRisk:number;   // riskReward cutoff for HIGH_CONVICTION
  validSignalFinal:        number;   // finalScore cutoff for VALID_SIGNAL
  developingSetupFinal:    number;   // finalScore cutoff for DEVELOPING_SETUP
  noTradeConfidence:       number;   // below this → NO_TRADE regardless
  noTradeRewardRisk:       number;   // below this → NO_TRADE regardless
}

export const DEFAULT_CLASSIFICATION_THRESHOLDS: ClassificationThresholds = {
  highConvictionFinal:      75,
  highConvictionConfidence: 70,
  highConvictionRewardRisk:  2.0,
  validSignalFinal:         50,
  developingSetupFinal:     30,
  noTradeConfidence:        50,
  noTradeRewardRisk:         1.0,
};

// ── Output ──────────────────────────────────────────────────────
export interface ScoringComponents {
  /** Raw confidence, 0-100 */
  confidence:      number;
  /** 100 - riskScore, 0-100 (higher is better) */
  riskQuality:     number;
  /** riskReward mapped to 0-100 via linear saturation at 3.0 */
  rewardRisk:      number;
  /** portfolioFit with null → 50 */
  portfolioFit:    number;
  /** regimeAlignment with null → 50 */
  regimeAlignment: number;
  /** freshnessScore with null → 100 */
  freshness:       number;
}

export interface ScoringResult {
  /** 0-100, rounded to one decimal place */
  finalScore:     number;
  classification: ClassificationBand;
  components:     ScoringComponents;
  /** Each dimension's contribution to finalScore (sums to finalScore) */
  weightedContributions: Record<keyof ScoringWeights, number>;
  /** Weights actually applied after normalization (rarely differs from input) */
  appliedWeights: ScoringWeights;
  /** Human-readable reason string for debug logs / API responses */
  reason:         string;
}

// ── Helpers ─────────────────────────────────────────────────────

function clamp(n: number, min = 0, max = 100): number {
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/** riskReward → 0-100 score via piecewise-linear saturation at 3.0.
 *  0.0 → 0, 1.0 → 33, 1.5 → 50, 2.0 → 67, 3.0+ → 100. */
function normalizeRewardRisk(rr: number): number {
  if (!Number.isFinite(rr) || rr <= 0) return 0;
  if (rr >= 3)                         return 100;
  return (rr / 3) * 100;
}

function normalizeWeights(w: ScoringWeights): ScoringWeights {
  const sum =
    w.confidence + w.riskQuality + w.rewardRisk +
    w.portfolioFit + w.regimeAlignment + w.freshness;
  if (Math.abs(sum - 1) < 1e-6) return w;
  if (sum <= 0) return DEFAULT_SCORING_WEIGHTS;
  return {
    confidence:      w.confidence      / sum,
    riskQuality:     w.riskQuality     / sum,
    rewardRisk:      w.rewardRisk      / sum,
    portfolioFit:    w.portfolioFit    / sum,
    regimeAlignment: w.regimeAlignment / sum,
    freshness:       w.freshness       / sum,
  };
}

// ── Public API ──────────────────────────────────────────────────

/**
 * Classify a scored signal into one of four product-facing bands.
 * Exported independently so callers that already have a
 * `final_score` (e.g. persisted q365_signals rows) can derive the
 * band without re-running the full scorer.
 */
export function classify(
  finalScore:      number,
  confidenceScore: number,
  riskReward:      number,
  signalStatus?:   UpstreamSignalStatus,
  thresholds:      ClassificationThresholds = DEFAULT_CLASSIFICATION_THRESHOLDS,
): ClassificationBand {
  // Upstream tri-state overrides — never upgrade a rejected row.
  if (signalStatus === 'NO_TRADE')         return 'NO_TRADE';
  if (signalStatus === 'DEVELOPING_SETUP') return 'DEVELOPING_SETUP';

  // Absolute floors — a trade with confidence < 50 or R:R < 1.0
  // is never actionable regardless of final_score composition.
  if (confidenceScore < thresholds.noTradeConfidence) return 'NO_TRADE';
  if (riskReward      < thresholds.noTradeRewardRisk) return 'NO_TRADE';

  // High-conviction gate: finalScore AND confidence AND R:R
  // must all clear their respective thresholds. All-or-nothing —
  // one weak dimension drops the row to VALID_SIGNAL.
  if (finalScore      >= thresholds.highConvictionFinal      &&
      confidenceScore >= thresholds.highConvictionConfidence &&
      riskReward      >= thresholds.highConvictionRewardRisk) {
    return 'HIGH_CONVICTION';
  }

  if (finalScore >= thresholds.validSignalFinal)     return 'VALID_SIGNAL';
  if (finalScore >= thresholds.developingSetupFinal) return 'DEVELOPING_SETUP';
  return 'NO_TRADE';
}

/**
 * Main entry point. Converts per-dimension scores into a weighted
 * composite finalScore + classification band. Pure function —
 * safe to call from any layer.
 */
export function computeFinalScore(
  input:      ScoringInput,
  weights:    ScoringWeights            = DEFAULT_SCORING_WEIGHTS,
  thresholds: ClassificationThresholds = DEFAULT_CLASSIFICATION_THRESHOLDS,
): ScoringResult {
  const w = normalizeWeights(weights);

  const components: ScoringComponents = {
    confidence:      clamp(input.confidenceScore),
    riskQuality:     clamp(100 - input.riskScore),
    rewardRisk:      normalizeRewardRisk(input.riskReward),
    portfolioFit:    clamp(input.portfolioFit    ?? 50),
    regimeAlignment: clamp(input.regimeAlignment ?? 50),
    freshness:       clamp(input.freshnessScore  ?? 100),
  };

  const weightedContributions: Record<keyof ScoringWeights, number> = {
    confidence:      components.confidence      * w.confidence,
    riskQuality:     components.riskQuality     * w.riskQuality,
    rewardRisk:      components.rewardRisk      * w.rewardRisk,
    portfolioFit:    components.portfolioFit    * w.portfolioFit,
    regimeAlignment: components.regimeAlignment * w.regimeAlignment,
    freshness:       components.freshness       * w.freshness,
  };

  const rawFinal =
    weightedContributions.confidence      +
    weightedContributions.riskQuality     +
    weightedContributions.rewardRisk      +
    weightedContributions.portfolioFit    +
    weightedContributions.regimeAlignment +
    weightedContributions.freshness;

  const finalScore = round1(clamp(rawFinal));

  const classification = classify(
    finalScore,
    components.confidence,
    input.riskReward,
    input.signalStatus,
    thresholds,
  );

  const reason = buildReason(classification, finalScore, components, input);

  return {
    finalScore,
    classification,
    components,
    weightedContributions,
    appliedWeights: w,
    reason,
  };
}

// ── Reason builder ──────────────────────────────────────────────
//
// Short, operator-readable justification. Surfaces the dimension
// that did the most work (positive or negative) so logs are
// scannable without re-deriving components.
function buildReason(
  cls:        ClassificationBand,
  finalScore: number,
  c:          ScoringComponents,
  input:      ScoringInput,
): string {
  if (input.signalStatus === 'NO_TRADE')
    return 'Upstream NO_TRADE — structural reject inherited';
  if (input.signalStatus === 'DEVELOPING_SETUP')
    return 'Upstream DEVELOPING_SETUP — wait for confirmation';

  if (cls === 'NO_TRADE' && c.confidence < 50)
    return `Confidence ${c.confidence.toFixed(0)} below floor (50)`;
  if (cls === 'NO_TRADE' && input.riskReward < 1.0)
    return `R:R ${input.riskReward.toFixed(2)} below floor (1.0)`;

  const driver =
    cls === 'HIGH_CONVICTION' ? 'all dimensions aligned' :
    cls === 'VALID_SIGNAL'    ? 'meets signals-table thresholds'  :
    cls === 'DEVELOPING_SETUP'? 'final score below actionable cut':
                                 'final score too low';

  return `${cls} — final=${finalScore}, ${driver} ` +
    `(conf=${c.confidence.toFixed(0)}, risk_q=${c.riskQuality.toFixed(0)}, ` +
    `rr=${input.riskReward.toFixed(2)})`;
}

// ════════════════════════════════════════════════════════════════
//  Phase-2 Final-Score API: calculateFinalScore
// ════════════════════════════════════════════════════════════════
//
//  Self-contained scoring entry point requested by the Phase-2
//  spec. Coexists with computeFinalScore (above) — the existing
//  pipeline keeps using the legacy 6-component scorer; this new
//  function is intentionally NOT wired into any caller yet.
//
//  Formula (weights sum to 1.00):
//    Strategy Quality       20%
//    Trend Alignment        15%
//    Momentum               10%
//    Volume Confirmation    10%
//    Risk Reward            15%
//    Liquidity              10%
//    Market Regime          10%
//    Portfolio Fit          10%
//                          -----
//                         100%
//    − Manipulation Risk Penalty   (points)
//    − Staleness Penalty           (points)
//    − Volatility Shock Penalty    (points)
//
//  Final score is clamped to [0, 100].
//
//  Classification:
//    85-100  INSTITUTIONAL_HIGH_CONVICTION
//    75-84   HIGH_CONVICTION
//    65-74   VALID_SIGNAL
//    50-64   DEVELOPING_SETUP
//    35-49   WATCHLIST_ONLY
//      <35   NO_TRADE
//
//  Pure function. Stateless. IO-free.

/** Phase-2 classification band — 6-state scheme. */
export type FinalScoreBand =
  | 'INSTITUTIONAL_HIGH_CONVICTION'
  | 'HIGH_CONVICTION'
  | 'VALID_SIGNAL'
  | 'DEVELOPING_SETUP'
  | 'WATCHLIST_ONLY'
  | 'NO_TRADE';

/** Eight weighted factors. Each is a 0-100 quality score.
 *  Nulls are treated as "not measured" and substituted with a
 *  neutral 50 so a single missing dimension cannot tank the score. */
export interface FinalScoreFactorInputs {
  strategyQuality:     number | null;
  trendAlignment:      number | null;
  momentum:            number | null;
  volumeConfirmation:  number | null;
  riskReward:          number | null;
  liquidity:           number | null;
  marketRegime:        number | null;
  portfolioFit:        number | null;
}

/** Three penalties. Each is a non-negative point value subtracted
 *  from the weighted sum. Null is treated as 0. Each penalty is
 *  individually clamped to [0, MAX_PENALTY_PER_DIMENSION] so a
 *  badly-tuned upstream cannot zero the score with a single field. */
export interface FinalScorePenaltyInputs {
  manipulationRiskPenalty: number | null;
  stalenessPenalty:        number | null;
  volatilityShockPenalty:  number | null;
}

export interface FinalScoreInput
  extends FinalScoreFactorInputs, FinalScorePenaltyInputs {}

/** Per-factor breakdown — `raw` is the 0-100 input (post-substitute),
 *  `weight` is the applied weight, `weighted` is `raw * weight`. */
export interface FactorContribution {
  raw:      number;
  weight:   number;
  weighted: number;
}

/** Per-penalty breakdown — `raw` is what the caller passed,
 *  `applied` is the value after clamp/cap. */
export interface PenaltyContribution {
  raw:     number;
  applied: number;
}

export interface FinalScoreBreakdown {
  /** Sum of weighted factor contributions BEFORE penalties. */
  baseWeightedSum: number;
  /** Total points subtracted by penalties. */
  penaltyTotal:    number;
  /** baseWeightedSum − penaltyTotal, BEFORE clamp. */
  rawFinal:        number;
  /** Final score after clamp to [0, 100]. */
  finalClamped:    number;
  /** Operator-readable bullet lines. */
  lines:           string[];
  /** One-sentence rationale. */
  rationale:       string;
}

export interface FinalScoreResult {
  /** 0-100, rounded to one decimal place. */
  finalScore:     number;
  classification: FinalScoreBand;
  /** Per-factor 0-100 inputs after null-substitution. Snake-case
   *  to match API/UI conventions (matches q365_signals columns). */
  factor_scores: {
    strategy_quality:     number;
    trend_alignment:      number;
    momentum:             number;
    volume_confirmation:  number;
    risk_reward:          number;
    liquidity:            number;
    market_regime:        number;
    portfolio_fit:        number;
  };
  /** Per-factor weighted contributions (raw, weight, weighted). */
  factor_contributions: Record<keyof FinalScoreFactorInputs, FactorContribution>;
  /** Per-penalty contributions (raw, applied). */
  penalty_contributions: {
    manipulation_risk: PenaltyContribution;
    staleness:         PenaltyContribution;
    volatility_shock:  PenaltyContribution;
  };
  /** Explanation-ready bundle for UI / debug logs. */
  breakdown:      FinalScoreBreakdown;
}

/** Phase-2 weights (sum exactly 1.00). */
export const FINAL_SCORE_WEIGHTS: Readonly<Record<keyof FinalScoreFactorInputs, number>> = Object.freeze({
  strategyQuality:     0.20,
  trendAlignment:      0.15,
  momentum:            0.10,
  volumeConfirmation:  0.10,
  riskReward:          0.15,
  liquidity:           0.10,
  marketRegime:        0.10,
  portfolioFit:        0.10,
});

/** Per-penalty cap — no single penalty may subtract more than this
 *  many points. Prevents a runaway upstream value (e.g. a bug
 *  emitting a 9999 manipulation score) from zeroing every signal. */
export const MAX_PENALTY_PER_DIMENSION = 30;

/** MATURATION_AUDIT_2026-05 — total-penalty ceiling. Three penalties
 *  (manipulation, staleness, volatility) at MAX_PENALTY_PER_DIMENSION
 *  each could subtract 90 points, which crushed any row hitting two
 *  or more penalties simultaneously even when the base score was
 *  strong. Cap the SUM at 25 so the worst-case still leaves a
 *  high-base setup tradable: e.g. a 70-base row with 3 penalties at
 *  full force lands at 45 instead of 0. Env-tunable for ops who want
 *  the legacy stacking behaviour back.
 *
 *  Applied AFTER per-dimension caps, so a single runaway penalty is
 *  still bounded by MAX_PENALTY_PER_DIMENSION and the multi-penalty
 *  pile-up is bounded by this. */
export const MAX_TOTAL_PENALTY = (() => {
  const raw = Number(process.env.SIGNAL_API_MAX_TOTAL_PENALTY);
  if (!Number.isFinite(raw) || raw < 0) return 25;
  return Math.min(90, Math.max(0, raw));
})();

const FINAL_SCORE_BAND_THRESHOLDS: ReadonlyArray<{ min: number; band: FinalScoreBand }> = [
  { min: 85, band: 'INSTITUTIONAL_HIGH_CONVICTION' },
  { min: 75, band: 'HIGH_CONVICTION' },
  { min: 65, band: 'VALID_SIGNAL' },
  { min: 50, band: 'DEVELOPING_SETUP' },
  { min: 35, band: 'WATCHLIST_ONLY' },
  { min:  0, band: 'NO_TRADE' },
];

function classifyFinalScore(finalScore: number): FinalScoreBand {
  for (const t of FINAL_SCORE_BAND_THRESHOLDS) {
    if (finalScore >= t.min) return t.band;
  }
  return 'NO_TRADE';
}

function substituteFactor(v: number | null): number {
  if (v == null || !Number.isFinite(v)) return 50;
  return clamp(v);
}

function substitutePenalty(v: number | null): { raw: number; applied: number } {
  const raw = v == null || !Number.isFinite(v) ? 0 : Number(v);
  // Negative penalties are nonsense — never let a "penalty" boost
  // the score. Cap the upper bound at MAX_PENALTY_PER_DIMENSION.
  const applied = Math.max(0, Math.min(MAX_PENALTY_PER_DIMENSION, raw));
  return { raw, applied };
}

/**
 * Phase-2 entry point. Pure function. Returns a clamped final score
 * in [0, 100], a 6-band classification, per-factor and per-penalty
 * contributions, and an explanation-ready breakdown.
 *
 * The optional `weights` parameter overrides FINAL_SCORE_WEIGHTS so
 * Phase-3 per-strategy presets can reweight the scoring composition
 * (e.g. breakout strategies emphasise volume_confirmation, mean
 * reversion emphasises risk_reward). When omitted, the global
 * defaults apply. Weights are used as supplied — callers that want
 * normalization to 1.0 must do it themselves (Phase-3's
 * `getFinalScoreWeights` already does).
 */
export function calculateFinalScore(
  input:    FinalScoreInput,
  weights?: Partial<Record<keyof FinalScoreFactorInputs, number>>,
): FinalScoreResult {
  const w: Record<keyof FinalScoreFactorInputs, number> = {
    strategyQuality:    weights?.strategyQuality    ?? FINAL_SCORE_WEIGHTS.strategyQuality,
    trendAlignment:     weights?.trendAlignment     ?? FINAL_SCORE_WEIGHTS.trendAlignment,
    momentum:           weights?.momentum           ?? FINAL_SCORE_WEIGHTS.momentum,
    volumeConfirmation: weights?.volumeConfirmation ?? FINAL_SCORE_WEIGHTS.volumeConfirmation,
    riskReward:         weights?.riskReward         ?? FINAL_SCORE_WEIGHTS.riskReward,
    liquidity:          weights?.liquidity          ?? FINAL_SCORE_WEIGHTS.liquidity,
    marketRegime:       weights?.marketRegime       ?? FINAL_SCORE_WEIGHTS.marketRegime,
    portfolioFit:       weights?.portfolioFit       ?? FINAL_SCORE_WEIGHTS.portfolioFit,
  };

  // ── 1. Detect present (non-null) factors + renormalize weights ──
  //
  //  MATURATION_AUDIT_2026-05 — dynamic weight renormalization.
  //
  //  The legacy behaviour substituted every null factor with 50 (the
  //  neutral mid-range). With 65% of total weight tied up in factors
  //  the engine doesn't currently compute (liquidity, marketRegime,
  //  portfolioFit, trendAlignment, momentum, volumeConfirmation),
  //  every row was anchored to ~50 regardless of how strong the
  //  computed factors were. A row with confidence=100 + perfect RR
  //  could only reach 67.5/100 — never hitting HIGH_CONVICTION (≥75)
  //  even at theoretical maximum. That's why the dashboard kept
  //  reporting "confidence=79, final_score=42-47" — the unscored
  //  factors were dragging the score down by ~25 points.
  //
  //  New semantic: when a factor input is null (engine didn't grade
  //  it), we IGNORE it and renormalize the weights of the factors
  //  that ARE present so they sum to 1.0. "We score what we know."
  //  A row strong on graded dimensions ranks high; ungraded ones
  //  don't penalise it.
  //
  //  Backward compat: when all 8 factors are present, the
  //  renormalization is a no-op (weights already sum to 1.0). Only
  //  partially-graded rows see different scores. Set
  //  SIGNAL_API_DISABLE_FACTOR_RENORM=1 to restore legacy behaviour.
  //
  //  Safety: when ZERO factors are present (degenerate input), we
  //  fall back to the legacy substitute-to-50 path so the function
  //  always returns a finite score.
  const renormDisabled = process.env.SIGNAL_API_DISABLE_FACTOR_RENORM === '1';
  const presence: Record<keyof FinalScoreFactorInputs, boolean> = {
    strategyQuality:    input.strategyQuality    != null && Number.isFinite(input.strategyQuality),
    trendAlignment:     input.trendAlignment     != null && Number.isFinite(input.trendAlignment),
    momentum:           input.momentum           != null && Number.isFinite(input.momentum),
    volumeConfirmation: input.volumeConfirmation != null && Number.isFinite(input.volumeConfirmation),
    riskReward:         input.riskReward         != null && Number.isFinite(input.riskReward),
    liquidity:          input.liquidity          != null && Number.isFinite(input.liquidity),
    marketRegime:       input.marketRegime       != null && Number.isFinite(input.marketRegime),
    portfolioFit:       input.portfolioFit       != null && Number.isFinite(input.portfolioFit),
  };
  const presentWeightSum =
    (presence.strategyQuality    ? w.strategyQuality    : 0) +
    (presence.trendAlignment     ? w.trendAlignment     : 0) +
    (presence.momentum           ? w.momentum           : 0) +
    (presence.volumeConfirmation ? w.volumeConfirmation : 0) +
    (presence.riskReward         ? w.riskReward         : 0) +
    (presence.liquidity          ? w.liquidity          : 0) +
    (presence.marketRegime       ? w.marketRegime       : 0) +
    (presence.portfolioFit       ? w.portfolioFit       : 0);
  // When everything is null OR renormalization is disabled, fall
  // through to the legacy substitute-to-50 path. Otherwise rescale
  // present weights so they sum to 1.0.
  const useRenorm = !renormDisabled && presentWeightSum > 0;
  const renormScale = useRenorm ? 1 / presentWeightSum : 1;

  // Effective per-factor weight after renormalization. For absent
  // factors this is 0 (they don't contribute) when renorm is on; in
  // legacy mode it's the original weight.
  const effW: Record<keyof FinalScoreFactorInputs, number> = {
    strategyQuality:    useRenorm ? (presence.strategyQuality    ? w.strategyQuality    * renormScale : 0) : w.strategyQuality,
    trendAlignment:     useRenorm ? (presence.trendAlignment     ? w.trendAlignment     * renormScale : 0) : w.trendAlignment,
    momentum:           useRenorm ? (presence.momentum           ? w.momentum           * renormScale : 0) : w.momentum,
    volumeConfirmation: useRenorm ? (presence.volumeConfirmation ? w.volumeConfirmation * renormScale : 0) : w.volumeConfirmation,
    riskReward:         useRenorm ? (presence.riskReward         ? w.riskReward         * renormScale : 0) : w.riskReward,
    liquidity:          useRenorm ? (presence.liquidity          ? w.liquidity          * renormScale : 0) : w.liquidity,
    marketRegime:       useRenorm ? (presence.marketRegime       ? w.marketRegime       * renormScale : 0) : w.marketRegime,
    portfolioFit:       useRenorm ? (presence.portfolioFit       ? w.portfolioFit       * renormScale : 0) : w.portfolioFit,
  };

  // Substitute nulls only when renormalization is OFF; with renorm
  // ON, absent factors carry weight=0 so the substituted value is
  // multiplied by 0 and doesn't affect the sum (we still record the
  // raw 50 for the contribution audit).
  const factors = {
    strategyQuality:    substituteFactor(input.strategyQuality),
    trendAlignment:     substituteFactor(input.trendAlignment),
    momentum:           substituteFactor(input.momentum),
    volumeConfirmation: substituteFactor(input.volumeConfirmation),
    riskReward:         substituteFactor(input.riskReward),
    liquidity:          substituteFactor(input.liquidity),
    marketRegime:       substituteFactor(input.marketRegime),
    portfolioFit:       substituteFactor(input.portfolioFit),
  };

  // ── 2. Per-factor weighted contributions ──────────────────────
  const factor_contributions: Record<keyof FinalScoreFactorInputs, FactorContribution> = {
    strategyQuality:    { raw: factors.strategyQuality,    weight: effW.strategyQuality,    weighted: factors.strategyQuality    * effW.strategyQuality    },
    trendAlignment:     { raw: factors.trendAlignment,     weight: effW.trendAlignment,     weighted: factors.trendAlignment     * effW.trendAlignment     },
    momentum:           { raw: factors.momentum,           weight: effW.momentum,           weighted: factors.momentum           * effW.momentum           },
    volumeConfirmation: { raw: factors.volumeConfirmation, weight: effW.volumeConfirmation, weighted: factors.volumeConfirmation * effW.volumeConfirmation },
    riskReward:         { raw: factors.riskReward,         weight: effW.riskReward,         weighted: factors.riskReward         * effW.riskReward         },
    liquidity:          { raw: factors.liquidity,          weight: effW.liquidity,          weighted: factors.liquidity          * effW.liquidity          },
    marketRegime:       { raw: factors.marketRegime,       weight: effW.marketRegime,       weighted: factors.marketRegime       * effW.marketRegime       },
    portfolioFit:       { raw: factors.portfolioFit,       weight: effW.portfolioFit,       weighted: factors.portfolioFit       * effW.portfolioFit       },
  };
  const baseWeightedSum =
    factor_contributions.strategyQuality.weighted    +
    factor_contributions.trendAlignment.weighted     +
    factor_contributions.momentum.weighted           +
    factor_contributions.volumeConfirmation.weighted +
    factor_contributions.riskReward.weighted         +
    factor_contributions.liquidity.weighted          +
    factor_contributions.marketRegime.weighted       +
    factor_contributions.portfolioFit.weighted;

  // ── 3. Penalties ──────────────────────────────────────────────
  const manip = substitutePenalty(input.manipulationRiskPenalty);
  const stale = substitutePenalty(input.stalenessPenalty);
  const volsh = substitutePenalty(input.volatilityShockPenalty);
  const penaltyRaw   = manip.applied + stale.applied + volsh.applied;
  // MATURATION_AUDIT_2026-05 — total-penalty ceiling. Three penalties
  // at MAX_PENALTY_PER_DIMENSION each could subtract 90 points; cap
  // the SUM at MAX_TOTAL_PENALTY so a row hitting two or three
  // penalties simultaneously still leaves a high-base setup tradable.
  const penaltyTotal = Math.min(MAX_TOTAL_PENALTY, penaltyRaw);

  // ── 4. Combine + clamp ────────────────────────────────────────
  const rawFinal     = baseWeightedSum - penaltyTotal;
  const finalClamped = clamp(rawFinal);
  const finalScore   = round1(finalClamped);

  // ── 5. Classify ───────────────────────────────────────────────
  const classification = classifyFinalScore(finalScore);

  // ── 6. Explanation-ready breakdown ────────────────────────────
  // Each factor row prints its EFFECTIVE weight (after renormalization)
  // alongside the raw value, plus a "(absent)" tag when the input was
  // null and the weight was redistributed to other present factors.
  const wRow = (label: string, raw: number, eff: number, present: boolean): string => {
    const suffix = present ? '' : ' (absent — weight redistributed)';
    return `${label.padEnd(22)} ${raw.toFixed(0).padStart(3)} × ${eff.toFixed(2)} = ${(raw * eff).toFixed(2)}${suffix}`;
  };
  const lines: string[] = [
    wRow('Strategy Quality',    factors.strategyQuality,    effW.strategyQuality,    presence.strategyQuality),
    wRow('Trend Alignment',     factors.trendAlignment,     effW.trendAlignment,     presence.trendAlignment),
    wRow('Momentum',            factors.momentum,           effW.momentum,           presence.momentum),
    wRow('Volume Confirmation', factors.volumeConfirmation, effW.volumeConfirmation, presence.volumeConfirmation),
    wRow('Risk Reward',         factors.riskReward,         effW.riskReward,         presence.riskReward),
    wRow('Liquidity',           factors.liquidity,          effW.liquidity,          presence.liquidity),
    wRow('Market Regime',       factors.marketRegime,       effW.marketRegime,       presence.marketRegime),
    wRow('Portfolio Fit',       factors.portfolioFit,       effW.portfolioFit,       presence.portfolioFit),
    `── base weighted sum  ${baseWeightedSum.toFixed(2)}` + (useRenorm
      ? `  (renormalized over ${Object.values(presence).filter(Boolean).length}/8 present factors)`
      : ''),
    `− Manipulation Risk   ${manip.applied.toFixed(2)}${manip.raw !== manip.applied ? ` (capped from ${manip.raw.toFixed(2)})` : ''}`,
    `− Staleness           ${stale.applied.toFixed(2)}${stale.raw !== stale.applied ? ` (capped from ${stale.raw.toFixed(2)})` : ''}`,
    `− Volatility Shock    ${volsh.applied.toFixed(2)}${volsh.raw !== volsh.applied ? ` (capped from ${volsh.raw.toFixed(2)})` : ''}`,
    `── penalty total      ${penaltyTotal.toFixed(2)}` + (penaltyRaw !== penaltyTotal
      ? `  (capped from ${penaltyRaw.toFixed(2)} by MAX_TOTAL_PENALTY=${MAX_TOTAL_PENALTY})`
      : ''),
    `── final (raw)        ${rawFinal.toFixed(2)}`,
    `── final (clamped)    ${finalScore.toFixed(1)}`,
    `── classification     ${classification}`,
  ];
  const rationale =
    `${classification}: weighted sum ${baseWeightedSum.toFixed(1)} − penalties ` +
    `${penaltyTotal.toFixed(1)} = ${finalScore.toFixed(1)}.`;

  const breakdown: FinalScoreBreakdown = {
    baseWeightedSum,
    penaltyTotal,
    rawFinal,
    finalClamped,
    lines,
    rationale,
  };

  return {
    finalScore,
    classification,
    factor_scores: {
      strategy_quality:    factors.strategyQuality,
      trend_alignment:     factors.trendAlignment,
      momentum:            factors.momentum,
      volume_confirmation: factors.volumeConfirmation,
      risk_reward:         factors.riskReward,
      liquidity:           factors.liquidity,
      market_regime:       factors.marketRegime,
      portfolio_fit:       factors.portfolioFit,
    },
    factor_contributions,
    penalty_contributions: {
      manipulation_risk: manip,
      staleness:         stale,
      volatility_shock:  volsh,
    },
    breakdown,
  };
}
