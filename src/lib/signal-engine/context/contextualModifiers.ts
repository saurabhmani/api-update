// ════════════════════════════════════════════════════════════════
//  Contextual Modifier Engine — Phase 4
//
//  Safely adjusts confidence using bounded modifiers.
//  Total adjustment capped at ±10. Fully auditable.
//
//  NUMERIC CONTRACT: All NewsContext fields use 0-1 scale.
//  No scale detection/guessing logic — single standard.
//
//  News modifier uses ±8 range when enriched news intelligence
//  is available (symbolImpactScore present), ±5 for legacy path.
//
//  STRICT: news modifier CANNOT override risk penalties.
//  A positive news modifier is capped so it does not exceed
//  the event risk penalty — news cannot make a risky trade safe.
// ════════════════════════════════════════════════════════════════

import type { ContextualModifierBreakdown, MacroContext, NewsContext, EventRiskSnapshot, SignalFreshness, FeedbackState } from '../types/phase4.types';
import { clamp } from '../utils/math';

const MAX_ADAPTIVE_ADJUSTMENT = 10;

export function computeContextualModifiers(
  originalConfidence: number,
  macro: MacroContext,
  news: NewsContext,
  eventRisk: EventRiskSnapshot,
  freshness: SignalFreshness,
  feedback: FeedbackState,
  sectorInLeadership: boolean,
): ContextualModifierBreakdown {
  // ── News modifier (±8 enriched, ±5 legacy) ────────────────
  const newsModifier = computeNormalizedNewsModifier(news, eventRisk);

  // ── Macro modifier (±4) ───────────────────────────────────
  let macroModifier = 0;
  if (macro.marketTone === 'strongly_constructive') macroModifier = 4;
  else if (macro.marketTone === 'constructive') macroModifier = 2;
  else if (macro.marketTone === 'cautious') macroModifier = -2;
  else if (macro.marketTone === 'hostile') macroModifier = -4;

  // ── Event risk penalty (0 to -6) ──────────────────────────
  const eventPenalty = -Math.min(6, eventRisk.eventRiskPenalty);

  // ── Sector narrative (±3) ─────────────────────────────────
  const sectorModifier = sectorInLeadership ? 3 : 0;

  // ── Strategy fit from feedback (±3) ───────────────────────
  let strategyFitModifier = 0;
  if (feedback.strategyEnvironmentFit === 'excellent') strategyFitModifier = 3;
  else if (feedback.strategyEnvironmentFit === 'good') strategyFitModifier = 1;
  else if (feedback.strategyEnvironmentFit === 'poor') strategyFitModifier = -3;

  // ── Freshness penalty (0 to -5) ───────────────────────────
  let freshnessPenalty = 0;
  if (freshness.decayState === 'stale') freshnessPenalty = -4;
  else if (freshness.decayState === 'actionable_but_aging') freshnessPenalty = -2;
  else if (freshness.decayState === 'expired') freshnessPenalty = -5;

  // ── Feedback calibration (±2) ─────────────────────────────
  let feedbackCalibrationModifier = 0;
  if (feedback.confidenceCalibrationState === 'overconfident') feedbackCalibrationModifier = -2;
  else if (feedback.confidenceCalibrationState === 'underconfident') feedbackCalibrationModifier = 2;

  // ── Total ─────────────────────────────────────────────────
  const rawTotal = newsModifier + macroModifier + eventPenalty + sectorModifier + strategyFitModifier + freshnessPenalty + feedbackCalibrationModifier;
  const cappedAdaptiveAdjustment = clamp(rawTotal, -MAX_ADAPTIVE_ADJUSTMENT, MAX_ADAPTIVE_ADJUSTMENT);
  const finalAdjustedConfidence = clamp(originalConfidence + cappedAdaptiveAdjustment, 0, 100);

  return {
    newsModifier,
    macroModifier,
    eventRiskPenalty: eventPenalty,
    sectorNarrativeModifier: sectorModifier,
    strategyFitModifier,
    freshnessPenalty,
    feedbackCalibrationModifier,
    rawTotal,
    cappedAdaptiveAdjustment,
    originalConfidence,
    finalAdjustedConfidence,
  };
}

/**
 * Compute a deterministic news modifier from the NewsContext.
 * All NewsContext values are 0-1 (no scale detection needed).
 *
 * Enriched path (±8): when symbolImpactScore is present, we use
 * the richer fields for more granular influence.
 *
 * Legacy path (±5): basic RSS headline data without enrichment.
 *
 * Behavior:
 *  - Bullish high-confidence direct news → modest positive conviction
 *  - Bearish high-confidence direct news → reduce conviction / trigger caution
 *  - High eventRiskScore → increases caution (reduces positive modifier)
 *  - High manipulationSuspicion → suppresses aggressive promotion
 */
function computeNormalizedNewsModifier(
  news: NewsContext,
  eventRisk: EventRiskSnapshot,
): number {
  const isEnriched = news.symbolImpactScore !== undefined;
  const maxNewsMod = isEnriched ? 8 : 5;

  let modifier = 0;

  if (isEnriched) {
    // ── Enriched path: use full scored intelligence ──────────
    const impact = news.symbolImpactScore ?? 0;       // 0-1
    const manipulation = news.manipulationSuspicion ?? 0; // 0-1
    const directness = news.directnessScore ?? 0;     // 0-1
    const riskScore = news.eventRiskScore ?? 0;        // 0-1

    // Manipulation dampening: high suspicion suppresses aggressive promotion
    const manipulationDampener = manipulation > 0.5
      ? Math.max(0.2, 1 - manipulation)
      : 1;

    // Directness boost: direct symbol news matters more than sector noise
    const directnessWeight = 0.5 + directness * 0.5; // 0.5 to 1.0

    if (news.bias === 'positive' && news.strength > 0.3 && news.freshnessHours < 24) {
      // Positive modifier: strength × impact × directness × manipulation dampening
      const raw = news.strength * impact * directnessWeight * manipulationDampener * maxNewsMod;
      modifier = Math.round(raw);
    } else if (news.bias === 'negative' && news.strength > 0.2) {
      // Negative modifier: more responsive to bearish news
      const raw = -news.strength * Math.max(impact, 0.3) * directnessWeight * maxNewsMod;
      modifier = Math.round(raw);
    }

    // High event risk score reduces positive modifier further
    if (modifier > 0 && riskScore > 0.4) {
      modifier = Math.round(modifier * (1 - riskScore * 0.5));
    }
  } else {
    // ── Legacy path: basic strength/bias only ────────────────
    if (news.bias === 'positive' && news.strength > 0.5 && news.freshnessHours < 24) {
      modifier = Math.round(news.strength * maxNewsMod);
    } else if (news.bias === 'negative' && news.strength > 0.3) {
      modifier = -Math.round(news.strength * maxNewsMod);
    }
  }

  // STRICT: positive news modifier cannot exceed event risk penalty
  // → news cannot make a risky trade look safe
  if (modifier > 0 && eventRisk.eventRiskPenalty > 0) {
    modifier = Math.min(modifier, Math.max(0, maxNewsMod - eventRisk.eventRiskPenalty));
  }

  return clamp(modifier, -maxNewsMod, maxNewsMod);
}
