// ════════════════════════════════════════════════════════════════
//  News Impact Engine — Symbol / Sector / Market Impact
//
//  Converts scored news events into trading intelligence:
//    1. Symbol Impact  — per-symbol confidence modifier + risk penalty
//    2. Sector Impact  — sector-wide sentiment aggregation
//    3. Market Impact  — market-wide macro tone
//
//  STRICT RULES:
//    - confidenceModifier bounded ±8
//    - riskPenalty bounded 0–10
//    - NEVER override risk engine rules
//    - NEVER approve a bad trade due to positive news
//    - suppressSignal = true is an advisory; risk engine has final say
// ════════════════════════════════════════════════════════════════

import { db } from '@/lib/db';
import { ensureNewsSchemas } from '../repository/ensureNewsSchemas';
import type { NewsScoreCard } from '../types/scoring.types';
import type {
  SymbolImpact,
  SectorImpact,
  MarketImpact,
  NewsImpactResult,
  EventRiskDetail,
} from '../types/impact.types';
import type { NewsCategory } from '../types/newsEngine.types';
import { classifyEventRisk, aggregateEventRisks } from './eventRiskClassifier';
import { getSector } from '@/lib/signal-engine/constants/phase3.constants';

// ════════════════════════════════════════════════════════════════
//  1. SYMBOL IMPACT
// ════════════════════════════════════════════════════════════════

/**
 * Compute trading impact for a single symbol from its scored events.
 *
 * @param symbol - Target symbol
 * @param cards  - NewsScoreCards that reference this symbol
 */
export function computeSymbolImpact(
  symbol: string,
  cards: NewsScoreCard[],
): SymbolImpact {
  if (cards.length === 0) {
    return emptySymbolImpact(symbol);
  }

  // ── Aggregate sentiment (weighted by freshness × importance) ──
  let sentimentWeightedSum = 0;
  let totalWeight = 0;
  const eventRisks: EventRiskDetail[] = [];
  const activeTags = new Set<NewsCategory>();
  const warnings: string[] = [];

  for (const card of cards) {
    const weight = (card.freshness.score / 100) * (card.importance.score / 100);
    sentimentWeightedSum += card.sentiment.score * weight;
    totalWeight += weight;

    // Classify event risk per card
    // We need the original event data — use card fields
    const risk = classifyEventRisk(
      (card as any).category ?? 'general',
      '',   // title not on card — risk classifier uses category + scores
      null,
      card.sentiment.score,
      card.manipulation.score,
      card.importance.score,
    );
    eventRisks.push(risk);

    if ((card as any).category) activeTags.add((card as any).category);
  }

  const avgSentiment = totalWeight > 0 ? sentimentWeightedSum / totalWeight : 0;

  // ── Net sentiment direction ────────────────────────────────
  let netSentiment: SymbolImpact['netSentiment'];
  if (avgSentiment > 15) netSentiment = 'bullish';
  else if (avgSentiment < -15) netSentiment = 'bearish';
  else netSentiment = 'neutral';

  // ── Aggregate impact score (weighted avg of symbolImpactScore) ─
  const impactSum = cards.reduce((s, c) => s + c.symbolImpactScore, 0);
  const aggregateImpact = Math.round(impactSum / cards.length);

  // ── Aggregate event risk ───────────────────────────────────
  const worstRisk = aggregateEventRisks(eventRisks);

  // ── Manipulation risk boost (max across cards) ─────────────
  const manipulationRiskBoost = Math.max(...cards.map((c) => c.manipulationRiskBoost));

  // ── Confidence modifier: bounded ±8 ────────────────────────
  //
  // Positive news with high trust → positive modifier (capped +8)
  // Negative news → negative modifier (capped -8)
  // GUARD: positive modifier CANNOT exceed risk penalty magnitude
  //        (news cannot make a risky trade look safe)
  let rawConfModifier = 0;

  if (netSentiment === 'bullish' && aggregateImpact > 50) {
    // Scale: impact 50→0, impact 100→+8
    rawConfModifier = Math.round((aggregateImpact - 50) * 0.16);
  } else if (netSentiment === 'bearish') {
    // Scale: avgSentiment -15→0, -100→-8
    rawConfModifier = Math.round(Math.max(-8, avgSentiment * 0.08));
  }

  // STRICT: clamp to ±8
  let confidenceModifier = clamp(rawConfModifier, -8, 8);

  // STRICT: positive modifier cannot exceed risk penalty
  // → news cannot make a dangerous trade look good
  if (confidenceModifier > 0 && worstRisk.riskPenalty > 0) {
    confidenceModifier = Math.min(confidenceModifier, Math.max(0, 8 - worstRisk.riskPenalty));
  }

  // ── Risk penalty: bounded 0–10 ─────────────────────────────
  const riskPenalty = clamp(worstRisk.riskPenalty, 0, 10);

  // ── Suppression logic ──────────────────────────────────────
  let suppressSignal = worstRisk.suppressTrade;
  let suppressionReason: string | null = worstRisk.suppressTrade ? worstRisk.reason : null;

  // Additional: high manipulation + low trust = suppress
  if (manipulationRiskBoost >= 30) {
    const avgTrust = cards.reduce((s, c) => s + c.trust.score, 0) / cards.length;
    if (avgTrust < 40) {
      suppressSignal = true;
      suppressionReason = `High manipulation risk (${manipulationRiskBoost}) + low trust (${Math.round(avgTrust)}) — trade suppressed`;
    }
  }

  // ── Warnings ───────────────────────────────────────────────
  if (worstRisk.riskScore >= 60) {
    warnings.push(`News event risk: ${worstRisk.reason}`);
  }
  if (manipulationRiskBoost >= 15) {
    warnings.push(`Manipulation suspicion: news-based boost +${manipulationRiskBoost}`);
  }
  if (cards.some((c) => c.novelty.isBreaking)) {
    warnings.push('Breaking news detected — elevated volatility expected');
  }
  if (suppressSignal) {
    warnings.push(`SIGNAL SUPPRESSED: ${suppressionReason}`);
  }

  return {
    symbol,
    confidenceModifier,
    riskPenalty,
    netSentiment,
    aggregateImpact,
    eventRiskScore: worstRisk.riskScore,
    manipulationRiskBoost,
    eventCount: cards.length,
    warnings,
    activeTags: [...activeTags],
    suppressSignal,
    suppressionReason,
  };
}

// ════════════════════════════════════════════════════════════════
//  2. SECTOR IMPACT
// ════════════════════════════════════════════════════════════════

export function computeSectorImpact(
  sector: string,
  cards: NewsScoreCard[],
): SectorImpact {
  if (cards.length === 0) {
    return {
      sector, netSentiment: 'neutral', sentimentStrength: 0,
      avgImportance: 0, eventCount: 0, activeTags: [], riskTone: 'neutral',
    };
  }

  const sentiments = cards.map((c) => c.sentiment.score);
  const avgSentiment = sentiments.reduce((s, v) => s + v, 0) / sentiments.length;
  const sentimentStrength = Math.round(
    cards.reduce((s, c) => s + c.sentiment.magnitude, 0) / cards.length,
  );
  const avgImportance = Math.round(
    cards.reduce((s, c) => s + c.importance.score, 0) / cards.length,
  );

  let netSentiment: SectorImpact['netSentiment'];
  if (avgSentiment > 10) netSentiment = 'bullish';
  else if (avgSentiment < -10) netSentiment = 'bearish';
  else netSentiment = 'neutral';

  const avgRisk = cards.reduce((s, c) => s + c.eventRiskScore, 0) / cards.length;
  let riskTone: SectorImpact['riskTone'];
  if (avgRisk <= 20) riskTone = 'favorable';
  else if (avgRisk <= 40) riskTone = 'neutral';
  else if (avgRisk <= 60) riskTone = 'cautious';
  else riskTone = 'adverse';

  const activeTags = new Set<NewsCategory>();
  for (const c of cards) {
    if ((c as any).category) activeTags.add((c as any).category);
  }

  return {
    sector, netSentiment, sentimentStrength, avgImportance,
    eventCount: cards.length, activeTags: [...activeTags], riskTone,
  };
}

// ════════════════════════════════════════════════════════════════
//  3. MARKET IMPACT
// ════════════════════════════════════════════════════════════════

export function computeMarketImpact(
  allCards: NewsScoreCard[],
): MarketImpact {
  if (allCards.length === 0) {
    return {
      netSentiment: 'neutral', sentimentStrength: 0,
      macroProximity: 'none', eventRiskScore: 0,
      marketTone: 'neutral', eventCount: 0,
      activeMacroFactors: [], warnings: [],
    };
  }

  const sentiments = allCards.map((c) => c.sentiment.score);
  const avgSentiment = sentiments.reduce((s, v) => s + v, 0) / sentiments.length;
  const sentimentStrength = Math.round(
    allCards.reduce((s, c) => s + c.sentiment.magnitude, 0) / allCards.length,
  );

  let netSentiment: MarketImpact['netSentiment'];
  if (avgSentiment > 10) netSentiment = 'bullish';
  else if (avgSentiment < -10) netSentiment = 'bearish';
  else netSentiment = 'neutral';

  // Market tone from sentiment + risk
  const avgRisk = allCards.reduce((s, c) => s + c.eventRiskScore, 0) / allCards.length;
  let marketTone: MarketImpact['marketTone'];
  if (netSentiment === 'bullish' && avgRisk < 30) marketTone = 'strongly_constructive';
  else if (netSentiment === 'bullish') marketTone = 'constructive';
  else if (netSentiment === 'neutral' && avgRisk < 40) marketTone = 'neutral';
  else if (netSentiment === 'neutral' || avgRisk < 60) marketTone = 'cautious';
  else marketTone = 'hostile';

  // Macro factor proximity
  const macroCards = allCards.filter((c) =>
    (c as any).category === 'macro_policy' || (c as any).category === 'global_cue',
  );
  let macroProximity: MarketImpact['macroProximity'] = 'none';
  if (macroCards.length >= 5) macroProximity = 'high';
  else if (macroCards.length >= 3) macroProximity = 'moderate';
  else if (macroCards.length >= 1) macroProximity = 'low';

  // Collect macro factors from all events
  const activeMacroFactors = new Set<string>();
  // We'd need event-level data here; approximate from card structure
  // The category itself indicates macro involvement

  const warnings: string[] = [];
  if (marketTone === 'hostile') {
    warnings.push('Market-wide news sentiment hostile — risk-off environment');
  }
  if (macroProximity === 'high') {
    warnings.push('Multiple macro events in play — elevated systemic risk');
  }

  const eventRiskScore = clamp(Math.round(avgRisk), 0, 100);

  return {
    netSentiment, sentimentStrength, macroProximity, eventRiskScore,
    marketTone, eventCount: allCards.length,
    activeMacroFactors: [...activeMacroFactors], warnings,
  };
}

// ════════════════════════════════════════════════════════════════
//  FULL IMPACT COMPUTATION
// ════════════════════════════════════════════════════════════════

/**
 * Compute full NewsImpactResult from recently scored events.
 * Reads from q365_news_scores and q365_news_events (for category).
 *
 * @param hoursBack - how far back to look (default: 24h)
 */
export async function computeNewsImpact(hoursBack = 24): Promise<NewsImpactResult> {
  await ensureNewsSchemas();

  const { rows } = await db.query<any>(
    `SELECT ns.*, ne.category, ne.title, ne.body, ne.macro_factors_json
     FROM q365_news_scores ns
     JOIN q365_news_events ne ON ne.id = ns.news_event_id
     WHERE ns.scored_at >= DATE_SUB(NOW(), INTERVAL ? HOUR)
     ORDER BY ns.symbol_impact_score DESC`,
    [hoursBack],
  );

  // Reconstruct minimal card objects with category attached
  const cards: (NewsScoreCard & { category: NewsCategory; title: string; body: string | null })[] =
    rows.map((r: any) => ({
      newsEventId:          r.news_event_id,
      symbol:               r.symbol,
      trust:                { score: r.trust_score, tier: r.trust_tier, factors: [] },
      sentiment:            { score: r.sentiment_score, magnitude: r.sentiment_magnitude, wordHitCount: 0, direction: r.sentiment_direction },
      importance:           { score: r.importance_score, factors: [] },
      novelty:              { score: r.novelty_score, recentDupes: 0, isBreaking: !!r.novelty_is_breaking },
      freshness:            { score: r.freshness_score, ageMinutes: 0, decayBand: r.freshness_band },
      directness:           { score: r.directness_score, matchType: r.directness_match, entityCount: 0, symbolCount: 0 },
      manipulation:         { score: r.manipulation_score, flags: safeJsonParse(r.manipulation_flags_json, []) },
      symbolImpactScore:    r.symbol_impact_score,
      eventRiskScore:       r.event_risk_score,
      manipulationRiskBoost: r.manipulation_risk_boost,
      scoredAt:             r.scored_at,
      // Extra fields for impact computation
      category:             r.category,
      title:                r.title,
      body:                 r.body,
    }));

  // ── Group by symbol ────────────────────────────────────────
  const bySymbol = new Map<string, typeof cards>();
  for (const card of cards) {
    const list = bySymbol.get(card.symbol) || [];
    list.push(card);
    bySymbol.set(card.symbol, list);
  }

  const symbolImpacts = new Map<string, SymbolImpact>();
  for (const [symbol, symbolCards] of bySymbol) {
    symbolImpacts.set(symbol, computeSymbolImpact(symbol, symbolCards));
  }

  // ── Group by sector ────────────────────────────────────────
  const bySector = new Map<string, typeof cards>();
  for (const card of cards) {
    const sector = getSector(card.symbol);
    const list = bySector.get(sector) || [];
    list.push(card);
    bySector.set(sector, list);
  }

  const sectorImpacts = new Map<string, SectorImpact>();
  for (const [sector, sectorCards] of bySector) {
    sectorImpacts.set(sector, computeSectorImpact(sector, sectorCards));
  }

  // ── Market-wide impact ─────────────────────────────────────
  const marketImpact = computeMarketImpact(cards);

  return {
    symbolImpacts,
    sectorImpacts,
    marketImpact,
    computedAt: new Date().toISOString(),
  };
}

/**
 * Get trading modifier for a specific symbol.
 * This is the main integration point for the signal engine.
 */
export async function getSymbolImpact(
  symbol: string,
  hoursBack = 24,
): Promise<SymbolImpact & {
  newsEventDetails: Array<{ eventId: number; impactScore: number; trustScore: number; sentimentScore: number }>;
  sectorImpactScore: number;
  marketImpactScore: number;
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
}> {
  await ensureNewsSchemas();

  const { rows } = await db.query<any>(
    `SELECT ns.*, ne.category, ne.title, ne.body
     FROM q365_news_scores ns
     JOIN q365_news_events ne ON ne.id = ns.news_event_id
     WHERE ns.symbol = ?
       AND ns.scored_at >= DATE_SUB(NOW(), INTERVAL ? HOUR)
     ORDER BY ns.symbol_impact_score DESC
     LIMIT 50`,
    [symbol, hoursBack],
  );

  if (rows.length === 0) return {
    ...emptySymbolImpact(symbol),
    newsEventDetails: [],
    sectorImpactScore: 0,
    marketImpactScore: 0,
    realDimensions: {
      avgTrustScore: 0,
      avgNoveltyScore: 0,
      avgDirectnessScore: 0,
      avgFreshnessScore: 0,
      avgSentimentMagnitude: 0,
      avgSentimentScore: 0,
      avgManipulationScore: 0,
      avgImportanceScore: 0,
      avgEntityConfidence: 0,
      derivedSourceClass: 'unknown' as const,
    },
  };

  const cards = rows.map((r: any) => ({
    newsEventId:          r.news_event_id,
    symbol:               r.symbol,
    trust:                { score: r.trust_score, tier: r.trust_tier, factors: [] },
    sentiment:            { score: r.sentiment_score, magnitude: r.sentiment_magnitude, wordHitCount: 0, direction: r.sentiment_direction },
    importance:           { score: r.importance_score, factors: [] },
    novelty:              { score: r.novelty_score, recentDupes: 0, isBreaking: !!r.novelty_is_breaking },
    freshness:            { score: r.freshness_score, ageMinutes: 0, decayBand: r.freshness_band },
    directness:           { score: r.directness_score, matchType: r.directness_match, entityCount: 0, symbolCount: 0 },
    manipulation:         { score: r.manipulation_score, flags: safeJsonParse(r.manipulation_flags_json, []) },
    symbolImpactScore:    r.symbol_impact_score,
    eventRiskScore:       r.event_risk_score,
    manipulationRiskBoost: r.manipulation_risk_boost,
    scoredAt:             r.scored_at,
    category:             r.category,
    title:                r.title,
    body:                 r.body,
  }));

  // Extract event details for linkage tracking
  const newsEventDetails = rows.map((r: any) => ({
    eventId:        Number(r.news_event_id),
    impactScore:    Number(r.symbol_impact_score),
    trustScore:     Number(r.trust_score),
    sentimentScore: Number(r.sentiment_score),
  }));

  const symbolResult = computeSymbolImpact(symbol, cards as any);

  // Compute sector and market impact from same cards for enriched context
  const sector = getSector(symbol);
  const sectorResult = computeSectorImpact(sector, cards as any);
  const marketResult = computeMarketImpact(cards as any);

  // Aggregate real per-dimension scores from scorecard DB rows (0-100)
  const n = cards.length;
  const avgTrustScore     = n > 0 ? cards.reduce((s, c) => s + c.trust.score, 0) / n : 0;
  const avgNoveltyScore   = n > 0 ? cards.reduce((s, c) => s + c.novelty.score, 0) / n : 0;
  const avgDirectnessScore = n > 0 ? cards.reduce((s, c) => s + c.directness.score, 0) / n : 0;
  const avgFreshnessScore = n > 0 ? cards.reduce((s, c) => s + c.freshness.score, 0) / n : 0;
  const avgSentimentMagnitude = n > 0 ? cards.reduce((s, c) => s + c.sentiment.magnitude, 0) / n : 0;
  const avgSentimentScore = n > 0 ? cards.reduce((s, c) => s + c.sentiment.score, 0) / n : 0;
  const avgManipulationScore = n > 0 ? cards.reduce((s, c) => s + c.manipulation.score, 0) / n : 0;
  const avgImportanceScore = n > 0 ? cards.reduce((s, c) => s + c.importance.score, 0) / n : 0;
  const entityCountTotal = n > 0 ? cards.reduce((s, c) => s + c.directness.entityCount, 0) / n : 0;

  // Compute real source class from event trust distribution
  const officialCount = cards.filter(c => c.trust.tier === 'institutional').length;
  const socialCount = cards.filter(c => c.trust.tier === 'social' || c.trust.tier === 'unknown').length;
  const mediaCount = n - officialCount - socialCount;
  let derivedSourceClass: 'official' | 'media' | 'deals' | 'social' | 'unknown' = 'unknown';
  if (n > 0) {
    const officialPct = officialCount / n;
    const socialPct = socialCount / n;
    const mediaPct = mediaCount / n;
    if (officialPct >= 0.5) derivedSourceClass = 'official';
    else if (socialPct >= 0.5) derivedSourceClass = 'social';
    else if (mediaPct >= 0.3) derivedSourceClass = 'media';
    else derivedSourceClass = 'media';
  }

  return {
    ...symbolResult,
    newsEventDetails,
    sectorImpactScore: sectorResult.sentimentStrength,   // 0-100
    marketImpactScore: marketResult.eventRiskScore,       // 0-100
    // Real aggregated dimension scores from scorecard (0-100)
    realDimensions: {
      avgTrustScore,
      avgNoveltyScore,
      avgDirectnessScore,
      avgFreshnessScore,
      avgSentimentMagnitude,
      avgSentimentScore,
      avgManipulationScore,
      avgImportanceScore,
      avgEntityConfidence: entityCountTotal,
      derivedSourceClass,
    },
  };
}

// ── Helpers ──────────────────────────────────────────────────────

function emptySymbolImpact(symbol: string): SymbolImpact {
  return {
    symbol, confidenceModifier: 0, riskPenalty: 0,
    netSentiment: 'neutral', aggregateImpact: 0, eventRiskScore: 0,
    manipulationRiskBoost: 0, eventCount: 0, warnings: [],
    activeTags: [], suppressSignal: false, suppressionReason: null,
  };
}

function clamp(val: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, val));
}

function safeJsonParse<T>(val: unknown, fallback: T): T {
  if (!val) return fallback;
  if (typeof val === 'object' && Array.isArray(val)) return val as T;
  try { return JSON.parse(String(val)); } catch { return fallback; }
}
