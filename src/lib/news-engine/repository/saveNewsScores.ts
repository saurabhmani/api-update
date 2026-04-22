// ════════════════════════════════════════════════════════════════
//  News Scores — Persistence Layer
//
//  Saves and reads NewsScoreCard rows from q365_news_scores.
//  Upserts on UNIQUE(news_event_id, symbol) so re-scoring
//  the same event overwrites cleanly.
// ════════════════════════════════════════════════════════════════

import { db } from '@/lib/db';
import { ensureNewsSchemas } from './ensureNewsSchemas';
import type { NewsScoreCard } from '../types/scoring.types';

/**
 * Persist a batch of score cards. Uses upsert so re-scoring is safe.
 * @returns Number of rows written (insert or update).
 */
export async function saveNewsScores(cards: NewsScoreCard[]): Promise<number> {
  await ensureNewsSchemas();

  let written = 0;

  for (const c of cards) {
    try {
      await db.query(
        `INSERT INTO q365_news_scores
           (news_event_id, symbol,
            trust_score, trust_tier,
            sentiment_score, sentiment_magnitude, sentiment_direction,
            importance_score,
            novelty_score, novelty_is_breaking,
            freshness_score, freshness_band,
            directness_score, directness_match,
            manipulation_score, manipulation_flags_json,
            symbol_impact_score, event_risk_score, manipulation_risk_boost,
            dimensions_json, scored_at)
         VALUES (?, ?,  ?, ?,  ?, ?, ?,  ?,  ?, ?,  ?, ?,  ?, ?,  ?, ?,  ?, ?, ?,  ?, ?)
         ON DUPLICATE KEY UPDATE
           trust_score = VALUES(trust_score),
           trust_tier = VALUES(trust_tier),
           sentiment_score = VALUES(sentiment_score),
           sentiment_magnitude = VALUES(sentiment_magnitude),
           sentiment_direction = VALUES(sentiment_direction),
           importance_score = VALUES(importance_score),
           novelty_score = VALUES(novelty_score),
           novelty_is_breaking = VALUES(novelty_is_breaking),
           freshness_score = VALUES(freshness_score),
           freshness_band = VALUES(freshness_band),
           directness_score = VALUES(directness_score),
           directness_match = VALUES(directness_match),
           manipulation_score = VALUES(manipulation_score),
           manipulation_flags_json = VALUES(manipulation_flags_json),
           symbol_impact_score = VALUES(symbol_impact_score),
           event_risk_score = VALUES(event_risk_score),
           manipulation_risk_boost = VALUES(manipulation_risk_boost),
           dimensions_json = VALUES(dimensions_json),
           scored_at = VALUES(scored_at)`,
        [
          c.newsEventId,
          c.symbol,
          c.trust.score,
          c.trust.tier,
          c.sentiment.score,
          c.sentiment.magnitude,
          c.sentiment.direction,
          c.importance.score,
          c.novelty.score,
          c.novelty.isBreaking ? 1 : 0,
          c.freshness.score,
          c.freshness.decayBand,
          c.directness.score,
          c.directness.matchType,
          c.manipulation.score,
          JSON.stringify(c.manipulation.flags),
          c.symbolImpactScore,
          c.eventRiskScore,
          c.manipulationRiskBoost,
          JSON.stringify({
            trust:    c.trust,
            sentiment: c.sentiment,
            importance: c.importance,
            novelty:   c.novelty,
            freshness: c.freshness,
            directness: c.directness,
            manipulation: c.manipulation,
          }),
          c.scoredAt,
        ],
      );
      written++;
    } catch (err) {
      console.warn(
        `[saveNewsScores] failed for event=${c.newsEventId} sym=${c.symbol}:`,
        (err as Error).message,
      );
    }
  }

  return written;
}

// ── Read Layer ───────────────────────────────────────────────────

export interface ScoreQueryFilter {
  symbol?:         string;
  minImpact?:      number;
  maxRisk?:        number;
  minManipBoost?:  number;
  fromDate?:       string;
  limit?:          number;
}

interface ScoreRow {
  id: number;
  news_event_id: number;
  symbol: string;
  trust_score: number;
  trust_tier: string;
  sentiment_score: number;
  sentiment_magnitude: number;
  sentiment_direction: string;
  importance_score: number;
  novelty_score: number;
  novelty_is_breaking: number;
  freshness_score: number;
  freshness_band: string;
  directness_score: number;
  directness_match: string;
  manipulation_score: number;
  manipulation_flags_json: string;
  symbol_impact_score: number;
  event_risk_score: number;
  manipulation_risk_boost: number;
  dimensions_json: string;
  scored_at: string;
  // Joined from q365_news_events
  title?: string;
  category?: string;
  published_at?: string;
}

function rowToScoreSummary(row: ScoreRow) {
  return {
    id:                   row.id,
    newsEventId:          row.news_event_id,
    symbol:               row.symbol,
    trustScore:           row.trust_score,
    trustTier:            row.trust_tier,
    sentimentScore:       row.sentiment_score,
    sentimentMagnitude:   row.sentiment_magnitude,
    sentimentDirection:   row.sentiment_direction,
    importanceScore:      row.importance_score,
    noveltyScore:         row.novelty_score,
    isBreaking:           !!row.novelty_is_breaking,
    freshnessScore:       row.freshness_score,
    freshnessBand:        row.freshness_band,
    directnessScore:      row.directness_score,
    directnessMatch:      row.directness_match,
    manipulationScore:    row.manipulation_score,
    manipulationFlags:    safeJsonParse(row.manipulation_flags_json, []),
    symbolImpactScore:    row.symbol_impact_score,
    eventRiskScore:       row.event_risk_score,
    manipulationRiskBoost: row.manipulation_risk_boost,
    scoredAt:             row.scored_at,
    // Joined fields
    title:                row.title,
    category:             row.category,
    publishedAt:          row.published_at,
  };
}

/**
 * Query scored events for a symbol, sorted by impact descending.
 */
export async function queryNewsScores(filter: ScoreQueryFilter = {}) {
  await ensureNewsSchemas();

  const conditions: string[] = ['1=1'];
  const params: any[] = [];

  if (filter.symbol) {
    conditions.push('ns.symbol = ?');
    params.push(filter.symbol);
  }
  if (filter.minImpact != null) {
    conditions.push('ns.symbol_impact_score >= ?');
    params.push(filter.minImpact);
  }
  if (filter.maxRisk != null) {
    conditions.push('ns.event_risk_score <= ?');
    params.push(filter.maxRisk);
  }
  if (filter.minManipBoost != null) {
    conditions.push('ns.manipulation_risk_boost >= ?');
    params.push(filter.minManipBoost);
  }
  if (filter.fromDate) {
    conditions.push('ns.scored_at >= ?');
    params.push(filter.fromDate);
  }

  const limit = Math.min(filter.limit ?? 50, 200);
  params.push(limit);

  const { rows } = await db.query<ScoreRow>(
    `SELECT ns.*, ne.title, ne.category, ne.published_at
     FROM q365_news_scores ns
     LEFT JOIN q365_news_events ne ON ne.id = ns.news_event_id
     WHERE ${conditions.join(' AND ')}
     ORDER BY ns.symbol_impact_score DESC
     LIMIT ?`,
    params,
  );

  return rows.map(rowToScoreSummary);
}

/**
 * Get the top N highest-impact scores for a symbol in the last N days.
 */
export async function getTopScoresForSymbol(
  symbol: string,
  limit = 10,
  daysBack = 7,
) {
  const fromDate = new Date(Date.now() - daysBack * 86_400_000).toISOString();
  return queryNewsScores({ symbol, fromDate, limit });
}

/**
 * Get events with high manipulation risk boost (for alerting).
 */
export async function getHighManipulationEvents(minBoost = 15, limit = 20) {
  return queryNewsScores({ minManipBoost: minBoost, limit });
}

function safeJsonParse<T>(val: unknown, fallback: T): T {
  if (!val) return fallback;
  if (typeof val === 'object' && Array.isArray(val)) return val as T;
  try { return JSON.parse(String(val)); } catch { return fallback; }
}
