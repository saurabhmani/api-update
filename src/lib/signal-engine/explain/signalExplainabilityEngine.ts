// ════════════════════════════════════════════════════════════════
//  Signal Explainability Engine
//
//  Factor-attribution layer that renders a scoringEngine.ScoringResult
//  as a human-readable breakdown of "why did this signal score the
//  way it did, and why was it classified accordingly." Produces three
//  things per the contract:
//
//    1. factorScores       — per-dimension 0-100 scores, applied
//                            weights, and signed weighted contributions.
//    2. explanations       — one plain-English string per factor
//                            calling out what drove it (top sub-
//                            dimension for confidence / risk / etc.).
//    3. decisionReasoning  — narrative that ties the classification
//                            band back to the 1-2 factors that did
//                            the most work for and against the trade.
//
//  Scope boundary vs existing explain files:
//
//    explain/buildReasons.ts          → feature-level trigger list
//                                        ("RSI at 62 in ideal range").
//                                        Operates on SignalFeatures,
//                                        ignores final scoring.
//
//    explain/buildWarnings.ts         → analogous warning list.
//
//    ai-explain/buildExplanation.ts   → full narrative product:
//                                        summary + whyNow + trader
//                                        guidance + invalidation.
//                                        Consumer-facing prose.
//
//    signalExplainabilityEngine.ts    → THIS FILE: weighted factor
//                                        attribution over the
//                                        ScoringResult. Structural,
//                                        not narrative. Used by the
//                                        API "why this score" drill-
//                                        down and as a debug view
//                                        when tuning weights.
//
//  Pure, synchronous, IO-free. Safe to call from any layer that
//  already has a ScoringResult in hand.
// ════════════════════════════════════════════════════════════════

import type {
  ScoringResult,
  ScoringWeights,
  ClassificationBand,
} from '../scoring/scoringEngine';
import type {
  ConfidenceBreakdown,
  RiskBreakdown,
  StrategyName,
} from '../types/signalEngine.types';
import type { PortfolioFitResult } from '../types/phase3.types';
import type { FreshnessReport } from '../freshness/freshnessEngine';

// ── Inputs ──────────────────────────────────────────────────────

export interface ExplainabilityInput {
  symbol?:       string;
  strategy?:     StrategyName;
  /** Required. Output of scoringEngine.computeFinalScore. */
  scoring:       ScoringResult;
  /** Optional drill-down sources. When supplied, the engine names the
   *  sub-dimension that drove each factor instead of producing a
   *  generic "confidence is X" line. */
  confidence?:   ConfidenceBreakdown;
  risk?:         RiskBreakdown;
  portfolioFit?: PortfolioFitResult;
  freshness?:    FreshnessReport;
  /** Raw R:R ratio that was fed into the scoring engine. Optional —
   *  used to surface the unclipped value in the reward explanation.
   *  When missing, the engine reports the normalized 0-100 score only. */
  riskReward?:   number;
}

// ── Outputs ─────────────────────────────────────────────────────

export type FactorId = keyof ScoringWeights;

/** Semantic grouping for the UI — confidence/risk/context/time. */
export type FactorCategory =
  | 'conviction'
  | 'risk'
  | 'reward'
  | 'portfolio'
  | 'regime'
  | 'timing';

export type FactorDirection = 'positive' | 'negative' | 'neutral';

export interface FactorAttribution {
  id:                   FactorId;
  label:                string;
  category:             FactorCategory;
  /** 0-100 normalized score (higher is better, regardless of factor). */
  score:                number;
  /** 0-1 weight as actually applied by the scoring engine. */
  weight:               number;
  /** score × weight. Sums to finalScore across all factors. */
  weightedContribution: number;
  /** Derived sentiment — how this factor pulled on the final score. */
  direction:            FactorDirection;
  /** One-line human-readable account of what drove this factor. */
  explanation:          string;
}

export interface ExplainabilityReport {
  finalScore:         number;
  classification:     ClassificationBand;
  factors:            FactorAttribution[];
  /** Same strings as `factors[].explanation`, flattened for UI lists. */
  explanations:       string[];
  /** Up to 2 highest-contributing factors (with direction === 'positive'). */
  topPositiveFactors: FactorAttribution[];
  /** Up to 2 factors that dragged the score most (low score × high weight). */
  topNegativeFactors: FactorAttribution[];
  /** Narrative: why the row was classified as it was. */
  decisionReasoning:  string;
}

// ── Factor metadata ─────────────────────────────────────────────
//
// Ordered to match scoringEngine.ScoringWeights. Labels and
// categories are what the UI renders; they do NOT affect any math.

const FACTOR_META: Record<FactorId, { label: string; category: FactorCategory }> = {
  confidence:      { label: 'Setup Conviction',   category: 'conviction' },
  riskQuality:     { label: 'Risk Quality',       category: 'risk'       },
  rewardRisk:      { label: 'Reward : Risk',      category: 'reward'     },
  portfolioFit:    { label: 'Portfolio Fit',      category: 'portfolio'  },
  regimeAlignment: { label: 'Regime Alignment',   category: 'regime'     },
  freshness:       { label: 'Signal Freshness',   category: 'timing'     },
};

const FACTOR_ORDER: FactorId[] = [
  'confidence', 'riskQuality', 'rewardRisk',
  'portfolioFit', 'regimeAlignment', 'freshness',
];

// ── Thresholds ──────────────────────────────────────────────────
//
// A factor pulls the score up or down relative to a neutral 50.
// These thresholds are deliberately symmetric so the sentiment is
// stable regardless of the underlying weight.
const POSITIVE_FLOOR = 60;
const NEGATIVE_CEIL  = 40;

// ── Helpers ─────────────────────────────────────────────────────

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function classifyDirection(score: number): FactorDirection {
  if (score >= POSITIVE_FLOOR) return 'positive';
  if (score <= NEGATIVE_CEIL)  return 'negative';
  return 'neutral';
}

// ── Per-factor explanations ─────────────────────────────────────
//
// Each branch returns a single short sentence. When a drill-down
// source is supplied (confidence / risk / portfolioFit / freshness)
// the engine names the sub-dimension that dominated; otherwise it
// falls back to a score-only template. Kept intentionally terse —
// downstream UI may truncate or stack these.

function explainConfidence(score: number, conf?: ConfidenceBreakdown): string {
  if (!conf) return `Setup conviction ${score.toFixed(0)}/100 (band derived from raw score).`;
  const parts: Array<[string, number]> = [
    ['trend',      conf.trendScore],
    ['momentum',   conf.momentumScore],
    ['volume',     conf.volumeScore],
    ['structure',  conf.structureScore],
    ['context',    conf.contextScore],
  ];
  const top = parts.reduce((a, b) => (b[1] > a[1] ? b : a));
  const bot = parts.reduce((a, b) => (b[1] < a[1] ? b : a));
  if (score >= POSITIVE_FLOOR) {
    return `Setup conviction ${score.toFixed(0)}/100 — ${top[0]} led the read (${top[1].toFixed(0)}), band "${conf.band}".`;
  }
  if (score <= NEGATIVE_CEIL) {
    return `Setup conviction ${score.toFixed(0)}/100 — weakest sub-dimension was ${bot[0]} (${bot[1].toFixed(0)}), band "${conf.band}".`;
  }
  return `Setup conviction ${score.toFixed(0)}/100 — mixed signal (${top[0]}=${top[1].toFixed(0)}, ${bot[0]}=${bot[1].toFixed(0)}), band "${conf.band}".`;
}

function explainRiskQuality(score: number, risk?: RiskBreakdown): string {
  // riskQuality = 100 - risk.totalScore. Higher score = less risk.
  if (!risk) return `Risk quality ${score.toFixed(0)}/100 (derived from 100 − risk score).`;
  const parts: Array<[string, number]> = [
    ['ATR',           risk.atrRisk],
    ['gap',           risk.gapRisk],
    ['stop distance', risk.stopDistanceRisk],
    ['overextension', risk.overextensionRisk],
    ['liquidity',     risk.liquidityRisk],
    ['candle vol',    risk.candleVolatilityRisk],
    ['regime',        risk.regimeRisk],
  ];
  const worst = parts.reduce((a, b) => (b[1] > a[1] ? b : a));
  if (score >= POSITIVE_FLOOR) {
    return `Risk quality ${score.toFixed(0)}/100 — ${risk.band} (worst driver: ${worst[0]} at ${worst[1].toFixed(0)}, still tolerable).`;
  }
  if (score <= NEGATIVE_CEIL) {
    return `Risk quality ${score.toFixed(0)}/100 — ${risk.band} driven by ${worst[0]} (${worst[1].toFixed(0)}).`;
  }
  return `Risk quality ${score.toFixed(0)}/100 — ${risk.band}, largest drag from ${worst[0]} (${worst[1].toFixed(0)}).`;
}

function explainRewardRisk(score: number, rr?: number): string {
  // If the caller passed the raw ratio we can name it directly;
  // otherwise we're stuck with just the normalized 0-100 score,
  // because the scoring engine's saturation at 3.0 makes the
  // inverse lossy.
  if (rr === undefined || !Number.isFinite(rr)) {
    if (score >= 67)    return `Reward:Risk scores ${score.toFixed(0)}/100 — strong payoff profile.`;
    if (score >= 50)    return `Reward:Risk scores ${score.toFixed(0)}/100 — meets signals-table floor.`;
    if (score >= 33)    return `Reward:Risk scores ${score.toFixed(0)}/100 — sub-floor, marginal payoff.`;
    return `Reward:Risk scores ${score.toFixed(0)}/100 — expected-value negative.`;
  }
  if (rr >= 3)   return `Reward:Risk ${rr.toFixed(2)} saturates the scale — exceptional payoff profile.`;
  if (rr >= 2)   return `Reward:Risk ${rr.toFixed(2)} — strong payoff, scores ${score.toFixed(0)}/100.`;
  if (rr >= 1.5) return `Reward:Risk ${rr.toFixed(2)} — meets signals-table floor, scores ${score.toFixed(0)}/100.`;
  if (rr >= 1.0) return `Reward:Risk ${rr.toFixed(2)} — sub-floor for VALID_SIGNAL, scores ${score.toFixed(0)}/100.`;
  return `Reward:Risk ${rr.toFixed(2)} below 1.0 — trade expected-value negative, scores ${score.toFixed(0)}/100.`;
}

function explainPortfolioFit(score: number, pf?: PortfolioFitResult): string {
  if (!pf) return `Portfolio fit ${score.toFixed(0)}/100 (input neutral — fit not supplied).`;
  if (pf.portfolioDecision === 'rejected') {
    return `Portfolio fit ${score.toFixed(0)}/100 — REJECTED: ${pf.penalties.join('; ') || 'exposure caps'}.`;
  }
  if (pf.portfolioDecision === 'deferred') {
    return `Portfolio fit ${score.toFixed(0)}/100 — deferred, capital: ${pf.capitalAvailability}.`;
  }
  if (pf.portfolioDecision === 'approved_with_penalty') {
    return `Portfolio fit ${score.toFixed(0)}/100 — approved with penalties: ${pf.penalties.join('; ')}.`;
  }
  return `Portfolio fit ${score.toFixed(0)}/100 — clean fit across sector, direction, correlation.`;
}

function explainRegime(score: number): string {
  if (score >= POSITIVE_FLOOR) return `Regime alignment ${score.toFixed(0)}/100 — tape is with the trade.`;
  if (score <= NEGATIVE_CEIL)  return `Regime alignment ${score.toFixed(0)}/100 — tape is against the trade, take with caution.`;
  return `Regime alignment ${score.toFixed(0)}/100 — neutral tape backdrop.`;
}

function explainFreshness(score: number, fr?: FreshnessReport): string {
  if (!fr) return `Freshness ${score.toFixed(0)}/100 (no decay data supplied — assumed fresh).`;
  if (fr.rotationCapHit) {
    return `Freshness ${score.toFixed(0)}/100 — rotation cap hit (age ${fr.ageBars} bars), validator will invalidate.`;
  }
  if (fr.entryMissed) {
    return `Freshness ${score.toFixed(0)}/100 — entry window missed (${fr.movePct.toFixed(1)}% past entry).`;
  }
  if (fr.decayState === 'fresh') {
    return `Freshness ${score.toFixed(0)}/100 — fresh (${fr.ageBars} bars, ${fr.movePct.toFixed(1)}% drift).`;
  }
  return `Freshness ${score.toFixed(0)}/100 — ${fr.decayState}, ${fr.ageBars} bars old.`;
}

// ── Factor assembly ─────────────────────────────────────────────

function explainFactor(
  id:       FactorId,
  score:    number,
  weight:   number,
  weighted: number,
  input:    ExplainabilityInput,
): FactorAttribution {
  const meta = FACTOR_META[id];
  let explanation = '';
  switch (id) {
    case 'confidence':      explanation = explainConfidence(score, input.confidence); break;
    case 'riskQuality':     explanation = explainRiskQuality(score, input.risk); break;
    case 'rewardRisk':      explanation = explainRewardRisk(score, input.riskReward); break;
    case 'portfolioFit':    explanation = explainPortfolioFit(score, input.portfolioFit); break;
    case 'regimeAlignment': explanation = explainRegime(score); break;
    case 'freshness':       explanation = explainFreshness(score, input.freshness); break;
  }

  return {
    id,
    label:                meta.label,
    category:             meta.category,
    score:                round1(score),
    weight:               round1(weight * 100) / 100,   // keep 2dp on the weight
    weightedContribution: round1(weighted),
    direction:            classifyDirection(score),
    explanation,
  };
}

// ── Decision reasoning ──────────────────────────────────────────
//
// The scoring engine already produces a terse `reason` string. This
// builder expands on it by naming the factors that moved the needle
// — what *specifically* earned the HIGH_CONVICTION stamp, what
// *specifically* stopped a VALID_SIGNAL from upgrading. Falls back
// to the scoring engine's reason when no factor is particularly
// decisive (everything clustered near neutral).

function buildDecisionReasoning(
  scoring:  ScoringResult,
  factors:  FactorAttribution[],
  topPos:   FactorAttribution[],
  topNeg:   FactorAttribution[],
  symbol?:  string,
  strategy?: StrategyName,
): string {
  const head =
    (symbol ? `${symbol} ` : '') +
    (strategy ? `(${strategy}) ` : '') +
    `classified ${scoring.classification} at final ${scoring.finalScore}.`;

  const bits: string[] = [];

  if (topPos.length > 0) {
    const names = topPos.map((f) => `${f.label.toLowerCase()} (+${f.weightedContribution.toFixed(1)})`).join(' and ');
    bits.push(`Supported by ${names}`);
  }
  if (topNeg.length > 0) {
    const names = topNeg.map((f) => `${f.label.toLowerCase()} (${f.score.toFixed(0)}/100)`).join(' and ');
    bits.push(`held back by ${names}`);
  }

  // Classification-specific tail.
  let tail = '';
  switch (scoring.classification) {
    case 'HIGH_CONVICTION':
      tail = 'All conviction/risk/reward gates cleared their high-conviction thresholds.';
      break;
    case 'VALID_SIGNAL':
      tail = factors.find((f) => f.id === 'confidence' && f.score < 70)
        ? 'Valid but below high-conviction — confidence sub-70 blocks the upgrade.'
        : 'Meets the signals-table gate; one dimension fell short of high-conviction.';
      break;
    case 'DEVELOPING_SETUP':
      tail = 'Score in the 30-50 band — watch, do not trade, wait for confirmation.';
      break;
    case 'NO_TRADE':
      tail = 'Structural reject — confidence/reward floor breached or upstream NO_TRADE inherited.';
      break;
  }

  const body = bits.length > 0 ? `${bits.join(', ')}. ` : '';
  return `${head} ${body}${tail}`.trim();
}

// ── Public API ──────────────────────────────────────────────────

/**
 * Produce factor-attribution + explanations + decision reasoning
 * from a completed ScoringResult and optional drill-down sources.
 *
 * The math here is a re-presentation of the scoring engine's output,
 * NOT a recomputation — so results are guaranteed consistent with
 * whatever was persisted as `final_score`. Callers that only have a
 * ScoringResult (no ConfidenceBreakdown / RiskBreakdown) still get a
 * usable report; the per-factor explanations fall back to score-only
 * templates.
 */
export function explainSignal(input: ExplainabilityInput): ExplainabilityReport {
  const { scoring } = input;

  // Build every factor in canonical order so downstream UIs can
  // render the same layout every time.
  const factors: FactorAttribution[] = FACTOR_ORDER.map((id) => {
    const score    = scoring.components[id];
    const weight   = scoring.appliedWeights[id];
    const weighted = scoring.weightedContributions[id];
    return explainFactor(id, score, weight, weighted, input);
  });

  // Top positive: highest weighted contribution among direction ===
  // 'positive'. Cap at 2 — narrative gets noisy past that.
  const topPositiveFactors = factors
    .filter((f) => f.direction === 'positive')
    .sort((a, b) => b.weightedContribution - a.weightedContribution)
    .slice(0, 2);

  // Top negative: largest gap between "what this factor COULD have
  // contributed at score 100" and what it did contribute. This picks
  // the factor that dragged the score most, regardless of whether
  // its raw score sits just inside the 'negative' bucket.
  const topNegativeFactors = factors
    .filter((f) => f.direction !== 'positive')
    .map((f) => ({ f, drag: f.weight * 100 - f.weightedContribution }))
    .sort((a, b) => b.drag - a.drag)
    .filter((x) => x.drag > 5)           // ignore near-neutral noise
    .slice(0, 2)
    .map((x) => x.f);

  const decisionReasoning = buildDecisionReasoning(
    scoring,
    factors,
    topPositiveFactors,
    topNegativeFactors,
    input.symbol,
    input.strategy,
  );

  return {
    finalScore:         scoring.finalScore,
    classification:     scoring.classification,
    factors,
    explanations:       factors.map((f) => f.explanation),
    topPositiveFactors,
    topNegativeFactors,
    decisionReasoning,
  };
}
