// ════════════════════════════════════════════════════════════════
//  /api/manipulation — unified manipulation endpoint
//
//  This route was the last consumer of the legacy
//  src/lib/manipulation-detection/ module. It has been rewritten
//  to use src/lib/manipulation-engine/ exclusively so there is
//  exactly one manipulation system in the codebase.
//
//  Surface (preserved for UI compatibility):
//    POST /api/manipulation
//      Body: { symbols?, lookbackDays?, minScore? }
//      Runs a batch scan via the engine's scanSymbol pipeline and
//      returns a legacy-shaped ManipulationScanResult envelope.
//
//    GET /api/manipulation?action=summary
//      Dashboard summary in the legacy ManipulationSummary shape
//      (totalAlerts, byType, bySeverity, topAlerts, recentTrend).
//
//    GET /api/manipulation?action=alerts[&type=&severity=&status=&symbol=&limit=]
//      Alert list mapped from q365_manipulation_events.
//
//    GET /api/manipulation?symbol=XYZ[&asOf=YYYY-MM-DD]
//      Phase 1 §5 query-string alias — forwards to the same logic
//      as GET /api/manipulation/:symbol.
//
//    PATCH /api/manipulation
//      Body: { alertId, status }
//      alertId is the numeric q365_manipulation_events.id as string.
//      Mutates the event's triage status. The status column is
//      added to q365_manipulation_events by the engine migration.
// ════════════════════════════════════════════════════════════════

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireSession } from '@/lib/session';
import {
  ensureManipulationEngineTables,
  saveSnapshot,
  loadLatestSnapshot,
  scanSymbol,
  deriveRiskLabels,
  buildHookResult,
} from '@/lib/manipulation-engine';
import { loadDailyBars } from '@/lib/manipulation-engine/data/candleLoader';
import { DEFAULT_PHASE1_CONFIG } from '@/lib/signal-engine/constants/signalEngine.constants';

// Hard cap on POST scan size. The default Phase-1 universe is ~3000
// symbols and one full sequential scan can run for many minutes. Without
// this cap, an authenticated client could still pin a CPU per request.
const MAX_SCAN_SYMBOLS = 500;

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// ── Shape mappers ─────────────────────────────────────────────
//
// The UI (src/app/manipulation/page.tsx) reads a ManipulationAlert
// shape inherited from the old manipulation-detection module. Keep
// that shape stable so the UI keeps working unchanged.

interface LegacyAlert {
  alertId: string;
  alert_id: string;
  symbol: string;
  type: string;
  severity: string;
  score: number;
  status: string;
  headline: string;
  description: string;
  evidence: unknown;
  relatedSymbols: string[];
  detectedAt: string;
  detected_at: string;
}

// The engine types severity as 'low' | 'medium' | 'high' | 'severe'
// (src/lib/manipulation-engine/types/index.ts), and that string is
// what lands in q365_manipulation_events.severity. The UI, however,
// inherits the legacy 'critical' | 'warning' | 'info' vocabulary
// and its summary cards, severity chip, and filter dropdown only
// react to those three values. Normalize on the way out so the UI
// keeps working against the engine-written data.
function toLegacySeverity(s: string | null | undefined): 'critical' | 'warning' | 'info' {
  const v = String(s ?? '').toLowerCase();
  if (v === 'severe' || v === 'high' || v === 'critical') return 'critical';
  if (v === 'medium' || v === 'warning') return 'warning';
  return 'info';
}

// Inverse map for the severity filter: the UI posts 'critical' /
// 'warning' / 'info' but the DB stores the engine's vocabulary, so
// expand to the matching engine values.
function engineSeveritiesFor(legacy: string): string[] {
  const v = legacy.toLowerCase();
  if (v === 'critical') return ['severe', 'high', 'critical'];
  if (v === 'warning')  return ['medium', 'warning'];
  if (v === 'info')     return ['low', 'info'];
  return [legacy]; // pass-through for anything else
}

function eventRowToLegacyAlert(r: any): LegacyAlert {
  const evidence =
    typeof r.evidence_json === 'string'
      ? safeParse(r.evidence_json) ?? {}
      : r.evidence_json ?? {};
  const detectedAt =
    typeof r.event_date === 'string'
      ? r.event_date
      : new Date(r.event_date).toISOString().split('T')[0];
  const type = String(r.event_type ?? 'unknown');
  const severity = toLegacySeverity(r.severity);
  return {
    alertId: String(r.id),
    alert_id: String(r.id),
    symbol: r.symbol,
    type,
    severity,
    score: Math.round(Number(r.score) * 100) / 100,
    status: String(r.status ?? 'new'),
    headline: `${titleCase(type)} on ${r.symbol}`,
    description:
      (evidence && typeof evidence === 'object' && 'reason' in (evidence as any)
        ? String((evidence as any).reason)
        : `${severity} ${titleCase(type)} signal detected`),
    evidence,
    relatedSymbols: [],
    detectedAt,
    detected_at: detectedAt,
  };
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function titleCase(s: string): string {
  return s
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(' ');
}

// ── Freshness + risk policy ───────────────────────────────────
//
// All four "is the manipulation surface live?" questions answered in
// one envelope so every UI/API surface treats stale data identically.
// Authoritative truth:
//   latestEventDate  = most recent triggered detector row
//   latestSnapshotAt = most recent successful scan persistence
//   latestCandleDate = most recent EOD candle (the data we'd scan against)
//   latestTradingDate = best-effort "today's expected trading date" — we
//     use latestCandleDate as a proxy since we don't have an exchange
//     calendar here. If the candle pipeline is also stale, daysLag
//     understates and the freshness still flips to STALE correctly.
//
// FRESH:    latestEventDate is within FRESH_DAYS_THRESHOLD of latestCandleDate
// STALE:    gap exceeds FRESH_DAYS_THRESHOLD
// NO_DATA:  no events at all
// PARTIAL:  events exist but no snapshot row in the same window (scan
//           never wrote a snapshot for the latest event, so detector
//           breakdown is missing)
const FRESH_DAYS_THRESHOLD = 3;

export type FreshnessStatus = 'FRESH' | 'STALE' | 'NO_DATA' | 'PARTIAL';

export interface FreshnessEnvelope {
  latestEventDate:   string | null;
  latestCandleDate:  string | null;
  latestScanAt:      string | null;
  latestTradingDate: string | null;
  isStale:           boolean;
  daysLag:           number | null;
  status:            FreshnessStatus;
  reason:            string;
}

function toIsoDate(v: unknown): string | null {
  if (!v) return null;
  if (typeof v === 'string') return v.split('T')[0];
  if (v instanceof Date) return v.toISOString().split('T')[0];
  return null;
}

function toIsoDateTime(v: unknown): string | null {
  if (!v) return null;
  if (typeof v === 'string') return v.includes('T') ? v : new Date(v).toISOString();
  if (v instanceof Date) return v.toISOString();
  return null;
}

function dayDiff(a: string | null, b: string | null): number | null {
  if (!a || !b) return null;
  const da = new Date(`${a}T00:00:00Z`).getTime();
  const db = new Date(`${b}T00:00:00Z`).getTime();
  if (!Number.isFinite(da) || !Number.isFinite(db)) return null;
  return Math.round((db - da) / 86_400_000);
}

async function computeFreshness(): Promise<FreshnessEnvelope> {
  let latestEventDate:  string | null = null;
  let latestCandleDate: string | null = null;
  let latestScanAt:     string | null = null;
  let snapshotCount30d = 0;

  try {
    const { rows } = await db.query<{ d: string | Date | null }>(
      `SELECT MAX(event_date) AS d FROM q365_manipulation_events`,
    );
    latestEventDate = toIsoDate(rows?.[0]?.d ?? null);
  } catch (err) {
    console.error('[manipulation freshness] events MAX(event_date) failed:', err);
  }

  try {
    const { rows } = await db.query<{ d: string | Date | null; n: number }>(
      `SELECT MAX(created_at) AS d, COUNT(*) AS n
         FROM q365_manipulation_snapshots
        WHERE snapshot_date >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)`,
    );
    latestScanAt = toIsoDateTime(rows?.[0]?.d ?? null);
    snapshotCount30d = Number(rows?.[0]?.n ?? 0);
  } catch (err) {
    console.error('[manipulation freshness] snapshots MAX(created_at) failed:', err);
  }

  try {
    // Same candles table used by the engine's loadDailyBars helper —
    // see src/lib/manipulation-engine/data/candleLoader.ts.
    const { rows } = await db.query<{ d: string | Date | null }>(
      `SELECT MAX(ts) AS d FROM candles
        WHERE candle_type = 'eod' AND interval_unit = '1day'`,
    );
    latestCandleDate = toIsoDate(rows?.[0]?.d ?? null);
  } catch (err) {
    console.error('[manipulation freshness] candles MAX(ts) failed:', err);
  }

  const latestTradingDate = latestCandleDate;
  const refDate = latestCandleDate ?? toIsoDate(new Date());
  const daysLag = dayDiff(latestEventDate, refDate);

  let status: FreshnessStatus;
  let reason: string;

  if (!latestEventDate) {
    status = 'NO_DATA';
    reason = 'No manipulation events have been recorded. Run a scan to populate the surveillance surface.';
  } else if (daysLag != null && daysLag > FRESH_DAYS_THRESHOLD) {
    status = 'STALE';
    reason = `No fresh manipulation scan or candle data after ${latestEventDate}. ` +
             `Latest events are ${daysLag} day(s) behind latest candle date.`;
  } else if (snapshotCount30d === 0) {
    // Events exist within the freshness window but no snapshot row was
    // persisted — the detector breakdown / band is unknown. Treat as
    // partial so the UI can still show alerts but warn that the symbol
    // risk view is incomplete.
    status = 'PARTIAL';
    reason = 'Manipulation events exist but no snapshot persisted in the last 30 days. ' +
             'Symbol-level risk view may be incomplete.';
  } else {
    status = 'FRESH';
    reason = `Latest event ${latestEventDate}, lag ${daysLag ?? 0} day(s) — within ${FRESH_DAYS_THRESHOLD}-day freshness window.`;
  }

  return {
    latestEventDate,
    latestCandleDate,
    latestScanAt,
    latestTradingDate,
    isStale: status === 'STALE',
    daysLag,
    status,
    reason,
  };
}

// ── Risk band + recommended action policy ─────────────────────
//
// Maps the engine's lower-case suspicion bands onto the UI vocabulary
// described in Part 4/7 of the spec. Stale data caps the action at
// WARNING_ONLY no matter how severe the band — fresh data is required
// before the manipulation surface can penalize or block a signal.

export type RiskBand = 'LOW' | 'WATCH' | 'ELEVATED' | 'HIGH' | 'SEVERE' | 'UNKNOWN';
export type RecommendedAction =
  | 'NO_IMPACT' | 'WARNING_ONLY' | 'PENALIZE' | 'RISK_RESTRICT' | 'BLOCK_APPROVAL';

function scoreToRiskBand(score: number | null | undefined): RiskBand {
  if (score == null || !Number.isFinite(score)) return 'UNKNOWN';
  if (score >= 85) return 'SEVERE';
  if (score >= 70) return 'HIGH';
  if (score >= 50) return 'ELEVATED';
  if (score >= 25) return 'WATCH';
  return 'LOW';
}

function recommendedActionFor(
  band: RiskBand,
  freshness: FreshnessStatus,
): RecommendedAction {
  // Stale, no-data, or partial freshness can only warn. Hard-restricting
  // signals based on stale manipulation data is explicitly forbidden by
  // Part 15 of the spec — see the safety rules.
  if (freshness !== 'FRESH') {
    return band === 'LOW' || band === 'UNKNOWN' ? 'NO_IMPACT' : 'WARNING_ONLY';
  }
  switch (band) {
    case 'SEVERE':   return 'BLOCK_APPROVAL';
    case 'HIGH':     return 'RISK_RESTRICT';
    case 'ELEVATED': return 'PENALIZE';
    case 'WATCH':    return 'WARNING_ONLY';
    case 'LOW':
    case 'UNKNOWN':
    default:         return 'NO_IMPACT';
  }
}

function canAffectSignalEngine(band: RiskBand, freshness: FreshnessStatus): boolean {
  return freshness === 'FRESH' && (band === 'ELEVATED' || band === 'HIGH' || band === 'SEVERE');
}

// ── POST: batch scan ──────────────────────────────────────────

export async function POST(req: NextRequest) {
  // Auth gate. POST runs a sequential scan over `symbols` (default: full
  // Phase-1 universe, ~3000 symbols, multi-minute CPU). Without this the
  // endpoint was an unauthenticated DoS vector — anyone could fire it
  // repeatedly and pin the Node process.
  try { await requireSession(); }
  catch { return NextResponse.json({ error: 'Unauthorized' }, { status: 401 }); }

  try {
    await ensureManipulationEngineTables();
    const body = await req.json().catch(() => ({}));
    let symbols: string[] =
      Array.isArray(body.symbols) && body.symbols.length > 0
        ? body.symbols
        : (DEFAULT_PHASE1_CONFIG.universe as readonly string[]).slice();
    if (symbols.length > MAX_SCAN_SYMBOLS) {
      symbols = symbols.slice(0, MAX_SCAN_SYMBOLS);
    }
    const lookbackDays = Number(body.lookbackDays ?? 60);
    const minScore = Number(body.minScore ?? 40);

    const startMs = Date.now();
    let scannedSymbols = 0;
    let eventsPersisted = 0;
    const scanDate = new Date().toISOString();

    // Iterate symbols sequentially. Each iteration is small (DB read
    // + ~13 pure detector calls + DB write), so concurrency gains are
    // modest and risk data-races on the UNIQUE (symbol, snapshot_date)
    // key. Sequential is fine for the nightly-scan use case.
    for (const symbol of symbols) {
      try {
        const bars = await loadDailyBars(symbol, { lookback: lookbackDays });
        if (bars.length < 22) continue;

        const snapshot = scanSymbol(symbol, bars, { symbol });
        if (!snapshot) continue;

        scannedSymbols++;
        if (snapshot.manipulationScore < minScore) continue;

        await saveSnapshot(snapshot);
        // Count only genuinely-triggered events so the response
        // number matches what appears in the alerts list.
        eventsPersisted += snapshot.triggeredEvents.filter((e) => e.triggered).length;
      } catch (err) {
        console.error(`[ManipulationScan] ${symbol}:`, err);
      }
    }

    const scanDuration = Date.now() - startMs;
    console.log(
      `[ManipulationScan] ${scannedSymbols}/${symbols.length} symbols, ${eventsPersisted} events in ${scanDuration}ms`,
    );

    // Load the top events from this scan window for the response
    // envelope. Uses the same shape as the old scanForManipulation
    // so the UI's POST handler keeps working.
    const { rows: topRows } = await db.query<any>(
      `SELECT id, symbol, event_type, severity, score, status, event_date, evidence_json
         FROM q365_manipulation_events
        WHERE created_at >= FROM_UNIXTIME(?)
        ORDER BY score DESC
        LIMIT 50`,
      [Math.floor(startMs / 1000)],
    );

    return NextResponse.json({
      scannedSymbols,
      alertsGenerated: eventsPersisted,
      alerts: (topRows ?? []).map(eventRowToLegacyAlert),
      scanDuration,
      scanDate,
      engine: {
        path: 'manipulation-engine',
        // Presence of this field is the unit test for "split-brain removed"
        module: 'src/lib/manipulation-engine',
      },
    });
  } catch (err) {
    console.error('[API manipulation] Scan error:', err);
    return NextResponse.json(
      { error: 'Scan failed', details: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}

// ── GET: summary / alerts / ?symbol=XYZ alias ─────────────────

export async function GET(req: NextRequest) {
  try {
    // ensureManipulationEngineTables is cached behind a `_migrated` flag,
    // so this is a no-op after the first successful call. Failures used
    // to bubble up as a 500 here even though most callers (the dashboard
    // summary card) just want "show 0s if the table isn't ready yet".
    // Catch + log so a transient migration hiccup can't break the whole
    // dashboard summary.
    try {
      await ensureManipulationEngineTables();
    } catch (mErr) {
      console.error('[API manipulation] migration check failed (continuing):', mErr);
    }

    const { searchParams } = req.nextUrl;
    const action = searchParams.get('action');
    const symbol = searchParams.get('symbol');

    // Phase 1 §5 — query-string alias for /api/manipulation/:symbol.
    // When ?symbol= is present without an explicit ?action=, return
    // the single-symbol deep dive (score + band + top events).
    if (symbol && !action) {
      return await handleSymbolLookup(symbol, searchParams.get('asOf') ?? undefined);
    }

    // Default action is summary — matches the legacy route.
    const effectiveAction = action ?? 'summary';

    if (effectiveAction === 'summary') {
      // buildSummary now degrades to an empty envelope on any per-query
      // failure rather than throwing — see implementation below.
      return NextResponse.json(await buildSummary());
    }

    if (effectiveAction === 'alerts') {
      // page/pageSize are the new pagination contract. `limit` is kept
      // as a legacy alias so the old UI (and the surveillance page that
      // still uses it) keep working.
      const pageSize = clampInt(searchParams.get('pageSize') ?? searchParams.get('limit') ?? '25', 1, 500, 25);
      const page     = clampInt(searchParams.get('page') ?? '1', 1, 10_000, 1);
      return NextResponse.json(
        await buildAlertList({
          type: searchParams.get('type') ?? undefined,
          severity: searchParams.get('severity') ?? undefined,
          status: searchParams.get('status') ?? undefined,
          symbol: symbol ?? undefined,
          actionRequired: searchParams.get('actionRequired') === '1',
          includeAcknowledged: searchParams.get('includeAcknowledged') === '1',
          page, pageSize,
        }),
      );
    }

    if (effectiveAction === 'patterns') {
      return NextResponse.json(await buildPatternList());
    }

    if (effectiveAction === 'symbols') {
      const pageSize = clampInt(searchParams.get('pageSize') ?? '25', 1, 200, 25);
      const page     = clampInt(searchParams.get('page') ?? '1', 1, 10_000, 1);
      return NextResponse.json(
        await buildSymbolRiskList({
          riskBand: searchParams.get('riskBand') ?? undefined,
          page, pageSize,
        }),
      );
    }

    if (effectiveAction === 'runs') {
      return NextResponse.json(await buildRunList());
    }

    if (effectiveAction === 'health') {
      return NextResponse.json(await buildHealth());
    }

    return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
  } catch (err) {
    // Log the full error before swallowing it into an opaque 500. The
    // previous version returned 500 without printing the cause, so a
    // 19s timeout in production showed up as "500 in 19271ms" with no
    // indication of which query failed.
    console.error('[API manipulation GET] uncaught:', err);
    return NextResponse.json(
      {
        error: 'Failed',
        details: err instanceof Error ? err.message : String(err),
      },
      { status: 500 },
    );
  }
}

// ── PATCH: mutate event triage status ─────────────────────────

export async function PATCH(req: NextRequest) {
  try {
    await ensureManipulationEngineTables();
    const body = await req.json();
    if (!body.alertId || !body.status) {
      return NextResponse.json(
        { error: 'alertId and status required' },
        { status: 400 },
      );
    }

    // The UI sends alertId as a string but in the engine schema the
    // event primary key is numeric. Parse defensively — reject
    // anything that isn't a positive integer.
    const numericId = parseInt(String(body.alertId), 10);
    if (!Number.isFinite(numericId) || numericId <= 0) {
      return NextResponse.json(
        { error: `Invalid alertId: ${body.alertId}` },
        { status: 400 },
      );
    }

    // Whitelist statuses so a caller can't write arbitrary text into
    // the column. Mirrors the old AlertStatus union.
    const allowed = new Set([
      'new',
      'acknowledged',
      'investigating',
      'resolved',
      'false_positive',
      'dismissed',
    ]);
    if (!allowed.has(String(body.status))) {
      return NextResponse.json(
        { error: `Invalid status: ${body.status}` },
        { status: 400 },
      );
    }

    const result: any = await db.query(
      `UPDATE q365_manipulation_events SET status = ? WHERE id = ?`,
      [body.status, numericId],
    );
    if ((result.affectedRows ?? 0) === 0) {
      return NextResponse.json({ error: 'Alert not found' }, { status: 404 });
    }
    return NextResponse.json({ success: true, id: numericId, status: body.status });
  } catch (err) {
    return NextResponse.json(
      {
        error: 'Update failed',
        details: err instanceof Error ? err.message : String(err),
      },
      { status: 500 },
    );
  }
}

// ── Helpers ───────────────────────────────────────────────────

function clampInt(raw: string, min: number, max: number, fallback: number): number {
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

async function buildSummary(): Promise<{
  totalAlerts: number;
  byType: Record<string, number>;
  bySeverity: Record<string, number>;
  topAlerts: LegacyAlert[];
  recentTrend: 'increasing' | 'decreasing' | 'stable';
  freshness: FreshnessEnvelope;
  signalEngineImpactMode: 'ACTIVE' | 'WARNING_ONLY';
}> {
  // Each query is independent. We catch + log per query so a single
  // slow / failing query (e.g. table missing on a fresh DB, or a
  // missing index on a large events table) cannot blow up the whole
  // dashboard summary card. Empty defaults are returned in place of
  // whatever section failed.
  //
  // Previous behaviour: any one query throwing → 500 in ~19s with no
  // server-side log line, leaving operators guessing which query was
  // the culprit.

  // Pre-seed the three buckets the UI cards read so they render as 0
  // rather than undefined even before the first scan.
  const byType: Record<string, number> = {};
  const bySeverity: Record<string, number> = { critical: 0, warning: 0, info: 0 };
  let total = 0;
  let topAlerts: LegacyAlert[] = [];
  let recentTrend: 'increasing' | 'decreasing' | 'stable' = 'stable';

  // Counts by type + severity in the last 30 days.
  try {
    const { rows: countRows } = await db.query<{
      event_type: string;
      severity: string;
      cnt: number;
    }>(
      `SELECT event_type, severity, COUNT(*) AS cnt
         FROM q365_manipulation_events
        WHERE event_date >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)
        GROUP BY event_type, severity`,
    );
    for (const r of countRows) {
      const cnt = Number(r.cnt);
      byType[r.event_type] = (byType[r.event_type] ?? 0) + cnt;
      const legacySev = toLegacySeverity(r.severity);
      bySeverity[legacySev] = (bySeverity[legacySev] ?? 0) + cnt;
      total += cnt;
    }
  } catch (err) {
    console.error('[API manipulation buildSummary] counts query failed:', err);
  }

  // Trend: last 7 days vs previous 7 days.
  try {
    const { rows: trendRows } = await db.query<{ recent: number; prior: number }>(
      `SELECT
         SUM(CASE WHEN event_date >= DATE_SUB(CURDATE(), INTERVAL 7 DAY) THEN 1 ELSE 0 END) AS recent,
         SUM(CASE WHEN event_date BETWEEN DATE_SUB(CURDATE(), INTERVAL 14 DAY)
                                     AND DATE_SUB(CURDATE(), INTERVAL 7 DAY) THEN 1 ELSE 0 END) AS prior
         FROM q365_manipulation_events
        WHERE event_date >= DATE_SUB(CURDATE(), INTERVAL 14 DAY)`,
    );
    const recent = Number(trendRows[0]?.recent ?? 0);
    const prior = Number(trendRows[0]?.prior ?? 0);
    recentTrend =
      recent > prior * 1.3 ? 'increasing' : recent < prior * 0.7 ? 'decreasing' : 'stable';
  } catch (err) {
    console.error('[API manipulation buildSummary] trend query failed:', err);
  }

  // Top 10 most recent events for the dashboard sidebar.
  // NOTE: the `ORDER BY event_date DESC, score DESC LIMIT 10` here has
  // no covering index — only `idx_qme_date` on (event_date) exists.
  // On a large events table this can be slow; if you see this query
  // dominating latency, add `INDEX idx_qme_date_score (event_date, score)`.
  try {
    const { rows: topRows } = await db.query<any>(
      `SELECT id, symbol, event_type, severity, score, status, event_date, evidence_json
         FROM q365_manipulation_events
        ORDER BY event_date DESC, score DESC
        LIMIT 10`,
    );
    topAlerts = (topRows ?? []).map(eventRowToLegacyAlert);
  } catch (err) {
    console.error('[API manipulation buildSummary] topAlerts query failed:', err);
  }

  // Freshness is computed last because it shares the same DB connection
  // pool and we want the summary's primary counts to land even if one
  // freshness probe stalls (e.g. INFORMATION_SCHEMA stall).
  const freshness = await computeFreshness().catch((err) => {
    console.error('[API manipulation buildSummary] freshness failed:', err);
    return {
      latestEventDate: null, latestCandleDate: null, latestScanAt: null, latestTradingDate: null,
      isStale: false, daysLag: null, status: 'NO_DATA' as FreshnessStatus,
      reason: 'Freshness probe failed; treating as no-data for safety.',
    };
  });

  return {
    totalAlerts: total,
    byType,
    bySeverity,
    topAlerts,
    recentTrend,
    freshness,
    // Stale data must never block signal approval. The UI reads this
    // flag to decide whether to show a "hard rejection disabled" banner.
    signalEngineImpactMode: freshness.status === 'FRESH' ? 'ACTIVE' : 'WARNING_ONLY',
  };
}

async function buildAlertList(filters: {
  type?: string;
  severity?: string;
  status?: string;
  symbol?: string;
  actionRequired?: boolean;
  includeAcknowledged?: boolean;
  page: number;
  pageSize: number;
}): Promise<{
  alerts:      LegacyAlert[];
  total:       number;
  page:        number;
  pageSize:    number;
  totalPages:  number;
  hasNext:     boolean;
  hasPrevious: boolean;
  freshness:   FreshnessEnvelope;
}> {
  const where: string[] = [];
  const args: unknown[] = [];
  if (filters.type) {
    where.push('event_type = ?');
    args.push(filters.type);
  }
  if (filters.severity) {
    // Expand the UI's legacy severity ('critical'/'warning'/'info')
    // into the engine's vocabulary stored in the DB. A single UI
    // value may match multiple engine rows (e.g. 'critical' covers
    // both 'severe' and 'high').
    const expanded = engineSeveritiesFor(filters.severity);
    where.push(`severity IN (${expanded.map(() => '?').join(',')})`);
    args.push(...expanded);
  }
  if (filters.status) {
    where.push('status = ?');
    args.push(filters.status);
  } else if (!filters.includeAcknowledged) {
    // Hide acknowledged / resolved / dismissed by default so the "live
    // surveillance" view is not polluted with already-triaged rows.
    where.push(`status NOT IN ('acknowledged','resolved','dismissed','false_positive')`);
  }
  if (filters.symbol) {
    where.push('symbol = ?');
    args.push(filters.symbol);
  }
  if (filters.actionRequired) {
    // "Action required" view = critical/severe band, still new.
    where.push(`severity IN ('severe','high','critical')`);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  // Count first so the UI can render proper pagination chrome (total +
  // hasNext) instead of a flat "next" button that may overshoot.
  let total = 0;
  try {
    const { rows: countRows } = await db.query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM q365_manipulation_events ${whereSql}`,
      args,
    );
    total = Number(countRows?.[0]?.n ?? 0);
  } catch (err) {
    console.error('[API manipulation buildAlertList] count failed:', err);
  }

  const pageSize = Math.min(Math.max(filters.pageSize || 25, 1), 500);
  const page     = Math.max(filters.page || 1, 1);
  const offset   = (page - 1) * pageSize;

  let rows: any[] = [];
  try {
    const result = await db.query<any>(
      `SELECT id, symbol, event_type, severity, score, status, event_date, evidence_json
         FROM q365_manipulation_events
         ${whereSql}
         ORDER BY event_date DESC, score DESC
         LIMIT ? OFFSET ?`,
      [...args, pageSize, offset],
    );
    rows = result.rows ?? [];
  } catch (err) {
    console.error('[API manipulation buildAlertList] page query failed:', err);
  }

  const alerts     = rows.map(eventRowToLegacyAlert);
  const totalPages = pageSize > 0 ? Math.ceil(total / pageSize) : 1;

  // Freshness travels with every list response so the UI can flip into
  // read-only mode on any tab — not only the Overview card.
  const freshness = await computeFreshness().catch(() => ({
    latestEventDate: null, latestCandleDate: null, latestScanAt: null, latestTradingDate: null,
    isStale: false, daysLag: null, status: 'NO_DATA' as FreshnessStatus,
    reason: 'Freshness probe failed.',
  }));

  return {
    alerts, total, page, pageSize, totalPages,
    hasNext: page < totalPages,
    hasPrevious: page > 1,
    freshness,
  };
}

// ── Part 3 — alerts grouped by pattern (event_type) ───────────
async function buildPatternList(): Promise<{
  patterns: Array<{
    pattern:           string;
    label:             string;
    alertCount:        number;
    criticalCount:     number;
    avgScore:          number;
    latestEventDate:   string | null;
    topSymbols:        string[];
    freshnessStatus:   FreshnessStatus;
  }>;
  totalPatterns: number;
  freshness:     FreshnessEnvelope;
}> {
  const freshness = await computeFreshness().catch(() => ({
    latestEventDate: null, latestCandleDate: null, latestScanAt: null, latestTradingDate: null,
    isStale: false, daysLag: null, status: 'NO_DATA' as FreshnessStatus,
    reason: 'Freshness probe failed.',
  }));

  let aggregates: any[] = [];
  try {
    const { rows } = await db.query<any>(
      `SELECT event_type,
              COUNT(*)                                         AS alert_count,
              SUM(CASE WHEN severity IN ('severe','high','critical') THEN 1 ELSE 0 END) AS critical_count,
              ROUND(AVG(score), 2)                             AS avg_score,
              MAX(event_date)                                  AS latest_event_date
         FROM q365_manipulation_events
        GROUP BY event_type
        ORDER BY alert_count DESC`,
    );
    aggregates = rows ?? [];
  } catch (err) {
    console.error('[API manipulation buildPatternList] aggregate failed:', err);
  }

  // Pull top-5 affected symbols per pattern in a single query, then
  // bucket client-side. Faster than N+1 queries per pattern.
  const topSymbolsByPattern: Record<string, string[]> = {};
  try {
    const { rows } = await db.query<any>(
      `SELECT event_type, symbol, COUNT(*) AS n
         FROM q365_manipulation_events
        GROUP BY event_type, symbol
        ORDER BY event_type, n DESC`,
    );
    for (const r of rows ?? []) {
      const t = String(r.event_type);
      if (!topSymbolsByPattern[t]) topSymbolsByPattern[t] = [];
      if (topSymbolsByPattern[t].length < 5) topSymbolsByPattern[t].push(String(r.symbol));
    }
  } catch (err) {
    console.error('[API manipulation buildPatternList] top symbols failed:', err);
  }

  const patterns = aggregates.map((r) => ({
    pattern:         String(r.event_type),
    label:           titleCase(String(r.event_type)),
    alertCount:      Number(r.alert_count ?? 0),
    criticalCount:   Number(r.critical_count ?? 0),
    avgScore:        Number(r.avg_score ?? 0),
    latestEventDate: toIsoDate(r.latest_event_date),
    topSymbols:      topSymbolsByPattern[String(r.event_type)] ?? [],
    // A pattern is only fresh if both the overall surface is fresh AND
    // this pattern has an event in the freshness window — otherwise the
    // card represents historical aggregation only.
    freshnessStatus:
      freshness.status === 'FRESH' &&
      r.latest_event_date != null &&
      (dayDiff(toIsoDate(r.latest_event_date), freshness.latestCandleDate) ?? Infinity) <= FRESH_DAYS_THRESHOLD
        ? 'FRESH' : freshness.status,
  }));

  return { patterns, totalPatterns: patterns.length, freshness };
}

// ── Part 4 — symbol-level risk view (computed dynamically) ────
async function buildSymbolRiskList(filters: {
  riskBand?: string;
  page:      number;
  pageSize:  number;
}): Promise<{
  symbols:   Array<{
    symbol:                 string;
    manipulationScore:      number;
    riskBand:               RiskBand;
    alertCount:             number;
    patternCount:           number;
    latestEventDate:        string | null;
    latestScanAt:           string | null;
    freshnessStatus:        FreshnessStatus;
    dominantPatterns:       string[];
    recommendedAction:      RecommendedAction;
    canAffectSignalEngine:  boolean;
  }>;
  total:       number;
  page:        number;
  pageSize:    number;
  totalPages:  number;
  hasNext:     boolean;
  hasPrevious: boolean;
  freshness:   FreshnessEnvelope;
}> {
  const freshness = await computeFreshness().catch(() => ({
    latestEventDate: null, latestCandleDate: null, latestScanAt: null, latestTradingDate: null,
    isStale: false, daysLag: null, status: 'NO_DATA' as FreshnessStatus,
    reason: 'Freshness probe failed.',
  }));

  // Pull latest snapshot per symbol (authoritative score + band) joined
  // with event aggregates. Snapshots use UNIQUE (symbol, snapshot_date)
  // so we just take the row with the max snapshot_date per symbol.
  let snapshotRows: any[] = [];
  try {
    const { rows } = await db.query<any>(
      `SELECT s.symbol,
              s.snapshot_date,
              s.manipulation_score,
              s.suspicion_band,
              s.created_at AS scan_at
         FROM q365_manipulation_snapshots s
         JOIN (
                SELECT symbol, MAX(snapshot_date) AS d
                  FROM q365_manipulation_snapshots
                 GROUP BY symbol
              ) latest
           ON latest.symbol = s.symbol AND latest.d = s.snapshot_date`,
    );
    snapshotRows = rows ?? [];
  } catch (err) {
    console.error('[API manipulation buildSymbolRiskList] snapshots failed:', err);
  }

  let eventRows: any[] = [];
  try {
    const { rows } = await db.query<any>(
      `SELECT symbol,
              COUNT(*)                  AS alert_count,
              COUNT(DISTINCT event_type) AS pattern_count,
              MAX(event_date)           AS latest_event_date,
              GROUP_CONCAT(DISTINCT event_type ORDER BY event_type) AS patterns
         FROM q365_manipulation_events
        GROUP BY symbol`,
    );
    eventRows = rows ?? [];
  } catch (err) {
    console.error('[API manipulation buildSymbolRiskList] event aggregates failed:', err);
  }

  const eventBySymbol = new Map<string, any>();
  for (const r of eventRows) eventBySymbol.set(String(r.symbol), r);

  const merged = snapshotRows.map((s) => {
    const e = eventBySymbol.get(String(s.symbol));
    const score = Number(s.manipulation_score ?? 0);
    const band = scoreToRiskBand(score);

    // Per-symbol freshness: a symbol can be stale even when the global
    // surface is fresh, if its specific events are old. Compare its
    // latest event date against the latest candle date.
    const symbolLatestEventDate = toIsoDate(e?.latest_event_date ?? null);
    const lag = dayDiff(symbolLatestEventDate, freshness.latestCandleDate);
    const symbolFreshness: FreshnessStatus =
      !symbolLatestEventDate ? 'NO_DATA'
      : lag != null && lag > FRESH_DAYS_THRESHOLD ? 'STALE'
      : freshness.status === 'PARTIAL' ? 'PARTIAL'
      : 'FRESH';

    const patterns = String(e?.patterns ?? '').split(',').filter(Boolean).slice(0, 5);

    return {
      symbol:                String(s.symbol),
      manipulationScore:     Math.round(score * 100) / 100,
      riskBand:              band,
      alertCount:            Number(e?.alert_count ?? 0),
      patternCount:          Number(e?.pattern_count ?? 0),
      latestEventDate:       symbolLatestEventDate,
      latestScanAt:          toIsoDateTime(s.scan_at),
      freshnessStatus:       symbolFreshness,
      dominantPatterns:      patterns,
      recommendedAction:     recommendedActionFor(band, symbolFreshness),
      canAffectSignalEngine: canAffectSignalEngine(band, symbolFreshness),
    };
  });

  // Filter
  const filtered = filters.riskBand
    ? merged.filter((m) => m.riskBand === filters.riskBand!.toUpperCase())
    : merged;

  // Sort: severe → high → elevated → watch → low → unknown; within band by score desc.
  const bandOrder: Record<RiskBand, number> = {
    SEVERE: 0, HIGH: 1, ELEVATED: 2, WATCH: 3, LOW: 4, UNKNOWN: 5,
  };
  filtered.sort((a, b) => {
    const d = bandOrder[a.riskBand] - bandOrder[b.riskBand];
    return d !== 0 ? d : b.manipulationScore - a.manipulationScore;
  });

  const total      = filtered.length;
  const pageSize   = Math.min(Math.max(filters.pageSize || 25, 1), 200);
  const page       = Math.max(filters.page || 1, 1);
  const totalPages = pageSize > 0 ? Math.ceil(total / pageSize) : 1;
  const offset     = (page - 1) * pageSize;
  const symbols    = filtered.slice(offset, offset + pageSize);

  return {
    symbols, total, page, pageSize, totalPages,
    hasNext: page < totalPages,
    hasPrevious: page > 1,
    freshness,
  };
}

// ── Part 13 — scan runs (derived from snapshot writes per day) ─
async function buildRunList(): Promise<{
  runs: Array<{
    scanDate:        string;
    symbolsScanned:  number;
    eventsGenerated: number;
    avgScore:        number;
    severeCount:     number;
  }>;
  freshness: FreshnessEnvelope;
}> {
  const freshness = await computeFreshness().catch(() => ({
    latestEventDate: null, latestCandleDate: null, latestScanAt: null, latestTradingDate: null,
    isStale: false, daysLag: null, status: 'NO_DATA' as FreshnessStatus,
    reason: 'Freshness probe failed.',
  }));

  let runs: any[] = [];
  try {
    const { rows } = await db.query<any>(
      `SELECT DATE(created_at)             AS scan_date,
              COUNT(DISTINCT symbol)        AS symbols_scanned,
              ROUND(AVG(manipulation_score), 2) AS avg_score,
              SUM(CASE WHEN suspicion_band = 'severe' THEN 1 ELSE 0 END) AS severe_count
         FROM q365_manipulation_snapshots
        GROUP BY DATE(created_at)
        ORDER BY scan_date DESC
        LIMIT 60`,
    );
    runs = rows ?? [];
  } catch (err) {
    console.error('[API manipulation buildRunList] snapshots aggregate failed:', err);
  }

  // Events-per-day for the same window so the UI can show triggered-events
  // alongside scanned-symbols.
  const eventCountByDate = new Map<string, number>();
  try {
    const { rows } = await db.query<any>(
      `SELECT DATE(created_at) AS d, COUNT(*) AS n
         FROM q365_manipulation_events
        GROUP BY DATE(created_at)
        ORDER BY d DESC
        LIMIT 60`,
    );
    for (const r of rows ?? []) eventCountByDate.set(toIsoDate(r.d) ?? '', Number(r.n ?? 0));
  } catch (err) {
    console.error('[API manipulation buildRunList] events aggregate failed:', err);
  }

  return {
    runs: runs.map((r) => {
      const dt = toIsoDate(r.scan_date) ?? '';
      return {
        scanDate:        dt,
        symbolsScanned:  Number(r.symbols_scanned ?? 0),
        eventsGenerated: eventCountByDate.get(dt) ?? 0,
        avgScore:        Number(r.avg_score ?? 0),
        severeCount:     Number(r.severe_count ?? 0),
      };
    }),
    freshness,
  };
}

// ── Part 11 + Part 14 — health & engine status envelope ───────
interface EodIngestionHealthRow {
  provider:           string;
  status:             string;
  symbolsRequested:   number;
  symbolsReturned:    number;
  coveragePercent:    number;
  dataQuality:        string | null;
  errorMessage:       string | null;
  requestStartedAt:   string | null;
  responseReceivedAt: string | null;
  latencyMs:          number | null;
}

async function buildEodIngestionStatus(): Promise<{
  status:   'FRESH' | 'STALE' | 'FAILED' | 'NEVER_RAN';
  message:  string;
  lastRunAt: string | null;
  sources:  EodIngestionHealthRow[];
}> {
  // Pull the most recent q365_data_feed_health row per EOD provider
  // we know about. The pipeline records 'NSE_BHAVCOPY' today; this
  // pattern lets BSE / bulk-deal / ASM rows surface here automatically
  // once their adapters land.
  const EOD_PROVIDERS = [
    'NSE_BHAVCOPY',
    'BSE_BHAVCOPY',
    'NSE_BULK_BLOCK_DEALS',
    'NSE_ASM',
  ];

  const sources: EodIngestionHealthRow[] = [];
  for (const provider of EOD_PROVIDERS) {
    try {
      const { rows } = await db.query<any>(
        `SELECT provider, status, symbols_requested, symbols_returned,
                coverage_percent, data_quality, error_message,
                request_started_at, response_received_at, latency_ms
           FROM q365_data_feed_health
          WHERE provider = ?
          ORDER BY response_received_at DESC
          LIMIT 1`,
        [provider],
      );
      const r = rows?.[0];
      if (!r) continue;
      sources.push({
        provider:           String(r.provider),
        status:             String(r.status ?? 'unknown'),
        symbolsRequested:   Number(r.symbols_requested ?? 0),
        symbolsReturned:    Number(r.symbols_returned ?? 0),
        coveragePercent:    Number(r.coverage_percent ?? 0),
        dataQuality:        r.data_quality ? String(r.data_quality) : null,
        errorMessage:       r.error_message ? String(r.error_message) : null,
        requestStartedAt:   toIsoDateTime(r.request_started_at),
        responseReceivedAt: toIsoDateTime(r.response_received_at),
        latencyMs:          r.latency_ms != null ? Number(r.latency_ms) : null,
      });
    } catch {
      // Table may not exist on a fresh DB — soft-fail per provider.
    }
  }

  // Derive top-level status.
  if (sources.length === 0) {
    return {
      status:    'NEVER_RAN',
      message:   'No EOD ingestion has been recorded. Trigger /api/manipulation/eod-ingest or wait for the 19:30 IST scheduler.',
      lastRunAt: null,
      sources,
    };
  }

  // Pick the most recent run across all sources for the top-level
  // lastRunAt / status fields.
  const newest = sources.reduce((a, b) =>
    (a.responseReceivedAt ?? '') > (b.responseReceivedAt ?? '') ? a : b,
  );
  const lastRunAt = newest.responseReceivedAt;

  // Fresh = NSE bhavcopy success in the last 26 hours (covers a
  // weekend gap + a one-day delay).
  const STALE_MS = 26 * 60 * 60 * 1000;
  const lastRunMs = lastRunAt ? new Date(lastRunAt).getTime() : 0;
  const ageMs = lastRunAt ? Date.now() - lastRunMs : Infinity;

  const lastNse = sources.find((s) => s.provider === 'NSE_BHAVCOPY');
  if (lastNse && lastNse.status === 'success' && ageMs < STALE_MS) {
    return {
      status:    'FRESH',
      message:   `Last NSE bhavcopy ingestion at ${lastNse.responseReceivedAt} returned ${lastNse.symbolsReturned} rows.`,
      lastRunAt,
      sources,
    };
  }
  if (lastNse && lastNse.status === 'success' && ageMs >= STALE_MS) {
    return {
      status:    'STALE',
      message:   `Last successful EOD ingestion was ${Math.round(ageMs / 3600000)}h ago — no fresh trading day data.`,
      lastRunAt,
      sources,
    };
  }
  return {
    status:    'FAILED',
    message:   lastNse?.errorMessage ?? newest.errorMessage ?? 'Last EOD ingestion failed. Inspect q365_data_feed_health for the row.',
    lastRunAt,
    sources,
  };
}

async function buildScannerStatus(): Promise<{
  status:               'FRESH' | 'STALE' | 'NEVER_RAN';
  message:              string;
  lastScanAt:           string | null;
  snapshotsLast24h:     number;
  eventsLast24h:        number;
}> {
  let lastScanAt: string | null = null;
  let snapshotsLast24h = 0;
  let eventsLast24h = 0;

  try {
    const { rows } = await db.query<{ d: string | Date | null }>(
      `SELECT MAX(created_at) AS d FROM q365_manipulation_snapshots`,
    );
    lastScanAt = toIsoDateTime(rows?.[0]?.d ?? null);
  } catch {
    /* swallow */
  }
  try {
    const { rows } = await db.query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM q365_manipulation_snapshots
        WHERE created_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR)`,
    );
    snapshotsLast24h = Number(rows?.[0]?.n ?? 0);
  } catch { /* swallow */ }
  try {
    const { rows } = await db.query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM q365_manipulation_events
        WHERE created_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR)`,
    );
    eventsLast24h = Number(rows?.[0]?.n ?? 0);
  } catch { /* swallow */ }

  if (!lastScanAt) {
    return {
      status:           'NEVER_RAN',
      message:          'No manipulation scan has been persisted. Run the daily-scan endpoint to populate.',
      lastScanAt:       null,
      snapshotsLast24h: 0,
      eventsLast24h:    0,
    };
  }

  const ageMs = Date.now() - new Date(lastScanAt).getTime();
  const STALE_MS = 26 * 60 * 60 * 1000;
  if (ageMs < STALE_MS && snapshotsLast24h > 0) {
    return {
      status:           'FRESH',
      message:          `Last scan ${lastScanAt} produced ${snapshotsLast24h} snapshots / ${eventsLast24h} events.`,
      lastScanAt,
      snapshotsLast24h,
      eventsLast24h,
    };
  }
  return {
    status:           'STALE',
    message:          `Last scan was ${Math.round(ageMs / 3600000)}h ago — no fresh snapshots within the freshness window.`,
    lastScanAt,
    snapshotsLast24h,
    eventsLast24h,
  };
}

async function buildHealth(): Promise<{
  freshness:                     FreshnessEnvelope;
  signalEngineImpactMode:        'ACTIVE' | 'WARNING_ONLY';
  hardRejectionEnabled:          boolean;
  staleWarningOnlyMode:          boolean;
  signalEngineIntegrationActive: boolean;
  warningOnlyMode:               boolean;
  /** EOD candle ingestion freshness — populated by /api/manipulation/eod-ingest runs. */
  eodIngestionStatus:            Awaited<ReturnType<typeof buildEodIngestionStatus>>;
  /** Manipulation scanner run freshness. */
  scannerStatus:                 Awaited<ReturnType<typeof buildScannerStatus>>;
  /** Per-adapter source rows (one per EOD provider) — same shape as eodIngestionStatus.sources. */
  sources:                       EodIngestionHealthRow[];
  /** Best-effort estimated lag in days between latest event and latest candle. */
  lagDays:                       number | null;
  totals: {
    symbolsScanned30d:     number;
    eventsGenerated30d:    number;
    snapshotsPersisted30d: number;
    totalEvents:           number;
    symbolsWithRisk:       number;
    severeRiskSymbols:     number;
    staleRiskSymbols:      number;
  };
  latestEventDate:  string | null;
  latestCandleDate: string | null;
  latestScanAt:     string | null;
  explanation:      string;
}> {
  const freshness = await computeFreshness();

  let symbolsScanned30d = 0;
  let eventsGenerated30d = 0;
  let snapshotsPersisted30d = 0;
  let totalEvents = 0;
  let symbolsWithRisk = 0;
  let severeRiskSymbols = 0;
  let staleRiskSymbols = 0;

  try {
    const { rows } = await db.query<{ n: number }>(
      `SELECT COUNT(DISTINCT symbol) AS n
         FROM q365_manipulation_snapshots
        WHERE snapshot_date >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)`,
    );
    symbolsScanned30d = Number(rows?.[0]?.n ?? 0);
  } catch { /* swallow */ }

  try {
    const { rows } = await db.query<{ n: number }>(
      `SELECT COUNT(*) AS n
         FROM q365_manipulation_events
        WHERE event_date >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)`,
    );
    eventsGenerated30d = Number(rows?.[0]?.n ?? 0);
  } catch { /* swallow */ }

  try {
    const { rows } = await db.query<{ n: number }>(
      `SELECT COUNT(*) AS n
         FROM q365_manipulation_snapshots
        WHERE snapshot_date >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)`,
    );
    snapshotsPersisted30d = Number(rows?.[0]?.n ?? 0);
  } catch { /* swallow */ }

  // Total events lifetime + severe/risk symbol counts from snapshots.
  // Stale per-symbol count is derived from event lag vs latest candle.
  try {
    const { rows } = await db.query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM q365_manipulation_events`,
    );
    totalEvents = Number(rows?.[0]?.n ?? 0);
  } catch { /* swallow */ }

  try {
    const { rows } = await db.query<{ n: number; severe: number }>(
      `SELECT COUNT(*) AS n,
              SUM(CASE WHEN suspicion_band = 'severe' THEN 1 ELSE 0 END) AS severe
         FROM (
                SELECT symbol, MAX(snapshot_date) AS d
                  FROM q365_manipulation_snapshots
                 GROUP BY symbol
              ) latest
         JOIN q365_manipulation_snapshots s
           ON s.symbol = latest.symbol AND s.snapshot_date = latest.d
        WHERE s.suspicion_band IN ('watch','elevated','high','severe')`,
    );
    symbolsWithRisk    = Number(rows?.[0]?.n ?? 0);
    severeRiskSymbols  = Number((rows?.[0] as any)?.severe ?? 0);
  } catch { /* swallow */ }

  try {
    const { rows } = await db.query<{ n: number }>(
      `SELECT COUNT(*) AS n
         FROM (
                SELECT symbol, MAX(event_date) AS d
                  FROM q365_manipulation_events
                 GROUP BY symbol
                HAVING DATEDIFF(?, d) > 3
              ) stale`,
      [freshness.latestCandleDate ?? new Date().toISOString().slice(0, 10)],
    );
    staleRiskSymbols = Number(rows?.[0]?.n ?? 0);
  } catch { /* swallow */ }

  const isFresh = freshness.status === 'FRESH';
  const explanation = isFresh
    ? `Manipulation Engine is fresh. Latest event ${freshness.latestEventDate}; signal-engine penalties active.`
    : `Manipulation Engine is ${freshness.status.toLowerCase()}. Latest event ${freshness.latestEventDate ?? 'never'}. ` +
      `Hard rejection is disabled — Signal Engine will show warning only until a fresh scan runs.`;

  // EOD ingestion + scanner freshness — populated by the new
  // /api/manipulation/eod-ingest and /api/manipulation/daily-scan
  // routes and the 19:30 IST scheduler cron. Each probe is wrapped
  // in its own try/catch so a missing table on a fresh DB collapses
  // to NEVER_RAN rather than 500ing the whole health endpoint.
  const eodIngestionStatus = await buildEodIngestionStatus().catch((err) => {
    console.error('[API manipulation buildHealth] eodIngestionStatus failed:', err);
    return {
      status:    'NEVER_RAN' as const,
      message:   'EOD ingestion status probe failed.',
      lastRunAt: null,
      sources:   [] as EodIngestionHealthRow[],
    };
  });
  const scannerStatus = await buildScannerStatus().catch((err) => {
    console.error('[API manipulation buildHealth] scannerStatus failed:', err);
    return {
      status:           'NEVER_RAN' as const,
      message:          'Scanner status probe failed.',
      lastScanAt:       null,
      snapshotsLast24h: 0,
      eventsLast24h:    0,
    };
  });

  return {
    freshness,
    signalEngineImpactMode:        isFresh ? 'ACTIVE' : 'WARNING_ONLY',
    hardRejectionEnabled:          isFresh,
    staleWarningOnlyMode:         !isFresh,
    // Phase B exposes whether the manipulationRisk envelope is being
    // attached to live signal responses. The /api/signals route fetches
    // it on every call, so integration is active whenever the engine
    // has any data at all (FRESH/STALE/PARTIAL) — only NO_DATA means
    // no envelope can be built.
    signalEngineIntegrationActive: freshness.status !== 'NO_DATA',
    warningOnlyMode:              !isFresh,
    eodIngestionStatus,
    scannerStatus,
    sources:                       eodIngestionStatus.sources,
    lagDays:                       freshness.daysLag,
    totals: {
      symbolsScanned30d, eventsGenerated30d, snapshotsPersisted30d,
      totalEvents, symbolsWithRisk, severeRiskSymbols, staleRiskSymbols,
    },
    latestEventDate:  freshness.latestEventDate,
    latestCandleDate: freshness.latestCandleDate,
    latestScanAt:     freshness.latestScanAt,
    explanation,
  };
}

async function handleSymbolLookup(
  rawSymbol: string,
  asOf: string | undefined,
): Promise<NextResponse> {
  const symbol = decodeURIComponent(rawSymbol).toUpperCase();

  let snapshot = await loadLatestSnapshot(symbol);
  let source: 'persisted' | 'computed' = 'persisted';

  if (!snapshot) {
    const bars = await loadDailyBars(symbol, { asOfDate: asOf, lookback: 60 });
    if (bars.length < 5) {
      return NextResponse.json(
        { error: 'insufficient candle history', symbol, barsLoaded: bars.length },
        { status: 404 },
      );
    }
    snapshot = scanSymbol(symbol, bars, { symbol });
    source = 'computed';
  }
  if (!snapshot) {
    return NextResponse.json({ error: 'no snapshot', symbol }, { status: 404 });
  }

  const hook = buildHookResult(snapshot, symbol);
  const riskLabels =
    snapshot.riskLabels && snapshot.riskLabels.length > 0
      ? snapshot.riskLabels
      : deriveRiskLabels(snapshot.triggeredEvents);

  return NextResponse.json({
    symbol,
    source,
    snapshotDate: snapshot.snapshotDate,
    score: snapshot.manipulationScore,
    band: snapshot.suspicionBand,
    riskLabels,
    warning: hook.warning,
    shouldPenalize: hook.shouldPenalize,
    shouldReject: hook.shouldReject,
    explanation: snapshot.explanation,
    topEvents: snapshot.triggeredEvents
      .filter((e) => e.triggered)
      .slice(0, 5)
      .map((e) => ({
        eventType: e.eventType,
        severity: e.severity,
        confidence: e.confidence,
        label: e.detectorLabel,
      })),
  });
}
