import path from 'path';
import { config as loadEnv } from 'dotenv';
loadEnv({ path: path.resolve(process.cwd(), '.env.local') });
import { db } from '../src/lib/db';
(async () => {
  const sigs = await db.query<any>(`SELECT COUNT(*) AS c FROM q365_signals`);
  const sigsActive = await db.query<any>(`
    SELECT COUNT(*) AS c FROM q365_signals
     WHERE status IN ('active','watchlist','flagged')
       AND (invalidation_reason IS NULL
            OR invalidation_reason NOT IN ('stop_loss_broken','target_reached','engine_disagree','live_rejected'))
       AND (expires_at IS NULL OR expires_at > NOW())
       AND decay_state <> 'expired'`);
  const sigsLatest = await db.query<any>(`SELECT batch_id, UNIX_TIMESTAMP(MAX(generated_at)) AS ts FROM q365_signals WHERE batch_id IS NOT NULL GROUP BY batch_id ORDER BY ts DESC LIMIT 3`);
  const trk  = await db.query<any>(`SELECT stage, COUNT(*) AS c FROM q365_signal_maturity_tracker GROUP BY stage`);
  const snap = await db.query<any>(`SELECT status, COUNT(*) AS c FROM q365_confirmed_signal_snapshots GROUP BY status`);
  const cdl  = await db.query<any>(`SELECT UNIX_TIMESTAMP(MAX(ts)) AS ts FROM market_data_daily`);
  console.log('q365_signals total rows  :', Number((sigs.rows[0] as any).c ?? 0));
  console.log('q365_signals ACTIVE      :', Number((sigsActive.rows[0] as any).c ?? 0));
  console.log('latest 3 batches         :', sigsLatest.rows);
  console.log('tracker by stage         :', trk.rows);
  console.log('confirmed by status      :', snap.rows);
  console.log('market_data_daily MAX(ts):', cdl.rows[0]);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
