// ════════════════════════════════════════════════════════════════
//  cancelOrder — NEUTRALIZED STUB
//
//  Broker execution removed. Signal-only mode has no orders to cancel.
// ════════════════════════════════════════════════════════════════

export interface CancelOrderResult {
  ok:     boolean;
  dryRun: boolean;
  error?: string;
}

export async function cancelOrder(
  _orderId: string,
  _variety: 'regular' | 'bo' | 'co' | 'amo' = 'regular',
): Promise<CancelOrderResult> {
  return { ok: true, dryRun: true };
}
