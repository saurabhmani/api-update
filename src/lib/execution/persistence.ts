// ════════════════════════════════════════════════════════════════
//  Execution persistence helpers
//
//  Thin async wrappers around q365_exec_signals / q365_exec_trades /
//  q365_exec_positions. Every function is self-contained, swallows
//  DB errors with a console.error, and returns either the inserted
//  row id or null. The execution engine must NOT abort a live
//  trading flow on a persistence blip — so every call site should
//  treat persistence failures as non-fatal.
// ════════════════════════════════════════════════════════════════

import { logger } from '@/lib/logger';
import { db } from '@/lib/db';

const log = logger.child({ component: 'executionPersistence' });

// ── Signals ───────────────────────────────────────────────────

export interface SignalRow {
  symbol:       string;
  side:         'BUY' | 'SELL';
  price:        number;
  confidence?:  number | null;
  strategy?:    string | null;
  stop_loss?:   number | null;
  target_1?:    number | null;
  engine_entry?: number | null;
  volume?:      number | null;
}

export async function saveSignal(row: SignalRow): Promise<number | null> {
  try {
    const result = await db.query(
      `INSERT INTO q365_exec_signals
         (symbol, side, price, confidence, strategy, stop_loss, target_1, engine_entry, volume)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.symbol, row.side, row.price,
        row.confidence ?? null, row.strategy ?? null,
        row.stop_loss ?? null, row.target_1 ?? null,
        row.engine_entry ?? null, row.volume ?? null,
      ],
    );
    return result.insertId ?? null;
  } catch (err: any) {
    console.error('[persistence] saveSignal failed:', err?.message);
    return null;
  }
}

export async function updateSignalOutcome(
  signalId: number,
  outcome: 'emitted' | 'risk_rejected' | 'order_placed' | 'order_failed',
  reason?: string,
): Promise<void> {
  try {
    await db.query(
      `UPDATE q365_exec_signals SET outcome = ?, outcome_reason = ? WHERE id = ?`,
      [outcome, reason ?? null, signalId],
    );
  } catch (err: any) {
    console.error('[persistence] updateSignalOutcome failed:', err?.message);
  }
}

// ── Trades ────────────────────────────────────────────────────

export interface TradeRow {
  order_id:         string;
  parent_order_id?: string | null;
  symbol:           string;
  side:             'BUY' | 'SELL';
  role:             'ENTRY' | 'STOP' | 'TARGET';
  quantity:         number;
  requested_price?: number | null;
  trigger_price?:   number | null;
  status:           string;
  order_type?:      string | null;
  product?:         string | null;
  position_id?:     number | null;
  signal_id?:       number | null;
  dry_run?:         boolean;
  error?:           string | null;
}

export async function saveTrade(row: TradeRow): Promise<number | null> {
  try {
    const result = await db.query(
      `INSERT INTO q365_exec_trades
         (order_id, parent_order_id, symbol, side, role, quantity,
          requested_price, trigger_price, status, order_type, product,
          position_id, signal_id, dry_run, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         status          = VALUES(status),
         error           = VALUES(error),
         requested_price = VALUES(requested_price),
         trigger_price   = VALUES(trigger_price),
         updated_at      = CURRENT_TIMESTAMP`,
      [
        row.order_id, row.parent_order_id ?? null, row.symbol, row.side,
        row.role, row.quantity,
        row.requested_price ?? null, row.trigger_price ?? null,
        row.status, row.order_type ?? null, row.product ?? null,
        row.position_id ?? null, row.signal_id ?? null,
        row.dry_run ? 1 : 0, row.error ?? null,
      ],
    );
    return result.insertId ?? null;
  } catch (err: any) {
    console.error('[persistence] saveTrade failed:', err?.message);
    return null;
  }
}

export interface PostbackUpdate {
  order_id:           string;
  status:             string;
  status_message?:    string | null;
  filled_quantity?:   number | null;
  pending_quantity?:  number | null;
  average_price?:     number | null;
  exchange_timestamp?: string | null;
}

export async function updateTradeFromPostback(u: PostbackUpdate): Promise<{
  found: boolean;
  tradeId?: number;
  positionId?: number | null;
  symbol?: string;
  side?: 'BUY' | 'SELL';
  role?: 'ENTRY' | 'STOP' | 'TARGET';
}> {
  try {
    const existing = await db.query<any>(
      `SELECT id, position_id, symbol, side, role, filled_quantity
         FROM q365_exec_trades WHERE order_id = ? LIMIT 1`,
      [u.order_id],
    );
    const row = existing.rows[0];
    if (!row) {
      console.warn(`[persistence] postback for unknown order_id=${u.order_id}`);
      return { found: false };
    }

    await db.query(
      `UPDATE q365_exec_trades
         SET status           = ?,
             status_message   = ?,
             filled_quantity  = COALESCE(?, filled_quantity),
             pending_quantity = COALESCE(?, pending_quantity),
             average_price    = COALESCE(?, average_price),
             exchange_ts      = ?,
             updated_at       = CURRENT_TIMESTAMP
       WHERE order_id = ?`,
      [
        u.status,
        u.status_message ?? null,
        u.filled_quantity ?? null,
        u.pending_quantity ?? null,
        u.average_price ?? null,
        u.exchange_timestamp ?? null,
        u.order_id,
      ],
    );

    return {
      found:      true,
      tradeId:    row.id,
      positionId: row.position_id,
      symbol:     row.symbol,
      side:       row.side,
      role:       row.role,
    };
  } catch (err: any) {
    console.error('[persistence] updateTradeFromPostback failed:', err?.message);
    return { found: false };
  }
}

// ── Positions ─────────────────────────────────────────────────

export interface OpenPositionRow {
  symbol:          string;
  side:            'BUY' | 'SELL';
  quantity:        number;
  requested_price?: number | null;
  stop_loss?:      number | null;
  target_1?:       number | null;
  entry_signal_id?: number | null;
  strategy?:       string | null;
  dry_run?:        boolean;
}

export async function insertPendingPosition(row: OpenPositionRow): Promise<number | null> {
  try {
    const result = await db.query(
      `INSERT INTO q365_exec_positions
         (symbol, side, quantity, requested_price, stop_loss, target_1,
          entry_signal_id, strategy, dry_run, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING')`,
      [
        row.symbol, row.side, row.quantity,
        row.requested_price ?? null, row.stop_loss ?? null,
        row.target_1 ?? null, row.entry_signal_id ?? null,
        row.strategy ?? null, row.dry_run ? 1 : 0,
      ],
    );
    return result.insertId ?? null;
  } catch (err: any) {
    console.error('[persistence] insertPendingPosition failed:', err?.message);
    return null;
  }
}

export async function attachOrderIds(
  positionId: number,
  orders: { entry?: string | null; stop?: string | null; target?: string | null },
): Promise<void> {
  try {
    await db.query(
      `UPDATE q365_exec_positions
         SET entry_order_id  = COALESCE(?, entry_order_id),
             stop_order_id   = COALESCE(?, stop_order_id),
             target_order_id = COALESCE(?, target_order_id)
       WHERE id = ?`,
      [orders.entry ?? null, orders.stop ?? null, orders.target ?? null, positionId],
    );
  } catch (err: any) {
    console.error('[persistence] attachOrderIds failed:', err?.message);
  }
}

export async function markPositionOpen(
  positionId: number,
  entryPrice: number,
  filledQty: number,
): Promise<void> {
  try {
    // Only write filled_at on the first transition out of PENDING —
    // a second postback with progressive fills must not rewind the
    // timestamp. `filled_at = COALESCE(filled_at, CURRENT_TIMESTAMP)`.
    // entry_price and filled_quantity always take the latest values
    // because Kite hands us the weighted average on every postback.
    await db.query(
      `UPDATE q365_exec_positions
         SET status          = 'OPEN',
             entry_price     = ?,
             filled_quantity = ?,
             filled_at       = COALESCE(filled_at, CURRENT_TIMESTAMP)
       WHERE id = ? AND status IN ('PENDING','OPEN')`,
      [entryPrice, filledQty, positionId],
    );
  } catch (err: any) {
    console.error('[persistence] markPositionOpen failed:', err?.message);
  }
}

/**
 * Aggregate notional of all non-closed positions. Used by the
 * portfolio-level exposure guard in positionSizing. Counts
 * requested_price × quantity for PENDING rows (we haven't filled
 * yet but the order is live at the broker) and entry_price ×
 * filled_quantity for OPEN rows (actual money at work).
 */
export async function getAggregateOpenNotional(): Promise<number> {
  try {
    const { rows } = await db.query<any>(
      `SELECT
         COALESCE(SUM(
           CASE
             WHEN status = 'OPEN'
               THEN COALESCE(entry_price, requested_price, 0) * filled_quantity
             WHEN status = 'PENDING'
               THEN COALESCE(requested_price, 0) * quantity
             ELSE 0
           END
         ), 0) AS notional
       FROM q365_exec_positions
       WHERE status IN ('PENDING','OPEN')`,
    );
    return Number(rows[0]?.notional ?? 0);
  } catch (err: any) {
    console.error('[persistence] getAggregateOpenNotional failed:', err?.message);
    return 0;
  }
}

/**
 * Fetch a position row with all three order_ids. Used by the
 * postback handler to find the sibling order when one leg fills
 * (for OCO cancel).
 */
export async function getPositionBracket(positionId: number): Promise<{
  entry_order_id: string | null;
  stop_order_id:  string | null;
  target_order_id: string | null;
} | null> {
  try {
    const { rows } = await db.query<any>(
      `SELECT entry_order_id, stop_order_id, target_order_id
         FROM q365_exec_positions WHERE id = ? LIMIT 1`,
      [positionId],
    );
    return rows[0] ?? null;
  } catch (err: any) {
    console.error('[persistence] getPositionBracket failed:', err?.message);
    return null;
  }
}

export async function markPositionClosed(
  positionId: number,
  exitPrice: number,
  exitReason: 'STOP' | 'TARGET' | 'MANUAL' | 'CANCELLED',
): Promise<void> {
  try {
    // Compute PnL at the DB layer so the value is atomic with the
    // status flip — avoids the read-compute-write race that would
    // otherwise happen if two postbacks arrived simultaneously.
    await db.query(
      `UPDATE q365_exec_positions
         SET status      = 'CLOSED',
             exit_price  = ?,
             exit_reason = ?,
             closed_at   = CURRENT_TIMESTAMP,
             pnl         = CASE
                              WHEN side = 'BUY'
                                THEN (? - entry_price) * filled_quantity
                              ELSE (entry_price - ?) * filled_quantity
                           END,
             pnl_pct     = CASE
                              WHEN entry_price > 0 AND side = 'BUY'
                                THEN ((? - entry_price) / entry_price) * 100
                              WHEN entry_price > 0 AND side = 'SELL'
                                THEN ((entry_price - ?) / entry_price) * 100
                              ELSE NULL
                           END
       WHERE id = ? AND status = 'OPEN'`,
      [exitPrice, exitReason, exitPrice, exitPrice, exitPrice, exitPrice, positionId],
    );
  } catch (err: any) {
    console.error('[persistence] markPositionClosed failed:', err?.message);
  }
}

export async function markPositionCancelled(positionId: number): Promise<void> {
  try {
    await db.query(
      `UPDATE q365_exec_positions SET status = 'CANCELLED', closed_at = CURRENT_TIMESTAMP
         WHERE id = ? AND status IN ('PENDING','OPEN')`,
      [positionId],
    );
  } catch (err: any) {
    console.error('[persistence] markPositionCancelled failed:', err?.message);
  }
}

export async function getPositionById(positionId: number): Promise<any | null> {
  try {
    const { rows } = await db.query(
      `SELECT * FROM q365_exec_positions WHERE id = ? LIMIT 1`,
      [positionId],
    );
    return rows[0] ?? null;
  } catch (err: any) {
    console.error('[persistence] getPositionById failed:', err?.message);
    return null;
  }
}

export async function getOpenPositionsDb(): Promise<any[]> {
  try {
    const { rows } = await db.query(
      `SELECT * FROM q365_exec_positions WHERE status IN ('PENDING','OPEN') ORDER BY opened_at DESC`,
    );
    return rows;
  } catch (err: any) {
    console.error('[persistence] getOpenPositionsDb failed:', err?.message);
    return [];
  }
}
