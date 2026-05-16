// ════════════════════════════════════════════════════════════════
//  Free EOD daily ingestion pipeline.
//
//  Calls every configured EOD adapter (NSE bhavcopy today, BSE / bulk
//  deal / ASM in future rounds), upserts the resulting candles into
//  the shared `candles` table on the same schema the manipulation
//  engine reads via loadDailyBars(), and writes a per-source summary
//  into the q365_data_feed_health rail so the operator can see why a
//  given trading day is missing.
//
//  Idempotent:
//    The upsert uses ON DUPLICATE KEY UPDATE keyed on
//    (instrument_key, candle_type, interval_unit, ts) — the same
//    primary key persistCandle() uses. Running this pipeline twice
//    for the same trade date updates the row in place, never
//    duplicates.
//
//  Failure contract:
//    • If every primary source fails the pipeline returns ok=false
//      but never throws — the scheduler keeps running.
//    • No source partially fails the whole run: each adapter's
//      records are upserted independently.
//    • A source returning 0 records is treated as FAILED, not
//      success-with-empty-data — silent zero on a trading day is the
//      most dangerous failure mode.
// ════════════════════════════════════════════════════════════════

import { db } from '@/lib/db';
import { logger } from '@/lib/logger';
import { logFeedHealth } from '@/lib/marketData/feedHealthLog';
import { fetchNseBhavcopy } from './nseBhavcopyAdapter';
import type {
  EodCandleRecord,
  EodFetchResult,
  EodIngestionResult,
  EodSourceSummary,
} from './types';

const log = logger.child({ component: 'eod-ingestion' });

// ── Upsert one candle, returning insert/update/noop. ────────────
//
// MySQL convention for ON DUPLICATE KEY UPDATE:
//   affectedRows = 1  → inserted
//   affectedRows = 2  → updated
//   affectedRows = 0  → row matched but no column changed
async function upsertCandleRow(rec: EodCandleRecord): Promise<'inserted' | 'updated' | 'duplicate'> {
  if (rec.close == null) return 'duplicate';

  // instrument_key follows the project's canonical "NSE_EQ|SYMBOL"
  // convention — the manipulation engine's loadDailyBars uses
  // `instrument_key LIKE '%SYMBOL%'`, so we keep the exchange prefix
  // stable. BSE will use 'BSE_EQ|SYMBOL'.
  const segmentPrefix = rec.exchange === 'NSE' ? 'NSE_EQ' : 'BSE_EQ';
  const instrumentKey = `${segmentPrefix}|${rec.symbol}`;

  // Candle timestamp: store the trade date at 00:00:00 UTC. The
  // manipulation loader reads with `ts <= asOf` and strips to date,
  // so the exact intraday timestamp doesn't matter for scanning.
  const ts = new Date(`${rec.tradeDate}T00:00:00Z`);

  const result: any = await db.query(
    `INSERT INTO candles
       (instrument_key, candle_type, interval_unit, ts, open, high, low, close, volume, oi)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       open   = VALUES(open),
       high   = VALUES(high),
       low    = VALUES(low),
       close  = VALUES(close),
       volume = VALUES(volume),
       oi     = VALUES(oi)`,
    [
      instrumentKey,
      'eod',
      '1day',
      ts,
      rec.open  ?? rec.close,
      rec.high  ?? rec.close,
      rec.low   ?? rec.close,
      rec.close,
      rec.volume ?? 0,
      0,
    ],
  );

  const affected = Number(result?.affectedRows ?? 0);
  if (affected === 1) return 'inserted';
  if (affected === 2) return 'updated';
  return 'duplicate';
}

async function persistSource(fetched: EodFetchResult): Promise<EodSourceSummary> {
  const summary: EodSourceSummary = {
    source:     fetched.source,
    status:     fetched.status,
    fetched:    fetched.fetched,
    inserted:   0,
    updated:    0,
    duplicates: 0,
    error:      fetched.error,
    sourceFile: fetched.sourceFile,
  };

  if (fetched.status !== 'SUCCESS') return summary;

  for (const rec of fetched.records) {
    try {
      const outcome = await upsertCandleRow(rec);
      if      (outcome === 'inserted')  summary.inserted++;
      else if (outcome === 'updated')   summary.updated++;
      else                              summary.duplicates++;
    } catch (err) {
      // Individual row failures shouldn't fail the whole source —
      // log and continue. The summary's `fetched` vs (inserted +
      // updated + duplicates) gap surfaces partial failure.
      log.warn('candle upsert failed', {
        source: fetched.source,
        symbol: rec.symbol,
        date:   rec.tradeDate,
        err:    (err as Error).message,
      });
    }
  }

  // If we lost records during upsert, downgrade SUCCESS → PARTIAL so
  // the caller (and feed-health row) reflect reality.
  const persistedTotal = summary.inserted + summary.updated + summary.duplicates;
  if (persistedTotal < fetched.fetched) {
    summary.status = 'PARTIAL';
    summary.error  =
      `Persisted ${persistedTotal}/${fetched.fetched} rows — some upserts failed.`;
  }

  return summary;
}

async function readLatestCandleDate(): Promise<string | null> {
  try {
    const { rows } = await db.query<{ d: string | Date | null }>(
      `SELECT MAX(ts) AS d FROM candles WHERE candle_type='eod' AND interval_unit='1day'`,
    );
    const d = rows?.[0]?.d;
    if (!d) return null;
    return typeof d === 'string' ? d.split('T')[0] : new Date(d).toISOString().split('T')[0];
  } catch (err) {
    log.warn('latestCandleDate probe failed', { err: (err as Error).message });
    return null;
  }
}

function feedHealthQuality(status: EodSourceSummary['status']): 'HIGH' | 'MEDIUM' | 'LOW' {
  switch (status) {
    case 'SUCCESS':        return 'HIGH';
    case 'PARTIAL':        return 'MEDIUM';
    case 'FAILED':
    case 'NOT_CONFIGURED':
    default:               return 'LOW';
  }
}

function feedHealthStatus(status: EodSourceSummary['status']): string {
  switch (status) {
    case 'SUCCESS':        return 'success';
    case 'PARTIAL':        return 'success';   // partial still served data
    case 'NOT_CONFIGURED': return 'failed';
    case 'FAILED':         return 'failed';
    default:               return 'failed';
  }
}

// ── Public entrypoint ─────────────────────────────────────────────

export interface RunEodIngestionOptions {
  /** Target trade date (YYYY-MM-DD). Defaults to the most recent weekday. */
  date?:       string;
  /** Per-adapter timeout in ms. */
  timeoutMs?:  number;
  /** Skip the NSE bhavcopy adapter. Useful for tests. */
  skipNse?:    boolean;
}

/**
 * Run every configured free EOD source for one trading day and upsert
 * the results into the shared `candles` table. Always resolves — even
 * if every source fails, the function returns `{ ok: false, ... }`
 * with a per-source error breakdown so the caller (API route / cron
 * job / UI button) can show a useful diagnostic.
 */
export async function runDailyEodIngestion(
  options: RunEodIngestionOptions = {},
): Promise<EodIngestionResult> {
  const startedAt = new Date().toISOString();
  const warnings: string[] = [];
  const sources: EodSourceSummary[] = [];

  log.info('eod ingestion starting', { date: options.date ?? '(today)' });

  // ── 1. NSE bhavcopy (primary cash-equity source). ──
  if (!options.skipNse) {
    const requestStart = new Date().toISOString();
    const fetched = await fetchNseBhavcopy({
      date:      options.date,
      timeoutMs: options.timeoutMs,
    });
    const summary = await persistSource(fetched);
    sources.push(summary);
    const requestEnd = new Date().toISOString();

    // Fire-and-forget data-feed-health row so the operator's freshness
    // panel reflects this run regardless of whether the API route or
    // the cron job triggered it.
    void logFeedHealth({
      provider:             'NSE_BHAVCOPY',
      endpoint:             summary.sourceFile ?? 'bhavcopy.csv.zip',
      request_started_at:   requestStart,
      response_received_at: requestEnd,
      status:               feedHealthStatus(summary.status),
      latency_ms:           Math.max(0, new Date(requestEnd).getTime() - new Date(requestStart).getTime()),
      symbols_requested:    summary.fetched,
      symbols_returned:     summary.inserted + summary.updated,
      coverage_percent:     summary.fetched > 0
                              ? Math.round(((summary.inserted + summary.updated) / summary.fetched) * 1000) / 10
                              : 0,
      data_quality:         feedHealthQuality(summary.status),
      error_code:           summary.status === 'SUCCESS' ? null : summary.status,
      error_message:        summary.error,
    });
  }

  const latestCandleDate = await readLatestCandleDate();

  // ── 2. Pipeline-level OK flag. ──
  // True iff at least one source returned data we successfully persisted.
  const ok = sources.some((s) =>
    (s.status === 'SUCCESS' || s.status === 'PARTIAL') && (s.inserted + s.updated) > 0,
  );

  if (!ok) {
    warnings.push(
      'No EOD source succeeded. The candle warehouse was not updated. ' +
      'Manipulation freshness will remain stale until the next successful run.',
    );
  }

  // Best-effort: report the date we believed we were ingesting for. If
  // every adapter rolled back to a different weekday (e.g. user asked
  // for Sunday → adapter rolled to Friday), use the first non-null
  // tradeDate from the adapters.
  const tradeDate =
    sources.find((s) => s.fetched > 0)?.sourceFile != null
      ? // adapters store the actual date in record.tradeDate, not in
        // EodSourceSummary, so fall back to latestCandleDate which is
        // updated within this run.
        latestCandleDate
      : options.date ?? latestCandleDate;

  const completedAt = new Date().toISOString();
  log.info('eod ingestion complete', {
    ok,
    sources:   sources.map((s) => ({ src: s.source, status: s.status, fetched: s.fetched, ins: s.inserted, upd: s.updated })),
    latestCandleDate,
    elapsedMs: new Date(completedAt).getTime() - new Date(startedAt).getTime(),
  });

  return {
    ok,
    tradeDate,
    startedAt,
    completedAt,
    sources,
    latestCandleDate,
    warnings,
  };
}
