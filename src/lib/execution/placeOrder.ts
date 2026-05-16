// ════════════════════════════════════════════════════════════════
//  placeOrder — NEUTRALIZED STUB
//
//  Broker execution removed. This module used to wrap Kite REST for
//  POST /orders/regular. Signal-only mode never places orders; every
//  call returns ok:false / dryRun:true so any leftover caller fails
//  safely and visibly instead of hitting a broker.
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
}

export interface PlaceOrderResult {
  ok: boolean;
  orderId?: string;
  dryRun:   boolean;
  error?:   string;
  raw?:     unknown;
}

export async function placeOrder(_params: PlaceOrderParams): Promise<PlaceOrderResult> {
  return {
    ok:     false,
    dryRun: true,
    error:  'execution_removed — signal-only mode',
  };
}
