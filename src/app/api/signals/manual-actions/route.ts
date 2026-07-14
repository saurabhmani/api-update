import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/lib/session';
import { db } from '@/lib/db';
import {
  PRODUCT_A_ALLOWED_ACTIONS,
  PRODUCT_A_PROHIBITED_ACTIONS,
  isProhibitedAction,
  computeManualPositionSizing,
  formatTradePlanCopy,
} from '@/lib/signals/manualExecutionSupport';

export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store, no-cache, must-revalidate' } as const;

/**
 * Phase 9 — Manual signal actions (Product A).
 *
 * Allowed: watchlist, price/lifecycle alerts, journal, sizing calculator, copy plan.
 * Prohibited: place_order, auto_execute/modify/close, broker credentials.
 */
export async function GET() {
  return NextResponse.json(
    {
      contractVersion: '9.0.0',
      allowedActions: PRODUCT_A_ALLOWED_ACTIONS,
      prohibitedActions: PRODUCT_A_PROHIBITED_ACTIONS,
      note: 'Product A is manual-execution only.',
    },
    { headers: NO_STORE },
  );
}

export async function POST(req: NextRequest) {
  try {
    const user = await requireSession();
    const body = await req.json();
    const action = String(body.action ?? '');

    if (isProhibitedAction(action)) {
      return NextResponse.json(
        {
          error: 'Action prohibited in Product A',
          prohibited: action,
          allowedActions: PRODUCT_A_ALLOWED_ACTIONS,
        },
        { status: 400, headers: NO_STORE },
      );
    }

    if (action === 'capital_risk_calculator') {
      const sizing = computeManualPositionSizing({
        capitalInr: Number(body.capitalInr),
        entry: Number(body.entry),
        stopLoss: Number(body.stopLoss),
        riskPct: Number(body.riskPct ?? 1),
      });
      return NextResponse.json({ sizing }, { headers: NO_STORE });
    }

    if (action === 'copy_trade_plan') {
      const text = formatTradePlanCopy({
        symbol: String(body.symbol ?? ''),
        direction: String(body.direction ?? 'BUY'),
        entry: body.entry ?? null,
        stop: body.stop ?? null,
        target1: body.target1 ?? null,
        target2: body.target2 ?? null,
        target3: body.target3 ?? null,
        rewardRisk: body.rewardRisk ?? null,
        validUntil: body.validUntil ?? null,
      });
      return NextResponse.json({ text }, { headers: NO_STORE });
    }

    if (action === 'add_to_watchlist') {
      const instrumentKey = body.instrument_key || `NSE_EQ|${body.symbol}`;
      const symbol = String(body.symbol || instrumentKey.split('|')[1] || '').toUpperCase();
      if (!symbol) {
        return NextResponse.json({ error: 'symbol required' }, { status: 400, headers: NO_STORE });
      }
      const { rows: wl } = await db.query(
        `SELECT id FROM watchlists WHERE user_id=? LIMIT 1`,
        [user.id],
      );
      let watchlistId = wl[0]?.id as number | undefined;
      if (!watchlistId) {
        await db.query(`INSERT INTO watchlists (user_id, name) VALUES (?, 'Default')`, [user.id]);
        const { rows: wl2 } = await db.query(
          `SELECT id FROM watchlists WHERE user_id=? LIMIT 1`,
          [user.id],
        );
        watchlistId = wl2[0]?.id;
      }
      await db.query(
        `INSERT INTO watchlist_items (watchlist_id, instrument_key, tradingsymbol, exchange, name)
         VALUES (?,?,?,?,?)
         ON DUPLICATE KEY UPDATE tradingsymbol=VALUES(tradingsymbol)`,
        [watchlistId, instrumentKey, symbol, body.exchange || 'NSE', body.name || symbol],
      ).catch(async () => {
        // Some schemas lack unique key — best-effort insert ignore duplicates
        await db.query(
          `INSERT INTO watchlist_items (watchlist_id, instrument_key, tradingsymbol, exchange, name)
           SELECT ?,?,?,?,? FROM DUAL
           WHERE NOT EXISTS (
             SELECT 1 FROM watchlist_items WHERE watchlist_id=? AND tradingsymbol=?
           )`,
          [watchlistId, instrumentKey, symbol, body.exchange || 'NSE', body.name || symbol, watchlistId, symbol],
        );
      });
      return NextResponse.json({ ok: true, symbol, watchlist_id: watchlistId }, { headers: NO_STORE });
    }

    if (action === 'alert_entry_valid' || action === 'alert_expire_or_invalidate') {
      const symbol = String(body.symbol ?? '').toUpperCase();
      if (!symbol) {
        return NextResponse.json({ error: 'symbol required' }, { status: 400, headers: NO_STORE });
      }
      const condition =
        action === 'alert_entry_valid'
          ? (body.condition || 'near_entry')
          : 'signal_lifecycle';
      const targetPrice =
        action === 'alert_entry_valid'
          ? parseFloat(String(body.target_price ?? body.targetPrice ?? 0))
          : 0;
      await db.query(
        `INSERT INTO alerts (user_id, instrument_key, tradingsymbol, \`condition\`, target_price)
         VALUES (?,?,?,?,?)`,
        [
          user.id,
          body.instrument_key || `NSE_EQ|${symbol}`,
          symbol,
          condition,
          Number.isFinite(targetPrice) ? targetPrice : 0,
        ],
      );
      return NextResponse.json({ ok: true, action, symbol }, { status: 201, headers: NO_STORE });
    }

    if (action === 'manual_trade_journal') {
      const symbol = String(body.symbol ?? '').toUpperCase();
      const note = String(body.note ?? '').slice(0, 4000);
      if (!symbol || !note) {
        return NextResponse.json({ error: 'symbol and note required' }, { status: 400, headers: NO_STORE });
      }
      // Persist into a lightweight journal table if present; otherwise store as alert-note hybrid.
      try {
        await db.query(
          `CREATE TABLE IF NOT EXISTS q365_manual_trade_journal (
             id BIGINT AUTO_INCREMENT PRIMARY KEY,
             user_id INT NOT NULL,
             signal_id BIGINT NULL,
             tradingsymbol VARCHAR(32) NOT NULL,
             note TEXT NOT NULL,
             created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
             INDEX idx_user_created (user_id, created_at)
           ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
        );
        await db.query(
          `INSERT INTO q365_manual_trade_journal (user_id, signal_id, tradingsymbol, note)
           VALUES (?,?,?,?)`,
          [user.id, body.signalId ?? null, symbol, note],
        );
      } catch (err) {
        return NextResponse.json(
          { error: 'Journal persist failed', detail: (err as Error).message },
          { status: 500, headers: NO_STORE },
        );
      }
      return NextResponse.json({ ok: true, action }, { status: 201, headers: NO_STORE });
    }

    return NextResponse.json(
      { error: 'Unknown action', allowedActions: PRODUCT_A_ALLOWED_ACTIONS },
      { status: 400, headers: NO_STORE },
    );
  } catch (e: unknown) {
    const status = (e as { status?: number })?.status === 401 ? 401 : 500;
    return NextResponse.json(
      { error: status === 401 ? 'Unauthorized' : 'Server error' },
      { status, headers: NO_STORE },
    );
  }
}
