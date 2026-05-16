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

/**
 * The write path (saveNewsEvents.ts:toMysqlDateTime) stores UTC as
 * plain "YYYY-MM-DD HH:MM:SS" into MySQL DATETIME (which has NO
 * timezone). The mysql2 driver, on read, parses that literal as
 * *local server time* — so a row written at UTC 12:33:35 and read
 * on an IST server comes back as a Date whose .getTime() encodes
 * "local IST 12:33:35", which is UTC 07:03:35. Calling
 * .toISOString() on it would emit "2026-04-23T07:03:35.000Z",
 * shifting the timestamp backward by the server's offset and
 * causing strict "last 10 min" filters to drop everything.
 *
 * This helper reverses the driver's local-interpretation mistake:
 * whether mysql2 returns a Date or a raw string, we reconstruct
 * the UTC instant by taking the literal Y/M/D/H/M/S fields and
 * feeding them through Date.UTC().
 */
function datetimeToUtcIso(val: unknown): string {
  if (val == null) return '';
  if (val instanceof Date) {
    // Take the string-visible fields (which mysql2 set from the raw
    // DB literal) and treat them as UTC instead of local.
    return new Date(Date.UTC(
      val.getFullYear(), val.getMonth(),   val.getDate(),
      val.getHours(),    val.getMinutes(), val.getSeconds(),
      val.getMilliseconds(),
    )).toISOString();
  }
  const s = String(val).trim();
  if (!s) return '';
  // Raw string mode: "2026-04-23 12:33:35" → "2026-04-23T12:33:35Z"
  const hasTz = /[zZ]$|[+-]\d{2}:?\d{2}$/.test(s);
  const iso = (s.includes('T') ? s : s.replace(' ', 'T')) + (hasTz ? '' : 'Z');
  const ms = new Date(iso).getTime();
  return Number.isFinite(ms) ? new Date(ms).toISOString() : s;
}

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
    publishedAt:    datetimeToUtcIso(row.published_at),
    fetchedAt:      datetimeToUtcIso(row.fetched_at),
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
    // Widen the SQL bound by an extra 6 h to absorb any timezone
    // offset between the caller's UTC threshold and the session's
    // interpretation of the DATETIME column. The authoritative
    // per-row filter runs in JS in the route handler
    // (rowToNewsEvent returns a genuine UTC ISO via datetimeToUtcIso,
    // so the post-filter is timezone-safe). This prevents the
    // previous symptom where a UTC/IST offset in the driver wiped
    // out every visible row in a "last 10 min" query.
    conditions.push('ne.published_at >= DATE_SUB(?, INTERVAL 6 HOUR)');
    params.push(filter.fromDate);
  } else {
    // Default freshness window: 72h (3 days). Keeps legacy 2024-era
    // rows from leaking into the current feed when the caller didn't
    // pass an explicit fromDate.
    conditions.push("ne.published_at >= DATE_SUB(NOW(), INTERVAL 72 HOUR)");
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
