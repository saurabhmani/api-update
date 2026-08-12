import { db } from '@/lib/db';

/** Repair only derivable geometry. Rows with no valid entry/risk remain failed. */
export async function repairActiveSignalRiskGeometry(batchSize = 500) {
  const { rows } = await db.query<any>(
    `SELECT id, direction, entry_price, stop_loss, target1, risk_reward
       FROM q365_signals
      WHERE status='active' AND entry_price > 0
        AND (stop_loss <= 0 OR target1 <= 0 OR risk_reward <= 0)
      ORDER BY generated_at ASC LIMIT ?`, [batchSize],
  );
  let repaired = 0;
  let failed = 0;
  for (const row of rows) {
    const entry = Number(row.entry_price);
    const direction = String(row.direction).toUpperCase();
    let stop = Number(row.stop_loss);
    let target = Number(row.target1);
    if (!(stop > 0) && target > 0) {
      const reward = Math.abs(target - entry);
      stop = direction === 'SELL' ? entry + reward / 2 : entry - reward / 2;
    }
    if (!(target > 0) && stop > 0) {
      const risk = Math.abs(entry - stop);
      target = direction === 'SELL' ? entry - risk * 2 : entry + risk * 2;
    }
    const risk = Math.abs(entry - stop);
    const reward = Math.abs(target - entry);
    if (!(stop > 0) || !(target > 0) || !(risk > 0) || !(reward > 0)) {
      failed++;
      continue;
    }
    await db.query(
      `UPDATE q365_signals SET stop_loss=?, target1=?, risk_reward=?
        WHERE id=? AND status='active' AND (stop_loss<=0 OR target1<=0 OR risk_reward<=0)`,
      [stop, target, reward / risk, row.id],
    );
    repaired++;
  }
  const { rows: remainingRows } = await db.query<any>(
    `SELECT COUNT(*) AS c FROM q365_signals WHERE status='active'
      AND (entry_price<=0 OR stop_loss<=0 OR target1<=0 OR risk_reward<=0)`,
  );
  return { scanned: rows.length, repaired, failed, remaining: Number(remainingRows[0]?.c ?? 0) };
}
