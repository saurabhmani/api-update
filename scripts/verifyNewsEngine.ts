/* eslint-disable no-console */
/**
 * One-shot verification script for the news-engine pipeline.
 * Bypasses the HTTP auth layer and reads the same shapes the
 * /api/news-engine?action=summary and ?action=source-status
 * endpoints would emit.
 *
 *   tsx scripts/verifyNewsEngine.ts
 */

import 'tsconfig-paths/register';
import { config as dotenvConfig } from 'dotenv';
dotenvConfig({ path: '.env.local' });

import { db } from '@/lib/db';
import { getConfiguredSourcesSnapshot } from '@/lib/news-engine/ingestion/ingestAll';
import { getRecentIngestionLogs } from '@/lib/news-engine/repository/readNewsEvents';

async function main() {
  console.log('═════════════════════════════════════════════════════');
  console.log('  News Engine Verification (live data)');
  console.log('═════════════════════════════════════════════════════\n');

  // 1. Configured sources snapshot (no network calls)
  const sources = getConfiguredSourcesSnapshot();
  console.log('1. SOURCE REGISTRATION + ENV STATE');
  console.table(sources.map(s => ({
    source:     s.source,
    configured: s.configured,
  })));

  // 2. Latest pipeline run (from audit log)
  const logs = await getRecentIngestionLogs(3).catch(() => []);
  const last = logs?.[0] ?? null;
  console.log('\n2. LATEST PIPELINE RUNS (most-recent 3 from q365_news_ingestion_log)');
  if (logs.length === 0) {
    console.log('  (no runs logged yet)');
  } else {
    console.table(logs.map((r: any) => ({
      run_at:           r.run_at,
      total_fetched:    r.total_fetched,
      new_events:       r.new_events,
      duplicates:       r.duplicates_skipped,
      duration_ms:      r.duration_ms,
    })));
  }

  // 3. Per-source breakdown from latest run
  if (last) {
    const bdRaw = last.source_breakdown_json ?? '{}';
    const breakdown = typeof bdRaw === 'string' ? JSON.parse(bdRaw) : bdRaw;
    console.log('\n3. PER-SOURCE FETCH COUNTS (latest run)');
    console.table(sources.map(s => ({
      source:     s.source,
      configured: s.configured,
      fetched:    breakdown[s.source] ?? 0,
    })));
  }

  // 4. DB freshness
  const { rows: evtCount }: any = await db.query(
    `SELECT COUNT(*) AS n FROM q365_news_events`,
  );
  const { rows: latestEvt }: any = await db.query(
    `SELECT published_at, source_id, title
       FROM q365_news_events
      ORDER BY published_at DESC
      LIMIT 1`,
  );
  const { rows: last24 }: any = await db.query(
    `SELECT COUNT(*) AS n FROM q365_news_events
      WHERE published_at >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL 24 HOUR)`,
  );
  const { rows: last10m }: any = await db.query(
    `SELECT COUNT(*) AS n FROM q365_news_events
      WHERE published_at >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL 10 MINUTE)`,
  );

  console.log('\n4. DB FRESHNESS');
  console.table({
    total_events_in_db:    evtCount?.[0]?.n,
    events_last_24h:       last24?.[0]?.n,
    events_last_10m:       last10m?.[0]?.n,
    latest_event_at_utc:   latestEvt?.[0]?.published_at,
    latest_event_source:   latestEvt?.[0]?.source_id,
    latest_event_title:    latestEvt?.[0]?.title?.slice(0, 80),
  });

  // 5. Per-source live counts in DB (24h)
  const { rows: bySrc }: any = await db.query(
    `SELECT source_id, COUNT(*) AS n
       FROM q365_news_events
      WHERE published_at >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL 24 HOUR)
      GROUP BY source_id`,
  );
  console.log('\n5. DB EVENTS BY SOURCE — LAST 24H');
  console.table(bySrc);

  // 6. Dedup hash sanity — should be unique
  const { rows: dupCheck }: any = await db.query(
    `SELECT COUNT(*) AS total,
            COUNT(DISTINCT dedup_hash) AS uniq
       FROM q365_news_events
      WHERE published_at >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL 24 HOUR)`,
  );
  console.log('\n6. DEDUP INTEGRITY (24h window)');
  console.table(dupCheck);

  console.log('\n═════════════════════════════════════════════════════');
  console.log('  Done.');
  console.log('═════════════════════════════════════════════════════');

  process.exit(0);
}

main().catch((err) => {
  console.error('verification failed:', err);
  process.exit(1);
});
