// ════════════════════════════════════════════════════════════════
//  Yahoo Scoring Engine — scanner-side composite scorer
//
//  Pure function that takes a candidate's factor scores plus the
//  hard-gate inputs and returns a single, classification-ready
//  result. No data fetching, no I/O. The scanner is responsible for
//  computing the seven factor scores from the indicator snapshot —
//  this module owns ONLY the weighted composite, the penalty
//  subtraction, the band classification, and the hard-reject gate.
//
//  Formula (per spec, NOT configurable — implements the contract verbatim):
//
//    composite = trend*0.20 + momentum*0.15 + volume*0.15
//              + breakout*0.20 + riskReward*0.15 + liquidity*0.10
//              + stability*0.05
//    final_score = clamp(composite − Σ penalties[].points, 0, 100)
//
//  Bands:
//    80–100  HIGH_CONVICTION_BUY  → show_in_main
//    65–79   VALID_BUY            → show_in_main
//    50–64   WATCHLIST            → show_in_emerging   (never main)
//    < 50    REJECT               → reject
//
//  Hard rejects (each fires regardless of composite score):
//    rsi14 > 80
//    riskReward < 1.5
//    liquidityScore < 40
//    price <= stopLoss
//    isStale === true
//    isInvalidated === true
//    |gapPct| > 18 with gapVolumeMult < 1.5 (extreme gap without volume confirmation)
//
//  When ANY hard reject fires the result is REJECT regardless of
//  the numeric score — the score is still computed and returned for
//  audit, but the band and decision are forced to reject.
// ════════════════════════════════════════════════════════════════

// ── Public types ─────────────────────────────────────────────────

export interface FactorScores {
  /** All factors are 0-100. Inputs are clamped defensively. */
  trend:      number;
  momentum:   number;
  volume:     number;
  breakout:   number;
  riskReward: number;
  liquidity:  number;
  stability:  number;
}

export interface Penalty {
  /** Stable code for log/UI keying. */
  code:   string;
  /** Positive points to SUBTRACT from composite. */
  points: number;
  /** Operator-readable reason. */
  reason: string;
}

export type Classification =
  | 'HIGH_CONVICTION_BUY'
  | 'VALID_BUY'
  | 'WATCHLIST'
  | 'REJECT';

export type Decision = 'show_in_main' | 'show_in_emerging' | 'reject';

export interface ScoringInput {
  factors:    FactorScores;
  /** Optional penalty list, each subtracted from the composite. */
  penalties?: Penalty[];

  // ── Hard-gate inputs (optional — gates self-skip when null/undefined,
  //     EXCEPT for stop_violated which needs price + stopLoss + direction) ──
  rsi14?:          number | null;
  riskReward?:     number | null;
  liquidityScore?: number | null;
  price?:          number | null;
  stopLoss?:       number | null;
  /** Trade direction. Used by the stop_violated rule:
   *    BUY  violated iff price ≤ stopLoss   (stop is below entry)
   *    SELL violated iff price ≥ stopLoss   (stop is above entry)
   *  When omitted, defaults to BUY-style (price ≤ stopLoss) to preserve
   *  backward compat for callers that haven't been updated. */
  direction?:      'BUY' | 'SELL';
  isStale?:        boolean;
  isInvalidated?:  boolean;
  gapPct?:         number | null;
  gapVolumeMult?:  number | null;

  // ── Tunable thresholds for the gap rule. Other gates use the
  //     fixed values from the spec (RSI 80, RR 1.5, liq 40). ──
  extremeGapPct?:  number;   // default 18
  gapConfirmMult?: number;   // default 1.5
}

export interface ScoringResult {
  final_score:    number;
  classification: Classification;
  factor_scores:  FactorScores;
  penalties:      Penalty[];
  decision:       Decision;

  // ── Diagnostics (additive — not required by the spec contract) ──
  total_penalty:         number;
  composite_pre_penalty: number;
  hard_rejects:          string[];
}

// ── Constants (frozen — formula is fixed by spec) ────────────────

export const SCORING_WEIGHTS = Object.freeze({
  trend:      0.20,
  momentum:   0.15,
  volume:     0.15,
  breakout:   0.20,
  riskReward: 0.15,
  liquidity:  0.10,
  stability:  0.05,
}) satisfies Record<keyof FactorScores, number>;

const BAND_HIGH_CONVICTION = 80;
const BAND_VALID_BUY       = 65;
const BAND_WATCHLIST       = 50;

const HARD_RSI_MAX           = 80;
const HARD_RR_MIN            = 1.5;
const HARD_LIQ_MIN           = 40;
const DEFAULT_EXTREME_GAP    = 18;
const DEFAULT_GAP_CONFIRM    = 1.5;

// ── Internals ────────────────────────────────────────────────────

function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  return Math.min(hi, Math.max(lo, n));
}

function clampFactors(f: FactorScores): FactorScores {
  return {
    trend:      clamp(f.trend,      0, 100),
    momentum:   clamp(f.momentum,   0, 100),
    volume:     clamp(f.volume,     0, 100),
    breakout:   clamp(f.breakout,   0, 100),
    riskReward: clamp(f.riskReward, 0, 100),
    liquidity:  clamp(f.liquidity,  0, 100),
    stability:  clamp(f.stability,  0, 100),
  };
}

function computeComposite(f: FactorScores): number {
  return (
    f.trend      * SCORING_WEIGHTS.trend +
    f.momentum   * SCORING_WEIGHTS.momentum +
    f.volume     * SCORING_WEIGHTS.volume +
    f.breakout   * SCORING_WEIGHTS.breakout +
    f.riskReward * SCORING_WEIGHTS.riskReward +
    f.liquidity  * SCORING_WEIGHTS.liquidity +
    f.stability  * SCORING_WEIGHTS.stability
  );
}

function classifyBand(score: number): Classification {
  if (score >= BAND_HIGH_CONVICTION) return 'HIGH_CONVICTION_BUY';
  if (score >= BAND_VALID_BUY)       return 'VALID_BUY';
  if (score >= BAND_WATCHLIST)       return 'WATCHLIST';
  return 'REJECT';
}

/** WATCHLIST is intentionally NOT shown in the main BUY/SELL table —
 *  per spec it's surfaced only in the emerging-opportunities section.
 *  REJECT never surfaces anywhere. */
function classificationToDecision(c: Classification): Decision {
  switch (c) {
    case 'HIGH_CONVICTION_BUY':
    case 'VALID_BUY':
      return 'show_in_main';
    case 'WATCHLIST':
      return 'show_in_emerging';
    case 'REJECT':
      return 'reject';
  }
}

function evaluateHardRejects(input: ScoringInput): string[] {
  const rejects: string[] = [];
  const extremeGapPct  = input.extremeGapPct  ?? DEFAULT_EXTREME_GAP;
  const gapConfirmMult = input.gapConfirmMult ?? DEFAULT_GAP_CONFIRM;

  if (input.rsi14 != null && Number.isFinite(input.rsi14) && input.rsi14 > HARD_RSI_MAX) {
    rejects.push('rsi_overbought_extreme');
  }
  if (input.riskReward != null && Number.isFinite(input.riskReward) && input.riskReward < HARD_RR_MIN) {
    rejects.push('risk_reward_insufficient');
  }
  if (input.liquidityScore != null && Number.isFinite(input.liquidityScore) && input.liquidityScore < HARD_LIQ_MIN) {
    rejects.push('liquidity_score_low');
  }
  if (
    input.price != null    && Number.isFinite(input.price) &&
    input.stopLoss != null && Number.isFinite(input.stopLoss) && input.stopLoss > 0
  ) {
    // Direction-aware stop check. Without it, every fresh SELL signal
    // (where stopLoss > entry by design) trips a spurious stop_violated.
    // Default to BUY-style if direction is missing — preserves prior
    // behaviour for callers that haven't started passing direction.
    const dir       = input.direction ?? 'BUY';
    const violated  = dir === 'SELL'
      ? input.price >= input.stopLoss
      : input.price <= input.stopLoss;
    if (violated) {
      rejects.push('stop_violated');
    }
  }
  if (input.isStale === true)        rejects.push('signal_stale');
  if (input.isInvalidated === true)  rejects.push('live_invalidated');

  if (
    input.gapPct != null && Number.isFinite(input.gapPct) &&
    Math.abs(input.gapPct) > extremeGapPct
  ) {
    const mult = input.gapVolumeMult;
    // Gate fires when volume DOESN'T confirm. Missing/null mult = no
    // confirmation by definition (we never accept an outlier without
    // explicit confirmation evidence).
    if (mult == null || !Number.isFinite(mult) || mult < gapConfirmMult) {
      rejects.push('extreme_gap_unconfirmed');
    }
  }
  return rejects;
}

// ── Public entry ─────────────────────────────────────────────────

/**
 * Score a candidate. Pure function: no I/O, never throws.
 *
 * The factor scores are the caller's responsibility — this module
 * does NOT know how to derive them from raw indicators. The scanner's
 * factor-builder layer is what feeds this function.
 *
 * Hard rejects fire on the explicit gate inputs (rsi14, riskReward,
 * liquidityScore, price/stopLoss, isStale, isInvalidated, gap context).
 * Any of them firing forces classification=REJECT regardless of score.
 */
export function scoreCandidate(input: ScoringInput): ScoringResult {
  const factors = clampFactors(input.factors);
  const penalties = (input.penalties ?? []).map((p) => ({
    code:   String(p.code ?? ''),
    points: Number.isFinite(p.points) ? Math.max(0, p.points) : 0,
    reason: String(p.reason ?? ''),
  }));
  const total_penalty = penalties.reduce((s, p) => s + p.points, 0);

  const composite_pre_penalty = computeComposite(factors);
  const final_score = clamp(composite_pre_penalty - total_penalty, 0, 100);

  const hard_rejects = evaluateHardRejects(input);

  // Hard rejects override the band. The numeric score is still surfaced
  // so dashboards can show "would have scored X but rejected because Y".
  const classification: Classification =
    hard_rejects.length > 0 ? 'REJECT' : classifyBand(final_score);
  const decision = classificationToDecision(classification);

  return {
    final_score,
    classification,
    factor_scores: factors,
    penalties,
    decision,
    total_penalty,
    composite_pre_penalty,
    hard_rejects,
  };
}
