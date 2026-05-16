// ════════════════════════════════════════════════════════════════
//  Phase-7 Stress Test Engine
//
//  Per-signal forward-looking stress simulator. Given a candidate
//  trade (symbol, direction, entry, stop, size, ATR, liquidity),
//  applies seven hostile scenarios and returns a 0-100 survival
//  score plus rejection codes.
//
//  Scenarios modeled:
//
//    market_down_3_percent          broad-market drop, 3 %
//    market_down_5_percent          broad-market drop, 5 %
//    market_down_10_percent         broad-market drop, 10 %
//    sector_down_5_percent          sector drop, 5 %
//    volatility_spike_30_percent    ATR widens 30 %, whipsaw both ways
//    gap_down_against_position      adverse overnight gap (1.5× ATR)
//    liquidity_dry_up               exit slippage scaled by illiquidity
//
//  All scenarios are evaluated relative to the position direction:
//
//    long  (BUY)  : market/sector/gap shocks lose capital
//    short (SELL) : market/sector/gap shocks PROFIT (loss is negative)
//                   volatility spike and liquidity dry-up still cost
//                   both sides — whipsaw and slippage are direction-
//                   neutral.
//
//  Output is the canonical per-signal block consumed by the main
//  signal table:
//
//    expected_loss            probability-weighted $ loss
//    worst_case_loss          largest $ loss across scenarios
//    stress_survival_score    0-100, capital + stop-breach blended
//    fragile                  true when score < 60
//    stress_rejection_codes   list of breach codes; main-table writer
//                             must hard-reject when 'stress_survival_below_60'
//                             is present.
//
//  Stateless, synchronous, IO-free.
// ════════════════════════════════════════════════════════════════

import { clamp, round } from '../utils/math';

// ── Scenario catalog ───────────────────────────────────────────

export type StressScenarioCode =
  | 'market_down_3_percent'
  | 'market_down_5_percent'
  | 'market_down_10_percent'
  | 'sector_down_5_percent'
  | 'volatility_spike_30_percent'
  | 'gap_down_against_position'
  | 'liquidity_dry_up';

type ScenarioKind = 'directional' | 'symmetric' | 'gap' | 'liquidity';

interface ScenarioSpec {
  code:       StressScenarioCode;
  kind:       ScenarioKind;
  /** Magnitude of the shock — interpretation depends on `kind`. */
  magnitude:  number;
  /** Probability weight for the expected-loss aggregate. Need not sum to 1. */
  weight:     number;
}

const SCENARIOS: ScenarioSpec[] = [
  // Directional shocks: long loses, short gains.
  { code: 'market_down_3_percent',       kind: 'directional', magnitude: 0.03, weight: 0.30 },
  { code: 'market_down_5_percent',       kind: 'directional', magnitude: 0.05, weight: 0.20 },
  { code: 'market_down_10_percent',      kind: 'directional', magnitude: 0.10, weight: 0.10 },
  { code: 'sector_down_5_percent',       kind: 'directional', magnitude: 0.05, weight: 0.15 },
  // Symmetric whipsaw: both sides lose. Magnitude = ATR widening factor.
  { code: 'volatility_spike_30_percent', kind: 'symmetric',   magnitude: 0.30, weight: 0.10 },
  // Adverse overnight gap: long gaps down, short gaps up. Magnitude = ATR multiple.
  { code: 'gap_down_against_position',   kind: 'gap',         magnitude: 1.5,  weight: 0.10 },
  // Exit slippage when liquidity evaporates. Magnitude = exit-bps at zero liquidity.
  { code: 'liquidity_dry_up',            kind: 'liquidity',   magnitude: 0.04, weight: 0.05 },
];

// ── Public input/output ─────────────────────────────────────────

export interface StressTestInput {
  symbol:         string;
  direction:      'BUY' | 'SELL';
  entryPrice:     number;
  stopLoss:       number;
  /** Position size in shares/units. Gross value = entryPrice × positionSize. */
  positionSize:   number;
  /** ATR as a fraction of price (e.g. 0.014 = 1.4 %). */
  atrPct:         number;
  /** 0-100. Lower = more illiquid, larger dry-up loss. */
  liquidityScore: number;
  sector:         string;
  /** Capital base used for % loss and survival calculations. */
  capital:        number;
  /** Optional beta vs broad market. Defaults to 1. */
  marketBeta?:    number;
  /** Optional beta vs sector. Defaults to 1. */
  sectorBeta?:    number;
}

export interface StressScenarioOutcome {
  scenario:    StressScenarioCode;
  /** Signed $ loss. Negative = profit under the scenario (e.g. shorts in a crash). */
  loss:        number;
  /** Signed loss as % of capital. */
  loss_pct:    number;
  /** True when this scenario's adverse move would cross the stop level. */
  stop_hit:    boolean;
}

export type StressRejectionCode =
  | 'stress_survival_below_60'
  | 'gap_breaches_stop'
  | 'volatility_breaches_stop'
  | 'market_crash_breaches_stop'
  | 'liquidity_dry_up_severe';

export interface StressTestResult {
  symbol:                 string;
  direction:              'BUY' | 'SELL';
  scenarios:              StressScenarioOutcome[];
  expected_loss:          number;
  expected_loss_pct:      number;
  worst_case_loss:        number;
  worst_case_loss_pct:    number;
  worst_case_scenario:    StressScenarioCode;
  stress_survival_score:  number;
  fragile:                boolean;
  stress_rejection_codes: StressRejectionCode[];
}

// ── Constants ──────────────────────────────────────────────────

/** Hard-reject threshold for the main signal table. */
export const STRESS_SURVIVAL_HARD_FLOOR = 60;
/** Capital-loss % at which the capital-stress contribution saturates. */
const MAX_CAPITAL_LOSS_PCT = 8;
/** Liquidity score at or below which 'liquidity_dry_up_severe' fires. */
const LIQUIDITY_SEVERE_FLOOR = 35;

// ── Per-scenario loss ──────────────────────────────────────────

/**
 * Loss magnitude under a directional shock. Long positions lose
 * grossValue × shock × beta. Short positions earn the same amount
 * (returned as a negative loss).
 */
function directionalLoss(
  spec:        ScenarioSpec,
  grossValue:  number,
  direction:   'BUY' | 'SELL',
  beta:        number,
): number {
  const magnitude = grossValue * spec.magnitude * beta;
  return direction === 'BUY' ? magnitude : -magnitude;
}

/**
 * Loss magnitude under a symmetric whipsaw. Both sides lose; the
 * trade gets stopped through a widened ATR band, costing roughly
 * (1 + magnitude) × stop-distance per share.
 */
function symmetricLoss(
  spec:         ScenarioSpec,
  positionSize: number,
  stopDistance: number,
): number {
  return positionSize * stopDistance * (1 + spec.magnitude);
}

/**
 * Loss magnitude under an adverse overnight gap. The scenario name
 * — "gap_down_against_position" — is direction-agnostic: longs gap
 * down, shorts gap up. Either way the position takes a loss.
 * Magnitude is expressed as an ATR multiple of the entry price.
 */
function gapLoss(
  spec:         ScenarioSpec,
  entryPrice:   number,
  positionSize: number,
  atrPct:       number,
): number {
  const gapMagnitude = entryPrice * atrPct * spec.magnitude;
  return positionSize * gapMagnitude;
}

/**
 * Liquidity dry-up cost. At liquidityScore=100 the slippage is 0;
 * at liquidityScore=0 the slippage is `magnitude` of gross value.
 * Linear interpolation in between. Direction-neutral — exiting an
 * illiquid book is expensive whether you are long or short.
 */
function liquidityLoss(
  spec:           ScenarioSpec,
  grossValue:     number,
  liquidityScore: number,
): number {
  const illiquidityFrac = clamp((100 - liquidityScore) / 100, 0, 1);
  return grossValue * spec.magnitude * illiquidityFrac;
}

/**
 * Whether the scenario's move would cross the stop. Used to
 * penalise survival score and emit advisory rejection codes — a
 * stop-breach on a 3 % market drop signals a too-tight stop.
 *
 * Directional shocks (market/sector down) only breach the stop
 * when they push price *into* the stop. For a long, a market drop
 * moves price toward a stop placed below entry — possible breach.
 * For a short, a market drop moves price away from a stop placed
 * above entry — no breach. Gap-against-position is adverse by
 * definition, and a volatility whipsaw can hit either side.
 */
function stopHit(
  spec:         ScenarioSpec,
  input:        StressTestInput,
): boolean {
  const stopDistance = Math.abs(input.entryPrice - input.stopLoss);
  if (stopDistance <= 0) return false;

  if (spec.kind === 'liquidity') return false;

  if (spec.kind === 'directional') {
    // Market/sector down only crosses the stop for longs.
    if (input.direction !== 'BUY') return false;
    const beta = spec.code === 'sector_down_5_percent'
      ? (input.sectorBeta ?? 1)
      : (input.marketBeta ?? 1);
    return input.entryPrice * spec.magnitude * beta >= stopDistance;
  }

  // gap (adverse by name) and symmetric (whipsaw) — both can hit
  // the stop regardless of position side.
  return input.entryPrice * input.atrPct * spec.magnitude >= stopDistance;
}

function evaluateScenario(
  spec:  ScenarioSpec,
  input: StressTestInput,
): StressScenarioOutcome {
  const grossValue   = input.entryPrice * input.positionSize;
  const stopDistance = Math.abs(input.entryPrice - input.stopLoss);

  let loss = 0;
  switch (spec.kind) {
    case 'directional': {
      const beta = spec.code === 'sector_down_5_percent'
        ? (input.sectorBeta ?? 1)
        : (input.marketBeta ?? 1);
      loss = directionalLoss(spec, grossValue, input.direction, beta);
      break;
    }
    case 'symmetric':
      loss = symmetricLoss(spec, input.positionSize, stopDistance);
      break;
    case 'gap':
      loss = gapLoss(spec, input.entryPrice, input.positionSize, input.atrPct);
      break;
    case 'liquidity':
      loss = liquidityLoss(spec, grossValue, input.liquidityScore);
      break;
  }

  return {
    scenario: spec.code,
    loss:     round(loss),
    loss_pct: round(input.capital > 0 ? (loss / input.capital) * 100 : 0),
    stop_hit: stopHit(spec, input),
  };
}

// ── Survival score ─────────────────────────────────────────────

/**
 * Blend capital drawdown and stop-breach count into a 0-100 score.
 *
 *   capitalStress = clamp(worst_loss_pct / MAX_CAPITAL_LOSS_PCT, 0, 1) × 100
 *   breachStress  = (# directional/gap scenarios breaching stop / 5) × 100
 *   survival      = 100 − (0.7 × capitalStress + 0.3 × breachStress)
 *
 * 70/30 weighting in favour of capital — a stop breach on a 10 %
 * market drop is concerning but absorbable; a 5 % capital hit on
 * the worst case is closer to terminal. A net-profit worst case
 * (e.g. short positions in a crash) floors the loss at 0.
 */
function computeSurvivalScore(
  worstCaseLossPctCapital: number,
  outcomes:                StressScenarioOutcome[],
): number {
  const lossPct = Math.max(0, worstCaseLossPctCapital);
  const capitalStress = clamp(lossPct / MAX_CAPITAL_LOSS_PCT, 0, 1) * 100;

  // Stop-breach denominator excludes the liquidity scenario (no
  // price move to compare against the stop).
  const breachable = outcomes.filter((o) => o.scenario !== 'liquidity_dry_up');
  const breaches   = breachable.filter((o) => o.stop_hit).length;
  const breachStress = breachable.length > 0
    ? (breaches / breachable.length) * 100
    : 0;

  const survival = 100 - (0.7 * capitalStress + 0.3 * breachStress);
  return Math.round(clamp(survival, 0, 100));
}

// ── Rejection codes ────────────────────────────────────────────

function buildRejectionCodes(
  outcomes:        StressScenarioOutcome[],
  survivalScore:   number,
  liquidityScore:  number,
): StressRejectionCode[] {
  const codes: StressRejectionCode[] = [];
  if (survivalScore < STRESS_SURVIVAL_HARD_FLOOR) {
    codes.push('stress_survival_below_60');
  }
  const gap = outcomes.find((o) => o.scenario === 'gap_down_against_position');
  if (gap?.stop_hit) codes.push('gap_breaches_stop');

  const vol = outcomes.find((o) => o.scenario === 'volatility_spike_30_percent');
  if (vol?.stop_hit) codes.push('volatility_breaches_stop');

  // Stop crossing a single-digit market drop signals a too-tight stop.
  const market3 = outcomes.find((o) => o.scenario === 'market_down_3_percent');
  const market5 = outcomes.find((o) => o.scenario === 'market_down_5_percent');
  if (market3?.stop_hit || market5?.stop_hit) codes.push('market_crash_breaches_stop');

  if (liquidityScore <= LIQUIDITY_SEVERE_FLOOR) codes.push('liquidity_dry_up_severe');
  return codes;
}

// ── Public API ─────────────────────────────────────────────────

/**
 * Run the Phase-7 stress test for a single signal. Apply every
 * scenario, derive the worst-case and probability-weighted expected
 * losses, score survival on a 0-100 scale, and emit rejection codes.
 *
 * Callers writing to the main signal table MUST hard-reject any
 * signal whose result.stress_rejection_codes contains
 * 'stress_survival_below_60'.
 */
export function runStressTest(input: StressTestInput): StressTestResult {
  const outcomes = SCENARIOS.map((s) => evaluateScenario(s, input));

  // Worst case = largest $ loss across scenarios. Profitable
  // scenarios (negative loss) cannot be the worst case.
  const worst = outcomes.reduce(
    (acc, o) => (o.loss > acc.loss ? o : acc),
    outcomes[0],
  );

  // Probability-weighted expected loss. Normalise by total weight
  // so partial scenario lists still produce a meaningful average.
  const totalWeight = SCENARIOS.reduce((s, sc) => s + sc.weight, 0);
  const expectedLoss = totalWeight > 0
    ? SCENARIOS.reduce((sum, sc, i) => sum + outcomes[i].loss * sc.weight, 0) / totalWeight
    : 0;
  const expectedLossPct = input.capital > 0 ? (expectedLoss / input.capital) * 100 : 0;
  const worstLossPct    = input.capital > 0 ? (worst.loss   / input.capital) * 100 : 0;

  const stressSurvivalScore = computeSurvivalScore(worstLossPct, outcomes);
  const stressRejectionCodes = buildRejectionCodes(outcomes, stressSurvivalScore, input.liquidityScore);

  return {
    symbol:                 input.symbol,
    direction:              input.direction,
    scenarios:              outcomes,
    expected_loss:          round(expectedLoss),
    expected_loss_pct:      round(expectedLossPct),
    worst_case_loss:        round(worst.loss),
    worst_case_loss_pct:    round(worstLossPct),
    worst_case_scenario:    worst.scenario,
    stress_survival_score:  stressSurvivalScore,
    fragile:                stressSurvivalScore < STRESS_SURVIVAL_HARD_FLOOR,
    stress_rejection_codes: stressRejectionCodes,
  };
}
