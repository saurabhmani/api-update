// ════════════════════════════════════════════════════════════════
//  News Repository — Write Layer
//
//  Persists NewsEvent[] with dedup via UNIQUE(dedup_hash).
//  Also persists entity links in a separate table.
//  Returns count of newly inserted events.
// ════════════════════════════════════════════════════════════════

import { db } from '@/lib/db';
import { ensureNewsSchemas } from './ensureNewsSchemas';
import type { NewsEvent } from '../types/newsEngine.types';

/**
 * Save a batch of news events. Skips duplicates via dedup_hash.
 * Also inserts entity links for each new event.
 *
 * @returns The events that were newly inserted (with .id populated).
 */
export async function saveNewsEvents(events: NewsEvent[]): Promise<NewsEvent[]> {
  await ensureNewsSchemas();

  const inserted: NewsEvent[] = [];

  for (const event of events) {
    try {
      const result = await db.query(
        `INSERT INTO q365_news_events
           (source_id, external_id, dedup_hash, title, body, url,
            category, sentiment, sentiment_score, published_at, fetched_at,
            symbols_json, sectors_json, macro_factors_json, commodities_json,
            is_processed)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE updated_at = NOW()`,
        [
          event.sourceId,
          event.externalId,
          event.dedupHash,
          event.title,
          event.body,
          event.url,
          event.category,
          event.sentiment,
          event.sentimentScore,
          event.publishedAt,
          event.fetchedAt,
          JSON.stringify(event.symbols),
          JSON.stringify(event.sectors),
          JSON.stringify(event.macroFactors),
          JSON.stringify(event.commodities),
          event.isProcessed ? 1 : 0,
        ],
      );

      const eventId = result.insertId;
      // insertId is 0 on duplicate key update (no new row)
      if (!eventId) continue;

      inserted.push({ ...event, id: eventId });

      // Persist entity links
      for (const entity of event.entities) {
        await db.query(
          `INSERT INTO q365_news_entity_links
             (news_event_id, entity_type, entity_value, confidence, match_method)
           VALUES (?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE confidence = VALUES(confidence)`,
          [
            eventId,
            entity.entityType,
            entity.entityValue,
            entity.confidence,
            entity.matchMethod,
          ],
        ).catch((err) => {
          // Non-fatal: log and continue
          console.warn(`[saveNewsEvents] entity link insert failed:`, (err as Error).message);
        });
      }
    } catch (err) {
      console.warn(`[saveNewsEvents] event insert failed for "${event.title.slice(0, 60)}":`, (err as Error).message);
    }
  }

  return inserted;
}

/**
 * Log an ingestion run for audit trail.
 */
export async function logIngestionRun(run: {
  totalFetched: number;
  duplicatesSkipped: number;
  newEvents: number;
  errors: string[];
  sourceBreakdown: Record<string, number>;
  durationMs: number;
}): Promise<void> {
  await ensureNewsSchemas();

  await db.query(
    `INSERT INTO q365_news_ingestion_log
       (run_at, total_fetched, duplicates_skipped, new_events,
        errors_json, source_breakdown_json, duration_ms)
     VALUES (NOW(), ?, ?, ?, ?, ?, ?)`,
    [
      run.totalFetched,
      run.duplicatesSkipped,
      run.newEvents,
      JSON.stringify(run.errors),
      JSON.stringify(run.sourceBreakdown),
      run.durationMs,
    ],
  );
}
