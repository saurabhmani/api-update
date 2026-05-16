import './loadEnv';
import { db } from '../lib/db';
(async () => {
  const { rows } = await db.query(
    `SELECT tp.signal_id, s.symbol, s.generated_at
       FROM q365_signal_trade_plans tp
       JOIN q365_signals s ON s.id = tp.signal_id
      ORDER BY tp.signal_id DESC LIMIT 5`, [],
  );
  console.log(rows);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
