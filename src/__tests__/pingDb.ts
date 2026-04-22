import './loadEnv';
import { db } from '../lib/db';
(async () => {
  const { rows } = await db.query('SELECT 1 AS ok, NOW() AS ts, DATABASE() AS db, VERSION() AS v', []);
  console.log(rows[0]);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
