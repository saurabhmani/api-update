/**
 * POST /api/run-signal-engine
 *
 * Phase 1 cutover adapter.
 *
 * Historically this route ran the legacy src/services/signalPipeline
 * generator. It now forwards to the phase-based engine
 * (generatePhase4Signals) so the visible app flow produces new-engine
 * rows with full provenance, Phase 3 artifacts, and Phase 4 context.
 *
 * The UI (signals page, intelligence page) does not read this route's
 * response body — both pages call this endpoint, ignore the response,
 * then reload from /api/signals or /api/intelligence, which now read
 * q365_signals via src/lib/signal-engine/repository/readSignals (the
 * reader-side cutover is complete). So the adapter only needs to:
 *   1. produce the same persistence side effects (rows in q365_signals
 *      + Phase 3/4 audit tables)
 *   2. return a legacy-shaped envelope for any non-UI caller that does
 *      read the body
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/lib/session';
import { db } from '@/lib/db';
import { migrateSignalEngine } from '@/lib/db/migrateSignalEngine';
import { ensureSignalEngineSchemas } from '@/lib/signal-engine/repository/ensureSchemas';
import {
  generatePhase4Signals,
  DEFAULT_PHASE3_CONFIG,
} from '@/lib/signal-engine';
import type { CandleProvider, PortfolioSnapshot, Candle } from '@/lib/signal-engine';
import { checkCandleFreshness } from '@/lib/signal-engine/live/candleFreshnessGuard';
import { refreshDailyCandles } from '@/lib/marketData/candleIngest';
import { DEFAULT_PHASE1_CONFIG } from '@/lib/signal-engine/constants/signalEngine.constants';
import { getMarketStatus } from '@/lib/marketData/marketHours';
import { getCandleRefreshAgeMs } from '@/lib/workers/candleRefreshScheduler';

// Max wall-clock age (ms) of the per-process "last candle refresh"
// timestamp before we consider DB bars stale for signal generation.
// Daily bar `ts` is always stamped at market open, so we measure
// age from refresh wall-clock, not from the bar's own ts field.
const STALE_SKIP_AGE_MS =
  Math.max(60_000, Number(process.env.ENGINE_STALE_SKIP_MS) || 10 * 60_000);

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// Ensure base tables + provenance columns exist on first call.
let migrated = false;

// Candle provider — reads from `market_data_daily` and stamps
// every fetch with a CANDLE DEBUG line so the terminal makes the
// freshness of what the engine consumed self-evident. Applies a
// per-symbol stale-skip guard: during market hours, if the last
// force-refresh wall clock is older than STALE_SKIP_AGE_MS, the
// symbol is skipped by returning an empty array — the existing
// Phase 1/3 loops interpret an empty bar list as a graceful
// rejection, so the engine never halts.
const dbCandleProvider: CandleProvider = {
  async fetchDailyCandles(symbol: string): Promise<Candle[]> {
    // Fetch NEWEST 300 bars, return in ASC order. Plain
    // `ORDER BY ts ASC LIMIT 300` silently returns the oldest 300,
    // so the engine reads year-old data once a symbol has >300 bars.
    const result = await db.query(
      `SELECT ts, open, high, low, close, volume FROM (
         SELECT ts, open, high, low, close, volume
         FROM market_data_daily
         WHERE symbol = ?
         ORDER BY ts DESC
         LIMIT 300
       ) t
       ORDER BY ts ASC`,
      [symbol],
    );
    const rows: Candle[] = result.rows.map((r: any) => ({
      ts: r.ts,
      open: Number(r.open),
      high: Number(r.high),
      low: Number(r.low),
      close: Number(r.close),
      volume: Number(r.volume),
    }));

    const latest = rows[rows.length - 1] ?? null;
    const latestTs = latest?.ts ? new Date(latest.ts).getTime() : null;

    // "ageMinutes" is measured against the candle scheduler's last
    // refresh wall clock, NOT the daily bar's `ts`. Yahoo's daily bar
    // is stamped at market open so its ts age is always multi-hour
    // during the session — measuring refresh age is the honest
    // "how fresh is the data we wrote?" metric.
    const refreshAgeMs = getCandleRefreshAgeMs();
    const ageMinutes =
      refreshAgeMs != null ? Math.round((refreshAgeMs / 60_000) * 10) / 10 : null;

    console.log('CANDLE DEBUG:', {
      symbol,
      latest: latest
        ? {
            time:   latestTs ? new Date(latestTs).toISOString() : null,
            open:   latest.open,
            high:   latest.high,
            low:    latest.low,
            close:  latest.close,
            volume: latest.volume,
          }
        : null,
      ageMinutes,
      bars: rows.length,
    });

    // Stale skip — only during market hours. Outside hours, yesterday's
    // bar IS the latest available, so skipping would produce zero
    // signals for a closed market, which is wrong.
    const market = getMarketStatus();
    if (market.isOpen && refreshAgeMs != null && refreshAgeMs > STALE_SKIP_AGE_MS) {
      console.warn('STALE DATA — skipping signal:', symbol, {
        ageMinutes,
        cutoff_min: STALE_SKIP_AGE_MS / 60_000,
      });
      return [];
    }

    return rows;
  },
};

// Portfolio snapshot loader — mirrors /api/signal-engine route.
async function loadPortfolioSnapshot(userId: number): Promise<PortfolioSnapshot> {
  const fallback: PortfolioSnapshot = {
    capital: DEFAULT_PHASE3_CONFIG.defaultCapital,
    cashAvailable: DEFAULT_PHASE3_CONFIG.defaultCapital,
    openPositions: [],
    pendingSignals: [],
  };
  try {
    const { rows: pRows } = await db.query(
      `SELECT id FROM portfolios WHERE user_id = ? LIMIT 1`,
      [userId],
    );
    if (!pRows.length) return fallback;

    const portfolioId = (pRows[0] as any).id;
    const { rows: pos } = await db.query(
      `SELECT pp.tradingsymbol AS symbol, pp.quantity, pp.buy_price, pp.current_price,
              COALESCE(i.sector, 'Other') AS sector
       FROM portfolio_positions pp
       LEFT JOIN instruments i ON pp.instrument_id = i.id
       WHERE pp.portfolio_id = ?`,
      [portfolioId],
    );

    const positions = (pos as any[]).map((p) => ({
      symbol: p.symbol,
      side: 'long' as const,
      sector: p.sector || 'Other',
      grossValue: (p.quantity || 0) * (p.current_price || p.buy_price || 0),
      riskAllocated: (p.quantity || 0) * (p.buy_price || 0) * 0.005,
    }));

    const totalGross = positions.reduce((s, p) => s + p.grossValue, 0);
    const capital = DEFAULT_PHASE3_CONFIG.defaultCapital;

    return {
      capital,
      cashAvailable: Math.max(0, capital - totalGross),
      openPositions: positions,
      pendingSignals: [],
    };
  } catch {
    return fallback;
  }
}

export async function POST(req: NextRequest) {
  let user: { id: number };
  try {
    user = await requireSession();
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Auto-migrate (provenance columns + Phase 2/3/4 schemas) on first call.
  // Also ensure the signal-engine views (notably market_data_daily, which
  // the DB candle provider below SELECTs from) exist — without this call
  // the pipeline throws "Table 'market_data_daily' doesn't exist" on the
  // first benchmark fetch, returns zero signals, and the UI keeps
  // rendering stale rows.
  if (!migrated) {
    await migrateSignalEngine().catch((err) =>
      console.warn('[RunSignalEngine] Migration warning:', err.message),
    );
    await ensureSignalEngineSchemas().catch((err) =>
      console.warn('[RunSignalEngine] ensureSchemas warning:', err.message),
    );
    migrated = true;
  }

  const start = Date.now();
  const batchId = `batch_${Date.now()}`;

  // ── Force refresh (Yahoo) ─────────────────────────────────
  // Every Run pulls fresh daily bars from Yahoo Finance before
  // the pipeline reads the DB. Per-symbol
  // upstream failures are logged and skipped by `refreshDailyCandles`
  // — they never block the run. The candle freshness guard is now
  // advisory: we log its verdict but do not 503 on stale data.
  try {
    const refresh = await refreshDailyCandles({
      symbols: DEFAULT_PHASE1_CONFIG.universe,
      force:   true,
    });
    console.log(
      `[RunSignalEngine] refresh done  refreshed=${refresh.refreshed}/${refresh.staleCount}  ` +
      `bars=${refresh.barsIngested}  failed=${refresh.failed.length}  ` +
      `before=${refresh.latestTsBefore} (${refresh.ageHoursBefore}h)  ` +
      `after=${refresh.latestTsAfter} (${refresh.ageHoursAfter}h)`
    );
  } catch (err) {
    // Only DB-level failures reach here; upstream HTTP failures are
    // already swallowed inside refreshDailyCandles. Log and continue
    // — the pipeline can still run off whatever bars are already in
    // the DB, and the per-symbol skip logic handles empty symbols.
    console.error(
      '[RunSignalEngine] refresh failed (continuing on DB bars):',
      (err as Error)?.message,
    );
  }

  const freshness = await checkCandleFreshness();
  console.log(
    `[RunSignalEngine] candle probe  market=${freshness.marketLabel}  ` +
    `latest=${freshness.latestCandleTs}  age=${freshness.ageHours}h  ` +
    `gap=${freshness.gapDays}d  cutoff=${freshness.maxGapDays}d  ok=${freshness.ok}`
  );
  if (!freshness.ok) {
    console.warn(
      '[RunSignalEngine] ⚠ candles still flagged as stale — running anyway:',
      freshness.reason,
    );
  }

  try {
    console.log('ENGINE STARTED:', {
      user_id: user.id,
      batch_id: batchId,
      universe_size: DEFAULT_PHASE1_CONFIG.universe.length,
      candle_latest: freshness.latestCandleTs,
      candle_age_hours: freshness.ageHours,
    });
    const portfolio = await loadPortfolioSnapshot(user.id);

    const result = await generatePhase4Signals(
      dbCandleProvider,
      portfolio,
      undefined, undefined, undefined, undefined,
      { generationSource: 'api:run-signal-engine:adapter' },
    );
    console.log('SIGNAL OUTPUT:', {
      batch_id: batchId,
      scanned: result.meta.scanned,
      produced: result.signals.length,
      rejected: result.meta.rejected,
      sample: result.signals.slice(0, 3).map((s) => ({
        symbol: s.symbol,
        conf: s.adjustedConfidenceScore,
        entry: s.tradePlan.entryZoneHigh,
      })),
    });

    // Per-signal validation log. One line per produced signal so the
    // operator can visually confirm each row was computed against a
    // recent candle, not stale DB state. The candle age here is
    // measured against the scheduler's last refresh wall clock
    // (same metric as CANDLE DEBUG above).
    const validationAgeMs = getCandleRefreshAgeMs();
    for (const s of result.signals) {
      console.log('SIGNAL DEBUG:', {
        symbol:       s.symbol,
        latestCandle: freshness.latestCandleTs,
        timestamp:    new Date().toISOString(),
        confidence:   s.adjustedConfidenceScore,
        entry:        s.tradePlan.entryZoneHigh,
        refreshAgeMin: validationAgeMs != null
          ? Math.round((validationAgeMs / 60_000) * 10) / 10
          : null,
      });
    }

    // Tag this batch's rows with the legacy batch_id. We match by
    // generation_source + generated_at window because the Phase 4
    // pipeline doesn't thread a batch id through saveSignals. This
    // is best-effort: if two adapter runs land in the same second
    // their batch_ids will overlap, which is acceptable for a
    // user-triggered button.
    const dbTag = await db.query(
      `UPDATE q365_signals
         SET batch_id = ?
       WHERE generation_source = 'api:run-signal-engine:adapter'
         AND batch_id IS NULL
         AND created_at >= FROM_UNIXTIME(?)`,
      [batchId, Math.floor(start / 1000)],
    ).catch((err) => ({ affectedRows: -1, error: err?.message }));
    console.log('DB INSERT RESULT:', {
      batch_id: batchId,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      tagged_rows: (dbTag as any)?.affectedRows ?? (dbTag as any)?.rows?.affectedRows ?? 'unknown',
    });

    const approved = result.signals.filter(
      (s) => s.executionReadiness.approvalDecision === 'approved',
    ).length;
    const deferred = result.signals.length - approved;

    // Legacy response envelope — preserves the field names the old
    // /api/run-signal-engine POST returned, so any caller reading the
    // body (cron jobs, admin tools) keeps working.
    return NextResponse.json({
      success: true,
      batch_id: batchId,
      total_scanned: result.meta.scanned,
      total_approved: approved,
      total_rejected: result.meta.rejected + deferred,
      signals: result.signals.map((s) => ({
        symbol: s.symbol,
        direction: s.executionReadiness.approvalDecision === 'approved' ? 'BUY' : 'WATCH',
        confidence_score: s.adjustedConfidenceScore,
        opportunity_score: s.adjustedConfidenceScore,
        entry_price: s.tradePlan.entryZoneHigh,
        risk_reward: s.tradePlan.rrTarget1,
        scenario_tag: s.signalType,
        conviction_band: s.confidenceBand,
      })),
      duration_ms: Date.now() - start,
      // Engine provenance — lets admin tools confirm the cutover landed.
      engine: {
        path: 'signal-engine:phase4',
        generation_source: 'api:run-signal-engine:adapter',
      },
    });
  } catch (err: any) {
    console.error('[RunSignalEngine/adapter]', err);
    return NextResponse.json(
      { error: 'Pipeline failed', details: err?.message },
      { status: 500 },
    );
  }
}

// GET alias so operators can trigger a regen by pasting the URL
// directly into the browser (405 on naked GET was the friction we
// just hit). Same session check, same pipeline — if a run is already
// in flight the in-process guard coalesces them. POST is still the
// canonical verb for scripts and curl.
export const GET = POST;
