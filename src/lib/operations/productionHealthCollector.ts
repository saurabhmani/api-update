// ════════════════════════════════════════════════════════════════
//  Phase 5 — Production Health Collector (read-only DB/cache probes)
// ════════════════════════════════════════════════════════════════

import { access, constants } from 'node:fs/promises';
import { join } from 'node:path';
import { db } from '@/lib/db';
import { cacheGet, cacheSet } from '@/lib/redis';
import { getSignalEngineConfig } from '@/lib/signal-engine/config/signalEnginePhase2Config';
import { getRuntimeSignalEngineConfig } from '@/lib/signal-engine/adaptive/runtimeConfiguration';
import {
  buildProductionHealthSummary,
  mapCheckStatus,
  type HealthProbeInput,
} from './productionHealthService';
import type { ComponentStatus, ProductionHealthSummary } from './types';

function toComponentStatus(check: 'ok' | 'warn' | 'fail' | 'unknown'): ComponentStatus {
  if (check === 'fail') return 'unhealthy';
  if (check === 'warn') return 'degraded';
  if (check === 'unknown') return 'unknown';
  return 'healthy';
}

export async function collectHealthProbeInput(): Promise<HealthProbeInput> {
  const generatedAt = new Date().toISOString();
  const input: HealthProbeInput = { generatedAt };

  try {
    const t0 = Date.now();
    const { rows } = await db.query<{ cnt: number; latest: string | null }>(
      `SELECT COUNT(*) AS cnt, MAX(ts) AS latest
       FROM candles WHERE candle_type = 'eod' AND interval_unit = '1day'`,
    );
    const cnt = Number(rows[0]?.cnt ?? 0);
    const latest = rows[0]?.latest ?? null;
    const ageHours = latest
      ? (Date.now() - new Date(latest).getTime()) / 3_600_000
      : null;
    input.marketData = {
      latencyMs: Date.now() - t0,
      lastCandleAt: latest,
      candleCount: cnt,
      status: cnt === 0 ? 'unhealthy' : ageHours != null && ageHours > 72 ? 'degraded' : 'healthy',
    };
  } catch {
    input.marketData = { latencyMs: null, lastCandleAt: null, candleCount: 0, status: 'unhealthy' };
  }

  try {
    const { rows } = await db.query<{ job_name: string; status: string; duration_ms: number; run_at: string }>(
      `SELECT job_name, status, duration_ms, run_at
       FROM q365_learning_job_runs
       WHERE run_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR)
       ORDER BY run_at DESC`,
    );
    const latestByJob = new Map<string, { name: string; status: string; durationMs: number; runAt: string }>();
    for (const r of rows) {
      if (!latestByJob.has(r.job_name)) {
        latestByJob.set(r.job_name, {
          name: r.job_name,
          status: r.status,
          durationMs: Number(r.duration_ms),
          runAt: String(r.run_at),
        });
      }
    }
    const jobs = [...latestByJob.values()];
    const hasFailure = jobs.some((j) => j.status === 'failed');
    input.scheduler = {
      jobs,
      status: jobs.length === 0 ? 'unknown' : hasFailure ? 'degraded' : 'healthy',
    };
  } catch {
    input.scheduler = { jobs: [], status: 'unknown' };
  }

  try {
    const { rows } = await db.query<{ cnt: number; latest: string | null }>(
      `SELECT COUNT(*) AS cnt, MAX(generated_at) AS latest
       FROM q365_signals WHERE DATE(generated_at) = CURDATE()`,
    );
    input.signalGeneration = {
      lastRunAt: rows[0]?.latest ? String(rows[0].latest) : null,
      signalsToday: Number(rows[0]?.cnt ?? 0),
      status: 'healthy',
    };
  } catch {
    input.signalGeneration = { lastRunAt: null, signalsToday: 0, status: 'unknown' };
  }

  try {
    const { rows } = await db.query<{ job_name: string; status: string; run_at: string }>(
      `SELECT job_name, status, run_at FROM q365_learning_job_runs
       WHERE job_name = 'runAdaptiveLearningPipeline'
       ORDER BY run_at DESC LIMIT 1`,
    );
    let activeId: string | null = null;
    try {
      const ptr = await db.query<{ parameter_id: string }>(
        `SELECT parameter_id FROM q365_adaptive_parameter_pointer WHERE pointer_name = 'active' LIMIT 1`,
      );
      activeId = ptr.rows[0]?.parameter_id ?? null;
    } catch { /* table may not exist yet */ }
    const row = rows[0];
    input.adaptivePipeline = {
      lastRunAt: row ? String(row.run_at) : null,
      lastStatus: row?.status ?? null,
      activeParameterId: activeId,
      status: row?.status === 'failed' ? 'degraded' : row ? 'healthy' : 'unknown',
    };
  } catch {
    input.adaptivePipeline = { lastRunAt: null, lastStatus: null, activeParameterId: null, status: 'unknown' };
  }

  try {
    const t0 = Date.now();
    await db.query('SELECT 1');
    input.database = { latencyMs: Date.now() - t0, status: 'healthy' };
  } catch (err) {
    input.database = {
      latencyMs: null,
      status: 'unhealthy',
      error: err instanceof Error ? err.message : String(err),
    };
  }

  try {
    const t0 = Date.now();
    await cacheSet('__ops_health__', 1, 10);
    const val = await cacheGet<number>('__ops_health__');
    input.cache = {
      latencyMs: Date.now() - t0,
      status: val === 1 ? 'healthy' : 'degraded',
    };
  } catch (err) {
    input.cache = {
      latencyMs: null,
      status: 'degraded',
      error: err instanceof Error ? err.message : String(err),
    };
  }

  try {
    const reportsDir = join(process.cwd(), 'reports');
    await access(reportsDir, constants.W_OK);
    input.filesystem = { reportsDirWritable: true, status: 'healthy' };
  } catch {
    input.filesystem = { reportsDirWritable: false, status: 'degraded' };
  }

  input.reportGeneration = {
    lastReportAt: null,
    status: input.filesystem?.reportsDirWritable ? 'healthy' : 'degraded',
  };

  return input;
}

export async function collectProductionHealth(): Promise<ProductionHealthSummary> {
  const start = Date.now();
  const input = await collectHealthProbeInput();
  return buildProductionHealthSummary(input, Date.now() - start);
}

export function getConfigurationVersions(): {
  configurationVersion: string;
  runtimeConfigurationVersion: string;
  activeAdaptiveVersion: string | null;
} {
  const base = getSignalEngineConfig();
  const runtime = getRuntimeSignalEngineConfig();
  return {
    configurationVersion: base.configVersionLabel,
    runtimeConfigurationVersion: runtime.config.configVersionLabel,
    activeAdaptiveVersion: runtime.manifest.adaptiveParameterId,
  };
}

export { toComponentStatus, mapCheckStatus };
