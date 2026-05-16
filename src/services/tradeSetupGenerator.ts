import { db } from '@/lib/db';
import {
  generateSignal as generateSignalV2,
  persistSignal as persistSignalV2,
  type Signal,
} from '@/lib/signal-engine/live/analyzeInstrument';
import { MIN_SETUP_CONFIDENCE } from '@/lib/constants/signals';

export async function generateSetupFromSignal(signal: Signal): Promise<number | null> {
  if (!signal || signal.confidence < MIN_SETUP_CONFIDENCE) return null;
  if (signal.direction === 'HOLD') return null;

  const signalId = await persistSignalV2(signal);

  const validHours = signal.timeframe === 'intraday' ? 8 : 72;
  const expiresAt  = new Date(Date.now() + validHours * 3600000).toISOString();
  const reasonText = signal.reasons.slice(0, 3).map(r => r.text).join('. ');

  const { rows } = await db.query(`
    INSERT INTO trade_setups
      (instrument_key, tradingsymbol, exchange, direction, entry_price,
       stop_loss, target1, target2, risk_reward, confidence, timeframe,
       validity_window_hours, reason_summary, status, signal_id, expires_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'pending',?,?)
    RETURNING id
  `, [
    signal.instrument_key, signal.tradingsymbol, signal.exchange, signal.direction,
    signal.entry_price, signal.stop_loss, signal.target1, signal.target2,
    signal.risk_reward, signal.confidence, signal.timeframe,
    validHours, reasonText, signalId, expiresAt,
  ]);

  const setupId = rows[0]?.id;

  // Also insert initial performance tracking row
  if (setupId) {
    await db.query(`
      INSERT INTO trade_setup_performance
        (setup_id, instrument_key, direction, entry_price, target1, stop_loss, outcome)
      VALUES (?,?,?,?,?,?,'pending')
    `, [setupId, signal.instrument_key, signal.direction, signal.entry_price, signal.target1, signal.stop_loss]);
  }

  return setupId ?? null;
}

export async function recomputeTopSetups(limit = 40): Promise<{ created: number; skipped: number }> {
  const { rows } = await db.query(
    `SELECT instrument_key, tradingsymbol, exchange FROM rankings ORDER BY score DESC LIMIT ?`, [limit]
  );

  let created = 0, skipped = 0;

  for (const inst of rows) {
    const signal = await generateSignalV2(inst.instrument_key, inst.tradingsymbol, inst.exchange);
    if (!signal || signal.confidence < MIN_SETUP_CONFIDENCE) { skipped++; continue; }

    // Check if active setup already exists
    const { rows: existing } = await db.query(
      `SELECT id FROM trade_setups WHERE instrument_key=? AND status='pending'
       AND (expires_at IS NULL OR expires_at > NOW()) LIMIT 1`,
      [inst.instrument_key]
    );
    if (existing.length) { skipped++; continue; }

    const id = await generateSetupFromSignal(signal);
    if (id) created++;
  }

  return { created, skipped };
}

export async function expireOldSetups(): Promise<void> {
  await db.query(`
    UPDATE trade_setups SET status='expired'
    WHERE status='pending' AND expires_at < NOW()
  `);
}

export async function updateSetupStatus(
  setupId: number,
  newStatus: string,
  priceAt: number,
  note?: string
): Promise<void> {
  const { rows } = await db.query(`SELECT status FROM trade_setups WHERE id=?`, [setupId]);
  const oldStatus = rows[0]?.status;

  await db.query(`UPDATE trade_setups SET status=? WHERE id=?`, [newStatus, setupId]);

  await db.query(`
    INSERT INTO trade_setup_status_history (setup_id, old_status, new_status, price_at, note)
    VALUES (?,?,?,?,?)
  `, [setupId, oldStatus, newStatus, priceAt, note || null]);
}
