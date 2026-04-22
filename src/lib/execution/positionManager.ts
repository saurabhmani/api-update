// ════════════════════════════════════════════════════════════════
//  positionManager — DB-backed position lifecycle
//
//  The source of truth for open and closed positions is the
//  q365_exec_positions table. This module is a thin façade over
//  persistence.ts that the signal executor and the postback
//  webhook both call. It exists so the lifecycle rules (when a
//  PENDING flips to OPEN, when OPEN flips to CLOSED) are enforced
//  in exactly one place.
//
//  State transitions:
//
//    PENDING  ── entry order ACK'd by exchange ──▶  OPEN
//    PENDING  ── entry CANCELLED / REJECTED  ───▶  CANCELLED
//    OPEN     ── stop fill            ─────────▶  CLOSED (exit=STOP)
//    OPEN     ── target fill          ─────────▶  CLOSED (exit=TARGET)
//    OPEN     ── manual close         ─────────▶  CLOSED (exit=MANUAL)
//
//  PnL is computed at the DB layer inside markPositionClosed so
//  two postbacks arriving simultaneously (stop + target race) can
//  never corrupt the number.
// ════════════════════════════════════════════════════════════════

import { logger } from '@/lib/logger';
import {
  insertPendingPosition,
  attachOrderIds,
  markPositionOpen,
  markPositionClosed,
  markPositionCancelled,
  getPositionById,
  getOpenPositionsDb,
  type OpenPositionRow,
} from './persistence';

const log = logger.child({ component: 'positionManager' });

export interface OpenPositionInput extends OpenPositionRow {}

/**
 * Create a PENDING position row. Called by the signal executor
 * BEFORE the entry order is sent, so the row is there to receive
 * the order_id as soon as placeOrder returns. Returns the new
 * position_id which is then threaded into all subsequent trade
 * rows (entry, stop, target).
 */
export async function openPendingPosition(
  input: OpenPositionInput,
): Promise<number | null> {
  const id = await insertPendingPosition(input);
  if (id != null) {
    console.log(
      `[positionMgr] pending  id=${id}  ${input.side} ${input.quantity} ${input.symbol}  ` +
      `entry~₹${input.requested_price ?? '?'}  stop=₹${input.stop_loss ?? '?'}  target=₹${input.target_1 ?? '?'}`
    );
  }
  return id;
}

/**
 * Attach broker order_ids to a position. Called after placeOrder
 * returns for each of entry/stop/target.
 */
export async function linkOrders(
  positionId: number,
  orders: { entry?: string | null; stop?: string | null; target?: string | null },
): Promise<void> {
  await attachOrderIds(positionId, orders);
}

/**
 * Promote a PENDING position to OPEN once the entry order has
 * filled. Called from the postback webhook when the ENTRY trade
 * row flips to COMPLETE. Uses the REAL fill price, not the
 * signal price — that's the whole point of postback recon.
 */
export async function markOpen(
  positionId: number,
  fillPrice: number,
  filledQty: number,
): Promise<void> {
  await markPositionOpen(positionId, fillPrice, filledQty);
  console.log(
    `[positionMgr] OPEN  id=${positionId}  fill=₹${fillPrice}  qty=${filledQty}`
  );
}

/**
 * Close a position. Called from the postback webhook when either
 * the STOP or TARGET trade row flips to COMPLETE, or from a
 * manual-close admin path.
 */
export async function closePosition(
  positionId: number,
  exitPrice: number,
  exitReason: 'STOP' | 'TARGET' | 'MANUAL' | 'CANCELLED',
): Promise<void> {
  await markPositionClosed(positionId, exitPrice, exitReason);
  // Reach back into the row to log the final PnL — harmless extra
  // SELECT, bought a legitimate log line for the operator.
  const row = await getPositionById(positionId);
  if (row) {
    console.log(
      `[positionMgr] CLOSED  id=${positionId}  ${row.symbol}  ` +
      `${row.entry_price} → ${exitPrice}  pnl=₹${row.pnl}  (${exitReason})`
    );
  }
}

export async function cancelPosition(positionId: number): Promise<void> {
  await markPositionCancelled(positionId);
  console.log(`[positionMgr] CANCELLED  id=${positionId}`);
}

/**
 * Runtime helper for dashboards / the ticker GET. Returns the raw
 * DB rows for open positions — the shape is stable because it's
 * the schema we defined.
 */
export async function listOpenPositions(): Promise<any[]> {
  return getOpenPositionsDb();
}

/**
 * In-memory helper for the risk manager. It computes unrealised
 * PnL on the open book given the current tick cache — pure
 * function over the DB snapshot, no writes.
 */
export function calculatePnL(
  row: {
    side: 'BUY' | 'SELL';
    entry_price: number | null;
    filled_quantity: number;
  },
  lastPrice: number,
): number {
  if (row.entry_price == null || row.entry_price <= 0) return 0;
  const qty = row.filled_quantity;
  return row.side === 'BUY'
    ? (lastPrice - row.entry_price) * qty
    : (row.entry_price - lastPrice) * qty;
}
