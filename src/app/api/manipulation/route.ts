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

// ── POST: batch scan ──────────────────────────────────────────

export async function POST(req: NextRequest) {
  try {
    await ensureManipulationEngineTables();
    const body = await req.json().catch(() => ({}));
    const symbols: string[] =
      Array.isArray(body.symbols) && body.symbols.length > 0
        ? body.symbols
        : (DEFAULT_PHASE1_CONFIG.universe as readonly string[]).slice();
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
    await ensureManipulationEngineTables();
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
      return NextResponse.json(await buildSummary());
    }

    if (effectiveAction === 'alerts') {
      return NextResponse.json(
        await buildAlertList({
          type: searchParams.get('type') ?? undefined,
          severity: searchParams.get('severity') ?? undefined,
          status: searchParams.get('status') ?? undefined,
          symbol: symbol ?? undefined,
          limit: parseInt(searchParams.get('limit') ?? '50'),
        }),
      );
    }

    return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
  } catch (err) {
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

async function buildSummary(): Promise<{
  totalAlerts: number;
  byType: Record<string, number>;
  bySeverity: Record<string, number>;
  topAlerts: LegacyAlert[];
  recentTrend: 'increasing' | 'decreasing' | 'stable';
}> {
  // Counts by type + severity in the last 30 days.
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

  const byType: Record<string, number> = {};
  // Pre-seed the three buckets the UI cards read so they render as 0
  // rather than undefined even before the first scan.
  const bySeverity: Record<string, number> = { critical: 0, warning: 0, info: 0 };
  let total = 0;
  for (const r of countRows) {
    const cnt = Number(r.cnt);
    byType[r.event_type] = (byType[r.event_type] ?? 0) + cnt;
    const legacySev = toLegacySeverity(r.severity);
    bySeverity[legacySev] = (bySeverity[legacySev] ?? 0) + cnt;
    total += cnt;
  }

  // Trend: last 7 days vs previous 7 days.
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
  const recentTrend: 'increasing' | 'decreasing' | 'stable' =
    recent > prior * 1.3 ? 'increasing' : recent < prior * 0.7 ? 'decreasing' : 'stable';

  // Top 10 most recent events for the dashboard sidebar.
  const { rows: topRows } = await db.query<any>(
    `SELECT id, symbol, event_type, severity, score, status, event_date, evidence_json
       FROM q365_manipulation_events
      ORDER BY event_date DESC, score DESC
      LIMIT 10`,
  );

  return {
    totalAlerts: total,
    byType,
    bySeverity,
    topAlerts: (topRows ?? []).map(eventRowToLegacyAlert),
    recentTrend,
  };
}

async function buildAlertList(filters: {
  type?: string;
  severity?: string;
  status?: string;
  symbol?: string;
  limit: number;
}): Promise<{ alerts: LegacyAlert[]; total: number }> {
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
  }
  if (filters.symbol) {
    where.push('symbol = ?');
    args.push(filters.symbol);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const limit = Math.min(Math.max(filters.limit || 50, 1), 500);
  const { rows } = await db.query<any>(
    `SELECT id, symbol, event_type, severity, score, status, event_date, evidence_json
       FROM q365_manipulation_events
       ${whereSql}
       ORDER BY event_date DESC, score DESC
       LIMIT ?`,
    [...args, limit],
  );

  const alerts = (rows ?? []).map(eventRowToLegacyAlert);
  return { alerts, total: alerts.length };
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
