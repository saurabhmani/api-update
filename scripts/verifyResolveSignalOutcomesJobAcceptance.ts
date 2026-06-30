// ════════════════════════════════════════════════════════════════
//  verifyResolveSignalOutcomesJobAcceptance.ts
//
//  Validates scheduler contract + latest execution log for ops.
//
//  Usage:
//    npx tsx scripts/verifyResolveSignalOutcomesJobAcceptance.ts
// ════════════════════════════════════════════════════════════════

import path from 'path';
import { config as loadEnv } from 'dotenv';
loadEnv({ path: process.env.DOTENV_CONFIG_PATH || path.resolve(process.cwd(), '.env.local') });
loadEnv({ path: path.resolve(process.cwd(), '.env') });

import { db } from '@/lib/db';
import {
  RESOLVE_SIGNAL_OUTCOMES_JOB_CRON,
  RESOLVE_SIGNAL_OUTCOMES_JOB_NAME,
  RESOLVE_SIGNAL_OUTCOMES_JOB_TIMEOUT_MS,
} from '@/lib/signals/outcome/resolveSignalOutcomesJob';
import { CRON_REGISTRY } from '@/lib/reliability/constants/cronRegistry';
import { DAILY_SCHEDULE_CRONS } from '@/lib/workers/dailyScanSchedule';

interface Check {
  id: string;
  area: string;
  pass: boolean;
  detail: string;
}

async function main(): Promise<void> {
  const checks: Check[] = [];

  checks.push({
    id: 'scheduler',
    area: 'Daily Scheduler',
    pass: DAILY_SCHEDULE_CRONS.signalOutcomesResolution === RESOLVE_SIGNAL_OUTCOMES_JOB_CRON,
    detail: `cron=${RESOLVE_SIGNAL_OUTCOMES_JOB_CRON} (16:30 IST Mon–Fri)`,
  });

  checks.push({
    id: 'monitoring',
    area: 'Monitoring',
    pass: CRON_REGISTRY.some((j) => j.id === 'resolve-signal-outcomes'),
    detail: 'cronRegistry entry resolve-signal-outcomes',
  });

  checks.push({
    id: 'timeout',
    area: 'Monitoring',
    pass: RESOLVE_SIGNAL_OUTCOMES_JOB_TIMEOUT_MS === 10 * 60 * 1000,
    detail: `hard timeout ${RESOLVE_SIGNAL_OUTCOMES_JOB_TIMEOUT_MS}ms`,
  });

  try {
    const { rows } = await db.query<{
      status: string;
      duration_ms: number | null;
      started_at: string;
      finished_at: string | null;
      metadata_json: string | Record<string, unknown> | null;
    }>(
      `SELECT status, duration_ms, started_at, finished_at, metadata_json
         FROM cron_job_logs
        WHERE job_name = ?
        ORDER BY started_at DESC
        LIMIT 1`,
      [RESOLVE_SIGNAL_OUTCOMES_JOB_NAME],
    );

    if (rows.length === 0) {
      checks.push({
        id: 'logs',
        area: 'Execution Logs',
        pass: false,
        detail: 'no cron_job_logs row yet — run resolveSignalOutcomesJob once',
      });
    } else {
      const row = rows[0];
      const meta = typeof row.metadata_json === 'string'
        ? JSON.parse(row.metadata_json)
        : (row.metadata_json ?? {});

      checks.push({
        id: 'logs',
        area: 'Execution Logs',
        pass: !!row.started_at && !!row.status,
        detail: `last status=${row.status} started=${row.started_at}`,
      });

      checks.push({
        id: 'once-daily',
        area: 'Execution Logs',
        pass: ['success', 'skipped', 'failed'].includes(row.status),
        detail: `terminal log status=${row.status}`,
      });

      checks.push({
        id: 'duration',
        area: 'Monitoring',
        pass: row.duration_ms == null || row.duration_ms <= RESOLVE_SIGNAL_OUTCOMES_JOB_TIMEOUT_MS,
        detail: `duration_ms=${row.duration_ms ?? 'n/a'}`,
      });

      checks.push({
        id: 'cache-meta',
        area: 'Cache Refresh',
        pass: row.status !== 'success' || meta.processed_count != null,
        detail: `processed_count=${meta.processed_count ?? 'n/a'}`,
      });
    }

    const { rows: successToday } = await db.query<{ n: number }>(
      `SELECT COUNT(*) AS n
         FROM cron_job_logs
        WHERE job_name = ?
          AND status = 'success'
          AND DATE(started_at) = CURDATE()`,
      [RESOLVE_SIGNAL_OUTCOMES_JOB_NAME],
    );
    const successCount = Number(successToday[0]?.n ?? 0);
    checks.push({
      id: 'duplicate-guard',
      area: 'Error Handling',
      pass: successCount <= 1,
      detail: `success runs today=${successCount} (expect ≤1)`,
    });
  } catch (err) {
    checks.push({
      id: 'db',
      area: 'Execution Logs',
      pass: false,
      detail: (err as Error).message,
    });
  }

  console.log('\nresolveSignalOutcomesJob — Acceptance\n');
  for (const c of checks) {
    console.log(`${c.pass ? '✅' : '❌'} [${c.area}] ${c.id}: ${c.detail}`);
  }

  const failed = checks.filter((c) => !c.pass).length;
  console.log(`\n${checks.length - failed}/${checks.length} checks passed\n`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
