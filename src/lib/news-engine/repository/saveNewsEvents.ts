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
      // Dedup-aware UPSERT.
      //
      // The INSERT columns are unchanged.
      //
      // The ON DUPLICATE KEY UPDATE clause used to set only
      //   `updated_at = NOW()`
      // which meant the FIRST insert's rule-based output
      // (symbols_json, sentiment, category, etc.) was permanently
      // frozen. When the alias map or classifier later improved, the
      // same article re-ingested would hit the dedup guard and keep
      // its stale empty symbols / outdated sentiment — producing the
      // observed "news_events_with_symbols=0 while scoring works"
      // symptom: fresh score cards had real symbols (from the current
      // resolver running in-memory on the same event), but the
      // persisted row kept the empty snapshot from the older run.
      //
      // The refresh now covers every column that is derived from a
      // rule-based layer upstream:
      //   - symbols_json / sectors_json / macro_factors_json /
      //     commodities_json   → entity resolver output
      //   - category / sentiment / sentiment_score → classifier output
      //   - is_processed       → normalization flag
      //
      // Columns NOT refreshed (intentionally):
      //   - source_id, external_id, dedup_hash, title, body, url,
      //     published_at, fetched_at  → truth-source facts. An article
      //     doesn't change its title or publish time between ingests.
      const result = await db.query(
        `INSERT INTO q365_news_events
           (source_id, external_id, dedup_hash, title, body, url,
            category, sentiment, sentiment_score, published_at, fetched_at,
            symbols_json, sectors_json, macro_factors_json, commodities_json,
            is_processed)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
            category          = VALUES(category),
            sentiment         = VALUES(sentiment),
            sentiment_score   = VALUES(sentiment_score),
            symbols_json      = VALUES(symbols_json),
            sectors_json      = VALUES(sectors_json),
            macro_factors_json = VALUES(macro_factors_json),
            commodities_json  = VALUES(commodities_json),
            is_processed      = VALUES(is_processed),
            updated_at        = NOW()`,
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
