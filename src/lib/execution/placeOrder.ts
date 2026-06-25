// ════════════════════════════════════════════════════════════════
//  placeOrder — routes through Broker Integration Layer
//
//  EXECUTION_MODE=live  → live order engine (gated)
//  EXECUTION_MODE=paper → paper adapter
//  default (signal-only)→ dry-run stub (safe no-op)
// ════════════════════════════════════════════════════════════════

export interface PlaceOrderParams {
  symbol: string;
  type:   'BUY' | 'SELL';
  quantity: number;
  product?:     'MIS' | 'CNC' | 'NRML';
  orderType?:   'MARKET' | 'LIMIT' | 'SL' | 'SL-M';
  price?:        number;
  triggerPrice?: number;
  exchange?:    'NSE' | 'BSE';
  userId?:       number;
  strategyId?:   string;
}

export interface PlaceOrderResult {
  ok: boolean;
  orderId?: string;
  dryRun:   boolean;
  error?:   string;
  raw?:     unknown;
}

const EXECUTION_MODE = process.env.EXECUTION_MODE ?? 'signal-only';

export async function placeOrder(params: PlaceOrderParams): Promise<PlaceOrderResult> {
  if (EXECUTION_MODE === 'signal-only') {
    return {
      ok:     false,
      dryRun: true,
      error:  'signal-only mode — set EXECUTION_MODE=live or paper to enable',
    };
  }

  const userId = params.userId ?? Number(process.env.EXECUTION_USER_ID ?? 0);
  if (!userId) {
    return { ok: false, dryRun: true, error: 'userId required for broker orders' };
  }

  const { placeLiveOrder } = await import('@/lib/broker');
  const result = await placeLiveOrder(userId, {
    symbol: params.symbol,
    side: params.type,
    quantity: params.quantity,
    orderType: params.orderType ?? 'MARKET',
    price: params.price,
    triggerPrice: params.triggerPrice,
    product: params.product,
    exchange: params.exchange,
    strategyId: params.strategyId,
  });

  return {
    ok: result.ok,
    orderId: result.orderId ?? result.brokerOrderId,
    dryRun: result.dryRun ?? false,
    error: result.error,
    raw: result,
  };
}
