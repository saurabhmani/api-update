// ════════════════════════════════════════════════════════════════
//  cancelOrder — DELETE /orders/:variety/:order_id
//
//  Kite doc: https://kite.trade/docs/connect/v3/orders/#cancelling-orders
//
//  Used by the postback handler for OCO (one-cancels-other)
//  cleanup: when STOP completes, we cancel the orphaned TARGET;
//  when TARGET completes, we cancel the orphaned STOP. Without
//  this, the surviving leg sits in Kite's order book and can
//  execute unintentionally the moment price ticks back — a
//  classic production disaster.
//
//  Dry-run mode returns a synthetic success without hitting the
//  broker, consistent with placeOrder. A DRY-... orderId (which is
//  what dry-run placeOrder hands out) is treated as a no-op
//  cancel — there's nothing to cancel on Kite's side.
// ════════════════════════════════════════════════════════════════

import { logger } from '@/lib/logger';
import { getKiteAccessToken } from '@/lib/marketData/kiteSession';

const log = logger.child({ component: 'cancelOrder' });
const KITE_API_BASE = 'https://api.kite.trade';
const TIMEOUT_MS = 5000;

export interface CancelOrderResult {
  ok:     boolean;
  dryRun: boolean;
  error?: string;
}

function isLive(): boolean {
  return String(process.env.EXECUTION_MODE ?? '').toLowerCase() === 'live';
}

export async function cancelOrder(
  orderId: string,
  variety: 'regular' | 'bo' | 'co' | 'amo' = 'regular',
): Promise<CancelOrderResult> {
  if (!orderId) {
    return { ok: false, dryRun: !isLive(), error: 'orderId required' };
  }

  // Dry-run fake orderIds don't exist at the broker — canceling
  // them is a no-op. Return success so the caller's logic runs
  // unmodified.
  if (orderId.startsWith('DRY-')) {
    console.log(`[cancelOrder] 🟡 DRY-RUN cancel  ${orderId}`);
    return { ok: true, dryRun: true };
  }

  if (!isLive()) {
    console.log(`[cancelOrder] 🟡 DRY-RUN cancel (mode=dry)  ${orderId}`);
    return { ok: true, dryRun: true };
  }

  const apiKey = process.env.KITE_API_KEY;
  const accessToken = await getKiteAccessToken();
  if (!apiKey || !accessToken) {
    return { ok: false, dryRun: false, error: 'Kite credentials missing' };
  }

  try {
    const res = await fetch(
      `${KITE_API_BASE}/orders/${variety}/${encodeURIComponent(orderId)}`,
      {
        method:  'DELETE',
        headers: {
          'X-Kite-Version': '3',
          'Authorization':  `token ${apiKey}:${accessToken}`,
        },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      },
    );

    const json: any = await res.json().catch(() => ({}));
    if (!res.ok || json?.status !== 'success') {
      // Already-cancelled / already-complete orders come back with
      // an error from Kite. That's fine for our purposes: the
      // order is no longer active, which is what we wanted. We
      // log and return ok=true so the caller doesn't treat a
      // benign "order not found" as a failure.
      const msg = String(json?.message ?? '').toLowerCase();
      if (msg.includes('not found') || msg.includes('already') || msg.includes('complete')) {
        console.log(`[cancelOrder] ${orderId} already terminal: ${json?.message}`);
        return { ok: true, dryRun: false };
      }
      const reason = json?.message ?? `HTTP ${res.status}`;
      console.error(`[cancelOrder] ✗ ${orderId}  ${reason}`);
      return { ok: false, dryRun: false, error: reason };
    }

    console.log(`[cancelOrder] ✓ ${orderId}  cancelled`);
    return { ok: true, dryRun: false };
  } catch (err: any) {
    console.error(`[cancelOrder] exception for ${orderId}:`, err?.message);
    return { ok: false, dryRun: false, error: err?.message ?? 'fetch failed' };
  }
}
