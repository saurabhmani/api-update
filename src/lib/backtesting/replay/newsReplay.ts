// ════════════════════════════════════════════════════════════════
//  News Replay for Backtesting
//
//  Tags backtest signals with news intelligence from the scored
//  events database. Applies news filtering and confidence
//  modification during historical replay.
//
//  RULE: News must ENHANCE decision quality, NOT replace system logic.
//  - News modifier is bounded ±8 (same as live)
//  - News filter is optional (config.newsFilterScore)
//  - All tags are auditable (persisted on SimulatedSignal)
// ════════════════════════════════════════════════════════════════

import { db } from '@/lib/db';
import type { SimulatedSignal } from '../types';
import type { BacktestRunConfig } from '../types';

interface NewsTag {
  impactScore:            number;   // 0–1 (normalized)
  confidenceModifier:     number;   // ±8
  riskPenalty:            number;   // 0–10
  eventRiskScore:         number;   // 0–1 (normalized)
  sentiment:              'bullish' | 'bearish' | 'neutral';
  warnings:               string[];
  excluded:               boolean;
  /** Enriched fields — all 0-1 normalized. */
  manipulationSuspicion:  number;
  noveltyScore:           number;
  directnessScore:        number;
  sentimentScore:         number;
  symbolImpactScore:      number;
  sourceClass:            'official' | 'media' | 'social' | 'mixed' | 'unknown';
}

/**
 * Tag a backtest signal with news intelligence.
 * Queries the scored events database for the signal's symbol
 * within 24 hours of the signal date.
 *
 * Returns null if no news data is available for this date/symbol.
 */
export async function buildNewsTag(
  symbol: string,
  signalDate: string,
  filterScore: number | undefined,
): Promise<NewsTag | null> {
  try {
    const { rows } = await db.query<any>(
      `SELECT
         AVG(ns.symbol_impact_score) AS avg_impact,
         AVG(ns.sentiment_score) AS avg_sentiment,
         AVG(ns.event_risk_score) AS avg_event_risk,
         MAX(ns.manipulation_risk_boost) AS max_manip_boost,
         AVG(ns.manipulation_score) AS avg_manipulation,
         AVG(ns.novelty_score) AS avg_novelty,
         AVG(ns.directness_score) AS avg_directness,
         AVG(ns.trust_score) AS avg_trust,
         COUNT(CASE WHEN ns.trust_score < 40 THEN 1 END) AS low_trust_count,
         COUNT(*) AS event_count
       FROM q365_news_scores ns
       JOIN q365_news_events ne ON ne.id = ns.news_event_id
       WHERE ns.symbol = ?
         AND ne.published_at BETWEEN DATE_SUB(?, INTERVAL 24 HOUR) AND ?`,
      [symbol, signalDate, signalDate],
    );

    const row = rows[0];
    if (!row || Number(row.event_count) === 0) return null;

    // Raw values (0-100 from DB)
    const avgImpact = Number(row.avg_impact ?? 0);
    const avgSentiment = Number(row.avg_sentiment ?? 0);
    const avgEventRisk = Number(row.avg_event_risk ?? 0);
    const avgManipulation = Number(row.avg_manipulation ?? 0);
    const avgNovelty = Number(row.avg_novelty ?? 0);
    const avgDirectness = Number(row.avg_directness ?? 0);
    const avgTrust = Number(row.avg_trust ?? 50);
    const totalCount = Number(row.event_count);
    const lowTrustCount = Number(row.low_trust_count ?? 0);

    // Normalize ALL scores to 0-1
    const impactNorm = avgImpact / 100;
    const eventRiskNorm = avgEventRisk / 100;
    const manipulationNorm = clamp(avgManipulation / 100, 0, 1);
    const noveltyNorm = clamp(avgNovelty / 100, 0, 1);
    const directnessNorm = clamp(avgDirectness / 100, 0, 1);
    const sentimentNorm = clamp(avgSentiment / 100, -1, 1);

    // Derive source class from trust
    const lowTrustRatio = totalCount > 0 ? lowTrustCount / totalCount : 0;
    const sourceClass = avgTrust >= 75 ? 'official' as const
                      : avgTrust >= 50 ? 'media' as const
                      : lowTrustRatio > 0.5 ? 'social' as const
                      : 'mixed' as const;

    // Compute modifier same as live path
    let confidenceModifier = 0;
    if (avgSentiment > 15 && avgImpact > 50) {
      confidenceModifier = Math.round((avgImpact - 50) * 0.16);
    } else if (avgSentiment < -15) {
      confidenceModifier = Math.round(Math.max(-8, avgSentiment * 0.08));
    }
    confidenceModifier = clamp(confidenceModifier, -8, 8);

    // Active manipulation penalty: high suspicion suppresses positive modifier
    if (manipulationNorm > 0.5 && confidenceModifier > 0) {
      confidenceModifier = Math.round(confidenceModifier * (1 - manipulationNorm));
    }

    // STRICT: positive modifier cannot exceed risk penalty
    const riskPenalty = clamp(Math.round(avgEventRisk / 10), 0, 10);
    if (confidenceModifier > 0 && riskPenalty > 0) {
      confidenceModifier = Math.min(confidenceModifier, Math.max(0, 8 - riskPenalty));
    }

    const sentiment: NewsTag['sentiment'] =
      avgSentiment > 15 ? 'bullish' : avgSentiment < -15 ? 'bearish' : 'neutral';

    const warnings: string[] = [];
    if (eventRiskNorm > 0.6) warnings.push(`News event risk: ${Math.round(eventRiskNorm * 100)}%`);
    if (manipulationNorm > 0.3) warnings.push(`Manipulation suspicion: ${Math.round(manipulationNorm * 100)}%`);
    if (Number(row.max_manip_boost) > 15) warnings.push(`Manipulation risk boost from news: +${row.max_manip_boost}`);

    // Filter uses 0-1 scale: convert threshold if provided as 0-100
    const filterNorm = filterScore != null ? (filterScore > 1 ? filterScore / 100 : filterScore) : undefined;
    const excluded = filterNorm != null && eventRiskNorm >= filterNorm;
    if (excluded) warnings.push(`Excluded: event risk ${Math.round(eventRiskNorm * 100)}% >= filter ${Math.round((filterNorm ?? 0) * 100)}%`);

    return {
      impactScore: impactNorm,
      confidenceModifier,
      riskPenalty,
      eventRiskScore: eventRiskNorm,
      sentiment,
      warnings,
      excluded,
      manipulationSuspicion: manipulationNorm,
      noveltyScore: noveltyNorm,
      directnessScore: directnessNorm,
      sentimentScore: sentimentNorm,
      symbolImpactScore: impactNorm,
      sourceClass,
    };
  } catch {
    return null;
  }
}

/**
 * Apply news tags to a batch of backtest signals.
 * Modifies signals in place and returns filter stats.
 */
export async function applyNewsTags(
  signals: SimulatedSignal[],
  config: BacktestRunConfig,
): Promise<{ tagged: number; filtered: number }> {
  let tagged = 0;
  let filtered = 0;

  for (const sig of signals) {
    const tag = await buildNewsTag(sig.symbol, sig.date, config.newsFilterScore);
    if (!tag) continue;

    tagged++;

    // Apply tags — all scores normalized 0-1
    sig.newsImpactScore = tag.impactScore;
    sig.newsConfidenceModifier = tag.confidenceModifier;
    sig.newsRiskPenalty = tag.riskPenalty;
    sig.newsEventRiskScore = tag.eventRiskScore;
    sig.newsSentiment = tag.sentiment;
    sig.newsWarnings = tag.warnings;
    // Enriched context fields (0-1 normalized)
    sig.newsManipulationSuspicion = tag.manipulationSuspicion;
    sig.newsNoveltyScore = tag.noveltyScore;
    sig.newsDirectnessScore = tag.directnessScore;
    sig.newsSentimentScore = tag.sentimentScore;
    sig.newsSymbolImpactScore = tag.symbolImpactScore;
    sig.newsSourceClass = tag.sourceClass;

    if (tag.excluded) {
      sig.excludedByNewsFilter = true;
      sig.status = 'filtered';
      filtered++;
      continue;
    }

    // Active manipulation suspicion: suppress or penalize hype-driven signals
    if (tag.manipulationSuspicion > 0.6 && sig.confidenceScore < 70) {
      sig.excludedByNewsFilter = true;
      sig.status = 'filtered';
      sig.warnings = [...sig.warnings, `Filtered: manipulation suspicion ${Math.round(tag.manipulationSuspicion * 100)}% + weak technical`];
      filtered++;
      continue;
    }

    // Apply confidence modifier if configured
    if (config.applyNewsModifier && tag.confidenceModifier !== 0) {
      sig.confidenceScore = clamp(sig.confidenceScore + tag.confidenceModifier, 0, 100);
      sig.warnings = [...sig.warnings, ...tag.warnings];
    }
  }

  return { tagged, filtered };
}

// ══════��═════════════════════════════════════════════════════════
//  Comparison Modes — technical-only vs enriched-news
// ════════════════════════════════════���═══════════════════════════

export type ReplayMode = 'technical_only' | 'technical_plus_legacy_news' | 'technical_plus_enriched_news';

/**
 * Run a backtest pass under a specific replay mode.
 * - technical_only: no news applied
 * - technical_plus_legacy_news: basic headline sentiment only
 * - technical_plus_enriched_news: full scored intelligence
 *
 * Returns modified signals + mode metadata.
 */
export async function applyNewsTagsByMode(
  signals: SimulatedSignal[],
  config: BacktestRunConfig,
  mode: ReplayMode,
): Promise<{ tagged: number; filtered: number; mode: ReplayMode }> {
  if (mode === 'technical_only') {
    // Strip any news fields — pure technical
    for (const sig of signals) {
      sig.newsImpactScore = undefined as any;
      sig.newsConfidenceModifier = undefined as any;
      sig.newsRiskPenalty = undefined as any;
      sig.newsEventRiskScore = undefined as any;
      sig.newsSentiment = undefined as any;
      sig.newsWarnings = [];
      sig.excludedByNewsFilter = false;
      sig.newsManipulationSuspicion = undefined as any;
      sig.newsNoveltyScore = undefined as any;
      sig.newsDirectnessScore = undefined as any;
      sig.newsSentimentScore = undefined as any;
      sig.newsSymbolImpactScore = undefined as any;
      sig.newsSourceClass = undefined as any;
    }
    return { tagged: 0, filtered: 0, mode };
  }

  if (mode === 'technical_plus_legacy_news') {
    // Use only basic sentiment (no manipulation/event risk influence)
    const configNoFilter = { ...config, applyNewsModifier: true, newsFilterScore: undefined };
    const result = await applyNewsTags(signals, configNoFilter);
    // Strip enriched-only fields to simulate legacy
    for (const sig of signals) {
      sig.newsRiskPenalty = 0 as any;
      sig.newsEventRiskScore = 0 as any;
      sig.newsManipulationSuspicion = undefined as any;
      sig.newsNoveltyScore = undefined as any;
      sig.newsDirectnessScore = undefined as any;
      sig.newsSentimentScore = undefined as any;
      sig.newsSymbolImpactScore = undefined as any;
      sig.newsSourceClass = undefined as any;
    }
    return { ...result, mode };
  }

  // Full enriched path (default)
  const result = await applyNewsTags(signals, config);
  return { ...result, mode };
}

/**
 * Build enriched NewsTag with additional fields for source class
 * and manipulation suspicion from scored events.
 */
/**
 * Build enriched NewsTag. Since buildNewsTag now returns all enriched
 * fields (normalized 0-1), this is a thin wrapper that delegates directly.
 * Kept for backward compatibility with callers expecting the extended shape.
 */
export async function buildEnrichedNewsTag(
  symbol: string,
  signalDate: string,
  filterScore: number | undefined,
): Promise<NewsTag | null> {
  // buildNewsTag now includes all enriched fields (manipulation, novelty,
  // directness, sourceClass) — no separate query needed.
  return buildNewsTag(symbol, signalDate, filterScore);
}

function clamp(val: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, val));
}
