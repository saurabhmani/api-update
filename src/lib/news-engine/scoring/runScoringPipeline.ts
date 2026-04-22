// ════════════════════════════════════════════════════════════════
//  News Scoring Pipeline
//
//  Scores all unscored events or a given batch of events.
//  For each event:
//    1. Count recent similar events (novelty input)
//    2. Compute score card per linked symbol
//    3. Persist to q365_news_scores
//
//  Can be called:
//    - As part of runNewsPipeline (after ingest+normalize)
//    - Standalone for re-scoring existing events
// ════════════════════════════════════════════════════════════════

import { db } from '@/lib/db';
import { ensureNewsSchemas } from '../repository/ensureNewsSchemas';
import { saveNewsScores } from '../repository/saveNewsScores';
import { scoreEventForAllSymbols } from './computeScoreCard';
import type { NewsEvent } from '../types/newsEngine.types';
import type { NewsScoreCard, ScoringResult } from '../types/scoring.types';

/**
 * Count events with overlapping title tokens in the last 24h.
 * Used as the novelty input. Lightweight: takes the first 5
 * significant words from the title and checks for partial match.
 */
async function countRecentSimilar(event: NewsEvent): Promise<number> {
  // Extract significant title words (skip short/common words)
  const words = event.title
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .split(/\s+/)
    .filter((w) => w.length > 3)
    .slice(0, 5);

  if (words.length === 0) return 0;

  // Build LIKE conditions — match events containing at least 3 of these words
  // For speed, just check title LIKE '%word%' for the first 3 words
  const likeWords = words.slice(0, 3);
  const conditions = likeWords.map(() => 'ne.title LIKE ?');
  const params: any[] = likeWords.map((w) => `%${w}%`);

  try {
    const { rows } = await db.query<{ cnt: number }>(
      `SELECT COUNT(*) AS cnt FROM q365_news_events ne
       WHERE ne.published_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR)
         AND ne.id != ?
         AND (${conditions.join(' AND ')})`,
      [event.id ?? 0, ...params],
    );
    return rows[0]?.cnt ?? 0;
  } catch {
    return 0;
  }
}

/**
 * Score a batch of events. Typically called with the events
 * that were just ingested in this pipeline run.
 */
export async function scoreEvents(events: NewsEvent[]): Promise<ScoringResult> {
  await ensureNewsSchemas();
  const startMs = Date.now();
  const errors: string[] = [];
  const allCards: NewsScoreCard[] = [];

  for (const event of events) {
    if (!event.id) continue; // needs DB id to persist scores

    try {
      const recentSimilar = await countRecentSimilar(event);
      const cards = scoreEventForAllSymbols(event, recentSimilar);
      allCards.push(...cards);
    } catch (err) {
      errors.push(`event ${event.id}: ${(err as Error).message}`);
    }
  }

  // Persist all score cards
  const written = await saveNewsScores(allCards);

  return {
    totalScored:  events.filter((e) => !!e.id).length,
    symbolScores: written,
    errors,
    durationMs:   Date.now() - startMs,
  };
}

/**
 * Re-score all unscored events from the last N hours.
 * Useful for backfilling or after scoring logic changes.
 */
export async function scoreUnscoredEvents(hoursBack = 48): Promise<ScoringResult> {
  await ensureNewsSchemas();

  const { rows } = await db.query<any>(
    `SELECT ne.*
     FROM q365_news_events ne
     LEFT JOIN q365_news_scores ns ON ns.news_event_id = ne.id
     WHERE ne.published_at >= DATE_SUB(NOW(), INTERVAL ? HOUR)
       AND ns.id IS NULL
     ORDER BY ne.published_at DESC
     LIMIT 200`,
    [hoursBack],
  );

  // Reconstruct NewsEvent objects from DB rows
  const events: NewsEvent[] = rows.map((r: any) => ({
    id:             r.id,
    sourceId:       r.source_id,
    externalId:     r.external_id,
    dedupHash:      r.dedup_hash,
    title:          r.title,
    body:           r.body,
    url:            r.url,
    category:       r.category,
    sentiment:      r.sentiment,
    sentimentScore: parseFloat(r.sentiment_score) || 0,
    publishedAt:    r.published_at instanceof Date ? r.published_at.toISOString() : String(r.published_at),
    fetchedAt:      r.fetched_at instanceof Date ? r.fetched_at.toISOString() : String(r.fetched_at),
    entities:       [],
    symbols:        safeJsonParse(r.symbols_json, []),
    sectors:        safeJsonParse(r.sectors_json, []),
    macroFactors:   safeJsonParse(r.macro_factors_json, []),
    commodities:    safeJsonParse(r.commodities_json, []),
    isProcessed:    !!r.is_processed,
  }));

  return scoreEvents(events);
}

function safeJsonParse<T>(val: unknown, fallback: T): T {
  if (!val) return fallback;
  if (typeof val === 'object' && Array.isArray(val)) return val as T;
  try { return JSON.parse(String(val)); } catch { return fallback; }
}
