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
import { CACHE_TTL } from '@/lib/cache/cachePolicy';
import { getPipelineHeartbeat } from '@/lib/marketData/providers/batchScheduler';
import { computeManipulationFreshness } from '@/lib/manipulation-engine/manipulationSignalRisk';

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
  source:   'yahoo'; // @deprecated marker
  mode:     'signal-only';
  realtime: false;
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

/** Only hard failures flip overall status — warnings stay visible per-check. */
function applyCheckResult(
  overall: HealthStatus,
  checkStatus: CheckStatus,
): HealthStatus {
  if (checkStatus === 'fail') return degradeStatus(overall, 'degraded');
  return overall;
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
    await cacheSet(testKey, 1, CACHE_TTL.REDIS_HEALTH_PROBE);
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
    const { probeCandleWarehouse } = await import('@/lib/monitor/candleWarehouseProbe');
    const t0 = Date.now();
    const cov = await probeCandleWarehouse();
    const ageDays = cov.latestCandleDate
      ? Math.floor((Date.now() - new Date(`${cov.latestCandleDate}T00:00:00Z`).getTime()) / (1000 * 60 * 60 * 24))
      : null;
    checks.candleData = {
      status: cov.candleCount > 0 || cov.latestCandleDate ? 'ok' : 'warn',
      totalCandles: cov.candleCount,
      latestBar: cov.latestCandleDate,
      ageDays,
      latencyMs: Date.now() - t0,
      fromCache: cov.fromCache === true,
    };
    if (!(cov.candleCount > 0 || cov.latestCandleDate)) {
      overallStatus = applyCheckResult(overallStatus, 'fail');
    }
  } catch (err) {
    checks.candleData = {
      status: 'fail',
      error: err instanceof Error ? err.message : String(err),
    };
    overallStatus = applyCheckResult(overallStatus, 'fail');
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
    if (jobs.length > 0 && !allSuccess) {
      overallStatus = applyCheckResult(overallStatus, 'warn');
    }
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
    const newsRequired = process.env.NEWS_PIPELINE_REQUIRED === 'true';
    const newsStatus: CheckStatus = !r ? 'unknown'
      : ageHours != null && ageHours <= 4 ? 'ok'
      : newsRequired ? 'fail' : 'warn';
    checks.newsPipeline = {
      status: newsStatus,
      lastRun, ageHours,
      lastFetched: r?.total_fetched ?? 0,
      lastNewEvents: r?.new_events ?? 0,
      lastDurationMs: r?.duration_ms ?? 0,
      required: newsRequired,
    };
    overallStatus = applyCheckResult(overallStatus, newsStatus);
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
    overallStatus = applyCheckResult(overallStatus, status);
  } catch (err) {
    checks.backtestEngine = {
      status: 'fail',
      error: (err as Error).message,
    };
    overallStatus = applyCheckResult(overallStatus, 'fail');
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
    overallStatus = applyCheckResult(overallStatus, status);
  } catch (err) {
    checks.signalEngine = {
      status: 'fail',
      error: (err as Error).message,
    };
    overallStatus = applyCheckResult(overallStatus, 'fail');
  }

  // ── Check 9: Market-data scheduler liveness ──────────────
  // instrument_sync_logs CRON rows are optional — in-proc schedulers
  // and the pipeline heartbeat are authoritative fallbacks.
  try {
    const { rows } = await db.query<any>(
      `SELECT exchange AS job, status, total, updated, error_msg, synced_at
         FROM instrument_sync_logs
        WHERE exchange LIKE 'CRON:%'
        ORDER BY id DESC
        LIMIT 1`,
    );
    const r = (rows as any[])[0];
    let lastRun: string | null = r?.synced_at ?? null;
    let ageHours: number | null = lastRun
      ? Math.round((Date.now() - new Date(lastRun).getTime()) / 3600000)
      : null;
    let probeSource = 'instrument_sync_logs';
    let status: CheckStatus;

    if (lastRun) {
      status =
        (ageHours ?? 0) > 48 ? 'fail' :
        (ageHours ?? 0) > 14 ? 'warn' : 'ok';
    } else {
      const heartbeat = await getPipelineHeartbeat().catch(() => null);
      const hbAgeMin = heartbeat
        ? Math.round((Date.now() - heartbeat.at) / 60_000)
        : null;
      const candleOk =
        checks.candleData?.status === 'ok'
        && (checks.candleData.ageDays as number | null | undefined) != null
        && (checks.candleData.ageDays as number) <= 1;

      if (heartbeat && hbAgeMin != null && hbAgeMin <= 15) {
        status = 'ok';
        probeSource = `redis_heartbeat:${heartbeat.source}`;
        lastRun = new Date(heartbeat.at).toISOString();
        ageHours = Math.round(hbAgeMin / 60);
      } else if (candleOk) {
        status = 'ok';
        probeSource = 'candle_freshness_proxy';
        lastRun = String(checks.candleData?.latestBar ?? null);
        ageHours = 0;
      } else if (heartbeat && hbAgeMin != null && hbAgeMin <= 60) {
        status = 'warn';
        probeSource = `redis_heartbeat_stale:${heartbeat.source}`;
        lastRun = new Date(heartbeat.at).toISOString();
        ageHours = Math.round(hbAgeMin / 60);
      } else {
        status = 'warn';
        probeSource = 'no_cron_log_no_heartbeat';
      }
    }

    checks.marketDataScheduler = {
      status,
      probeSource,
      lastJob:     r?.job ?? null,
      lastRun,
      ageHours,
      lastStatus:  r?.status ?? null,
      lastUpdated: Number(r?.updated ?? 0),
      lastError:   r?.error_msg ?? null,
    };
    overallStatus = applyCheckResult(overallStatus, status);
  } catch (err) {
    checks.marketDataScheduler = {
      status: 'unknown',
      error: (err as Error).message,
    };
  }

  // ── Check 10: Manipulation scanner status ──────────────────
  try {
    const freshness = await computeManipulationFreshness().catch(() => null);
    const { rows } = await db.query<any>(
      `SELECT MAX(created_at) AS latest_scan_at,
              MAX(snapshot_date) AS latest_snapshot_date,
              COUNT(*) AS total
         FROM q365_manipulation_snapshots
        WHERE created_at >= DATE_SUB(NOW(), INTERVAL 3 DAY)`,
    );
    const r = (rows as any[])[0];
    const recentSnapshots = Number(r?.total ?? 0);
    const manipStatus: CheckStatus =
      !freshness || freshness.status === 'NO_DATA' ? 'warn' :
      freshness.isStale ? 'warn' :
      recentSnapshots > 0 ? 'ok' : 'warn';
    checks.manipulationScanner = {
      status: manipStatus,
      latestScanAt: freshness?.latestScanAt ?? r?.latest_scan_at ?? null,
      latestSnapshotDate: r?.latest_snapshot_date ?? null,
      freshnessStatus: freshness?.status ?? 'unknown',
      recentSnapshots,
    };
    if (freshness?.isStale) {
      overallStatus = applyCheckResult(overallStatus, 'warn');
    }
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
    source:   'yahoo', // @deprecated marker
    mode:     'signal-only',
    realtime: false,
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
