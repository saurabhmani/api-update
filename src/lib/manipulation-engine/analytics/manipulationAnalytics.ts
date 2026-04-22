// ════════════════════════════════════════════════════════════════
//  Phase 3 — Manipulation Analytics
//
//  Aggregations over the manipulation snapshots, events, and the
//  backtest tables. Every function returns small, JSON-serialisable
//  shapes — they back the surveillance dashboard and the
//  /analytics endpoint.
//
//  Pure helpers (bucket math) live at the bottom of the file so the
//  unit tests can exercise them without touching the database.
// ════════════════════════════════════════════════════════════════

import { db } from '@/lib/db';
import type { SuspicionBand, EventType } from '../types';
import { SUSPICION_BANDS } from '../constants/thresholds';

export interface TopSuspiciousRow {
  symbol: string;
  score: number;
  band: SuspicionBand;
  snapshotDate: string;
}

export interface EventDensityRow {
  symbol: string;
  eventCount: number;
  windowDays: number;
}

export interface SectorAnomalyRow {
  sector: string;
  symbolCount: number;
  totalEvents: number;
  avgScore: number;
}

export interface BucketPerformance {
  band: SuspicionBand;
  sampleSize: number;
  winRate: number | null;       // %
  avgPnlPct: number | null;
  falseBreakoutRate: number | null; // %
}

export interface StrategyPerfRow {
  strategy: string;
  sampleSize: number;
  winRate: number;
  avgPnlPct: number;
}

// ── Top suspicious symbols today ────────────────────────────────

export async function topSuspiciousSymbols(date: string, limit = 25): Promise<TopSuspiciousRow[]> {
  const safe = Math.max(1, Math.min(limit, 200));
  const { rows } = await db.query<any>(
    `SELECT symbol, manipulation_score, suspicion_band, snapshot_date
     FROM q365_manipulation_snapshots
     WHERE snapshot_date = ?
     ORDER BY manipulation_score DESC
     LIMIT ${safe}`,
    [date],
  );
  return (rows ?? []).map((r: any) => ({
    symbol: r.symbol,
    score: Number(r.manipulation_score),
    band: r.suspicion_band,
    snapshotDate: typeof r.snapshot_date === 'string'
      ? r.snapshot_date
      : new Date(r.snapshot_date).toISOString().split('T')[0],
  }));
}

// ── Event density (20/60/120 day windows) ───────────────────────

export async function eventDensityByWindow(
  windowDays: 20 | 60 | 120,
  endDate: string,
  limit = 50,
): Promise<EventDensityRow[]> {
  const start = new Date(endDate);
  start.setUTCDate(start.getUTCDate() - windowDays);
  const startStr = start.toISOString().split('T')[0];
  const safe = Math.max(1, Math.min(limit, 500));
  const { rows } = await db.query<any>(
    `SELECT symbol, COUNT(*) AS event_count
     FROM q365_manipulation_events
     WHERE event_date BETWEEN ? AND ?
     GROUP BY symbol
     ORDER BY event_count DESC
     LIMIT ${safe}`,
    [startStr, endDate],
  );
  return (rows ?? []).map((r: any) => ({
    symbol: r.symbol,
    eventCount: Number(r.event_count),
    windowDays,
  }));
}

// ── Sector concentration ────────────────────────────────────────

export async function sectorAnomalyConcentration(
  startDate: string,
  endDate: string,
): Promise<SectorAnomalyRow[]> {
  // We join through backtest_signals which has a `sector` column. If a
  // symbol has no backtest signal at all the sector is bucketed as "Other".
  const { rows } = await db.query<any>(
    `SELECT COALESCE(bs.sector, 'Other') AS sector,
            COUNT(DISTINCT e.symbol) AS symbol_count,
            COUNT(*)                 AS total_events,
            AVG(e.score)             AS avg_score
     FROM q365_manipulation_events e
     LEFT JOIN backtest_signals bs ON bs.symbol = e.symbol
     WHERE e.event_date BETWEEN ? AND ?
     GROUP BY COALESCE(bs.sector, 'Other')
     ORDER BY total_events DESC
     LIMIT 50`,
    [startDate, endDate],
  );
  return (rows ?? []).map((r: any) => ({
    sector: r.sector,
    symbolCount: Number(r.symbol_count),
    totalEvents: Number(r.total_events),
    avgScore: r.avg_score != null ? Number(Number(r.avg_score).toFixed(2)) : 0,
  }));
}

// ── Win rate vs score bucket ────────────────────────────────────

export async function winRateByScoreBucket(runId?: string): Promise<BucketPerformance[]> {
  // Pull every backtest trade with its joined manipulation snapshot at
  // signal date. Bucket by suspicion band → win rate / avg PnL.
  const params: any[] = [];
  let where = '';
  if (runId) { where = 'WHERE bs.run_id = ?'; params.push(runId); }

  const { rows } = await db.query<any>(
    `SELECT s.suspicion_band AS band,
            COUNT(*)         AS n,
            AVG(CASE WHEN bt.outcome = 'win' THEN 1 ELSE 0 END) AS win_rate,
            AVG(bt.pnl_pct)                                      AS avg_pnl_pct
     FROM backtest_trades bt
     JOIN backtest_signals bs ON bs.signal_id = bt.signal_id
     LEFT JOIN q365_manipulation_snapshots s
            ON s.symbol = bs.symbol AND s.snapshot_date = bs.date
     ${where}
     GROUP BY s.suspicion_band`,
    params,
  );

  // Fill out missing bands with empty buckets so the dashboard renders all 5.
  const byBand = new Map<string, any>();
  for (const r of rows ?? []) byBand.set(r.band ?? 'low', r);
  return SUSPICION_BANDS.map((b) => {
    const r = byBand.get(b.band);
    if (!r) return { band: b.band, sampleSize: 0, winRate: null, avgPnlPct: null, falseBreakoutRate: null };
    return {
      band: b.band,
      sampleSize: Number(r.n ?? 0),
      winRate: r.win_rate != null ? Number((Number(r.win_rate) * 100).toFixed(2)) : null,
      avgPnlPct: r.avg_pnl_pct != null ? Number(Number(r.avg_pnl_pct).toFixed(3)) : null,
      falseBreakoutRate: null,
    };
  });
}

// ── Strategy performance with vs without manipulation filter ────

export async function strategyPerfFiltered(
  runId: string,
  band: SuspicionBand = 'elevated',
): Promise<{ included: StrategyPerfRow[]; excluded: StrategyPerfRow[] }> {
  // "excluded" view excludes trades whose snapshot band is ≥ `band`.
  const { rows: incRows } = await db.query<any>(
    `SELECT bs.strategy AS strategy,
            COUNT(*)    AS n,
            AVG(CASE WHEN bt.outcome='win' THEN 1 ELSE 0 END) AS win_rate,
            AVG(bt.pnl_pct) AS avg_pnl
     FROM backtest_trades bt
     JOIN backtest_signals bs ON bs.signal_id = bt.signal_id
     WHERE bs.run_id = ?
     GROUP BY bs.strategy
     ORDER BY n DESC`,
    [runId],
  );

  const minScore = bandToMinScore(band);
  const { rows: excRows } = await db.query<any>(
    `SELECT bs.strategy AS strategy,
            COUNT(*)    AS n,
            AVG(CASE WHEN bt.outcome='win' THEN 1 ELSE 0 END) AS win_rate,
            AVG(bt.pnl_pct) AS avg_pnl
     FROM backtest_trades bt
     JOIN backtest_signals bs ON bs.signal_id = bt.signal_id
     LEFT JOIN q365_manipulation_snapshots s
            ON s.symbol = bs.symbol AND s.snapshot_date = bs.date
     WHERE bs.run_id = ?
       AND (s.manipulation_score IS NULL OR s.manipulation_score < ?)
     GROUP BY bs.strategy
     ORDER BY n DESC`,
    [runId, minScore],
  );

  return {
    included: (incRows ?? []).map(toStratRow),
    excluded: (excRows ?? []).map(toStratRow),
  };
}

function toStratRow(r: any): StrategyPerfRow {
  return {
    strategy: r.strategy,
    sampleSize: Number(r.n),
    winRate: r.win_rate != null ? Number((Number(r.win_rate) * 100).toFixed(2)) : 0,
    avgPnlPct: r.avg_pnl != null ? Number(Number(r.avg_pnl).toFixed(3)) : 0,
  };
}

// ── Pure helpers (unit-testable, no DB) ─────────────────────────

export function bandToMinScore(band: SuspicionBand): number {
  const found = SUSPICION_BANDS.find((b) => b.band === band);
  return found ? found.min : 50;
}

/**
 * Bucket an array of trades by the manipulation score that was attached
 * to the signal at signal date. Returns one row per band.
 */
export function bucketTradesByScore<T extends {
  score: number | null; outcome: 'win' | 'loss' | 'breakeven' | string; pnlPct?: number;
}>(trades: T[]): BucketPerformance[] {
  const buckets = new Map<SuspicionBand, T[]>();
  for (const b of SUSPICION_BANDS) buckets.set(b.band, []);
  for (const t of trades) {
    const score = t.score ?? 0;
    const band = SUSPICION_BANDS.find((b) => score >= b.min && score <= b.max)?.band ?? 'low';
    buckets.get(band)!.push(t);
  }
  return SUSPICION_BANDS.map((b) => {
    const arr = buckets.get(b.band)!;
    if (arr.length === 0) {
      return { band: b.band, sampleSize: 0, winRate: null, avgPnlPct: null, falseBreakoutRate: null };
    }
    const wins = arr.filter((t) => t.outcome === 'win').length;
    const pnls = arr.map((t) => t.pnlPct ?? 0);
    const avgPnl = pnls.reduce((a, b) => a + b, 0) / arr.length;
    return {
      band: b.band,
      sampleSize: arr.length,
      winRate: Number(((wins / arr.length) * 100).toFixed(2)),
      avgPnlPct: Number(avgPnl.toFixed(3)),
      falseBreakoutRate: null,
    };
  });
}

// ── Event-type histogram (dashboard) ────────────────────────────

export async function eventTypeHistogram(
  startDate: string,
  endDate: string,
): Promise<Array<{ eventType: EventType; count: number }>> {
  const { rows } = await db.query<any>(
    `SELECT event_type, COUNT(*) AS count
     FROM q365_manipulation_events
     WHERE event_date BETWEEN ? AND ?
     GROUP BY event_type
     ORDER BY count DESC`,
    [startDate, endDate],
  );
  return (rows ?? []).map((r: any) => ({
    eventType: r.event_type as EventType,
    count: Number(r.count),
  }));
}
