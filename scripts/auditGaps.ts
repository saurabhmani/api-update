/// <reference types="node" />
import path from 'path';
import { config } from 'dotenv';
config({ path: process.env.DOTENV_CONFIG_PATH || path.resolve(process.cwd(), '.env.local') });
import { db } from '../src/lib/db';

async function main() {
  const r = await db.query(`
    SELECT symbol, yahoo_symbol, signal_type, expires_at
    FROM q365_signals
    WHERE generation_source='scanner:custom-universe:yahoo'
      AND batch_id LIKE 'cuni-2026042513%'
    ORDER BY id DESC LIMIT 5
  `);
  console.log('Latest 5 from current batch — yahoo_symbol + expires_at + signal_type:');
  for (const row of r.rows) console.log('  ', row);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
