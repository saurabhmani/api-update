/**
 * scripts/checkDbState.ts
 *
 * Spec "STEP 1 — VERIFY DATABASE STATE" — answers the three diagnostic
 * questions a "no signals" investigation always starts with:
 *
 *   - How many rows are in q365_signals?
 *   - How many rows are in q365_confirmed_signal_snapshots?
 *   - How many tradeable symbols are in q365_universe (is_active=1)?
 *
 * Fail-hard threshold: universe count < 480 ⇒ exit 2 with a loud
 * error so the operator can't silently boot a degraded scan list.
 * 480 is the same floor enforced at nifty500Universe.ts:172, surfaced
 * here as a script-level guard so an operator running this BEFORE a
 * pipeline run can catch the issue without provoking an HTTP 500.
 *
 * Usage:
 *   npm run db:status
 *   # or
 *   npx tsx scripts/checkDbState.ts
 *
 * Exit codes:
 *   0 — all three layers populated, universe in [480, 550]
 *   1 — q365_signals OR q365_confirmed_signal_snapshots empty (warning;
 *       pipeline hasn't run yet but the universe is fine)
 *   2 — universe count below the 480 floor — refuse to run pipeline
 *   3 — script error (env / DB connection)
 */

import path from 'path';
import { config as loadEnv } from 'dotenv';
loadEnv({ path: process.env.DOTENV_CONFIG_PATH || path.resolve(process.cwd(), '.env.local') });

import { db } from '../src/lib/db';

const UNIVERSE_FLOOR = 480;

interface CountResult {
  table: string;
  count: number;
  ok:    boolean;
  err?:  string;
}

async function countRows(table: string, where = ''): Promise<CountResult> {
  try {
    const r = await db.query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM ${table} ${where}`,
    );
    const n = Number((r.rows[0] as any)?.n ?? 0);
    return { table, count: Number.isFinite(n) ? n : 0, ok: true };
  } catch (err) {
    return {
      table,
      count: 0,
      ok:    false,
      err:   err instanceof Error ? err.message : String(err),
    };
  }
}

async function main(): Promise<number> {
  console.log('═══════════════════════════════════════════════════════════════════');
  console.log('  DB STATE — pre-pipeline diagnostic');
  console.log('═══════════════════════════════════════════════════════════════════');

  const [signals, snapshots, universe, recentSignals] = await Promise.all([
    countRows('q365_signals'),
    countRows('q365_confirmed_signal_snapshots'),
    countRows('q365_universe', 'WHERE is_active = 1'),
    countRows(
      'q365_signals',
      'WHERE generated_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR) AND batch_id IS NOT NULL',
    ),
  ]);

  for (const r of [signals, snapshots, universe, recentSignals]) {
    if (!r.ok) {
      console.error(`✗ ${r.table}: query failed (${r.err})`);
      return 3;
    }
  }

  console.log(`  q365_signals                      : ${signals.count}`);
  console.log(`  q365_signals (last 24h, batched)  : ${recentSignals.count}`);
  console.log(`  q365_confirmed_signal_snapshots   : ${snapshots.count}`);
  console.log(`  q365_universe (is_active=1)       : ${universe.count}`);
  console.log();

  // Spec STEP 1 — universe < 400 fails hard. We use the codebase's
  // canonical 480 floor (NIFTY500_MIN_SIZE) which matches the boot
  // guard at nifty500Universe.ts:172. Anything below that means the
  // universe table was never seeded or got truncated; the pipeline
  // would refuse to boot anyway, so fail loudly here first.
  if (universe.count < UNIVERSE_FLOOR) {
    console.error(
      `✗ FAIL HARD: universe count ${universe.count} < ${UNIVERSE_FLOOR}. ` +
      `q365_universe is degraded. ` +
      `Re-seed via:\n` +
      `    npx tsx scripts/loadNifty500.ts\n` +
      `then re-run the pipeline.`,
    );
    return 2;
  }

  if (signals.count === 0 && snapshots.count === 0) {
    console.warn(
      `⚠ WARNING: q365_signals AND q365_confirmed_signal_snapshots are both empty. ` +
      `The pipeline has never produced output in this DB. ` +
      `Trigger a sync run:\n` +
      `    DEBUG_FORCE_SIGNAL=true curl -X POST 'http://localhost:3000/api/run-signal-engine?sync=true&force=true'\n` +
      `or wait for /api/signals to fire auto-recovery (cold-start path bypasses cooldown).`,
    );
    return 1;
  }

  if (recentSignals.count === 0) {
    console.warn(
      `⚠ WARNING: no q365_signals rows in the last 24h. ` +
      `Older rows exist but the pipeline hasn't written anything fresh. ` +
      `Check [PIPELINE END] / [DB INSERT ATTEMPT] markers in the server log for the last attempt.`,
    );
    return 1;
  }

  console.log(
    `✓ DB state healthy. Universe=${universe.count}, signals(24h)=${recentSignals.count}, ` +
    `snapshots=${snapshots.count}.`,
  );
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error('db:status crashed:', err);
    process.exit(3);
  });
