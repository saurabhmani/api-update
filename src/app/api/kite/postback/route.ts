// ════════════════════════════════════════════════════════════════
//  POST /api/kite/postback
//
//  Kite Connect calls this endpoint whenever an order's state
//  changes at the broker. The handler is the reconciliation leg
//  of the execution pipeline:
//
//    broker fill  →  postback POST  →  update trade row
//                                  →  transition position state
//                                  →  release risk manager slot
//
//  Kite body (JSON):
//    {
//      user_id, unix_timestamp, app_id, status, status_message,
//      order_id, exchange_order_id, parent_order_id,
//      tradingsymbol, exchange, order_type, transaction_type,
//      product, variety, quantity, filled_quantity,
//      pending_quantity, cancelled_quantity,
//      average_price, price, trigger_price,
//      market_protection, disclosed_quantity, placed_by,
//      order_timestamp, exchange_timestamp, exchange_update_timestamp,
//      checksum                       ← sha256(order_id + order_timestamp + api_secret)
//    }
//
//  ─── Authenticity ─────────────────────────────────────────────
//  Kite signs each postback with:
//      sha256(order_id + order_timestamp + api_secret)
//  We recompute and reject mismatches with 401. In development
//  you can disable this with KITE_POSTBACK_SKIP_CHECKSUM=1 so
//  hand-crafted curl payloads still work, but it MUST stay on in
//  production or any attacker who knows the webhook URL could
//  synthesise fake fills.
//
//  ─── Idempotency ──────────────────────────────────────────────
//  Kite retries postbacks on 5xx, so the same state message can
//  arrive multiple times. Every handler call goes through
//  updateTradeFromPostback, which is a single UPDATE — repeat
//  delivery just re-writes the same row. Position transitions
//  are guarded by `WHERE status = 'OPEN'` / `WHERE status IN
//  ('PENDING','OPEN')` so second delivery is a no-op.
// ════════════════════════════════════════════════════════════════

import crypto from 'crypto';
import { NextRequest, NextResponse } from 'next/server';
import { ensureExecutionSchema } from '@/lib/execution/schema';
import {
  updateTradeFromPostback,
  type PostbackUpdate,
} from '@/lib/execution/persistence';
import { updatePosition } from '@/lib/portfolio/positionManager';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

function verifyChecksum(body: any): { ok: boolean; reason?: string } {
  if (process.env.KITE_POSTBACK_SKIP_CHECKSUM === '1') {
    return { ok: true };
  }
  const apiSecret = process.env.KITE_API_SECRET;
  if (!apiSecret) {
    return { ok: false, reason: 'KITE_API_SECRET not configured' };
  }
  const { order_id, order_timestamp, checksum } = body ?? {};
  if (!order_id || !order_timestamp || !checksum) {
    return { ok: false, reason: 'missing order_id / order_timestamp / checksum' };
  }
  const expected = crypto
    .createHash('sha256')
    .update(String(order_id) + String(order_timestamp) + apiSecret)
    .digest('hex');
  if (expected !== checksum) {
    return { ok: false, reason: 'checksum mismatch' };
  }
  return { ok: true };
}

export async function POST(req: NextRequest) {
  try {
    await ensureExecutionSchema();

    const body = await req.json().catch(() => ({}));

    // ── Authenticity ─────────────────────────────────────
    const auth = verifyChecksum(body);
    if (!auth.ok) {
      console.warn(`[postback] ✗ rejected — ${auth.reason}`);
      return NextResponse.json({ ok: false, error: auth.reason }, { status: 401 });
    }

    const update: PostbackUpdate = {
      order_id:           String(body.order_id ?? ''),
      status:             String(body.status ?? 'UNKNOWN'),
      status_message:     body.status_message ?? null,
      filled_quantity:    body.filled_quantity != null ? Number(body.filled_quantity) : null,
      pending_quantity:   body.pending_quantity != null ? Number(body.pending_quantity) : null,
      average_price:      body.average_price != null ? Number(body.average_price) : null,
      exchange_timestamp: body.exchange_timestamp ?? null,
    };

    if (!update.order_id) {
      return NextResponse.json({ ok: false, error: 'missing order_id' }, { status: 400 });
    }

    console.log(
      `[postback] ← ${update.order_id}  status=${update.status}  ` +
      `filled=${update.filled_quantity ?? '-'}  avg=₹${update.average_price ?? '-'}`
    );

    // ── Write-through to the trade row ───────────────────
    const res = await updateTradeFromPostback(update);
    if (!res.found) {
      // Either the order was placed outside this process, or the
      // trade row hasn't been committed yet (unlikely race since
      // INSERT happens synchronously before HTTP returns from
      // placeOrder). ACK 200 so Kite doesn't retry forever.
      return NextResponse.json({ ok: true, note: 'unknown order_id' });
    }

    // ── Delegate to the position manager ─────────────────
    //
    // The six-branch state machine (partial fills, OCO cancel,
    // manager bus events, risk slot release) lives in
    // src/lib/portfolio/positionManager.ts → updatePosition().
    // This route's only jobs are: verify authenticity, update
    // the trade row, and hand the normalised update off to the
    // manager. One place to reason about state. One place to
    // test.
    if (res.positionId && res.role && res.symbol && res.side) {
      const decision = await updatePosition({
        orderId:        update.order_id,
        positionId:     res.positionId,
        role:           res.role,
        symbol:         res.symbol,
        side:           res.side,
        status:         update.status,
        averagePrice:   update.average_price ?? null,
        filledQuantity: update.filled_quantity ?? null,
      });
      console.log(
        `[postback] ${update.order_id}  role=${res.role}  → ${decision.action}` +
        (decision.reason ? `  (${decision.reason})` : '')
      );
    }

    return NextResponse.json({ ok: true });
  } catch (err: any) {
    console.error('[POST /api/kite/postback] failed:', err?.message);
    // Return 500 so Kite retries — the error is likely transient
    // (DB blip, schema migration in flight). Only permanent
    // failures should swallow the retry signal, and those come
    // back through the 401 / 400 paths above.
    return NextResponse.json({ ok: false, error: err?.message }, { status: 500 });
  }
}

export async function GET() {
  return NextResponse.json({ ok: true, endpoint: 'kite postback' });
}
