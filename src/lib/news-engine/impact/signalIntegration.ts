// ════════════════════════════════════════════════════════════════
//  Signal Engine Integration Bridge
//
//  Connects news impact engine to:
//    1. Signal engine (confidence modifiers)
//    2. Risk engine (risk penalties)
//    3. Manipulation engine (suspicion boost)
//    4. Phase 4 contextual modifiers (enriched news context)
//
//  NUMERIC CONTRACT:
//    All values returned to the signal engine are 0-1 unless
//    explicitly documented otherwise.
//    freshnessHours remains in raw hours.
//    sentimentScore is -1 to +1.
//
//  STRICT RULES:
//    - NEVER override risk rules: risk penalty is ADDITIVE only
//    - NEVER approve bad trade: suppressSignal is ADVISORY to
//      the risk engine, which has final authority
//    - Positive news cannot reduce risk score
//    - confidenceModifier bounded ±8
//    - riskPenalty bounded 0–10
// ════════════════════════════════════════════════════════════════

import type { SymbolImpact, NewsModifierForSignal } from '../types/impact.types';
import type { NewsContext, NewsScoreCardSummary, NewsImpactBreakdown } from '@/lib/signal-engine/types/phase4.types';
import { getSymbolImpact } from './computeImpact';

/**
 * Build a NewsModifierForSignal from the news impact engine.
 * This is the main entry point called by the Phase 4 pipeline
 * for each signal being processed.
 *
 * @param symbol    - The symbol to get modifiers for
 * @param hoursBack - How far back to look for news (default: 24h)
 */
export async function getNewsModifierForSignal(
  symbol: string,
  hoursBack = 24,
): Promise<NewsModifierForSignal> {
  const impact = await getSymbolImpact(symbol, hoursBack);
  const modifier = buildModifierFromImpact(impact);
  modifier.newsEventDetails = impact.newsEventDetails ?? [];
  return modifier;
}

/**
 * Pure function: converts a SymbolImpact into a signal modifier.
 * Separated from the async path for testability.
 *
 * Accepts optional sectorImpactScore/marketImpactScore from
 * the extended getSymbolImpact result to populate the full
 * enriched context breakdown.
 */
export function buildModifierFromImpact(
  impact: SymbolImpact & {
    sectorImpactScore?: number;
    marketImpactScore?: number;
    realDimensions?: {
      avgTrustScore: number;
      avgNoveltyScore: number;
      avgDirectnessScore: number;
      avgFreshnessScore: number;
      avgSentimentMagnitude: number;
      avgSentimentScore: number;
      avgManipulationScore: number;
      avgImportanceScore: number;
      avgEntityConfidence: number;
      derivedSourceClass: 'official' | 'media' | 'deals' | 'social' | 'unknown';
    };
  },
): NewsModifierForSignal {
  // Build the full enriched news context (0-1 normalized)
  const newsContext = buildSignalNewsContext(impact);

  // Patch sector/market impact into the breakdown if available
  if (newsContext.impactBreakdown && impact.sectorImpactScore !== undefined) {
    newsContext.impactBreakdown.sectorImpact = impact.sectorImpactScore / 100;
  }
  if (newsContext.impactBreakdown && impact.marketImpactScore !== undefined) {
    newsContext.impactBreakdown.marketImpact = impact.marketImpactScore / 100;
  }
  // Also set top-level fields for convenience
  if (impact.sectorImpactScore !== undefined) {
    newsContext.sectorImpactScore = impact.sectorImpactScore / 100;
  }
  if (impact.marketImpactScore !== undefined) {
    newsContext.marketImpactScore = impact.marketImpactScore / 100;
  }

  return {
    symbol:                 impact.symbol,
    confidenceModifier:     impact.confidenceModifier,       // ±8 (already bounded)
    riskPenalty:            impact.riskPenalty,               // 0–10 (already bounded)
    eventRiskScore:         impact.eventRiskScore,
    manipulationRiskBoost:  impact.manipulationRiskBoost,
    suppressSignal:         impact.suppressSignal,
    warnings:               impact.warnings,
    enrichedNewsContext:     newsContext,
  };
}

/**
 * Build the full enriched NewsContext for the signal engine.
 * All values normalized to 0-1 contract (except freshnessHours
 * and sentimentScore which use their natural scales).
 *
 * This is the PRIMARY builder — returns the complete enriched
 * context that Phase 4 and Dexter consume directly.
 *
 * Attaches:
 *  - scoreCard: 7-dimension scoring summary (normalized 0-1)
 *  - impactBreakdown: symbol/sector/market impact + penalties
 *  - sourceClass: origin classification (official/media/deals/social)
 */
export function buildSignalNewsContext(impact: SymbolImpact & {
  realDimensions?: {
    avgTrustScore: number;
    avgNoveltyScore: number;
    avgDirectnessScore: number;
    avgFreshnessScore: number;
    avgSentimentMagnitude: number;
    avgSentimentScore: number;
    avgManipulationScore: number;
    avgImportanceScore: number;
    avgEntityConfidence: number;
    derivedSourceClass: 'official' | 'media' | 'deals' | 'social' | 'unknown';
  };
}): NewsContext {
  // Map netSentiment to bias
  const biasMap: Record<string, 'positive' | 'neutral' | 'negative'> = {
    bullish: 'positive',
    neutral: 'neutral',
    bearish: 'negative',
  };

  // realDimensions is always present (getSymbolImpact provides it for
  // both populated and empty result sets). No heuristic fallbacks needed.
  const rd = impact.realDimensions ?? {
    avgTrustScore: 0, avgNoveltyScore: 0, avgDirectnessScore: 0,
    avgFreshnessScore: 0, avgSentimentMagnitude: 0, avgSentimentScore: 0,
    avgManipulationScore: 0, avgImportanceScore: 0, avgEntityConfidence: 0,
    derivedSourceClass: 'unknown' as const,
  };

  // Strength: normalize aggregateImpact (0–100) to 0–1
  const strength = impact.aggregateImpact / 100;

  // ── All enriched values from REAL scorecard data ──────────────
  const symbolImpactNorm = impact.aggregateImpact / 100;
  const eventRiskNorm = impact.eventRiskScore / 100;

  // All dimensions normalized from real 0-100 scorecard values to 0-1
  const manipulationNorm = Math.min(1, rd.avgManipulationScore / 100);
  const noveltyNorm = rd.avgNoveltyScore / 100;
  const directnessNorm = rd.avgDirectnessScore / 100;
  const sentimentNorm = Math.max(-1, Math.min(1, rd.avgSentimentScore / 100));
  const sourceConfNorm = rd.avgTrustScore / 100;
  const recencyNorm = rd.avgFreshnessScore / 100;
  const entityConfNorm = Math.min(1, rd.avgEntityConfidence / 10);

  // Source tier from real trust scores
  let sourceTier = 'unknown';
  if (rd.avgTrustScore >= 75) sourceTier = 'high';
  else if (rd.avgTrustScore >= 50) sourceTier = 'medium';
  else if (rd.avgTrustScore > 0) sourceTier = 'low';

  // Source class from REAL event distribution — never inferred from tier
  const sourceClass: NewsContext['sourceClass'] = rd.derivedSourceClass;

  // Freshness from real data
  const freshnessHours = recencyNorm > 0
    ? Math.max(1, Math.round((1 - recencyNorm) * 48))
    : 999;

  // Build structured scoreCard summary — all from REAL data (0-1)
  const scoreCard: NewsScoreCardSummary = {
    sourceReliability:  sourceConfNorm,
    recency:            recencyNorm,
    sentiment:          sentimentNorm,
    novelty:            noveltyNorm,
    directness:         directnessNorm,
    entityConfidence:   entityConfNorm,
    manipulationRisk:   manipulationNorm,
    finalSymbolImpact:  symbolImpactNorm,
    finalEventRisk:     eventRiskNorm,
  };

  // Build structured impact breakdown
  const impactBreakdown: NewsImpactBreakdown = {
    symbolImpact:       symbolImpactNorm,
    sectorImpact:       0,       // populated downstream when sector-level cards are available
    marketImpact:       0,       // populated downstream when market-level cards are available
    confidencePenalty:  Math.abs(Math.min(0, impact.confidenceModifier)),
    riskPenalty:        impact.riskPenalty,
    narrativeSummary:   buildNarrativeSummary(impact),
  };

  return {
    bias:                  biasMap[impact.netSentiment] ?? 'neutral',
    strength,
    freshnessHours,
    sourceConfidence:      sourceConfNorm,
    eventTags:             impact.activeTags,
    headline:              impact.warnings[0] ?? null,
    // Enriched fields — all normalized to 0-1 from REAL scorecard
    symbolImpactScore:     symbolImpactNorm,
    eventRiskScore:        eventRiskNorm,
    manipulationSuspicion: manipulationNorm,
    noveltyScore:          noveltyNorm,
    directnessScore:       directnessNorm,
    sentimentScore:        sentimentNorm,
    eventType:             impact.activeTags[0] ?? 'general',
    sourceTier,
    sourceClass,
    // Structured breakdowns for decision layers and Dexter
    scoreCard,
    impactBreakdown,
  };
}

/** Build a one-line narrative summary from impact data. */
function buildNarrativeSummary(impact: SymbolImpact): string {
  if (impact.eventCount === 0) return 'No recent news events for this symbol.';
  const direction = impact.netSentiment === 'bullish' ? 'positive'
                  : impact.netSentiment === 'bearish' ? 'negative' : 'neutral';
  const strength = impact.aggregateImpact >= 60 ? 'strong' : impact.aggregateImpact >= 30 ? 'moderate' : 'mild';
  const risk = impact.eventRiskScore >= 60 ? 'elevated risk' : impact.eventRiskScore >= 30 ? 'moderate risk' : 'low risk';
  return `${strength} ${direction} news flow from ${impact.eventCount} event(s), ${risk}.`;
}

/**
 * Legacy builder — for old callers that still need the minimal shape.
 * Prefer buildSignalNewsContext() for all new code paths.
 * @deprecated Use buildSignalNewsContext() instead.
 */
export function buildLegacyNewsContext(impact: SymbolImpact): NewsContext {
  return {
    bias:             impact.netSentiment === 'bullish' ? 'positive'
                    : impact.netSentiment === 'bearish' ? 'negative' : 'neutral',
    strength:         impact.aggregateImpact / 100,
    freshnessHours:   impact.eventCount > 0 ? 6 : 999,
    sourceConfidence: Math.min(1, impact.eventCount * 0.15),
    eventTags:        impact.activeTags,
    headline:         impact.warnings[0] ?? null,
  };
}

/**
 * Build enhanced news context for Phase 4 and apply to signal.
 * This replaces the old fetchLiveNewsContext() in the pipeline
 * with a richer, scored version.
 *
 * Returns warnings that should be appended to the signal.
 */
export async function enrichSignalWithNews(
  symbol: string,
  currentConfidence: number,
  currentRiskScore: number,
): Promise<{
  newsContext: NewsContext;
  confidenceAdjustment: number;
  riskAdjustment: number;
  warnings: string[];
  suppressSignal: boolean;
  /** News event IDs + scores used in this enrichment (for linkage tracking). */
  newsEventDetails: Array<{ eventId: number; impactScore: number; trustScore: number; sentimentScore: number }>;
}> {
  const modifier = await getNewsModifierForSignal(symbol);

  // STRICT: Positive modifier cannot push confidence above 95
  // (even great news shouldn't create overconfidence)
  let confidenceAdjustment = modifier.confidenceModifier;
  if (currentConfidence + confidenceAdjustment > 95) {
    confidenceAdjustment = Math.max(0, 95 - currentConfidence);
  }

  // STRICT: Risk adjustment is ADDITIVE ONLY (never reduces risk)
  // Positive news doesn't make a risky trade safe
  const riskAdjustment = modifier.riskPenalty; // always >= 0

  return {
    // Return the FULL enriched context directly — no stripping
    newsContext:          modifier.enrichedNewsContext,
    confidenceAdjustment,
    riskAdjustment,
    warnings:             modifier.warnings,
    suppressSignal:       modifier.suppressSignal,
    newsEventDetails:     modifier.newsEventDetails ?? [],
  };
}
