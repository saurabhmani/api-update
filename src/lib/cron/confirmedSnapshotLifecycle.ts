// ════════════════════════════════════════════════════════════════
//  Confirmed Snapshot Lifecycle Worker
//
//  Runs at ~30s cadence and walks every ACTIVE row in
//  q365_confirmed_signal_snapshots. It compares the current LTP to
//  the snapshot's frozen entry / stop / target and transitions the
//  status field. THIS IS THE ONLY PROCESS ALLOWED TO MUTATE
//  SNAPSHOT ROWS, and it only ever changes:
//    - status
//    - status_changed_at
//    - invalidation_reason
//
//  Frozen-by-design columns (entry, stop, target, confidence, score,
//  explanation, factor scores, gate result) are NEVER touched.
//
//  Status transitions:
//    BUY:  LTP <= stop_loss → STOP_LOSS_HIT
//          LTP >= target1   → TARGET_HIT
//    SELL: LTP >= stop_loss → STOP_LOSS_HIT
//          LTP <= target1   → TARGET_HIT
//    Any:  valid_until <= NOW()                    → EXPIRED
//          live-validation hard fail (drift, etc.) → INVALIDATED
//
//  EXPIRED takes precedence over the price-driven transitions: if a
//  row has aged out, we don't care what the price is.
//
//  Idempotent: running the worker twice in the same minute on the
//  same row is a no-op once the row has transitioned away from
//  ACTIVE — the WHERE clause filters status='ACTIVE' so already-
//  transitioned rows are invisible.
// ════════════════════════════════════════════════════════════════

import { db } from '@/lib/db';
import { resolvePrices } from '@/lib/marketData/resolver/marketDataResolver';
import { getMarketStatus } from '@/lib/marketData/marketHours';
import { markTerminated } from '@/lib/signal-engine/repository/maturityTracker';

interface ActiveSnapshotRow {
  id:           number;
  symbol:       string;
  direction:    'BUY' | 'SELL' | string;
  entry_price:  number | string;
  stop_loss:    number | string;
  target1:      number | string;
  valid_until:  Date | string;
}

export interface LifecycleRunResult {
  scanned:       number;
  expired:       number;
  target_hit:    number;
  stop_loss_hit: number;
  invalidated:   number;
  unchanged:     number;
  failedFetches: number;
  elapsedMs:     number;
}

// 3% adverse drift from frozen entry on a delayed Yahoo tape is the
// soft hard-invalidation threshold. Tighter (e.g. 1%) would falsely
// invalidate snapshots during normal intraday wiggle; looser (e.g.
// 5%) and the snapshot loses meaning when the real trade plan is
// already underwater. Mirrors the live-validation engine's drift cap.
const HARD_DRIFT_PCT = 0.03;

function toMysqlDateTime(d: Date): string {
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

function num(v: number | string): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Resolve the next status for a single snapshot. Returns null when
 * the row should remain ACTIVE.
 */
function decideTransition(
  row: ActiveSnapshotRow,
  ltp: number | null,
  now: number,
): { nextStatus: 'TARGET_HIT' | 'STOP_LOSS_HIT' | 'EXPIRED' | 'INVALIDATED'; reason: string } | null {
  // EXPIRED first — the snapshot is no longer valid regardless of price.
  const validUntilMs = row.valid_until instanceof Date
    ? row.valid_until.getTime()
    : Date.parse(typeof row.valid_until === 'string'
        ? (row.valid_until.includes('T') ? row.valid_until : row.valid_until.replace(' ', 'T') + 'Z')
        : '');
  if (Number.isFinite(validUntilMs) && validUntilMs <= now) {
    return { nextStatus: 'EXPIRED', reason: 'validity_window_elapsed' };
  }

  if (ltp == null || !Number.isFinite(ltp) || ltp <= 0) {
    // No live price → cannot evaluate price-driven transitions. Leave
    // the row ACTIVE; we'll re-check on the next tick.
    return null;
  }

  const direction = String(row.direction).toUpperCase();
  const entry  = num(row.entry_price);
  const stop   = num(row.stop_loss);
  const target = num(row.target1);

  if (direction === 'BUY') {
    if (ltp <= stop)   return { nextStatus: 'STOP_LOSS_HIT', reason: 'ltp_at_or_below_stop' };
    if (ltp >= target) return { nextStatus: 'TARGET_HIT',    reason: 'ltp_at_or_above_target' };
  } else if (direction === 'SELL') {
    if (ltp >= stop)   return { nextStatus: 'STOP_LOSS_HIT', reason: 'ltp_at_or_above_stop' };
    if (ltp <= target) return { nextStatus: 'TARGET_HIT',    reason: 'ltp_at_or_below_target' };
  }

  // Hard live-validation: did the price drift catastrophically away
  // from the frozen entry without hitting stop or target? This catches
  // gap-throughs and catastrophic engine disagreements.
  if (entry > 0) {
    const driftPct = Math.abs(ltp - entry) / entry;
    if (driftPct > HARD_DRIFT_PCT) {
      // BUY drifting strongly UP isn't an invalidation — that's the
      // trade working. Same for SELL drifting DOWN. Only flag when the
      // direction is wrong relative to the trade plan.
      const adverseDrift =
        (direction === 'BUY'  && ltp < entry) ||
        (direction === 'SELL' && ltp > entry);
      if (adverseDrift) {
        return { nextStatus: 'INVALIDATED', reason: `adverse_drift_${(driftPct * 100).toFixed(1)}_pct` };
      }
    }
  }

  return null;
}

export async function runConfirmedSnapshotLifecycle(): Promise<LifecycleRunResult> {
  const t0 = Date.now();
  const result: LifecycleRunResult = {
    scanned: 0, expired: 0, target_hit: 0, stop_loss_hit: 0,
    invalidated: 0, unchanged: 0, failedFetches: 0, elapsedMs: 0,
  };

  let rows: ActiveSnapshotRow[];
  try {
    const queryRes = await db.query<ActiveSnapshotRow>(
      `SELECT id, symbol, direction, entry_price, stop_loss, target1, valid_until
         FROM q365_confirmed_signal_snapshots
        WHERE status = 'ACTIVE'
        LIMIT 500`,
    );
    rows = queryRes.rows as ActiveSnapshotRow[];
  } catch (err: any) {
    if (/doesn'?t exist|unknown table/i.test(err?.message ?? '')) {
      // Pre-migration boot — nothing to do.
      result.elapsedMs = Date.now() - t0;
      return result;
    }
    throw err;
  }

  result.scanned = rows.length;
  if (rows.length === 0) {
    result.elapsedMs = Date.now() - t0;
    return result;
  }

  // Step 1 — fast-path EXPIRED. No live price needed; we can flip
  // these in a single bulk UPDATE before paying the LTP-fetch cost.
  const now = Date.now();
  const expiredIds: number[] = [];
  const remaining: ActiveSnapshotRow[] = [];
  for (const r of rows) {
    const validUntilMs = r.valid_until instanceof Date
      ? r.valid_until.getTime()
      : Date.parse(typeof r.valid_until === 'string'
          ? (r.valid_until.includes('T') ? r.valid_until : r.valid_until.replace(' ', 'T') + 'Z')
          : '');
    if (Number.isFinite(validUntilMs) && validUntilMs <= now) {
      expiredIds.push(r.id);
    } else {
      remaining.push(r);
    }
  }
  if (expiredIds.length > 0) {
    const placeholders = expiredIds.map(() => '?').join(',');
    try {
      await db.query(
        `UPDATE q365_confirmed_signal_snapshots
            SET status              = 'EXPIRED',
                status_changed_at   = ?,
                invalidation_reason = 'validity_window_elapsed'
          WHERE id IN (${placeholders})
            AND status = 'ACTIVE'`,
        [toMysqlDateTime(new Date(now)), ...expiredIds],
      );
      result.expired = expiredIds.length;
      // Termination feedback — flip every matching tracker to
      // 'terminated' so the next scanner detection starts a fresh
      // maturity cycle. Best-effort; tracker errors don't block.
      for (const sid of expiredIds) {
        try { await markTerminated(sid); }
        catch (e: any) { console.warn(`[snapshotLifecycle] markTerminated ${sid}:`, e?.message); }
      }
    } catch (err: any) {
      console.warn('[snapshotLifecycle] bulk expire failed:', err?.message);
    }
  }

  if (remaining.length === 0) {
    result.elapsedMs = Date.now() - t0;
    return result;
  }

  // Step 6 of the budget-fix PR: gate the price-fetch portion to
  // market hours. The bulk-EXPIRE block above stays 24×7 — that's
  // how snapshots time out overnight. Without this gate the worker
  // pulled live prices every 30s on weekends, burning quota for no
  // signal value (no trades happen, no price moves to detect).
  const market = getMarketStatus();
  if (!market.isOpen) {
    result.elapsedMs = Date.now() - t0;
    return result;
  }

  // Step 2 — batch-fetch LTPs for remaining rows. Use unique symbols
  // so multiple snapshots on the same symbol share one fetch.
  const uniqueSymbols = Array.from(new Set(remaining.map((r) => r.symbol.toUpperCase())));
  const priceMap = new Map<string, number | null>();
  try {
    const quotes = await resolvePrices(uniqueSymbols, { concurrency: 12 });
    for (const q of quotes) {
      priceMap.set(q.symbol.toUpperCase(), q.price ?? null);
    }
  } catch (err: any) {
    console.warn('[snapshotLifecycle] resolvePrices failed:', err?.message);
    result.failedFetches = uniqueSymbols.length;
  }

  // Step 3 — decide transitions per row, group by next-status, apply
  // bulk UPDATEs.
  const transitions = new Map<string, Array<{ id: number; reason: string }>>();
  for (const r of remaining) {
    const ltp = priceMap.get(r.symbol.toUpperCase()) ?? null;
    if (ltp == null) result.failedFetches++;
    const decision = decideTransition(r, ltp, now);
    if (!decision) {
      result.unchanged++;
      continue;
    }
    if (!transitions.has(decision.nextStatus)) transitions.set(decision.nextStatus, []);
    transitions.get(decision.nextStatus)!.push({ id: r.id, reason: decision.reason });
  }

  for (const [nextStatus, items] of transitions) {
    if (items.length === 0) continue;
    // Per-row UPDATE so each invalidation_reason can be precise. The
    // batch is bounded to 500 rows total so the loop cost is fine.
    for (const it of items) {
      try {
        await db.query(
          `UPDATE q365_confirmed_signal_snapshots
              SET status              = ?,
                  status_changed_at   = ?,
                  invalidation_reason = ?
            WHERE id = ?
              AND status = 'ACTIVE'`,
          [nextStatus, toMysqlDateTime(new Date(now)), it.reason, it.id],
        );
        // Termination feedback — fresh maturity cycle next detection.
        try { await markTerminated(it.id); }
        catch (e: any) { console.warn(`[snapshotLifecycle] markTerminated ${it.id}:`, e?.message); }
      } catch (err: any) {
        console.warn(`[snapshotLifecycle] update id=${it.id} failed:`, err?.message);
      }
    }
    if (nextStatus === 'TARGET_HIT')      result.target_hit    += items.length;
    else if (nextStatus === 'STOP_LOSS_HIT') result.stop_loss_hit += items.length;
    else if (nextStatus === 'INVALIDATED')   result.invalidated   += items.length;
    else if (nextStatus === 'EXPIRED')       result.expired       += items.length;
  }

  result.elapsedMs = Date.now() - t0;
  return result;
}
