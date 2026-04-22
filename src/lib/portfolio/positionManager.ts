// ════════════════════════════════════════════════════════════════
//  src/lib/portfolio/positionManager.ts
//
//  Public position management API — the single entry point code
//  outside the execution subsystem should use when it needs to
//  open, update, close, or inspect a position.
//
//  This is a FACADE over the DB-backed primitives in
//  src/lib/execution/positionManager.ts and src/lib/execution/
//  persistence.ts. Nothing in here reimplements state — it just
//  exposes a clean, task-shaped API:
//
//    openPosition(trade)          → number | null   (position_id)
//    updatePosition(orderUpdate)  → UpdateResult
//    closePosition(positionId, …) → void
//    calculatePnL(input)          → number
//
//  The postback route calls updatePosition() with the normalised
//  order update; the signal executor calls openPosition() when a
//  signal clears the risk/sizing gates.
//
//  Partial-fill, OCO, and PnL rules all live inside updatePosition
//  so there is exactly ONE place in the codebase that decides
//  when a position transitions PENDING → OPEN → CLOSED. If you
//  find yourself writing an "if status ..." block on a position
//  row outside this file, you're doing it wrong.
// ════════════════════════════════════════════════════════════════

import { tickBus } from '@/lib/marketData/tickBus';
import { recordClose } from '@/lib/execution/riskManager';
import { cancelOrder } from '@/lib/execution/cancelOrder';
import {
  openPendingPosition as _openPendingPosition,
  linkOrders as _linkOrders,
  markOpen as _markOpen,
  closePosition as _closePosition,
  cancelPosition as _cancelPosition,
  listOpenPositions as _listOpenPositions,
  type OpenPositionInput,
} from '@/lib/execution/positionManager';
import { getPositionBracket } from '@/lib/execution/persistence';

// ── Public types ──────────────────────────────────────────────

export type Side     = 'BUY' | 'SELL';
export type OrderRole = 'ENTRY' | 'STOP' | 'TARGET';

/**
 * Shape passed to openPosition. This is what the signal executor
 * already constructs after sizing: a validated intent to trade,
 * BEFORE the broker has been touched. We create the DB row in
 * PENDING state so the subsequent placeOrder calls can link
 * their order_ids back to the position.
 */
export interface OpenPositionTrade {
  symbol:     string;
  side:       Side;
  quantity:   number;
  /** Reference price (live tick or engine entry). The REAL fill
   *  price arrives later via the postback and overwrites this. */
  entryPrice: number;
  stopLoss?:  number | null;
  target?:    number | null;
  strategy?:  string | null;
  signalId?:  number | null;
  dryRun?:    boolean;
}

/**
 * Shape passed to updatePosition. A denormalised view of a Kite
 * postback with only the fields the position state machine
 * cares about. The postback route normalises the raw JSON into
 * this shape after it has verified the checksum and updated the
 * underlying trade row.
 */
export interface OrderUpdate {
  orderId:          string;
  positionId:       number;
  role:             OrderRole;
  symbol:           string;
  side:             Side;
  status:           string;
  averagePrice?:    number | null;
  filledQuantity?:  number | null;
}

export interface UpdateResult {
  action:
    | 'noop'
    | 'entry_partial'     // filled > 0, status not terminal
    | 'entry_full'        // filled = quantity, status = COMPLETE
    | 'entry_partial_cancelled' // filled > 0 then CANCELLED — keeps OPEN
    | 'entry_cancelled'   // filled = 0, CANCELLED/REJECTED
    | 'stop_hit'
    | 'target_hit'
    | 'sibling_cancelled'; // normal OCO echo — ignored
  reason?: string;
}

export interface PnLInput {
  side:         Side;
  entryPrice:   number;
  quantity:     number;
  /** When present → realised PnL (use for CLOSED positions) */
  exitPrice?:   number | null;
  /** When exitPrice is absent → unrealised PnL at currentPrice */
  currentPrice?: number | null;
}

// Terminal statuses from Kite — keep in sync with the postback
// route; duplicating the sets here so this file can be imported
// in isolation (unit tests, CLI tools).
const STATUS_FILLED    = new Set(['COMPLETE']);
const STATUS_CANCELLED = new Set(['CANCELLED', 'REJECTED']);

// ── 1. openPosition ───────────────────────────────────────────
//
// Called from signalExecutor AFTER all risk / sizing gates have
// passed. Creates a PENDING row so the executor has a position_id
// to link trade rows to, BEFORE any broker call. The order_ids
// are attached later via linkOrders once placeOrder returns.

export async function openPosition(
  trade: OpenPositionTrade,
): Promise<number | null> {
  const input: OpenPositionInput = {
    symbol:          trade.symbol,
    side:            trade.side,
    quantity:        trade.quantity,
    requested_price: trade.entryPrice,
    stop_loss:       trade.stopLoss ?? null,
    target_1:        trade.target ?? null,
    entry_signal_id: trade.signalId ?? null,
    strategy:        trade.strategy ?? null,
    dry_run:         !!trade.dryRun,
  };
  return _openPendingPosition(input);
}

/** Thin passthrough so the executor can wire up broker order_ids
 *  to the position row after placeOrder returns. Kept on the
 *  facade so execution internals stay behind one import path. */
export async function linkPositionOrders(
  positionId: number,
  orders: { entry?: string | null; stop?: string | null; target?: string | null },
): Promise<void> {
  await _linkOrders(positionId, orders);
}

// ── 2. updatePosition ─────────────────────────────────────────
//
// The six-branch state machine. This is the ONLY function that
// decides when a position transitions state in response to a
// broker fill. Every branch is idempotent — a repeated delivery
// from Kite's retry logic ends up writing the same row state,
// so we can safely process the same update twice.
//
// Branch map:
//
//   A. ENTRY  + filled > 0 (any status)    → mark OPEN at weighted avg
//      A1. partial then CANCELLED           → keep OPEN, warn (stop/target
//                                              now oversized vs filled)
//   B. ENTRY  + filled = 0 + CANCELLED/REJ → cancel, release risk slot
//   C. STOP   + COMPLETE                   → close(STOP)   + OCO target
//   D. TARGET + COMPLETE                   → close(TARGET) + OCO stop
//   E. STOP/TARGET + CANCELLED             → noop (our own OCO echo)
//

export async function updatePosition(u: OrderUpdate): Promise<UpdateResult> {
  const avg    = u.averagePrice ?? 0;
  const filled = u.filledQuantity ?? 0;
  const isFilled    = STATUS_FILLED.has(u.status);
  const isCancelled = STATUS_CANCELLED.has(u.status);

  // ── ENTRY branches ────────────────────────────────────────
  if (u.role === 'ENTRY') {
    if (filled > 0 && avg > 0) {
      // A: partial OR full fill — transition to OPEN at weighted avg.
      // markOpen uses COALESCE(filled_at, CURRENT_TIMESTAMP) so
      // progressive partials don't rewind the timestamp.
      await _markOpen(u.positionId, avg, filled);

      tickBus.emit('position:open', {
        positionId: u.positionId,
        symbol:     u.symbol,
        side:       u.side,
        fillPrice:  avg,
        quantity:   filled,
        partial:    !isFilled,
      });

      if (isCancelled) {
        // A1: partial then cancelled. Stop/target were placed for
        // the full requested quantity and now over-size the
        // actual position. Flag it loudly — an auto-rebalance of
        // stop/target qty is future work (modify-order flow).
        console.warn(
          `[positionMgr] ⚠ PARTIAL ENTRY then CANCELLED  pos=${u.positionId}  ` +
          `filled=${filled} — stop/target qty exceeds filled qty; manual review`
        );
        return { action: 'entry_partial_cancelled', reason: 'filled portion kept OPEN' };
      }

      return {
        action: isFilled ? 'entry_full' : 'entry_partial',
        reason: `filled=${filled} avg=₹${avg}`,
      };
    }

    if (isCancelled) {
      // B: zero-fill cancel or reject. Nothing ever touched the
      // market → drop the whole position and release the risk
      // slot so the next signal on this symbol isn't blocked.
      await _cancelPosition(u.positionId);
      recordClose(u.symbol);

      tickBus.emit('position:cancel', {
        positionId: u.positionId,
        symbol:     u.symbol,
        reason:     u.status,
      });

      return { action: 'entry_cancelled', reason: u.status };
    }

    return { action: 'noop', reason: 'entry update with no fill and not terminal' };
  }

  // ── STOP branch (C) ───────────────────────────────────────
  if (u.role === 'STOP') {
    if (isFilled && avg > 0 && filled > 0) {
      await _closePosition(u.positionId, avg, 'STOP');
      recordClose(u.symbol);

      tickBus.emit('position:close', {
        positionId: u.positionId,
        symbol:     u.symbol,
        exitPrice:  avg,
        reason:     'STOP',
      });

      // OCO: cancel the orphaned TARGET order so it can't fire
      // on a price rebound. Fire-and-forget — the DB state is
      // already settled, this cleanup is opportunistic.
      void cancelSibling(u.positionId, 'STOP');
      return { action: 'stop_hit', reason: `exit=${avg}` };
    }
    if (isCancelled) return { action: 'sibling_cancelled' };
    return { action: 'noop' };
  }

  // ── TARGET branch (D) ─────────────────────────────────────
  if (u.role === 'TARGET') {
    if (isFilled && avg > 0 && filled > 0) {
      await _closePosition(u.positionId, avg, 'TARGET');
      recordClose(u.symbol);

      tickBus.emit('position:close', {
        positionId: u.positionId,
        symbol:     u.symbol,
        exitPrice:  avg,
        reason:     'TARGET',
      });

      void cancelSibling(u.positionId, 'TARGET');
      return { action: 'target_hit', reason: `exit=${avg}` };
    }
    if (isCancelled) return { action: 'sibling_cancelled' };
    return { action: 'noop' };
  }

  return { action: 'noop' };
}

// OCO helper — kept internal to this file so the state machine
// and the cleanup live together.
async function cancelSibling(
  positionId: number,
  firedRole: 'STOP' | 'TARGET',
): Promise<void> {
  const bracket = await getPositionBracket(positionId);
  if (!bracket) return;
  const siblingOrderId =
    firedRole === 'STOP' ? bracket.target_order_id : bracket.stop_order_id;
  if (!siblingOrderId) return;

  const result = await cancelOrder(siblingOrderId);
  if (!result.ok) {
    console.warn(
      `[positionMgr] OCO cancel failed  pos=${positionId}  sibling=${siblingOrderId}  err=${result.error}`
    );
  } else {
    console.log(
      `[positionMgr] OCO cancelled sibling  pos=${positionId}  ` +
      `leg=${firedRole === 'STOP' ? 'TARGET' : 'STOP'}  ${siblingOrderId}`
    );
  }
}

// ── 3. closePosition ──────────────────────────────────────────
//
// Direct manual close path — admin dashboards, force-exit on a
// stale position, end-of-day flatten. The normal path is through
// updatePosition above, which handles STOP/TARGET fills from the
// postback. Use this one for "I know what I'm doing" scenarios.

export async function closePosition(
  positionId: number,
  exitPrice: number,
  reason: 'STOP' | 'TARGET' | 'MANUAL' | 'CANCELLED' = 'MANUAL',
): Promise<void> {
  await _closePosition(positionId, exitPrice, reason);
}

// ── 4. calculatePnL ───────────────────────────────────────────
//
// Pure function. If `exitPrice` is provided → realised PnL for a
// closed position. If `currentPrice` is provided → unrealised PnL
// for an open position marked to the latest tick. Side-aware: a
// SHORT entry profits as price falls.
//
// Formula:
//   BUY  → (exit - entry) × qty
//   SELL → (entry - exit) × qty

export function calculatePnL(input: PnLInput): number {
  const { side, entryPrice, quantity } = input;
  if (!Number.isFinite(entryPrice) || entryPrice <= 0 || quantity <= 0) return 0;

  const exit = input.exitPrice ?? input.currentPrice ?? null;
  if (exit == null || !Number.isFinite(exit)) return 0;

  return side === 'BUY'
    ? (exit - entryPrice) * quantity
    : (entryPrice - exit) * quantity;
}

/** Percentage variant — handy for dashboards. Safe against /0. */
export function calculatePnLPct(input: PnLInput): number {
  const pnl = calculatePnL(input);
  if (!pnl || input.entryPrice <= 0 || input.quantity <= 0) return 0;
  const notional = input.entryPrice * input.quantity;
  return (pnl / notional) * 100;
}

// ── Read helpers ──────────────────────────────────────────────

export async function listOpenPositions(): Promise<any[]> {
  return _listOpenPositions();
}
