/**
 * Trade Setups API — Quantorus365
 *
 * Live path: ranked universe → generateSignal → rejection engine.
 * Fallback: when the live scan produces zero rows, seed from q365_signals
 * only for symbols that pass Phase-12 main-table gates (same bar as /signals).
 */
import { NextRequest, NextResponse }    from 'next/server';
import { requireSession } from '@/lib/session';
import { db }                           from '@/lib/db';
import { generateSignal, logRejection } from '@/lib/signal-engine/live/analyzeInstrument';
import { getActiveSignals }             from '@/lib/signal-engine/repository/readSignals';
import { syncRankingsFromNse }          from '@/services/dataSync';
import { MIN_SETUP_CONFIDENCE }         from '@/lib/constants/signals';
import { belongsInMainTable } from '@/lib/signal-engine/pipeline/phase12Routing';

export const dynamic   = 'force-dynamic';
export const revalidate = 0;

const SETUP_VALIDITY_MS = 24 * 3600 * 1000;

function minSetupConfidence(): number {
  const relaxed = String(process.env.SIGNAL_RELAX_MODE ?? '').trim().toLowerCase() === 'true';
  return relaxed ? 55 : MIN_SETUP_CONFIDENCE;
}

function hasValidSetupPrices(entry: number, stop: number, target: number): boolean {
  return entry > 0 && stop > 0 && target > 0;
}

/** Phase-12 main-table gates — same bar as /signals BUY/SELL table. */
function passesInstitutionalGates(row: {
  classification?: string | null;
  signal_status?: string | null;
  live_valid?: boolean | number | null;
  stress_survival_score?: number | null;
  final_score?: number | null;
}): boolean {
  return belongsInMainTable(row);
}

async function loadSignalGateFields(sym: string): Promise<Record<string, unknown> | null> {
  const { rows: sigRows } = await db.query(
    `SELECT symbol, direction, confidence_score, signal_status, classification,
            live_valid, stress_survival_score, rejection_reasons_json, final_score, status
       FROM q365_signals
      WHERE UPPER(symbol) = ?
      ORDER BY generated_at DESC LIMIT 1`,
    [sym.toUpperCase()],
  );
  return (sigRows[0] as Record<string, unknown>) ?? null;
}

async function expireStaleSetups(): Promise<void> {
  await db.query(
    `UPDATE trade_setups SET status = 'expired'
      WHERE status = 'active' AND expires_at IS NOT NULL AND expires_at <= NOW()`,
  );
}

async function upsertTradeSetup(row: {
  instrument_key: string;
  tradingsymbol:  string;
  exchange:       string;
  direction:      string;
  entry_price:    number;
  stop_loss:      number;
  target1:        number;
  target2:        number | null;
  risk_reward:    number;
  confidence:     number;
  timeframe:      string;
  reason:         string;
  scenario_tag:   string;
  regime:         string;
  expires_at:     Date;
}): Promise<boolean> {
  await db.query(
    `UPDATE trade_setups SET status = 'expired'
      WHERE tradingsymbol = ? AND status = 'active'`,
    [row.tradingsymbol],
  );
  await db.query(
    `INSERT INTO trade_setups
       (instrument_key, tradingsymbol, exchange, direction, entry_price,
        stop_loss, target1, target2, risk_reward, confidence, timeframe,
        reason, scenario_tag, regime, status, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)`,
    [
      row.instrument_key, row.tradingsymbol, row.exchange, row.direction,
      row.entry_price, row.stop_loss, row.target1, row.target2, row.risk_reward,
      row.confidence, row.timeframe, row.reason, row.scenario_tag, row.regime,
      row.expires_at,
    ],
  );
  return true;
}

export async function GET(req: NextRequest) {
  try { await requireSession(); }
  catch { return NextResponse.json({ error: 'Unauthorized' }, { status: 401 }); }

  const action = req.nextUrl.searchParams.get('action') || 'active';
  const limit  = Math.min(parseInt(req.nextUrl.searchParams.get('limit') || '20'), 100);

  try {
    if (action === 'active') {
      // Read trade_setups only — the UI renders ts.* fields. A JOIN to
      // q365_signals was removed: instrument_key collations differ
      // (utf8mb4_unicode_ci vs utf8mb4_0900_ai_ci) and caused 500s.
      const { rows } = await db.query(`
        SELECT *
        FROM trade_setups
        WHERE status = 'active'
          AND (expires_at IS NULL OR expires_at > NOW())
        ORDER BY confidence DESC, created_at DESC
        LIMIT ?
      `, [limit]);
      const confFloor = minSetupConfidence();
      const gatedRows: typeof rows = [];

      for (const setup of rows as Array<Record<string, unknown>>) {
        const sym = String(setup.tradingsymbol ?? '').toUpperCase();
        if (!sym) continue;
        const entry = Number(setup.entry_price ?? 0);
        const stop = Number(setup.stop_loss ?? 0);
        const target = Number(setup.target1 ?? 0);
        if (!hasValidSetupPrices(entry, stop, target)) continue;
        try {
          const sig = await loadSignalGateFields(sym);
          if (!sig) continue;
          // Use the confidence stored on the setup row (validated at creation).
          // Re-checking against the latest q365_signals score empties the UI when
          // live signal confidence decays after the setup was written.
          const conf = Number(setup.confidence ?? 0);
          if (conf < confFloor) continue;
          if (!passesInstitutionalGates({
            classification: sig.classification as string | null,
            signal_status: sig.signal_status as string | null,
            live_valid: sig.live_valid as boolean | number | null,
            stress_survival_score: sig.stress_survival_score != null ? Number(sig.stress_survival_score) : null,
            final_score: sig.final_score != null ? Number(sig.final_score) : null,
          })) continue;
          gatedRows.push(setup);
        } catch { /* skip rows we cannot validate */ }
      }

      return NextResponse.json({ setups: gatedRows, count: gatedRows.length });
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

  await expireStaleSetups();

  let created = 0, rejected = 0, skipped = 0, fallback = 0, gateFiltered = 0;
  const expiresAt = new Date(Date.now() + SETUP_VALIDITY_MS);
  const confFloor = minSetupConfidence();

  for (const inst of ranked) {
    const signal = await generateSignal(inst.instrument_key, inst.tradingsymbol, inst.exchange);
    if (!signal) { skipped++; continue; }

    if (signal.rejection_reasons.length > 0) {
      rejected++;
      await logRejection(inst.instrument_key, inst.tradingsymbol, signal.rejection_reasons);
      continue;
    }

    if (signal.direction === 'HOLD' || signal.confidence < confFloor) { skipped++; continue; }

    if (!hasValidSetupPrices(signal.entry_price, signal.stop_loss, signal.target1)) {
      gateFiltered++;
      continue;
    }

    if (!passesInstitutionalGates({
      classification: signal.classification,
      signal_status: signal.signal_status,
      live_valid: null,
      stress_survival_score: null,
      final_score: signal.final_score,
    })) {
      gateFiltered++;
      continue;
    }

    const reason = signal.reasons.slice(0, 3).map(r => r.text).join('. ');

    try {
      await upsertTradeSetup({
        instrument_key: inst.instrument_key,
        tradingsymbol:  inst.tradingsymbol,
        exchange:       inst.exchange,
        direction:      signal.direction,
        entry_price:    signal.entry_price,
        stop_loss:      signal.stop_loss,
        target1:        signal.target1,
        target2:        signal.target2,
        risk_reward:    signal.risk_reward,
        confidence:     signal.confidence,
        timeframe:      signal.timeframe,
        reason,
        scenario_tag:   signal.scenario_tag,
        regime:         signal.regime,
        expires_at:     expiresAt,
      });
      created++;
    } catch (err: any) {
      console.warn('[TradeSetups] insert failed:', inst.tradingsymbol, err?.message);
      skipped++;
    }
  }

  // Fall back to scanner pool only when live scan produced zero rows.
  // Apply the same Phase-12 main-table gates as /signals — no
  // DEVELOPING_SETUP / WATCHLIST_ONLY rows.
  if (created === 0) {
    const active = await getActiveSignals(Math.min(limit, 50));
    const seen = new Set<string>();
    for (const s of active) {
      const dir = String(s.direction ?? '').toUpperCase();
      if (dir !== 'BUY' && dir !== 'SELL') continue;
      const conf = Number(s.confidence_score ?? s.confidence ?? 0);
      if (conf < confFloor) continue;
      const entry = Number(s.entry_price ?? 0);
      const stop = Number(s.stop_loss ?? 0);
      const target = Number(s.target1 ?? 0);
      if (!hasValidSetupPrices(entry, stop, target)) { gateFiltered++; continue; }
      const sym = String(s.tradingsymbol ?? s.symbol ?? '').toUpperCase();
      if (!sym || seen.has(sym)) continue;
      const gateRow = await loadSignalGateFields(sym);
      if (!gateRow || !passesInstitutionalGates({
        classification: gateRow.classification as string | null,
        signal_status: gateRow.signal_status as string | null,
        live_valid: gateRow.live_valid as boolean | number | null,
        stress_survival_score: gateRow.stress_survival_score != null ? Number(gateRow.stress_survival_score) : null,
        final_score: gateRow.final_score != null ? Number(gateRow.final_score) : null,
      })) {
        gateFiltered++;
        continue;
      }
      seen.add(sym);
      const reason = Array.isArray(s.reasons)
        ? s.reasons.slice(0, 3).map((r: any) => r.message ?? r.text ?? '').filter(Boolean).join('. ')
        : '';
      try {
        await upsertTradeSetup({
          instrument_key: s.instrument_key ?? `NSE_EQ|${sym}`,
          tradingsymbol:  sym,
          exchange:       s.exchange ?? 'NSE',
          direction:      dir,
          entry_price:    Number(s.entry_price ?? 0),
          stop_loss:      Number(s.stop_loss ?? 0),
          target1:        Number(s.target1 ?? 0),
          target2:        s.target2 != null ? Number(s.target2) : null,
          risk_reward:    Number(s.risk_reward ?? 0),
          confidence:     conf,
          timeframe:      s.timeframe ?? 'swing',
          reason:         reason || `Scanner ${dir} — ${s.scenario_tag ?? s.signal_type ?? 'active signal'}`,
          scenario_tag:   String(s.scenario_tag ?? 'NO_STRATEGY'),
          regime:         String(s.regime ?? s.market_regime ?? 'NEUTRAL'),
          expires_at:     expiresAt,
        });
        created++;
        fallback++;
      } catch (err: any) {
        console.warn('[TradeSetups] fallback insert failed:', sym, err?.message);
      }
    }
  }

  return NextResponse.json({
    success: true, created, rejected, skipped, fallback, gateFiltered, total: ranked.length,
    approval_rate: ranked.length > 0 ? parseFloat((created / ranked.length * 100).toFixed(1)) : 0,
    note: created > 0
      ? fallback > 0
        ? `${created} setups created from scanner pool (${fallback} passed Phase-12 main-table gates; ${gateFiltered} filtered; ${rejected} live candidates rejected).`
        : `${created} setups created. ${rejected} signals blocked by rejection engine.`
      : `No setups passed institutional gates (${rejected} live rejected, ${gateFiltered} scanner filtered, ${skipped} skipped from ${ranked.length} stocks).`,
  });
}
