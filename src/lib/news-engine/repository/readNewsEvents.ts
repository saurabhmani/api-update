// ════════════════════════════════════════════════════════════════
//  News Repository — Read Layer
//
//  Query news events with filters: symbol, sector, category,
//  sentiment, date range. Also supports entity-based lookups.
// ════════════════════════════════════════════════════════════════

import { db } from '@/lib/db';
import { ensureNewsSchemas } from './ensureNewsSchemas';
import type { NewsEvent, NewsQueryFilter, EntityLink } from '../types/newsEngine.types';

// ── Reconstruct NewsEvent from DB row ────────────────────────────

function rowToNewsEvent(row: any): NewsEvent {
  return {
    id:             row.id,
    sourceId:       row.source_id,
    externalId:     row.external_id,
    dedupHash:      row.dedup_hash,
    title:          row.title,
    body:           row.body,
    url:            row.url,
    category:       row.category,
    sentiment:      row.sentiment,
    sentimentScore: parseFloat(row.sentiment_score) || 0,
    publishedAt:    row.published_at instanceof Date
      ? row.published_at.toISOString()
      : String(row.published_at),
    fetchedAt:      row.fetched_at instanceof Date
      ? row.fetched_at.toISOString()
      : String(row.fetched_at),
    entities:       [],  // loaded separately if needed
    symbols:        safeJsonParse(row.symbols_json, []),
    sectors:        safeJsonParse(row.sectors_json, []),
    macroFactors:   safeJsonParse(row.macro_factors_json, []),
    commodities:    safeJsonParse(row.commodities_json, []),
    isProcessed:    !!row.is_processed,
  };
}

function safeJsonParse<T>(val: unknown, fallback: T): T {
  if (!val) return fallback;
  if (typeof val === 'object' && Array.isArray(val)) return val as T;
  try {
    return JSON.parse(String(val));
  } catch {
    return fallback;
  }
}

// ── Query with filters ───────────────────────────────────────────

export async function queryNewsEvents(filter: NewsQueryFilter = {}): Promise<NewsEvent[]> {
  await ensureNewsSchemas();

  const conditions: string[] = ['1=1'];
  const params: any[] = [];

  if (filter.symbols?.length) {
    // Use JSON_CONTAINS to match symbols in the JSON array
    const symbolConditions = filter.symbols.map(() => 'JSON_CONTAINS(ne.symbols_json, ?)');
    conditions.push(`(${symbolConditions.join(' OR ')})`);
    for (const sym of filter.symbols) {
      params.push(JSON.stringify(sym));
    }
  }

  if (filter.sectors?.length) {
    const sectorConditions = filter.sectors.map(() => 'JSON_CONTAINS(ne.sectors_json, ?)');
    conditions.push(`(${sectorConditions.join(' OR ')})`);
    for (const s of filter.sectors) {
      params.push(JSON.stringify(s));
    }
  }

  if (filter.categories?.length) {
    const placeholders = filter.categories.map(() => '?').join(',');
    conditions.push(`ne.category IN (${placeholders})`);
    params.push(...filter.categories);
  }

  if (filter.sentiment?.length) {
    const placeholders = filter.sentiment.map(() => '?').join(',');
    conditions.push(`ne.sentiment IN (${placeholders})`);
    params.push(...filter.sentiment);
  }

  if (filter.fromDate) {
    conditions.push('ne.published_at >= ?');
    params.push(filter.fromDate);
  }

  if (filter.toDate) {
    conditions.push('ne.published_at <= ?');
    params.push(filter.toDate);
  }

  const limit = Math.min(filter.limit ?? 50, 200);
  const offset = filter.offset ?? 0;

  const sql = `
    SELECT ne.*
    FROM q365_news_events ne
    WHERE ${conditions.join(' AND ')}
    ORDER BY ne.published_at DESC
    LIMIT ? OFFSET ?`;

  params.push(limit, offset);

  const { rows } = await db.query(sql, params);
  return rows.map(rowToNewsEvent);
}

// ── Get news for a specific symbol ───────────────────────────────

export async function getNewsForSymbol(
  symbol: string,
  limit = 20,
  daysBack = 7,
): Promise<NewsEvent[]> {
  return queryNewsEvents({
    symbols: [symbol],
    fromDate: new Date(Date.now() - daysBack * 86_400_000).toISOString(),
    limit,
  });
}

// ── Get news for a sector ────────────────────────────────────────

export async function getNewsForSector(
  sector: string,
  limit = 20,
  daysBack = 7,
): Promise<NewsEvent[]> {
  return queryNewsEvents({
    sectors: [sector],
    fromDate: new Date(Date.now() - daysBack * 86_400_000).toISOString(),
    limit,
  });
}

// ── Get entity links for a news event ────────────────────────────

export async function getEntityLinksForEvent(newsEventId: number): Promise<EntityLink[]> {
  await ensureNewsSchemas();

  const { rows } = await db.query(
    `SELECT entity_type, entity_value, confidence, match_method
     FROM q365_news_entity_links
     WHERE news_event_id = ?
     ORDER BY confidence DESC`,
    [newsEventId],
  );

  return rows.map((r: any) => ({
    entityType:  r.entity_type,
    entityValue: r.entity_value,
    confidence:  r.confidence,
    matchMethod: r.match_method,
  }));
}

// ── Get recent ingestion log ─────────────────────────────────────

export async function getRecentIngestionLogs(limit = 10): Promise<any[]> {
  await ensureNewsSchemas();

  const { rows } = await db.query(
    `SELECT * FROM q365_news_ingestion_log ORDER BY run_at DESC LIMIT ?`,
    [limit],
  );
  return rows;
}

// ── Count unprocessed events ─────────────────────────────────────

export async function countUnprocessedEvents(): Promise<number> {
  await ensureNewsSchemas();

  const { rows } = await db.query(
    `SELECT COUNT(*) AS cnt FROM q365_news_events WHERE is_processed = 0`,
  );
  return rows[0]?.cnt ?? 0;
}
