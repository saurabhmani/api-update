import { config as dotenvConfig } from 'dotenv';
import { resolve as resolvePath } from 'node:path';

dotenvConfig({ path: resolvePath(process.cwd(), '.env.local') });
dotenvConfig({ path: resolvePath(process.cwd(), '.env') });

import { db } from '@/lib/db';

async function main(): Promise<void> {
  const { rows } = await db.query<{ mdd: number; candles: number }>(
    `SELECT
       SUM(CASE WHEN COALESCE(d.bc, 0) >= 80 THEN 1 ELSE 0 END) AS mdd,
       SUM(CASE WHEN COALESCE(c.bc, 0) >= 80 THEN 1 ELSE 0 END) AS candles
     FROM securities_master m
     LEFT JOIN (
       SELECT symbol, COUNT(*) bc FROM market_data_daily GROUP BY symbol
     ) d ON d.symbol COLLATE utf8mb4_unicode_ci = m.symbol COLLATE utf8mb4_unicode_ci
     LEFT JOIN (
       SELECT SUBSTRING_INDEX(instrument_key, '|', -1) sym, COUNT(*) bc
         FROM candles WHERE candle_type='eod' AND interval_unit='1day'
        GROUP BY instrument_key
     ) c ON c.sym COLLATE utf8mb4_unicode_ci = m.symbol COLLATE utf8mb4_unicode_ci
     WHERE m.is_active=1 AND m.series='EQ'`,
  );
  console.log('eq_ge80_compare', rows[0]);

  const { rows: gap } = await db.query(
    `SELECT m.symbol, COALESCE(d.bc,0) dbc, COALESCE(c.bc,0) cbc
       FROM securities_master m
       LEFT JOIN (SELECT symbol, COUNT(*) bc FROM market_data_daily GROUP BY symbol) d
         ON d.symbol COLLATE utf8mb4_unicode_ci = m.symbol COLLATE utf8mb4_unicode_ci
       LEFT JOIN (
         SELECT SUBSTRING_INDEX(instrument_key,'|',-1) sym, COUNT(*) bc
           FROM candles WHERE candle_type='eod' AND interval_unit='1day' GROUP BY instrument_key
       ) c ON c.sym COLLATE utf8mb4_unicode_ci = m.symbol COLLATE utf8mb4_unicode_ci
      WHERE m.is_active=1 AND m.series='EQ' AND COALESCE(c.bc,0) >= 80 AND COALESCE(d.bc,0) < 80
      LIMIT 10`,
  );
  console.log('candles_ok_mdd_low_sample', gap);
}

main().catch((e) => { console.error(e); process.exit(1); });
