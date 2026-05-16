/**
 * scripts/fix-db.ts
 *
 * DB-fix utility for stuck signal state. Run ad-hoc when the dashboard
 * shows latest_batch_id=null / total_persisted=null despite a successful
 * pipeline run. Three orthogonal fixes:
 *
 *   1. resetInvalidBatchId()   — promote rows where batch_id was set to
 *      a generation_source string ('api:run-signal-engine:adapter',
 *      'auto-recovery:indianapi') back to NULL so the route's stamp
 *      UPDATE matches them on the next run.
 *
 *   2. reactivateExpiredFromCurrentBatch() — flip status='active' for
 *      rows from the most recent batch_id that were wrongly expired by
 *      the cleanup query (legacy positional-bug victims).
 *
 *   3. deleteLowConfidenceJunk() — drop rows with confidence_score < 5
 *      AND signal_status='NO_TRADE' that piled up before the saveSignals
 *      MIN_CONFIDENCE_FLOOR was lowered. Lossless — those rows can never
 *      pass the API floor (STRICT_CONFIDENCE_FLOOR=55) anyway.
 *
 * Usage:
 *   npx tsx scripts/fix-db.ts
 *   npx tsx scripts/fix-db.ts --dry-run             # report only, no writes
 *   npx tsx scripts/fix-db.ts --skip-junk-delete    # skip step 3
 *
 * Exit codes:
 *   0 — at least one fix succeeded (or --dry-run completed)
 *   1 — every fix failed / DB unreachable
 *   2 — script error (env / connection)
 */

import path from 'path';
import { config as loadEnv } from 'dotenv';
loadEnv({ path: process.env.DOTENV_CONFIG_PATH || path.resolve(process.cwd(), '.env.local') });

import { db } from '../src/lib/db';

const DRY_RUN          = process.argv.includes('--dry-run');
const SKIP_JUNK_DELETE = process.argv.includes('--skip-junk-delete');

interface FixResult {
  step: string;
  affected: number;
  ok: boolean;
  error?: string;
}

async function resetInvalidBatchId(): Promise<FixResult> {
  // batch_id values that are clearly the generation_source string,
  // not a per-run batch id like 'batch_1714895712345'.
  const knownBadValues = [
    'api:run-signal-engine:adapter',
    'auto-recovery:indianapi',
    'signal-engine:generatePhase4Signals',
  ];
  try {
    if (DRY_RUN) {
      const r = await db.query<{ n: number }>(
        `SELECT COUNT(*) AS n FROM q365_signals
          WHERE batch_id IN (?, ?, ?)`,
        knownBadValues,
      );
      const n = Number((r.rows[0] as any)?.n ?? 0);
      return { step: 'resetInvalidBatchId', affected: n, ok: true };
    }
    const r: any = await db.query(
      `UPDATE q365_signals SET batch_id = NULL
        WHERE batch_id IN (?, ?, ?)`,
      knownBadValues,
    );
    return {
      step:     'resetInvalidBatchId',
      affected: Number(r?.affectedRows ?? 0),
      ok:       true,
    };
  } catch (err) {
    return {
      step:     'resetInvalidBatchId',
      affected: 0,
      ok:       false,
      error:    err instanceof Error ? err.message : String(err),
    };
  }
}

async function reactivateExpiredFromCurrentBatch(): Promise<FixResult> {
  try {
    // Find the latest legitimate batch_id (one that looks like batch_<epoch> or
    // auto-recovery_<epoch>, not a generation_source string).
    const r = await db.query<{ batch_id: string | null }>(
      `SELECT batch_id FROM q365_signals
        WHERE batch_id REGEXP '^(batch_|auto-recovery_)[0-9]+$'
          AND generated_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR)
        GROUP BY batch_id
        ORDER BY MIN(generated_at) DESC
        LIMIT 1`,
    );
    const latest = (r.rows[0] as any)?.batch_id;
    if (!latest) {
      return { step: 'reactivateExpiredFromCurrentBatch', affected: 0, ok: true };
    }
    if (DRY_RUN) {
      const c = await db.query<{ n: number }>(
        `SELECT COUNT(*) AS n FROM q365_signals
          WHERE batch_id = ? AND status = 'expired'`,
        [latest],
      );
      const n = Number((c.rows[0] as any)?.n ?? 0);
      console.log(`  → would reactivate ${n} expired rows from batch_id=${latest}`);
      return { step: 'reactivateExpiredFromCurrentBatch', affected: n, ok: true };
    }
    const u: any = await db.query(
      `UPDATE q365_signals SET status = 'active'
        WHERE batch_id = ? AND status = 'expired'`,
      [latest],
    );
    return {
      step:     'reactivateExpiredFromCurrentBatch',
      affected: Number(u?.affectedRows ?? 0),
      ok:       true,
    };
  } catch (err) {
    return {
      step:     'reactivateExpiredFromCurrentBatch',
      affected: 0,
      ok:       false,
      error:    err instanceof Error ? err.message : String(err),
    };
  }
}

async function deleteLowConfidenceJunk(): Promise<FixResult> {
  if (SKIP_JUNK_DELETE) {
    return { step: 'deleteLowConfidenceJunk', affected: 0, ok: true };
  }
  try {
    if (DRY_RUN) {
      const r = await db.query<{ n: number }>(
        `SELECT COUNT(*) AS n FROM q365_signals
          WHERE confidence_score < 5
            AND signal_status = 'NO_TRADE'
            AND status IN ('expired','rejected')`,
      );
      const n = Number((r.rows[0] as any)?.n ?? 0);
      return { step: 'deleteLowConfidenceJunk', affected: n, ok: true };
    }
    const r: any = await db.query(
      `DELETE FROM q365_signals
        WHERE confidence_score < 5
          AND signal_status = 'NO_TRADE'
          AND status IN ('expired','rejected')`,
    );
    return {
      step:     'deleteLowConfidenceJunk',
      affected: Number(r?.affectedRows ?? 0),
      ok:       true,
    };
  } catch (err) {
    return {
      step:     'deleteLowConfidenceJunk',
      affected: 0,
      ok:       false,
      error:    err instanceof Error ? err.message : String(err),
    };
  }
}

async function main(): Promise<number> {
  console.log('═══════════════════════════════════════════════════════════════════');
  console.log(`  DB FIX — signal-engine recovery${DRY_RUN ? ' (DRY RUN)' : ''}`);
  console.log('═══════════════════════════════════════════════════════════════════');

  const fixes = await Promise.all([
    resetInvalidBatchId(),
    reactivateExpiredFromCurrentBatch(),
    deleteLowConfidenceJunk(),
  ]);

  let anyOk = false;
  for (const f of fixes) {
    if (f.ok) {
      anyOk = true;
      console.log(`  ✓ ${f.step}: ${f.affected} rows ${DRY_RUN ? '(dry-run)' : 'updated'}`);
    } else {
      console.error(`  ✗ ${f.step}: ${f.error}`);
    }
  }

  if (!anyOk) {
    console.error('✗ Every fix failed — DB connection or schema may be off.');
    return 1;
  }
  console.log(DRY_RUN
    ? '✓ Dry run complete. Re-run without --dry-run to apply.'
    : '✓ Done. Re-run the pipeline and check /api/signals for non-empty output.');
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error('fix-db crashed:', err);
    process.exit(2);
  });
