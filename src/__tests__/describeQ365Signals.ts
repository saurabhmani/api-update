import './loadEnv';
import { db } from '../lib/db';
(async () => {
  const { rows } = await db.query(
    `SELECT column_name, data_type FROM information_schema.columns
      WHERE table_schema = DATABASE() AND table_name = 'q365_signals'
      ORDER BY ordinal_position`,
    [],
  );
  for (const r of rows as any[]) {
    console.log(`  ${String(r.column_name || r.COLUMN_NAME).padEnd(30)} ${r.data_type || r.DATA_TYPE}`);
  }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
