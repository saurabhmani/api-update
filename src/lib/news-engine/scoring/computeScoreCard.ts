// ════════════════════════════════════════════════════════════════
//  Composite Scorer — symbolImpact + eventRisk + manipulationBoost
//
//  FORMULA (symbolImpact):
//    0.22 × trust
//  + 0.20 × importance
//  + 0.18 × |sentiment|     (absolute magnitude, not direction)
//  + 0.15 × freshness
//  + 0.15 × novelty
//  + 0.10 × directness
//
//  GUARDS:
//    - Sentiment alone CANNOT drive decisions: if trust < 40,
//      sentiment weight drops to 0.08 (redistributed to trust).
//    - Low trust dampens ALL dimensions via a trust multiplier.
//    - Social signals boost manipulation suspicion.
//
//  OUTPUT:
//    - symbolImpactScore   (0–100)
//    - eventRiskScore      (0–100)
//    - manipulationRiskBoost (0–50)
// ════════════════════════════════════════════════════════════════

import type { NewsEvent } from '../types/newsEngine.types';
import type {
  NewsScoreCard,
  ScoringWeights,
} from '../types/scoring.types';
import { DEFAULT_SCORING_WEIGHTS } from '../types/scoring.types';
import {
  scoreTrust,
  scoreSentiment,
  scoreImportance,
  scoreNovelty,
  scoreFreshness,
  scoreDirectness,
  scoreManipulationSuspicion,
} from './scorers';

/**
 * Compute a full NewsScoreCard for one (event, symbol) pair.
 *
 * @param event              - the normalized news event
 * @param targetSymbol       - which symbol this card is for
 * @param recentSimilarCount - # of similar events in last 24h (for novelty)
 * @param weights            - optional weight overrides
 */
export function computeScoreCard(
  event: NewsEvent,
  targetSymbol: string,
  recentSimilarCount = 0,
  weights: ScoringWeights = DEFAULT_SCORING_WEIGHTS,
): NewsScoreCard {
  // ── Step 1: Compute all 7 dimensions ───────────────────────
  const trust       = scoreTrust(event);
  const sentiment   = scoreSentiment(event);
  const importance  = scoreImportance(event);
  const novelty     = scoreNovelty(event, recentSimilarCount);
  const freshness   = scoreFreshness(event);
  const directness  = scoreDirectness(event, targetSymbol);
  const manipulation = scoreManipulationSuspicion(event, trust, novelty);

  // ── Step 2: Adjust weights based on trust level ────────────
  //
  // RULE: Sentiment alone cannot drive decisions.
  // When trust is low, we redistribute sentiment weight to trust
  // so that unreliable sources can't move the needle via sentiment.
  let w = { ...weights };

  if (trust.score < 40) {
    // Low trust: slash sentiment weight, boost trust weight
    const sentimentReduction = w.sentiment - 0.08;
    w = {
      ...w,
      sentiment: 0.08,
      trust: w.trust + sentimentReduction,
    };
  } else if (trust.score < 55) {
    // Moderate trust: slightly reduce sentiment influence
    const sentimentReduction = w.sentiment - 0.12;
    w = {
      ...w,
      sentiment: 0.12,
      trust: w.trust + sentimentReduction,
    };
  }

  // ── Step 3: Compute symbolImpactScore ──────────────────────
  //
  // Uses ABSOLUTE sentiment magnitude (not direction).
  // Direction is preserved in the sentiment dimension for consumers.
  const rawImpact =
    w.trust      * trust.score +
    w.importance * importance.score +
    w.sentiment  * sentiment.magnitude +    // abs value
    w.freshness  * freshness.score +
    w.novelty    * novelty.score +
    w.directness * directness.score;

  // Trust multiplier: low trust dampens the entire score
  // trust 80+ → multiplier 1.0, trust 40 → 0.7, trust 0 → 0.4
  const trustMultiplier = 0.4 + 0.6 * (trust.score / 100);
  const symbolImpactScore = clamp(Math.round(rawImpact * trustMultiplier), 0, 100);

  // ── Step 4: Compute eventRiskScore ─────────────────────────
  //
  // Risk of ACTING on this event. High when:
  //   - trust is low (unreliable source)
  //   - manipulation suspicion is high
  //   - novelty is low (rehashed / stale info)
  //   - directness is low (indirect relevance)
  const eventRiskScore = clamp(Math.round(
    0.30 * (100 - trust.score) +           // inverse trust
    0.30 * manipulation.score +             // manipulation risk
    0.15 * (100 - novelty.score) +          // inverse novelty
    0.15 * (100 - directness.score) +       // inverse directness
    0.10 * (100 - freshness.score)          // inverse freshness
  ), 0, 100);

  // ── Step 5: Compute manipulationRiskBoost ──────────────────
  //
  // Additive penalty for the signal layer. Capped at 50 to
  // avoid completely zeroing out legitimate signals.
  // Only kicks in when manipulation suspicion is meaningful.
  let manipulationRiskBoost = 0;
  if (manipulation.score >= 30) {
    manipulationRiskBoost = clamp(
      Math.round((manipulation.score - 20) * 0.625),  // maps 20→0, 100→50
      0,
      50,
    );
  }

  return {
    newsEventId:    event.id ?? 0,
    symbol:         targetSymbol,
    trust,
    sentiment,
    importance,
    novelty,
    freshness,
    directness,
    manipulation,
    symbolImpactScore,
    eventRiskScore,
    manipulationRiskBoost,
    scoredAt:       new Date().toISOString(),
  };
}

/**
 * Score a single event for ALL its linked symbols.
 * Returns one NewsScoreCard per symbol.
 */
export function scoreEventForAllSymbols(
  event: NewsEvent,
  recentSimilarCount = 0,
): NewsScoreCard[] {
  if (event.symbols.length === 0) {
    // No symbols → score against a synthetic 'MARKET' target
    return [computeScoreCard(event, 'MARKET', recentSimilarCount)];
  }
  return event.symbols.map((sym) =>
    computeScoreCard(event, sym, recentSimilarCount),
  );
}

function clamp(val: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, val));
}
