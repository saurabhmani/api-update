import path from 'path';
import { config as loadEnv } from 'dotenv';
loadEnv({ path: path.resolve(process.cwd(), '.env.local') });
import { db } from '../src/lib/db';
import { getActiveSignals } from '../src/lib/signal-engine/repository/readSignals';
(async () => {
  const overall = await db.query<any>(`
    SELECT signal_status, COUNT(*) AS c
      FROM q365_signals
     WHERE status IN ('active','watchlist','flagged')
       AND (invalidation_reason IS NULL OR invalidation_reason NOT IN
           ('stop_loss_broken','target_reached','engine_disagree','live_rejected'))
       AND (expires_at IS NULL OR expires_at > NOW())
       AND decay_state <> 'expired'
     GROUP BY signal_status`);
  console.log('active rows by signal_status:', overall.rows);

  const fs = await db.query<any>(`
    SELECT
      SUM(final_score IS NULL)              AS null_fs,
      SUM(final_score >= 30)                AS gte30,
      SUM(final_score < 30)                 AS lt30
      FROM q365_signals
     WHERE status IN ('active','watchlist','flagged')
       AND (expires_at IS NULL OR expires_at > NOW())
       AND decay_state <> 'expired'`);
  console.log('active rows by final_score:', fs.rows[0]);

  const rows = await getActiveSignals(50, { latestBatchOnly: true });
  console.log('getActiveSignals(latestBatchOnly=true) returned:', rows.length, 'rows');
  if (rows.length > 0) {
    console.log('first 3 sample rows:');
    for (const r of rows.slice(0, 3)) {
      console.log('  ', {
        symbol: r.symbol, direction: r.direction,
        signal_status: r.signal_status, status: r.status,
        confidence: r.confidence_score, final_score: r.final_score,
        rr: r.risk_reward, classification: r.classification,
      });
    }
  }
  const rowsAll = await getActiveSignals(50, { latestBatchOnly: false });
  console.log('getActiveSignals(latestBatchOnly=false) returned:', rowsAll.length, 'rows');
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
