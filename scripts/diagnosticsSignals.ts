/**
 * Safe signal-pipeline diagnostics for local and production.
 *
 *   npm run diagnostics:signals
 *
 * Exits non-zero when critical production requirements are missing.
 * Never prints passwords, API keys, or full connection strings.
 */

import { config as dotenvConfig } from 'dotenv';
import { resolveEnvFilePath } from '@/lib/envPath';
import { logRuntimeIdentity, resolveRuntimeIdentity } from '@/lib/diagnostics/runtimeIdentity';
import {
  checkSignalSchemaHealth,
  logSchemaHealth,
} from '@/lib/diagnostics/signalSchemaHealth';
import {
  checkWarehouseHealth,
  logWarehouseHealth,
} from '@/lib/diagnostics/scanWarehouseHealth';
import { getSchedulerScanHealth } from '@/lib/diagnostics/schedulerScanHealth';
import { db } from '@/lib/db';
import { isDailyScanScheduleEnabled } from '@/lib/signal-engine/schedule/signalSchedulePolicy';

const envFile = resolveEnvFilePath();
dotenvConfig({ path: envFile });
process.env.TZ = process.env.TZ || 'Asia/Kolkata';

function redactSecrets(value: unknown): unknown {
  if (value == null) return value;
  if (typeof value === 'string') {
    if (/password|secret|api[_-]?key|token|DATABASE_URL/i.test(value)) return '[REDACTED]';
    if (/:\/\/[^@]+@/.test(value)) return value.replace(/:\/\/[^@]+@/, '://***@');
    return value;
  }
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (/password|secret|api[_-]?key|token|DATABASE_URL|authorization/i.test(k)) {
        out[k] = '[REDACTED]';
      } else {
        out[k] = redactSecrets(v);
      }
    }
    return out;
  }
  return value;
}

async function probeRedis(): Promise<{ available: boolean; detail: string }> {
  if (['1', 'true', 'yes'].includes(String(process.env.REDIS_DISABLED || '').toLowerCase())) {
    return { available: false, detail: 'REDIS_DISABLED=1' };
  }
  try {
    const { cacheGet, cacheSet } = await import('@/lib/redis');
    const key = `diagnostics:signals:ping:${Date.now()}`;
    await cacheSet(key, { ok: true }, 30);
    const val = await cacheGet<{ ok: boolean }>(key);
    return { available: Boolean(val?.ok), detail: val?.ok ? 'pong' : 'miss' };
  } catch (err) {
    return {
      available: false,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

async function probeSignalsTable(): Promise<{
  total: number;
  newestCreatedAt: string | null;
  newestGeneratedAt: string | null;
  activeCount: number;
  approvedCount: number;
}> {
  try {
    const { rows } = await db.query<{
      total: number;
      newest_created: string | null;
      newest_generated: string | null;
      active_count: number;
      approved_count: number;
    }>(`
      SELECT
        COUNT(*) AS total,
        MAX(created_at) AS newest_created,
        MAX(generated_at) AS newest_generated,
        SUM(CASE WHEN status IN ('active','watchlist') THEN 1 ELSE 0 END) AS active_count,
        SUM(CASE WHEN classification = 'APPROVED_SIGNAL' OR signal_status = 'APPROVED_SIGNAL' THEN 1 ELSE 0 END) AS approved_count
      FROM q365_signals
    `);
    const r = rows[0] ?? ({} as any);
    return {
      total: Number(r.total ?? 0),
      newestCreatedAt: r.newest_created ? String(r.newest_created) : null,
      newestGeneratedAt: r.newest_generated ? String(r.newest_generated) : null,
      activeCount: Number(r.active_count ?? 0),
      approvedCount: Number(r.approved_count ?? 0),
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Retry without optional columns if schema is partial.
    if (/Unknown column/i.test(msg)) {
      const { rows } = await db.query<{ total: number; newest_created: string | null; newest_generated: string | null }>(`
        SELECT COUNT(*) AS total, MAX(created_at) AS newest_created, MAX(generated_at) AS newest_generated
        FROM q365_signals
      `);
      const r = rows[0] ?? ({} as any);
      return {
        total: Number(r.total ?? 0),
        newestCreatedAt: r.newest_created ? String(r.newest_created) : null,
        newestGeneratedAt: r.newest_generated ? String(r.newest_generated) : null,
        activeCount: -1,
        approvedCount: -1,
      };
    }
    throw err;
  }
}

async function probeCacheAge(): Promise<{ key: string; ageSeconds: number | null }> {
  try {
    const { cacheGet } = await import('@/lib/redis');
    // Best-effort: look at scheduler scan-health stamps.
    const morning = await cacheGet<{ completedAt?: string }>('scheduler:scanHealth:morning');
    if (morning?.completedAt) {
      const age = Math.round((Date.now() - Date.parse(morning.completedAt)) / 1000);
      return { key: 'scheduler:scanHealth:morning', ageSeconds: Number.isFinite(age) ? age : null };
    }
  } catch { /* ignore */ }
  return { key: 'scheduler:scanHealth:morning', ageSeconds: null };
}

async function main(): Promise<void> {
  const identity = logRuntimeIdentity({
    component: 'diagnostics:signals',
    processRole: 'diagnostics',
    envFileHint: envFile,
  });

  const schema = await checkSignalSchemaHealth();
  logSchemaHealth(schema);

  const warehouse = await checkWarehouseHealth();
  logWarehouseHealth(warehouse);

  const redis = await probeRedis();
  const signals = await probeSignalsTable();
  const scanHealth = await getSchedulerScanHealth();
  const cacheAge = await probeCacheAge();

  let confirmed: {
    total: number;
    active: number;
    maxConfirmedAt: string | null;
    maxUpdatedAt: string | null;
  } = { total: 0, active: 0, maxConfirmedAt: null, maxUpdatedAt: null };
  try {
    const { rows } = await db.query<{
      total: number;
      active: number;
      max_confirmed: string | null;
      max_updated: string | null;
    }>(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN status = 'ACTIVE' AND valid_until > NOW() THEN 1 ELSE 0 END) AS active,
        MAX(confirmed_at) AS max_confirmed,
        MAX(updated_at) AS max_updated
      FROM q365_confirmed_signal_snapshots
    `);
    const r = rows[0] as any;
    confirmed = {
      total: Number(r?.total ?? 0),
      active: Number(r?.active ?? 0),
      maxConfirmedAt: r?.max_confirmed ? String(r.max_confirmed) : null,
      maxUpdatedAt: r?.max_updated ? String(r.max_updated) : null,
    };
  } catch { /* table optional */ }

  const schedulerEnabled = isDailyScanScheduleEnabled();
  const inproc = String(process.env.Q365_INPROC_SCHEDULER ?? '').trim();

  const critical: string[] = [];
  if (!schema.ok) critical.push('schema_unhealthy');
  if (!warehouse.ok) critical.push('warehouse_not_ready');
  if (!identity.indianApiEnabled) critical.push('indianapi_disabled_or_missing_key');
  if (identity.nodeEnv === 'production' && !redis.available && !identity.redisDisabled) {
    critical.push('redis_unavailable_in_production');
  }
  if (signals.total === 0) critical.push('zero_signals');
  if (signals.newestGeneratedAt) {
    const ageH = (Date.now() - Date.parse(String(signals.newestGeneratedAt))) / 3_600_000;
    if (Number.isFinite(ageH) && ageH > 72) critical.push(`newest_signal_stale_hours=${ageH.toFixed(1)}`);
  } else if (signals.total > 0) {
    critical.push('newest_signal_timestamp_missing');
  }
  if (confirmed.maxConfirmedAt) {
    const ageH = (Date.now() - Date.parse(String(confirmed.maxConfirmedAt))) / 3_600_000;
    if (Number.isFinite(ageH) && ageH > 72) {
      critical.push(`newest_confirmed_stale_hours=${ageH.toFixed(1)}`);
    }
  } else if (identity.nodeEnv === 'production') {
    critical.push('no_confirmed_snapshots');
  }

  const report = {
    runtime: identity,
    redis: { available: redis.available, detail: redis.detail },
    indianApiEnabled: identity.indianApiEnabled,
    activeProvider: process.env.MARKET_DATA_PROVIDER || process.env.ACTIVE_MARKET_DATA_PROVIDER || 'indianapi',
    warehouse: {
      latestCandleDate: warehouse.latestCandleDate,
      universeCount: warehouse.universeCount,
      symbolsWithEnoughBars: warehouse.symbolsWithEnoughBars,
      staleSymbolCount: warehouse.staleSymbolCount,
      indianApiBreakerState: warehouse.indianApiBreakerState,
      ok: warehouse.ok,
      reason: warehouse.reason,
    },
    signals: {
      total: signals.total,
      newestCreatedAt: signals.newestCreatedAt,
      newestGeneratedAt: signals.newestGeneratedAt,
      activeCount: signals.activeCount,
      approvedCount: signals.approvedCount,
    },
    confirmedSnapshots: confirmed,
    schema: {
      ok: schema.ok,
      missingColumns: schema.missingColumns,
      missingIndexes: schema.missingIndexes,
    },
    scheduler: {
      enabled: schedulerEnabled,
      inprocFlag: inproc || '(unset)',
      ...scanHealth,
    },
    cache: cacheAge,
    critical,
    architectureNote:
      'Local and live use separate databases by design. Identical code ' +
      'does not imply identical rows — each environment generates signals ' +
      'from its own candle warehouse. Prefer production as canonical. ' +
      'Last Confirmed Signal = MAX(confirmed_at) on q365_confirmed_signal_snapshots; ' +
      'pipeline runs do not create confirmed rows — only the maturity worker does.',
  };

  console.log('\n[DIAGNOSTICS_SIGNALS_REPORT]');
  console.log(JSON.stringify(redactSecrets(report), null, 2));

  if (critical.length > 0) {
    console.error(`[DIAGNOSTICS_SIGNALS] FAIL critical=${critical.join(',')}`);
    process.exit(1);
  }
  console.log('[DIAGNOSTICS_SIGNALS] OK');
  process.exit(0);
}

main().catch((err) => {
  console.error('[diagnostics:signals] fatal:', err);
  process.exit(1);
});
