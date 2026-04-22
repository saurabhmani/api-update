// ════════════════════════════════════════════════════════════════
//  GET /api/health — System health probe
//
//  Returns:
//   - status: 'ok' | 'degraded' | 'unhealthy'
//   - db connectivity + latency
//   - redis connectivity
//   - candle data freshness
//   - scheduler / pipeline liveness
//   - process uptime + memory
//
//  Used by load balancers, ops dashboards, and uptime monitors.
// ════════════════════════════════════════════════════════════════

import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { logger } from '@/lib/logger';
import { cacheGet, cacheSet } from '@/lib/redis';

export const dynamic = 'force-dynamic';

type HealthStatus = 'ok' | 'degraded' | 'unhealthy';
type CheckStatus = 'ok' | 'warn' | 'fail' | 'unknown';

interface HealthCheck {
  status: CheckStatus;
  latencyMs?: number;
  error?: string;
  [key: string]: unknown;
}

interface HealthResponse {
  status: HealthStatus;
  timestamp: string;
  checks: Record<string, HealthCheck>;
  process?: {
    uptimeSec: number;
    memoryRssMb: number;
    memoryHeapMb: number;
    pid: number;
    nodeVersion: string;
  };
  responseTimeMs: number;
}

const log = logger.child({ component: 'health' });

function degradeStatus(current: HealthStatus, to: 'degraded' | 'unhealthy'): HealthStatus {
  if (current === 'unhealthy') return 'unhealthy';
  if (to === 'unhealthy') return 'unhealthy';
  return 'degraded';
}

export async function GET() {
  const startMs = Date.now();
  let overallStatus: HealthStatus = 'ok';
  const checks: Record<string, HealthCheck> = {};

  // ── Check 1: Database connectivity ────────────────────────
  try {
    const t0 = Date.now();
    await db.query('SELECT 1 AS ok');
    checks.database = { status: 'ok', latencyMs: Date.now() - t0 };
  } catch (err) {
    checks.database = {
      status: 'fail',
      error: err instanceof Error ? err.message : String(err),
    };
    overallStatus = degradeStatus(overallStatus, 'unhealthy');
  }

  // ── Check 2: Redis connectivity ───────────────────────────
  try {
    const testKey = '__health_probe__';
    await cacheSet(testKey, 1, 10);
    const val = await cacheGet<number>(testKey);
    checks.redis = { status: val === 1 ? 'ok' : 'warn' };
  } catch (err) {
    checks.redis = {
      status: 'warn',
      error: err instanceof Error ? err.message : String(err),
    };
  }

  // ── Check 3: Candle data freshness ────────────────────────
  try {
    const { rows } = await db.query<any>(
      `SELECT COUNT(*) AS cnt, MAX(ts) AS latest
       FROM candles WHERE candle_type = 'eod' AND interval_unit = '1day'`,
    );
    const cnt = Number((rows[0] as any)?.cnt ?? 0);
    const latest = (rows[0] as any)?.latest;
    const ageDays = latest
      ? Math.floor((Date.now() - new Date(latest).getTime()) / (1000 * 60 * 60 * 24))
      : null;
    checks.candleData = {
      status: cnt > 0 ? 'ok' : 'warn',
      totalCandles: cnt,
      latestBar: latest,
      ageDays,
    };
    if (cnt === 0) overallStatus = degradeStatus(overallStatus, 'degraded');
  } catch (err) {
    checks.candleData = {
      status: 'fail',
      error: err instanceof Error ? err.message : String(err),
    };
    overallStatus = degradeStatus(overallStatus, 'degraded');
  }

  // ── Check 4: Recent backtest activity ─────────────────────
  try {
    const { rows } = await db.query<any>(
      `SELECT
         SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
         SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
         SUM(CASE WHEN status = 'partial_success' THEN 1 ELSE 0 END) AS partial,
         COUNT(*) AS total,
         MAX(started_at) AS latest_run
       FROM backtest_runs
       WHERE started_at > DATE_SUB(NOW(), INTERVAL 7 DAY)`,
    );
    const r = rows[0] as any;
    checks.backtests = {
      status: 'ok',
      last7Days: {
        total: Number(r?.total ?? 0),
        completed: Number(r?.completed ?? 0),
        failed: Number(r?.failed ?? 0),
        partialSuccess: Number(r?.partial ?? 0),
      },
      latestRun: r?.latest_run,
    };
  } catch (err) {
    checks.backtests = {
      status: 'fail',
      error: err instanceof Error ? err.message : String(err),
    };
  }

  // ── Check 5: Learning scheduler status ─────────────────────
  try {
    const { rows } = await db.query<any>(
      `SELECT job_name, status, duration_ms, run_at
         FROM q365_learning_job_runs
        WHERE run_at = (SELECT MAX(run_at) FROM q365_learning_job_runs)
        ORDER BY job_name`,
    );
    const jobs = (rows as any[]).map((r) => ({
      name: r.job_name, status: r.status,
      durationMs: r.duration_ms, runAt: r.run_at,
    }));
    const lastRun = jobs[0]?.runAt ?? null;
    const ageHours = lastRun ? Math.round((Date.now() - new Date(lastRun).getTime()) / 3600000) : null;
    const allSuccess = jobs.every((j) => j.status === 'success');
    checks.learningScheduler = {
      status: jobs.length === 0 ? 'warn' : allSuccess ? 'ok' : 'warn',
      lastRun, ageHours, jobCount: jobs.length,
      jobs,
    };
    if (!allSuccess) overallStatus = degradeStatus(overallStatus, 'degraded');
  } catch {
    checks.learningScheduler = { status: 'unknown', lastRun: null };
  }

  // ── Check 6: News pipeline status ─────────────────────────
  try {
    const { rows } = await db.query<any>(
      `SELECT run_at, total_fetched, new_events, duration_ms
         FROM q365_news_ingestion_log
        ORDER BY run_at DESC LIMIT 1`,
    );
    const r = (rows as any[])[0];
    const lastRun = r?.run_at ?? null;
    const ageHours = lastRun ? Math.round((Date.now() - new Date(lastRun).getTime()) / 3600000) : null;
    checks.newsPipeline = {
      status: r ? (ageHours != null && ageHours <= 4 ? 'ok' : 'warn') : 'unknown',
      lastRun, ageHours,
      lastFetched: r?.total_fetched ?? 0,
      lastNewEvents: r?.new_events ?? 0,
      lastDurationMs: r?.duration_ms ?? 0,
    };
  } catch {
    checks.newsPipeline = { status: 'unknown', lastRun: null };
  }

  // ── Check 7: Nightly backtest freshness ──────────────────
  try {
    const { rows } = await db.query<any>(
      `SELECT run_id, name, status, started_at, completed_at, duration_ms
         FROM backtest_runs
        WHERE status = 'completed'
        ORDER BY started_at DESC
        LIMIT 1`,
    );
    const r = (rows as any[])[0];
    const latest = r?.started_at ?? null;
    const ageHours = latest
      ? Math.round((Date.now() - new Date(latest).getTime()) / 3600000)
      : null;
    const status: CheckStatus =
      !latest              ? 'fail' :
      (ageHours ?? 0) > 72 ? 'fail' :
      (ageHours ?? 0) > 30 ? 'warn' : 'ok';
    checks.backtestEngine = {
      status,
      lastRunId:       r?.run_id ?? null,
      lastName:        r?.name ?? null,
      lastStartedAt:   latest,
      lastCompletedAt: r?.completed_at ?? null,
      lastDurationMs:  r?.duration_ms ?? null,
      ageHours,
    };
    if (status !== 'ok') overallStatus = degradeStatus(overallStatus, 'degraded');
  } catch (err) {
    checks.backtestEngine = {
      status: 'fail',
      error: (err as Error).message,
    };
    overallStatus = degradeStatus(overallStatus, 'degraded');
  }

  // ── Check 8: Signal engine freshness ─────────────────────
  try {
    const { rows } = await db.query<any>(
      `SELECT MAX(generated_at) AS latest,
              COUNT(*)          AS total_7d,
              SUM(CASE WHEN generation_source LIKE 'cron:%' THEN 1 ELSE 0 END) AS cron_7d
         FROM q365_signals
        WHERE generated_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)`,
    );
    const r = (rows as any[])[0];
    const latest = r?.latest ?? null;
    const ageHours = latest
      ? Math.round((Date.now() - new Date(latest).getTime()) / 3600000)
      : null;
    const status: CheckStatus =
      !latest              ? 'fail' :
      (ageHours ?? 0) > 72 ? 'fail' :
      (ageHours ?? 0) > 30 ? 'warn' : 'ok';
    checks.signalEngine = {
      status,
      latestSignal:    latest,
      ageHours,
      total7d:         Number(r?.total_7d ?? 0),
      cronGenerated7d: Number(r?.cron_7d ?? 0),
    };
    if (status !== 'ok') overallStatus = degradeStatus(overallStatus, 'degraded');
  } catch (err) {
    checks.signalEngine = {
      status: 'fail',
      error: (err as Error).message,
    };
    overallStatus = degradeStatus(overallStatus, 'degraded');
  }

  // ── Check 9: Market-data scheduler liveness ──────────────
  try {
    const { rows } = await db.query<any>(
      `SELECT exchange AS job, status, total, updated, error_msg, synced_at
         FROM instrument_sync_logs
        WHERE exchange LIKE 'CRON:%'
        ORDER BY id DESC
        LIMIT 1`,
    );
    const r = (rows as any[])[0];
    const lastRun = r?.synced_at ?? null;
    const ageHours = lastRun
      ? Math.round((Date.now() - new Date(lastRun).getTime()) / 3600000)
      : null;
    const status: CheckStatus =
      !lastRun             ? 'fail' :
      (ageHours ?? 0) > 48 ? 'fail' :
      (ageHours ?? 0) > 14 ? 'warn' : 'ok';
    checks.marketDataScheduler = {
      status,
      lastJob:     r?.job ?? null,
      lastRun,
      ageHours,
      lastStatus:  r?.status ?? null,
      lastUpdated: Number(r?.updated ?? 0),
      lastError:   r?.error_msg ?? null,
    };
    if (status !== 'ok') overallStatus = degradeStatus(overallStatus, 'degraded');
  } catch (err) {
    checks.marketDataScheduler = {
      status: 'unknown',
      error: (err as Error).message,
    };
  }

  // ── Check 10: Manipulation scanner status ──────────────────
  try {
    const { rows } = await db.query<any>(
      `SELECT MAX(snapshot_date) AS latest, COUNT(*) AS total
         FROM q365_manipulation_snapshots
        WHERE snapshot_date >= DATE_SUB(NOW(), INTERVAL 3 DAY)`,
    );
    const r = (rows as any[])[0];
    checks.manipulationScanner = {
      status: Number(r?.total ?? 0) > 0 ? 'ok' : 'warn',
      latestSnapshot: r?.latest,
      recentSnapshots: Number(r?.total ?? 0),
    };
  } catch {
    checks.manipulationScanner = { status: 'unknown' };
  }

  // ── Process info ──────────────────────────────────────────
  const processInfo = typeof process !== 'undefined'
    ? (() => {
        const mem = process.memoryUsage();
        return {
          uptimeSec: Math.round(process.uptime()),
          memoryRssMb: Math.round(mem.rss / (1024 * 1024)),
          memoryHeapMb: Math.round(mem.heapUsed / (1024 * 1024)),
          pid: process.pid,
          nodeVersion: process.version,
        };
      })()
    : undefined;

  const response: HealthResponse = {
    status: overallStatus,
    timestamp: new Date().toISOString(),
    checks,
    process: processInfo,
    responseTimeMs: Date.now() - startMs,
  };

  if (overallStatus !== 'ok') {
    log.warn('Health check degraded', {
      status: overallStatus,
      responseTimeMs: response.responseTimeMs,
    });
  }

  const httpStatus = overallStatus === 'unhealthy' ? 503 : 200;
  return NextResponse.json(response, { status: httpStatus });
}
