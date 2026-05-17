// ════════════════════════════════════════════════════════════════
//  Signal Outcomes Writer — Phase 2 Priority 1 closure
//
//  Reads matured rows from `q365_confirmed_signal_snapshots`
//  (terminal status: TARGET_HIT / STOP_LOSS_HIT / EXPIRED /
//  INVALIDATED) and persists one normalised outcome row per signal
//  into `q365_signal_outcomes`. Idempotent — UNIQUE KEY on
//  source_snapshot_id with INSERT ... ON DUPLICATE KEY UPDATE.
//
//  Used by:
//   - POST /api/strategies/backfill?source=outcomes (operator trigger)
//   - Any future cron / scheduler that wants to keep outcomes fresh.
//
//  Safety:
//   - Idempotent; safe to run repeatedly.
//   - Never invents data. If a snapshot is in ACTIVE status it is
//     skipped (it's not a matured outcome yet).
//   - Falls back to a per-row try/catch so a single malformed row
//     doesn't abort the batch.
// ════════════════════════════════════════════════════════════════

import { db } from '@/lib/db';
import { getSector } from '@/lib/signal-engine/constants/phase3.constants';
import { ensureAllSchemas } from '@/lib/db/ensureAllSchemas';

export interface BackfillResult {
  scanned:    number;
  inserted:   number;
  updated:    number;
  skipped:    number;
  errors:     number;
  elapsedMs:  number;
}

export async function backfillSignalOutcomes(opts: { sinceIso?: string | null } = {}): Promise<BackfillResult> {
  const t0 = Date.now();
  await ensureAllSchemas();

  const cutoff = opts.sinceIso ?? null;
  const where  = cutoff ? `WHERE status_changed_at >= ?` : '';
  const params = cutoff ? [cutoff] : [];

  let scanned = 0, inserted = 0, updated = 0, skipped = 0, errors = 0;

  let rows: any[] = [];
  try {
    const res = await db.query<any>(
      `SELECT id, symbol, strategy, direction,
              entry_price, stop_loss, target1, target2,
              confidence_score, status, classification,
              status_changed_at, confirmed_at,
              invalidation_reason, execution_allowed,
              rejection_codes_json
         FROM q365_confirmed_signal_snapshots
         ${where}
         ORDER BY status_changed_at DESC
         LIMIT 20000`,
      params,
    );
    rows = res.rows ?? [];
  } catch {
    // Older schema without classification/execution_allowed/rejection_codes_json.
    const res = await db.query<any>(
      `SELECT id, symbol, strategy, direction,
              entry_price, stop_loss, target1, target2,
              confidence_score, status,
              status_changed_at, confirmed_at,
              invalidation_reason
         FROM q365_confirmed_signal_snapshots
         ${where}
         ORDER BY status_changed_at DESC
         LIMIT 20000`,
      params,
    );
    rows = res.rows ?? [];
  }
  scanned = rows.length;

  for (const r of rows) {
    const status = String(r.status ?? '').toUpperCase();
    // ACTIVE / PENDING rows haven't matured — skip until they resolve.
    if (status === 'ACTIVE' || status === 'PENDING' || status === '') { skipped++; continue; }

    try {
      const dir = String(r.direction ?? 'BUY').toUpperCase() === 'SELL' ? 'SELL' : 'BUY';
      const entry = num(r.entry_price);
      const stop  = num(r.stop_loss);
      const t1    = num(r.target1);

      // ── outcome / returnPct / returnR derivation (mirrors the
      // shape we already compute in observedRowToOutcome). ──
      let outcome = 'INSUFFICIENT_DATA';
      let returnPct: number | null = null;
      let returnR: number | null = null;
      let targetHit = 0, stopHit = 0, invalidated = 0;
      if (status === 'TARGET_HIT') {
        outcome = 'WIN'; targetHit = 1;
        if (entry != null && t1 != null && entry > 0) {
          returnPct = dir === 'SELL'
            ? round(((entry - t1) / entry) * 100, 4)
            : round(((t1 - entry) / entry) * 100, 4);
        }
        if (entry != null && stop != null && t1 != null) {
          const risk = Math.abs(entry - stop);
          if (risk > 0) returnR = round(Math.abs(t1 - entry) / risk, 3);
        }
      } else if (status === 'STOP_LOSS_HIT') {
        outcome = 'LOSS'; stopHit = 1;
        if (entry != null && stop != null && entry > 0) {
          returnPct = dir === 'SELL'
            ? round(((entry - stop) / entry) * 100, 4)
            : round(((stop - entry) / entry) * 100, 4);
        }
        returnR = -1;
      } else if (status === 'INVALIDATED') {
        outcome = 'INVALIDATED'; invalidated = 1;
      } else if (status === 'EXPIRED') {
        outcome = 'EXPIRED';
      }

      // ── approval status recovery (same rules as the live loader). ──
      const classification = String(r.classification ?? '').toUpperCase();
      const rejectionCodes = parseJsonArray(r.rejection_codes_json);
      let approvalStatus: string = 'APPROVED';
      if (r.execution_allowed === false || String(r.execution_allowed) === '0') approvalStatus = 'REJECTED';
      else if (r.invalidation_reason)                                            approvalStatus = 'REJECTED';
      else if (['DEVELOPING', 'LOW_CONVICTION', 'WATCHLIST', 'WATCHLIST_ONLY'].includes(classification)) approvalStatus = 'WATCHLIST';
      else if (rejectionCodes.length > 0)                                        approvalStatus = 'WATCHLIST';

      const sector = safeSector(r.symbol);
      const evaluatedAt = toMysqlDatetime(r.status_changed_at ?? r.confirmed_at);

      const upsert: any = await db.query(
        `INSERT INTO q365_signal_outcomes
          (source_snapshot_id, symbol, strategy, direction, sector, regime,
           confidence_score, outcome, return_pct, return_r,
           target_hit, stop_hit, invalidated,
           mfe_pct, mae_pct, holding_period_bars,
           approval_status, evaluated_at)
         VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?)
         ON DUPLICATE KEY UPDATE
           outcome           = VALUES(outcome),
           return_pct        = VALUES(return_pct),
           return_r          = VALUES(return_r),
           target_hit        = VALUES(target_hit),
           stop_hit          = VALUES(stop_hit),
           invalidated       = VALUES(invalidated),
           approval_status   = VALUES(approval_status),
           evaluated_at      = VALUES(evaluated_at)`,
        [
          r.id ?? null, String(r.symbol ?? ''), String(r.strategy ?? 'unclassified'), dir,
          sector, num(r.confidence_score), outcome, returnPct, returnR,
          targetHit, stopHit, invalidated, approvalStatus, evaluatedAt,
        ],
      );
      const affected = Number(upsert?.affectedRows ?? 0);
      if (affected === 1) inserted++;
      else if (affected === 2) updated++;
      else                     skipped++;
    } catch {
      errors++;
    }
  }

  return { scanned, inserted, updated, skipped, errors, elapsedMs: Date.now() - t0 };
}

// ── utilities ────────────────────────────────────────────────

function num(v: unknown): number | null {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}
function round(v: number, p: number): number {
  if (!Number.isFinite(v)) return 0;
  const f = 10 ** p;
  return Math.round(v * f) / f;
}
function safeSector(symbol: unknown): string | null {
  if (!symbol || typeof symbol !== 'string') return null;
  try {
    const s = getSector(symbol);
    return s && s !== 'Other' ? s : null;
  } catch { return null; }
}
function parseJsonArray(raw: unknown): string[] {
  if (!raw) return [];
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return Array.isArray(parsed) ? parsed.filter((x) => typeof x === 'string') : [];
  } catch { return []; }
}
function toMysqlDatetime(v: unknown): string {
  if (!v) return new Date().toISOString().slice(0, 19).replace('T', ' ');
  const d = typeof v === 'string' ? new Date(v) : (v instanceof Date ? v : new Date(String(v)));
  if (!Number.isFinite(d.getTime())) return new Date().toISOString().slice(0, 19).replace('T', ' ');
  return d.toISOString().slice(0, 19).replace('T', ' ');
}
