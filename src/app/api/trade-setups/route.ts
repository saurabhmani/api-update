/**
 * Trade Setups API — Quantorus365
 *
 * Only setups that pass all rejection engine gates are created.
 * Rejected candidates are logged to signal_rejections for analysis.
 */
import { NextRequest, NextResponse }    from 'next/server';
import { requireSession } from '@/lib/session';
import { db }                           from '@/lib/db';
import { generateSignal, logRejection } from '@/lib/signal-engine/live/analyzeInstrument';
import { syncRankingsFromNse }          from '@/services/dataSync';

export const dynamic   = 'force-dynamic';
export const revalidate = 0;

export async function GET(req: NextRequest) {
  try { await requireSession(); }
  catch { return NextResponse.json({ error: 'Unauthorized' }, { status: 401 }); }

  const action = req.nextUrl.searchParams.get('action') || 'active';
  const limit  = Math.min(parseInt(req.nextUrl.searchParams.get('limit') || '20'), 100);

  try {
    if (action === 'active') {
      const { rows } = await db.query(`
        SELECT ts.*, s.confidence_score, s.conviction_band, s.market_stance,
               s.portfolio_fit_score, s.scenario_tag AS signal_scenario
        FROM trade_setups ts
        LEFT JOIN signals s ON s.instrument_key=ts.instrument_key
          AND s.generated_at=(SELECT MAX(generated_at) FROM signals WHERE instrument_key=ts.instrument_key)
        WHERE ts.status='active' AND (ts.expires_at IS NULL OR ts.expires_at > NOW())
        ORDER BY ts.confidence DESC, ts.created_at DESC
        LIMIT ?
      `, [limit]);
      return NextResponse.json({ setups: rows, count: rows.length });
    }

    if (action === 'top') {
      const { rows } = await db.query(`
        SELECT * FROM trade_setups
        WHERE status='active' AND confidence >= 70
        ORDER BY confidence DESC LIMIT 10
      `);
      return NextResponse.json({ setups: rows });
    }

    const { rows } = await db.query(
      `SELECT * FROM trade_setups ORDER BY created_at DESC LIMIT ?`, [limit]
    );
    return NextResponse.json({ setups: rows });

  } catch (err: any) {
    if (err?.code === 'ER_NO_SUCH_TABLE')
      return NextResponse.json({ setups: [], note: 'Run migrations first' });
    throw err;
  }
}

export async function POST(req: NextRequest) {
  try { await requireSession(); }
  catch { return NextResponse.json({ error: 'Unauthorized' }, { status: 401 }); }

  const body  = await req.json().catch(() => ({}));
  const limit = parseInt(body.limit ?? '30');

  let ranked: any[] = [];
  try {
    const { rows } = await db.query(
      `SELECT instrument_key, tradingsymbol, exchange FROM rankings ORDER BY score DESC LIMIT ?`,
      [Math.min(limit, 100)]
    );
    ranked = rows as any[];
  } catch { return NextResponse.json({ error: 'Rankings table not found — run migrations.' }, { status: 503 }); }

  // Auto-seed rankings from live movers / Yahoo when empty
  if (ranked.length === 0) {
    console.log('[TradeSetups] Rankings empty — auto-syncing...');
    await syncRankingsFromNse();
    const { rows: r2 } = await db.query(
      `SELECT instrument_key, tradingsymbol, exchange FROM rankings ORDER BY score DESC LIMIT ?`,
      [Math.min(limit, 100)]
    );
    ranked = r2 as any[];
  }

  let created = 0, rejected = 0, skipped = 0;
  const expiresAt = new Date(Date.now() + 24 * 3600 * 1000);

  for (const inst of ranked) {
    const signal = await generateSignal(inst.instrument_key, inst.tradingsymbol, inst.exchange);
    if (!signal) { skipped++; continue; }

    if (signal.rejection_reasons.length > 0) {
      rejected++;
      await logRejection(inst.instrument_key, inst.tradingsymbol, signal.rejection_reasons);
      continue;
    }

    if (signal.direction === 'HOLD') { skipped++; continue; }

    const reason = signal.reasons.slice(0, 3).map(r => r.text).join('. ');

    try {
      await db.query(`
        INSERT INTO trade_setups
          (instrument_key, tradingsymbol, exchange, direction, entry_price,
           stop_loss, target1, target2, risk_reward, confidence, timeframe,
           reason, scenario_tag, regime, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
          confidence   = VALUES(confidence),
          entry_price  = VALUES(entry_price),
          stop_loss    = VALUES(stop_loss),
          target1      = VALUES(target1),
          expires_at   = VALUES(expires_at),
          updated_at   = NOW()
      `, [
        inst.instrument_key, inst.tradingsymbol, inst.exchange,
        signal.direction, signal.entry_price, signal.stop_loss,
        signal.target1, signal.target2, signal.risk_reward,
        signal.confidence, signal.timeframe, reason,
        signal.scenario_tag, signal.regime, expiresAt,
      ]);
      created++;
    } catch { skipped++; }
  }

  return NextResponse.json({
    success: true, created, rejected, skipped, total: ranked.length,
    approval_rate: ranked.length > 0 ? parseFloat((created/ranked.length*100).toFixed(1)) : 0,
    note: created > 0
      ? `${created} setups created. ${rejected} signals blocked by rejection engine.`
      : `No setups passed filters (${rejected} rejected, ${skipped} skipped from ${ranked.length} stocks). Market may be closed or data quality too low.`,
  });
}
