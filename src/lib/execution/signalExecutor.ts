// ════════════════════════════════════════════════════════════════
//  signalExecutor — tickBus('signal') → bracket order pipeline
//
//  End-to-end flow per signal:
//
//    tickBus('signal')
//         │
//         ▼
//    persist signal row (audit trail — success OR rejection)
//         │
//         ▼
//    riskManager.checkSignal(symbol, side)
//         │
//         ├─ reject → signal.outcome='risk_rejected', return
//         │
//         ▼
//    positionSizing.calculateQuantity(entry, stopLoss)
//         │
//         ├─ qty=0 (budget < stop dist) → outcome='risk_rejected'
//         │
//         ▼
//    positionManager.openPendingPosition   (DB row, id)
//         │
//         ▼
//    riskManager.recordAttempt (cooldown, pre-HTTP)
//         │
//         ▼
//    placeOrder(ENTRY, MARKET)
//         │
//         ├─ persist trade row, link to position+signal
//         │
//         ▼
//    placeOrder(STOP, SL-M)                      (if stopLoss present)
//    placeOrder(TARGET, LIMIT)                   (if target_1 present)
//         │
//         ▼
//    positionManager.linkOrders(entry, stop, target)
//         │
//         ▼
//    riskManager.recordFill (optimistic — confirmed later by postback)
//         │
//         ▼
//    tickBus.emit('trade', payload)
//
//  The real fill price + quantity are reconciled later by the
//  postback webhook at /api/kite/postback, which transitions the
//  position from PENDING → OPEN and eventually OPEN → CLOSED.
//
//  Fire-and-forget: the listener never awaits the async pipeline
//  inside the bus callback — blocking the bus on a 500ms Kite
//  round trip would stall every other signal.
// ════════════════════════════════════════════════════════════════

import { logger } from '@/lib/logger';
import { tickBus } from '@/lib/marketData/tickBus';
import { placeOrder } from './placeOrder';
import {
  checkSignal,
  recordAttempt,
  recordFill,
  getRiskStats,
} from './riskManager';
import { calculateQuantity, checkAggregateExposure, getSizingConfig } from './positionSizing';
import { openPendingPosition, linkOrders } from './positionManager';
import {
  saveSignal,
  updateSignalOutcome,
  saveTrade,
} from './persistence';

const log = logger.child({ component: 'signalExecutor' });

const GLOBAL_KEY = '__q365_signal_executor_registered__';

const PRODUCT: 'MIS' | 'CNC' | 'NRML' =
  (process.env.EXECUTION_PRODUCT as 'MIS' | 'CNC' | 'NRML') || 'MIS';

// ── Stale-tick guard ──────────────────────────────────────────
// The strategy runner fires signals from tick events. During a
// WebSocket disconnect, the tick cache goes cold — new ticks
// stop arriving, new signals stop being emitted. Self-gating in
// steady state.
//
// BUT: a signal that was already in flight (sizing + DB writes
// in progress) when the socket dropped can still reach placeOrder
// against a price that's now seconds stale. A live trading system
// must NEVER execute on cold data — market can gap while we're
// sleeping.
//
// This threshold is the hard floor on signal age at the moment
// we hit placeOrder. If the source tick is older than this, we
// reject the signal with reason='stale_tick' and the executor
// moves on. 5s is a comfortable default during market hours
// (typical tick cadence is 200-500ms on liquid names).
const MAX_SIGNAL_AGE_MS =
  Number(process.env.EXECUTION_MAX_SIGNAL_AGE_MS) || 5_000;

function isLive(): boolean {
  return String(process.env.EXECUTION_MODE ?? '').toLowerCase() === 'live';
}

// ── Stats (readable via getExecutorStats) ─────────────────────
const stats = {
  signalsSeen:     0,
  staleRejected:   0,
  riskRejected:    0,
  sizingRejected:  0,
  ordersSent:      0,
  ordersOk:        0,
  ordersFailed:    0,
  stopsPlaced:     0,
  targetsPlaced:   0,
  lastSymbol:      null as string | null,
  lastType:        null as 'BUY' | 'SELL' | null,
  lastOrderId:     null as string | null,
  lastPositionId:  null as number | null,
  lastError:       null as string | null,
  startedAt:       0,
};

export interface SignalPayload {
  symbol:       string;
  type:         'BUY' | 'SELL';
  price:        number;
  confidence?:  number;
  strategy?:    string | null;
  engineEntry?: number | null;
  stopLoss?:    number | null;
  target1?:     number | null;
  volume?:      number | null;
  quantity?:    number;
  timestamp?:   number;
}

async function handleSignal(signal: SignalPayload): Promise<void> {
  stats.signalsSeen += 1;
  stats.lastSymbol = signal.symbol;
  stats.lastType   = signal.type;

  // ── 0. Stale-tick guard — BEFORE anything else ────────────
  // Happens earliest so we spend zero DB writes / zero broker
  // calls on signals derived from cold data. If the tick that
  // produced this signal is older than MAX_SIGNAL_AGE_MS, the
  // market has moved on — reject cleanly.
  const tickAge = signal.timestamp ? Date.now() - signal.timestamp : 0;
  if (signal.timestamp && tickAge > MAX_SIGNAL_AGE_MS) {
    stats.staleRejected += 1;
    stats.lastError = `stale tick (${tickAge}ms)`;
    log.info('Stale tick rejected', { symbol: signal.symbol, tickAgeMs: tickAge, thresholdMs: MAX_SIGNAL_AGE_MS });
    return;
  }

  // ── 1. Persist signal (audit trail, whether or not we trade) ──
  const signalId = await saveSignal({
    symbol:      signal.symbol,
    side:        signal.type,
    price:       signal.price,
    confidence:  signal.confidence ?? null,
    strategy:    signal.strategy ?? null,
    stop_loss:   signal.stopLoss ?? null,
    target_1:    signal.target1 ?? null,
    engine_entry: signal.engineEntry ?? null,
    volume:      signal.volume ?? null,
  });

  // ── 2. Risk gate ──────────────────────────────────────────
  const decision = checkSignal(signal.symbol, signal.type);
  if (!decision.allow) {
    stats.riskRejected += 1;
    if (signalId) await updateSignalOutcome(signalId, 'risk_rejected', decision.reason);
    log.info('Signal blocked by risk gate', { type: signal.type, symbol: signal.symbol, reason: decision.reason });
    return;
  }

  // ── 3. Position sizing ────────────────────────────────────
  // Entry reference: prefer the live tick price (what we can
  // actually fill at right now) over the engine's entry.
  const entry = signal.price;
  const size = calculateQuantity({ entry, stopLoss: signal.stopLoss });
  if (size.quantity <= 0) {
    stats.sizingRejected += 1;
    if (signalId) await updateSignalOutcome(signalId, 'risk_rejected', size.reason);
    log.info('Sizing rejected', { symbol: signal.symbol, reason: size.reason });
    return;
  }
  log.info('Position sized', { symbol: signal.symbol, qty: size.quantity, notional: size.notional, atRisk: size.capitalAtRisk, reason: size.reason });

  // ── 3b. Portfolio-wide exposure gate ──────────────────────
  // Reads the open book and rejects if total notional would
  // exceed MAX_PORTFOLIO_NOTIONAL. Fails closed on DB error —
  // a flaky DB must NEVER silently admit a new trade.
  const exposure = await checkAggregateExposure(size.notional);
  if (!exposure.allow) {
    stats.sizingRejected += 1;
    if (signalId) await updateSignalOutcome(signalId, 'risk_rejected', exposure.reason);
    log.info('Exposure blocked', { symbol: signal.symbol, reason: exposure.reason });
    return;
  }

  // ── 4. Create a PENDING position row in the DB ────────────
  // Done BEFORE placing orders so the row exists to receive the
  // entry/stop/target order_ids as soon as placeOrder returns.
  const positionId = await openPendingPosition({
    symbol:          signal.symbol,
    side:            signal.type,
    quantity:        size.quantity,
    requested_price: entry,
    stop_loss:       signal.stopLoss ?? null,
    target_1:        signal.target1 ?? null,
    entry_signal_id: signalId,
    strategy:        signal.strategy ?? null,
    dry_run:         !isLive(),
  });
  stats.lastPositionId = positionId;

  // Mark the cooldown NOW — even if placeOrder blows up, we
  // don't want a flapping signal to retry immediately.
  recordAttempt(signal.symbol);

  // ── 5. Place the ENTRY order ──────────────────────────────
  stats.ordersSent += 1;
  const entryResult = await placeOrder({
    symbol:    signal.symbol,
    type:      signal.type,
    quantity:  size.quantity,
    product:   PRODUCT,
    orderType: 'MARKET',
  });

  await saveTrade({
    order_id:        entryResult.orderId ?? `FAIL-${Date.now()}-${signal.symbol}`,
    symbol:          signal.symbol,
    side:            signal.type,
    role:            'ENTRY',
    quantity:        size.quantity,
    requested_price: entry,
    status:          entryResult.ok ? 'OPEN' : 'FAILED',
    order_type:      'MARKET',
    product:         PRODUCT,
    position_id:     positionId,
    signal_id:       signalId,
    dry_run:         !!entryResult.dryRun,
    error:           entryResult.error ?? null,
  });

  if (!entryResult.ok) {
    stats.ordersFailed += 1;
    stats.lastError = entryResult.error ?? 'unknown';
    if (signalId) await updateSignalOutcome(signalId, 'order_failed', entryResult.error);
    log.error('Entry order failed', { symbol: signal.symbol, error: entryResult.error });
    return;
  }

  stats.ordersOk += 1;
  stats.lastOrderId = entryResult.orderId ?? null;
  stats.lastError = null;
  if (signalId) await updateSignalOutcome(signalId, 'order_placed');

  // ── 6. Bracket: STOP (SL-M) ───────────────────────────────
  // Opposite side of the entry. For a BUY entry, the stop is a
  // SELL SL-M that triggers when price drops to stopLoss.
  let stopOrderId: string | null = null;
  if (signal.stopLoss != null && signal.stopLoss > 0) {
    const stopSide: 'BUY' | 'SELL' = signal.type === 'BUY' ? 'SELL' : 'BUY';
    const stopResult = await placeOrder({
      symbol:       signal.symbol,
      type:         stopSide,
      quantity:     size.quantity,
      product:      PRODUCT,
      orderType:    'SL-M',
      triggerPrice: signal.stopLoss,
    });
    await saveTrade({
      order_id:        stopResult.orderId ?? `FAIL-${Date.now()}-STOP-${signal.symbol}`,
      parent_order_id: entryResult.orderId ?? null,
      symbol:          signal.symbol,
      side:            stopSide,
      role:            'STOP',
      quantity:        size.quantity,
      trigger_price:   signal.stopLoss,
      status:          stopResult.ok ? 'TRIGGER_PENDING' : 'FAILED',
      order_type:      'SL-M',
      product:         PRODUCT,
      position_id:     positionId,
      signal_id:       signalId,
      dry_run:         !!stopResult.dryRun,
      error:           stopResult.error ?? null,
    });
    if (stopResult.ok) {
      stopOrderId = stopResult.orderId ?? null;
      stats.stopsPlaced += 1;
    } else {
      log.error('Stop order failed — entry is live WITHOUT a stop', { symbol: signal.symbol, error: stopResult.error });
    }
  }

  // ── 7. Bracket: TARGET (LIMIT) ────────────────────────────
  let targetOrderId: string | null = null;
  if (signal.target1 != null && signal.target1 > 0) {
    const targetSide: 'BUY' | 'SELL' = signal.type === 'BUY' ? 'SELL' : 'BUY';
    const targetResult = await placeOrder({
      symbol:    signal.symbol,
      type:      targetSide,
      quantity:  size.quantity,
      product:   PRODUCT,
      orderType: 'LIMIT',
      price:     signal.target1,
    });
    await saveTrade({
      order_id:        targetResult.orderId ?? `FAIL-${Date.now()}-TGT-${signal.symbol}`,
      parent_order_id: entryResult.orderId ?? null,
      symbol:          signal.symbol,
      side:            targetSide,
      role:            'TARGET',
      quantity:        size.quantity,
      requested_price: signal.target1,
      status:          targetResult.ok ? 'OPEN' : 'FAILED',
      order_type:      'LIMIT',
      product:         PRODUCT,
      position_id:     positionId,
      signal_id:       signalId,
      dry_run:         !!targetResult.dryRun,
      error:           targetResult.error ?? null,
    });
    if (targetResult.ok) {
      targetOrderId = targetResult.orderId ?? null;
      stats.targetsPlaced += 1;
    }
  }

  // ── 8. Link bracket orders to the position row ────────────
  if (positionId) {
    await linkOrders(positionId, {
      entry:  entryResult.orderId,
      stop:   stopOrderId,
      target: targetOrderId,
    });
  }

  // ── 9. Optimistic in-memory fill (real fill lands via postback) ──
  recordFill({
    symbol:     signal.symbol,
    type:       signal.type,
    entryPrice: signal.price,
    qty:        size.quantity,
    openedAt:   Date.now(),
  });

  console.log(
    `[signalExecutor] ✓ ${signal.type} ${signal.symbol} qty=${size.quantity} ` +
    `@ ₹${signal.price}  pos=${positionId}  entry=${entryResult.orderId}` +
    `${stopOrderId ? ` stop=${stopOrderId}` : ''}` +
    `${targetOrderId ? ` tgt=${targetOrderId}` : ''}` +
    `${entryResult.dryRun ? '  (dry-run)' : ''}`
  );

  tickBus.emit('trade', {
    symbol:         signal.symbol,
    type:           signal.type,
    quantity:       size.quantity,
    price:          signal.price,
    positionId,
    entryOrderId:   entryResult.orderId,
    stopOrderId,
    targetOrderId,
    capitalAtRisk:  size.capitalAtRisk,
    notional:       size.notional,
    dryRun:         !!entryResult.dryRun,
    confidence:     signal.confidence,
    strategy:       signal.strategy,
    timestamp:      Date.now(),
  });
}

/**
 * Install the bus listener. Idempotent — calling twice is a no-op
 * so bootTicker and lazy-boot paths can both call it safely.
 */
export function registerSignalExecutor(): void {
  const g = globalThis as unknown as Record<string, boolean | undefined>;
  if (g[GLOBAL_KEY]) {
    return;
  }
  g[GLOBAL_KEY] = true;
  stats.startedAt = Date.now();

  tickBus.on('signal', (signal: SignalPayload) => {
    // Fire-and-forget — must not block the bus callback.
    handleSignal(signal).catch((err) => {
      stats.ordersFailed += 1;
      stats.lastError = err?.message ?? 'handler threw';
      console.error(
        `[signalExecutor] handler threw for ${signal?.symbol}:`,
        err?.message,
      );
    });
  });

  console.log(
    `[signalExecutor] registered  mode=${isLive() ? '🔴 LIVE' : '🟡 DRY-RUN'}  ` +
    `product=${PRODUCT}  sizing=${JSON.stringify(getSizingConfig())}`
  );
}

export function getExecutorStats() {
  return {
    ...stats,
    risk:    getRiskStats(),
    sizing:  getSizingConfig(),
    mode:    isLive() ? 'live' : 'dry',
    product: PRODUCT,
    uptimeMs: stats.startedAt ? Date.now() - stats.startedAt : 0,
  };
}
