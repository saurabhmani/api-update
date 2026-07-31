import { db } from '@/lib/db';
import {
  generateSignal as generateSignalV2,
  type Signal,
} from '@/lib/signal-engine/live/analyzeInstrument';
import { MIN_SETUP_CONFIDENCE, VALIDITY_HOURS } from '@/lib/constants/signals';
import { ENGINE_VERSION } from '@/lib/signal-engine/constants/engineVersion';

/**
 * Persist a setup from a live signal using the canonical trade_setups schema
 * (status=active, reason, generation_identity). Used by admin recompute.
 */
export async function generateSetupFromSignal(
  signal: Signal,
  opts: { userId?: number | null } = {},
): Promise<number | null> {
  if (!signal || signal.confidence < MIN_SETUP_CONFIDENCE) return null;
  if (signal.direction === 'HOLD') return null;
  if (!signal.entry_price || !signal.stop_loss || !signal.target1) return null;

  const hours = VALIDITY_HOURS[signal.timeframe as keyof typeof VALIDITY_HOURS]
    ?? VALIDITY_HOURS.swing;
  const expiresAt = new Date(Date.now() + hours * 3600000);
  const reasonText = signal.reasons.slice(0, 3).map(r => r.text).join('. ');
  const identity = [
    opts.userId ?? 'system',
    signal.tradingsymbol,
    'auto',
    signal.timeframe || 'swing',
    ENGINE_VERSION,
    new Date().toISOString().slice(0, 10),
  ].join('|');

  // Expire prior active rows for this symbol (system-wide admin path).
  await db.query(
    `UPDATE trade_setups
        SET status='expired', updated_at=NOW()
      WHERE UPPER(tradingsymbol)=? AND status='active'
        AND (generation_identity IS NULL OR generation_identity<>?)
        AND (user_id IS NULL OR user_id=?)`,
    [signal.tradingsymbol.toUpperCase(), identity, opts.userId ?? null],
  );

  await db.query(
    `INSERT INTO trade_setups
      (user_id, generation_identity, strategy_id, instrument_key,
       tradingsymbol, exchange, direction, entry_price, stop_loss, target1,
       target2, risk_reward, confidence, timeframe, reason, scenario_tag,
       regime, status, expires_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'active',?)
     ON DUPLICATE KEY UPDATE
       direction=VALUES(direction), entry_price=VALUES(entry_price),
       stop_loss=VALUES(stop_loss), target1=VALUES(target1),
       target2=VALUES(target2), risk_reward=VALUES(risk_reward),
       confidence=VALUES(confidence), reason=VALUES(reason),
       scenario_tag=VALUES(scenario_tag), regime=VALUES(regime),
       status='active', expires_at=VALUES(expires_at), updated_at=NOW()`,
    [
      opts.userId ?? null,
      identity,
      signal.strategy ?? 'auto',
      signal.instrument_key,
      signal.tradingsymbol,
      signal.exchange,
      signal.direction,
      signal.entry_price,
      signal.stop_loss,
      signal.target1,
      signal.target2 || null,
      signal.risk_reward,
      signal.confidence,
      signal.timeframe || 'swing',
      reasonText,
      signal.scenario_tag ?? null,
      signal.regime ?? null,
      expiresAt,
    ],
  );

  const { rows } = await db.query<{ id: number }>(
    `SELECT id FROM trade_setups WHERE generation_identity=? LIMIT 1`,
    [identity],
  );
  return rows[0]?.id ?? null;
}

export async function recomputeTopSetups(limit = 40): Promise<{ created: number; skipped: number }> {
  const { rows } = await db.query(
    `SELECT instrument_key, tradingsymbol, exchange FROM rankings ORDER BY score DESC LIMIT ?`,
    [limit],
  );

  let created = 0;
  let skipped = 0;

  for (const inst of rows) {
    const signal = await generateSignalV2(inst.instrument_key, inst.tradingsymbol, inst.exchange);
    if (!signal || signal.confidence < MIN_SETUP_CONFIDENCE || signal.direction === 'HOLD') {
      skipped++;
      continue;
    }

    const { rows: existing } = await db.query(
      `SELECT id FROM trade_setups
        WHERE UPPER(tradingsymbol)=? AND status='active'
          AND (expires_at IS NULL OR expires_at > NOW()) LIMIT 1`,
      [String(inst.tradingsymbol).toUpperCase()],
    );
    if (existing.length) {
      skipped++;
      continue;
    }

    const id = await generateSetupFromSignal(signal);
    if (id) created++;
    else skipped++;
  }

  return { created, skipped };
}

/** Expire wall-clock-stale active setups (and legacy pending rows). */
export async function expireOldSetups(): Promise<void> {
  await db.query(`
    UPDATE trade_setups SET status='expired', updated_at=NOW()
    WHERE status IN ('active', 'pending')
      AND expires_at IS NOT NULL AND expires_at < NOW()
  `);
}

export async function updateSetupStatus(
  setupId: number,
  newStatus: string,
  priceAt: number,
  note?: string,
): Promise<void> {
  const { rows } = await db.query<{ status: string }>(
    `SELECT status FROM trade_setups WHERE id=?`,
    [setupId],
  );
  const oldStatus = rows[0]?.status;

  await db.query(`UPDATE trade_setups SET status=?, updated_at=NOW() WHERE id=?`, [
    newStatus,
    setupId,
  ]);

  // Best-effort history — table may not exist on all environments.
  try {
    await db.query(
      `INSERT INTO trade_setup_status_history (setup_id, old_status, new_status, price_at, note)
       VALUES (?,?,?,?,?)`,
      [setupId, oldStatus, newStatus, priceAt, note || null],
    );
  } catch {
    // non-fatal
  }
}
