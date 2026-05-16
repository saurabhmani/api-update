/// <reference types="node" />
/**
 * scripts/verifyScannerPersistence.ts
 *
 * Sanity check: query q365_signals for scanner-written rows and
 * print counts + top 5. Used after a persisted scan to confirm
 * rows actually landed.
 *
 *   npx tsx scripts/verifyScannerPersistence.ts
 */

import path from 'path';
import { config } from 'dotenv';
config({ path: process.env.DOTENV_CONFIG_PATH || path.resolve(process.cwd(), '.env.local') });

import { db } from '../src/lib/db';

async function main(): Promise<void> {
  const counts = await db.query<{
    approved:  number;
    watchlist: number;
    batches:   number;
    latest:    string;
  }>(`
    SELECT
      SUM(CASE WHEN signal_status='APPROVED_SIGNAL'  THEN 1 ELSE 0 END) AS approved,
      SUM(CASE WHEN signal_status='DEVELOPING_SETUP' THEN 1 ELSE 0 END) AS watchlist,
      COUNT(DISTINCT batch_id)                                          AS batches,
      MAX(generated_at)                                                 AS latest
    FROM q365_signals
    WHERE generation_source = 'scanner:custom-universe:yahoo'
  `);
  console.log('Scanner rows in q365_signals:', counts.rows[0]);

  const top = await db.query(`
    SELECT symbol, direction, classification, final_score,
           portfolio_fit_score, stress_survival_score, signal_status, batch_id
    FROM q365_signals
    WHERE generation_source = 'scanner:custom-universe:yahoo'
    ORDER BY id DESC LIMIT 5
  `);
  console.log('Latest 5 rows (PFit + Stress columns):');
  for (const row of top.rows) console.log('  ', row);
}

main().then(() => process.exit(0)).catch((e) => {
  console.error(e);
  process.exit(1);
});
