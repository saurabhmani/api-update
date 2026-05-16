// ════════════════════════════════════════════════════════════════
//  Institutional Alert Service
//
//  PRD Rule: All alerts must be structured, deduplicated, and
//  suppressible. Critical alerts are always visible.
//
//  Single entry point: publishAlert()
//  Store: q365_alerts (see ensureAllSchemas.ts)
//
//  Dedup:
//    dedup_hash = sha256(category|severity|source|dedup_key)
//    Repeat publish increments occurrence_count, never inserts a
//    duplicate row. UNIQUE(dedup_hash) enforces this at the DB.
//
//  Suppression:
//    - info alerts:    suppressed after 10 repeats / 1 hour window
//    - warning alerts: suppressed after 25 repeats / 1 hour window
//    - critical alerts: NEVER suppressed
// ════════════════════════════════════════════════════════════════

import { createHash, randomBytes } from 'crypto';
import { db } from '@/lib/db';
import { logger } from '@/lib/logger';

const log = logger.child({ service: 'alertService' });

export type AlertSeverity = 'info' | 'warning' | 'critical';
export type SuppressionState = 'active' | 'suppressed' | 'muted';

export interface PublishAlertInput {
  category: string;            // e.g. 'risk.breach', 'governance.violation', 'monitoring.drawdown'
  severity: AlertSeverity;
  message: string;
  source: string;              // the emitting subsystem, e.g. 'breachDetectionService'
  dedupKey: string;            // caller-chosen stable identifier (e.g. `${portfolioId}:${metric}`)
  payload?: Record<string, unknown>;
}

export interface PublishAlertResult {
  alertId: string;
  created: boolean;            // true=new row, false=dedup hit
  occurrenceCount: number;
  suppressionState: SuppressionState;
}

export interface AlertRecord {
  alertId: string;
  category: string;
  severity: AlertSeverity;
  message: string;
  source: string;
  dedupKey: string;
  dedupHash: string;
  suppressionState: SuppressionState;
  occurrenceCount: number;
  firstSeenAt: string;
  lastSeenAt: string;
  resolvedAt: string | null;
  payload: Record<string, unknown> | null;
  createdAt: string;
}

// ── Suppression thresholds ────────────────────────────────────────
//
// Rationale: low-value chatter should auto-mute after N repeats in
// a rolling window. Critical is always visible — we never suppress
// an alert a regulator may need to see.
const SUPPRESSION_THRESHOLDS: Record<AlertSeverity, number> = {
  info:     10,
  warning:  25,
  critical: Number.POSITIVE_INFINITY, // never suppressed
};

const SUPPRESSION_WINDOW_MIN = 60; // occurrences inside this window count

// ── Hash / id helpers ─────────────────────────────────────────────

function computeDedupHash(
  category: string, severity: AlertSeverity, source: string, dedupKey: string,
): string {
  const tuple = `${category}|${severity}|${source}|${dedupKey}`;
  return createHash('sha256').update(tuple).digest('hex');
}

function generateAlertId(): string {
  // ALR-YYYYMMDD-<random 8-hex>
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  return `ALR-${date}-${randomBytes(4).toString('hex')}`;
}

// ── Single entry point for all alerts ─────────────────────────────
//
// Inserts on first seen; otherwise bumps occurrence_count and
// refreshes last_seen_at. Computes suppression_state after each
// publish so consumers always see an up-to-date verdict.

export async function publishAlert(
  input: PublishAlertInput,
): Promise<PublishAlertResult> {
  const dedupHash = computeDedupHash(input.category, input.severity, input.source, input.dedupKey);
  const alertId = generateAlertId();
  const payload = input.payload ? JSON.stringify(input.payload) : null;

  // Single-statement upsert: the UNIQUE(dedup_hash) constraint
  // collapses duplicates into an occurrence_count increment.
  await db.query(
    `INSERT INTO q365_alerts
       (alert_id, category, severity, message, source, dedup_key, dedup_hash, payload)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       occurrence_count = occurrence_count + 1,
       last_seen_at = CURRENT_TIMESTAMP,
       message = VALUES(message)`,
    [alertId, input.category, input.severity, input.message, input.source, input.dedupKey, dedupHash, payload],
  );

  // Read back the current state (handles both new + upsert cases)
  const { rows } = await db.query(
    `SELECT alert_id, occurrence_count, suppression_state, last_seen_at, first_seen_at
     FROM q365_alerts WHERE dedup_hash = ? LIMIT 1`,
    [dedupHash],
  );
  const row = rows[0] as any;
  if (!row) {
    // Should not happen — we just inserted
    log.error('publishAlert readback missed', { dedupHash, category: input.category });
    return { alertId, created: true, occurrenceCount: 1, suppressionState: 'active' };
  }

  const created = Number(row.occurrence_count) === 1;
  const nextState = computeSuppressionState(input.severity, Number(row.occurrence_count), row.first_seen_at);

  // Only write back if suppression_state actually changed
  if (nextState !== row.suppression_state) {
    await db.query(
      `UPDATE q365_alerts SET suppression_state = ? WHERE dedup_hash = ?`,
      [nextState, dedupHash],
    );
  }

  return {
    alertId: row.alert_id,
    created,
    occurrenceCount: Number(row.occurrence_count),
    suppressionState: nextState,
  };
}

// ── Suppression policy ────────────────────────────────────────────
//
// Critical → always 'active' (never silenced).
// info/warning → 'suppressed' once occurrence_count within the
// rolling window crosses the per-severity threshold.

export function computeSuppressionState(
  severity: AlertSeverity,
  occurrenceCount: number,
  firstSeenAt: Date | string,
): SuppressionState {
  if (severity === 'critical') return 'active';

  const threshold = SUPPRESSION_THRESHOLDS[severity];
  if (occurrenceCount < threshold) return 'active';

  const firstSeen = firstSeenAt instanceof Date ? firstSeenAt : new Date(firstSeenAt);
  const windowMs = SUPPRESSION_WINDOW_MIN * 60 * 1000;
  const withinWindow = Date.now() - firstSeen.getTime() <= windowMs;
  return withinWindow ? 'suppressed' : 'active';
}

// ── Query helpers ─────────────────────────────────────────────────

export async function getActiveAlerts(opts?: {
  severity?: AlertSeverity;
  category?: string;
  limit?: number;
}): Promise<AlertRecord[]> {
  const clauses: string[] = [
    // critical is NEVER hidden, regardless of suppression_state
    "(severity = 'critical' OR suppression_state = 'active')",
    'resolved_at IS NULL',
  ];
  const params: any[] = [];

  if (opts?.severity) { clauses.push('severity = ?'); params.push(opts.severity); }
  if (opts?.category) { clauses.push('category = ?'); params.push(opts.category); }

  const { rows } = await db.query(
    `SELECT alert_id, category, severity, message, source, dedup_key, dedup_hash,
            suppression_state, occurrence_count, first_seen_at, last_seen_at,
            resolved_at, payload, created_at
     FROM q365_alerts
     WHERE ${clauses.join(' AND ')}
     ORDER BY FIELD(severity,'critical','warning','info'), last_seen_at DESC
     LIMIT ?`,
    [...params, opts?.limit ?? 100],
  );

  return (rows as any[]).map(mapRow);
}

export async function resolveAlert(alertId: string): Promise<boolean> {
  const { affectedRows } = await db.query(
    `UPDATE q365_alerts SET resolved_at = CURRENT_TIMESTAMP WHERE alert_id = ? AND resolved_at IS NULL`,
    [alertId],
  );
  return Number(affectedRows ?? 0) > 0;
}

export async function muteAlertHash(dedupHash: string): Promise<void> {
  await db.query(
    `UPDATE q365_alerts SET suppression_state = 'muted' WHERE dedup_hash = ?`,
    [dedupHash],
  );
}

function mapRow(r: any): AlertRecord {
  return {
    alertId: r.alert_id,
    category: r.category,
    severity: r.severity,
    message: r.message,
    source: r.source,
    dedupKey: r.dedup_key,
    dedupHash: r.dedup_hash,
    suppressionState: r.suppression_state,
    occurrenceCount: Number(r.occurrence_count),
    firstSeenAt: typeof r.first_seen_at === 'string' ? r.first_seen_at : new Date(r.first_seen_at).toISOString(),
    lastSeenAt:  typeof r.last_seen_at  === 'string' ? r.last_seen_at  : new Date(r.last_seen_at).toISOString(),
    resolvedAt:  r.resolved_at ? (typeof r.resolved_at === 'string' ? r.resolved_at : new Date(r.resolved_at).toISOString()) : null,
    payload:     r.payload ? (typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload) : null,
    createdAt:   typeof r.created_at === 'string' ? r.created_at : new Date(r.created_at).toISOString(),
  };
}
