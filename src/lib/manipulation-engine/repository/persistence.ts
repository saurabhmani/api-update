// ════════════════════════════════════════════════════════════════
//  Manipulation Engine — Persistence Layer
//
//  Read/write helpers for the three q365_manipulation_* tables.
//  Save is atomic per snapshot: one snapshot row + one event row
//  per triggered detector. Upsert semantics on (symbol, date).
// ════════════════════════════════════════════════════════════════

import { db } from '@/lib/db';
import type {
  ManipulationSnapshot, ManipulationEventRecord, SignalManipulationLink,
  SuspicionBand, EventType, DetectorResult, DetectorResultRecord,
  ManipulationPenaltyRecord,
} from '../types';

/** Persist a snapshot + one row per triggered event. Upsert-safe. */
export async function saveSnapshot(snapshot: ManipulationSnapshot): Promise<number> {
  const result = await db.query(
    `INSERT INTO q365_manipulation_snapshots
      (symbol, snapshot_date, manipulation_score, suspicion_band, feature_json, triggered_events_json, explanation)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       manipulation_score = VALUES(manipulation_score),
       suspicion_band     = VALUES(suspicion_band),
       feature_json       = VALUES(feature_json),
       triggered_events_json = VALUES(triggered_events_json),
       explanation        = VALUES(explanation)`,
    [
      snapshot.symbol,
      snapshot.snapshotDate,
      snapshot.manipulationScore,
      snapshot.suspicionBand,
      JSON.stringify(snapshot.features),
      JSON.stringify(snapshot.triggeredEvents),
      snapshot.explanation,
    ],
  );

  // Look up id (upsert doesn't reliably return insertId on MySQL for update path).
  const { rows } = await db.query<{ id: number }>(
    `SELECT id FROM q365_manipulation_snapshots WHERE symbol = ? AND snapshot_date = ? LIMIT 1`,
    [snapshot.symbol, snapshot.snapshotDate],
  );
  const snapshotId = (rows[0] as any)?.id ?? (result as any).insertId ?? 0;

  // Replace event rows for this (symbol, date) so re-scans don't pile up.
  await db.query(
    `DELETE FROM q365_manipulation_events WHERE symbol = ? AND event_date = ?`,
    [snapshot.symbol, snapshot.snapshotDate],
  );

  for (const ev of snapshot.triggeredEvents) {
    if (!ev.triggered) continue;
    await db.query(
      `INSERT INTO q365_manipulation_events
        (symbol, event_date, event_type, severity, confidence, score, evidence_json)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        snapshot.symbol,
        snapshot.snapshotDate,
        ev.eventType,
        ev.severity,
        ev.confidence,
        ev.detectorScore,
        JSON.stringify(ev.evidence),
      ],
    );
  }

  // Phase 2: persist the per-detector breakdown (every detector, even
  // not-triggered, so the surveillance UI can render the full table).
  if (snapshotId) {
    await saveDetectorResults(snapshotId, snapshot.triggeredEvents);
  }

  return snapshotId;
}

// ── Phase 2: detector breakdown ─────────────────────────────────

export async function saveDetectorResults(
  snapshotId: number,
  detectors: DetectorResult[],
): Promise<void> {
  await db.query(
    `DELETE FROM q365_manipulation_detector_results WHERE snapshot_id = ?`,
    [snapshotId],
  );
  for (const d of detectors) {
    await db.query(
      `INSERT INTO q365_manipulation_detector_results
        (snapshot_id, detector_name, triggered, severity, score, evidence_json)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        snapshotId,
        d.detectorName,
        d.triggered ? 1 : 0,
        d.severity,
        d.detectorScore,
        JSON.stringify(d.evidence),
      ],
    );
  }
}

export async function loadDetectorResults(snapshotId: number): Promise<DetectorResultRecord[]> {
  const { rows } = await db.query<any>(
    `SELECT * FROM q365_manipulation_detector_results WHERE snapshot_id = ? ORDER BY score DESC`,
    [snapshotId],
  );
  return (rows ?? []).map((r: any) => ({
    id: r.id,
    snapshotId: r.snapshot_id,
    detectorName: r.detector_name,
    triggered: r.triggered === 1 || r.triggered === true,
    severity: r.severity,
    score: Number(r.score),
    evidence: parseJson(r.evidence_json) ?? [],
    createdAt: r.created_at,
  }));
}

// ── Phase 2: penalty log ────────────────────────────────────────

export async function saveManipulationPenalty(p: ManipulationPenaltyRecord): Promise<number> {
  const result: any = await db.query(
    `INSERT INTO q365_manipulation_penalties
      (signal_id, snapshot_id, confidence_penalty, risk_penalty, rejection_flag, reason)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      p.signalId,
      p.snapshotId,
      p.confidencePenalty,
      p.riskPenalty,
      p.rejectionFlag ? 1 : 0,
      p.reason,
    ],
  );
  return result.insertId ?? 0;
}

export async function loadPenaltiesForSignal(signalId: string): Promise<ManipulationPenaltyRecord[]> {
  const { rows } = await db.query<any>(
    `SELECT * FROM q365_manipulation_penalties WHERE signal_id = ? ORDER BY created_at DESC`,
    [signalId],
  );
  return (rows ?? []).map(rowToPenalty);
}

export async function loadRecentPenalties(limit = 100): Promise<ManipulationPenaltyRecord[]> {
  const safe = Math.max(1, Math.min(limit, 1000));
  const { rows } = await db.query<any>(
    `SELECT * FROM q365_manipulation_penalties ORDER BY created_at DESC LIMIT ${safe}`,
  );
  return (rows ?? []).map(rowToPenalty);
}

// ── Phase 2: suspicion trend + event clusters ───────────────────

export interface SuspicionTrendPoint {
  date: string;
  score: number;
  band: SuspicionBand;
}

export async function loadSuspicionTrend(
  symbol: string,
  days = 60,
): Promise<SuspicionTrendPoint[]> {
  const safe = Math.max(1, Math.min(days, 365));
  const { rows } = await db.query<any>(
    `SELECT snapshot_date, manipulation_score, suspicion_band
     FROM q365_manipulation_snapshots
     WHERE symbol = ?
     ORDER BY snapshot_date DESC
     LIMIT ${safe}`,
    [symbol],
  );
  return (rows ?? [])
    .map((r: any) => ({
      date: typeof r.snapshot_date === 'string'
        ? r.snapshot_date
        : new Date(r.snapshot_date).toISOString().split('T')[0],
      score: Number(r.manipulation_score),
      band: r.suspicion_band as SuspicionBand,
    }))
    .reverse();
}

export interface EventClusterRow {
  symbol: string;
  eventCount: number;
  lastEventDate: string;
  topEventType: EventType;
}

export async function loadEventClustersBySymbol(
  startDate: string,
  endDate: string,
  minEvents = 3,
): Promise<EventClusterRow[]> {
  const { rows } = await db.query<any>(
    `SELECT symbol,
            COUNT(*) AS event_count,
            MAX(event_date) AS last_event,
            (SELECT event_type FROM q365_manipulation_events e2
              WHERE e2.symbol = e1.symbol AND e2.event_date BETWEEN ? AND ?
              GROUP BY event_type ORDER BY COUNT(*) DESC LIMIT 1) AS top_type
     FROM q365_manipulation_events e1
     WHERE event_date BETWEEN ? AND ?
     GROUP BY symbol
     HAVING event_count >= ?
     ORDER BY event_count DESC
     LIMIT 200`,
    [startDate, endDate, startDate, endDate, minEvents],
  );
  return (rows ?? []).map((r: any) => ({
    symbol: r.symbol,
    eventCount: Number(r.event_count),
    lastEventDate: typeof r.last_event === 'string'
      ? r.last_event
      : new Date(r.last_event).toISOString().split('T')[0],
    topEventType: r.top_type as EventType,
  }));
}

function rowToPenalty(r: any): ManipulationPenaltyRecord {
  return {
    id: r.id,
    signalId: r.signal_id,
    snapshotId: r.snapshot_id,
    confidencePenalty: Number(r.confidence_penalty),
    riskPenalty: Number(r.risk_penalty),
    rejectionFlag: r.rejection_flag === 1 || r.rejection_flag === true,
    reason: r.reason ?? '',
    createdAt: r.created_at,
  };
}

/** Latest snapshot for a symbol — null if none. */
export async function loadLatestSnapshot(symbol: string): Promise<ManipulationSnapshot | null> {
  const { rows } = await db.query<any>(
    `SELECT * FROM q365_manipulation_snapshots
     WHERE symbol = ?
     ORDER BY snapshot_date DESC
     LIMIT 1`,
    [symbol],
  );
  const row = rows[0];
  if (!row) return null;
  return rowToSnapshot(row);
}

/** All snapshots for a symbol in a date range. */
export async function loadSnapshotsForSymbol(
  symbol: string,
  startDate?: string,
  endDate?: string,
): Promise<ManipulationSnapshot[]> {
  const conditions: string[] = ['symbol = ?'];
  const params: any[] = [symbol];
  if (startDate) { conditions.push('snapshot_date >= ?'); params.push(startDate); }
  if (endDate)   { conditions.push('snapshot_date <= ?'); params.push(endDate); }

  const { rows } = await db.query<any>(
    `SELECT * FROM q365_manipulation_snapshots
     WHERE ${conditions.join(' AND ')}
     ORDER BY snapshot_date DESC`,
    params,
  );
  return (rows ?? []).map(rowToSnapshot);
}

/** Events for a symbol (optionally filtered by type or date range). */
export async function loadEvents(filter: {
  symbol?: string;
  eventType?: EventType;
  startDate?: string;
  endDate?: string;
  limit?: number;
}): Promise<ManipulationEventRecord[]> {
  const conditions: string[] = [];
  const params: any[] = [];
  if (filter.symbol)    { conditions.push('symbol = ?');     params.push(filter.symbol); }
  if (filter.eventType) { conditions.push('event_type = ?'); params.push(filter.eventType); }
  if (filter.startDate) { conditions.push('event_date >= ?'); params.push(filter.startDate); }
  if (filter.endDate)   { conditions.push('event_date <= ?'); params.push(filter.endDate); }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = Math.max(1, Math.min(filter.limit ?? 200, 1000));

  const { rows } = await db.query<any>(
    `SELECT * FROM q365_manipulation_events ${where}
     ORDER BY event_date DESC, id DESC
     LIMIT ${limit}`,
    params,
  );

  return (rows ?? []).map((r: any) => ({
    id: r.id,
    symbol: r.symbol,
    eventDate: typeof r.event_date === 'string' ? r.event_date : new Date(r.event_date).toISOString().split('T')[0],
    eventType: r.event_type,
    severity: r.severity,
    confidence: Number(r.confidence),
    score: Number(r.score),
    evidence: parseJson(r.evidence_json) ?? [],
    createdAt: r.created_at,
  }));
}

/** Scan listing by date — one row per (symbol, snapshot_date) on the given date. */
export async function loadSnapshotsByDate(
  date: string,
  minBand?: SuspicionBand,
): Promise<ManipulationSnapshot[]> {
  const conditions: string[] = ['snapshot_date = ?'];
  const params: any[] = [date];
  if (minBand) {
    // Ordered score floor per band — cheap way to filter by minimum severity.
    const floors: Record<SuspicionBand, number> = {
      low: 0, watch: 25, elevated: 50, high: 70, severe: 85,
    };
    conditions.push('manipulation_score >= ?');
    params.push(floors[minBand]);
  }

  const { rows } = await db.query<any>(
    `SELECT * FROM q365_manipulation_snapshots
     WHERE ${conditions.join(' AND ')}
     ORDER BY manipulation_score DESC`,
    params,
  );
  return (rows ?? []).map(rowToSnapshot);
}

/** Record a signal↔manipulation link (used by the integration hook). */
export async function saveSignalManipulationLink(link: SignalManipulationLink): Promise<void> {
  await db.query(
    `INSERT INTO q365_signal_manipulation_links
      (signal_id, symbol, manipulation_snapshot_id, penalty_applied, warning_added)
     VALUES (?, ?, ?, ?, ?)`,
    [
      link.signalId,
      link.symbol,
      link.manipulationSnapshotId,
      link.penaltyApplied,
      link.warningAdded,
    ],
  );
}

// ── Helpers ─────────────────────────────────────────────────────

function rowToSnapshot(r: any): ManipulationSnapshot {
  const triggered = parseJson(r.triggered_events_json) ?? [];
  // Re-derive labels on read so old rows work without a schema change.
  // Lazy require to avoid a cycle with scoring/.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { deriveRiskLabels } = require('../scoring/riskLabels');
  return {
    symbol: r.symbol,
    snapshotDate: typeof r.snapshot_date === 'string'
      ? r.snapshot_date
      : new Date(r.snapshot_date).toISOString().split('T')[0],
    manipulationScore: Number(r.manipulation_score),
    suspicionBand: r.suspicion_band,
    features: parseJson(r.feature_json) ?? ({} as any),
    triggeredEvents: triggered,
    explanation: r.explanation ?? '',
    riskLabels: deriveRiskLabels(triggered),
  };
}

function parseJson(raw: any): any {
  if (raw == null) return null;
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(raw); } catch { return null; }
}
