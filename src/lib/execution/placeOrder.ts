// ════════════════════════════════════════════════════════════════
//  placeOrder — thin wrapper around Kite's /orders/regular POST
//
//  Kite docs: https://kite.trade/docs/connect/v3/orders/
//
//  Request:
//    POST https://api.kite.trade/orders/regular
//    Headers:
//      X-Kite-Version: 3
//      Authorization: token <api_key>:<access_token>
//      Content-Type:  application/x-www-form-urlencoded
//    Body (form):
//      tradingsymbol    e.g. TITAN
//      exchange         NSE
//      transaction_type BUY | SELL
//      order_type       MARKET | LIMIT | SL | SL-M
//      quantity         integer
//      product          MIS (intraday) | CNC (delivery) | NRML
//      validity         DAY | IOC
//      (LIMIT only)     price
//      (SL / SL-M only) trigger_price
//
//  Response (success):
//    { status: "success", data: { order_id: "240627000001234" } }
//
//  ─── SAFETY: DRY-RUN MODE ──────────────────────────────────────
//  Live order placement is gated by EXECUTION_MODE=live. Any
//  other value (including unset) runs in dry-run mode: the
//  function logs what it WOULD send and returns a synthetic
//  success without hitting the Kite API. This keeps an
//  accidentally-wired signal loop from placing real trades on
//  a dev box.
// ════════════════════════════════════════════════════════════════

import { logger } from '@/lib/logger';
import { getKiteAccessToken } from '@/lib/marketData/kiteSession';

const log = logger.child({ component: 'placeOrder' });
const KITE_API_BASE = 'https://api.kite.trade';
const TIMEOUT_MS = 5000;

export interface PlaceOrderParams {
  symbol: string;
  type: 'BUY' | 'SELL';
  quantity: number;
  product?: 'MIS' | 'CNC' | 'NRML';
  orderType?: 'MARKET' | 'LIMIT' | 'SL' | 'SL-M';
  price?: number;         // required for LIMIT / SL
  triggerPrice?: number;  // required for SL / SL-M
  exchange?: 'NSE' | 'BSE';
}

export interface PlaceOrderResult {
  ok: boolean;
  orderId?: string;
  dryRun: boolean;
  error?: string;
  raw?: unknown;
}

function isLive(): boolean {
  return String(process.env.EXECUTION_MODE ?? '').toLowerCase() === 'live';
}

export async function placeOrder(params: PlaceOrderParams): Promise<PlaceOrderResult> {
  const {
    symbol,
    type,
    quantity,
    product   = 'MIS',
    orderType = 'MARKET',
    price,
    triggerPrice,
    exchange  = 'NSE',
  } = params;

  if (!Number.isFinite(quantity) || quantity <= 0) {
    return { ok: false, dryRun: !isLive(), error: 'quantity must be > 0' };
  }
  if (orderType === 'LIMIT' && (price == null || price <= 0)) {
    return { ok: false, dryRun: !isLive(), error: 'LIMIT order requires price' };
  }
  if ((orderType === 'SL' || orderType === 'SL-M') && (triggerPrice == null || triggerPrice <= 0)) {
    return { ok: false, dryRun: !isLive(), error: `${orderType} order requires triggerPrice` };
  }

  // ─── DRY RUN ─────────────────────────────────────────────
  if (!isLive()) {
    const fakeId = `DRY-${Date.now()}-${symbol}`;
    console.log(
      `[placeOrder] 🟡 DRY-RUN  ${type} ${quantity} ${symbol} ` +
      `@ ${orderType}${price ? ` ₹${price}` : ''}  product=${product}  fakeId=${fakeId}`
    );
    return { ok: true, orderId: fakeId, dryRun: true };
  }

  // ─── LIVE ────────────────────────────────────────────────
  const apiKey = process.env.KITE_API_KEY;
  const accessToken = await getKiteAccessToken();
  if (!apiKey || !accessToken) {
    return {
      ok: false,
      dryRun: false,
      error: 'Kite credentials missing — cannot place live order',
    };
  }

  const body = new URLSearchParams({
    tradingsymbol:    symbol,
    exchange,
    transaction_type: type,
    order_type:       orderType,
    quantity:         String(Math.floor(quantity)),
    product,
    validity:         'DAY',
  });
  if (orderType === 'LIMIT' && price != null) body.set('price', String(price));
  if ((orderType === 'SL' || orderType === 'SL-M') && triggerPrice != null) {
    body.set('trigger_price', String(triggerPrice));
    if (orderType === 'SL' && price != null) body.set('price', String(price));
  }

  console.warn(
    `[placeOrder] 🔴 LIVE  ${type} ${quantity} ${symbol} ` +
    `@ ${orderType}${price ? ` ₹${price}` : ''}  product=${product}`
  );

  try {
    const res = await fetch(`${KITE_API_BASE}/orders/regular`, {
      method: 'POST',
      headers: {
        'X-Kite-Version': '3',
        'Authorization':  `token ${apiKey}:${accessToken}`,
        'Content-Type':   'application/x-www-form-urlencoded',
      },
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    const json: any = await res.json().catch(() => ({}));
    if (!res.ok || json?.status !== 'success' || !json?.data?.order_id) {
      const reason = json?.message ?? `HTTP ${res.status}`;
      console.error(`[placeOrder] ✗ ${symbol}  ${reason}`);
      return { ok: false, dryRun: false, error: reason, raw: json };
    }

    const orderId = json.data.order_id as string;
    console.log(`[placeOrder] ✓ ${symbol}  order_id=${orderId}`);
    return { ok: true, orderId, dryRun: false, raw: json };
  } catch (err: any) {
    console.error(`[placeOrder] exception for ${symbol}:`, err?.message);
    return { ok: false, dryRun: false, error: err?.message ?? 'fetch failed' };
  }
}
