// ════════════════════════════════════════════════════════════════
//  Provider request log + quota guard (IndianAPI)
//
//  Persists every billable upstream call to `provider_request_logs`
//  and exposes aggregation + pre-job budget checks.
//
//  Recommended env (see docs/PROVIDER_REQUEST_POLICY.md):
//    INDIAN_API_MONTHLY_BUDGET=100000   (alias: INDIANAPI_MONTHLY_LIMIT) — hard ceiling
//    INDIANAPI_MONTHLY_TARGET=25000     — ops planning band 22k–30k
//    INDIAN_API_DAILY_SOFT_LIMIT=4000   (alias: INDIANAPI_DAILY_LIMIT)
//    CANDLE_DAILY_UPDATE_MAX_FETCH=1000 — evening update per-run cap
//    INDIAN_API_HARD_STOP_ON_LIMIT=true
// ════════════════════════════════════════════════════════════════

import { db } from '@/lib/db';
import { migrateProviderRequestLogs } from '@/lib/db/migrateProviderRequestLogs';
import { getApiUsage } from '@/providers/adapters/indianApiUsageTracker';
import { getProviderRequestContext } from '@/lib/marketData/providerRequestContext';

let _tableReady: Promise<void> | null = null;

function ensureTable(): Promise<void> {
  if (!_tableReady) {
    _tableReady = migrateProviderRequestLogs().catch((err) => {
      _tableReady = null;
      throw err;
    });
  }
  return _tableReady;
}

function resolveBool(name: string, fallback: boolean): boolean {
  const raw = (process.env[name] ?? '').trim().toLowerCase();
  if (!raw) return fallback;
  return raw === 'true' || raw === '1' || raw === 'yes' || raw === 'on';
}

export const INDIAN_API_HARD_STOP_ON_LIMIT = () =>
  resolveBool('INDIAN_API_HARD_STOP_ON_LIMIT', true);

export interface ProviderRequestLogInput {
  provider?: string;
  endpoint: string;
  symbol?: string | null;
  requestType?: string | null;
  statusCode?: number | null;
  success: boolean;
  errorMessage?: string | null;
  jobId?: string | null;
  sourceJob?: string | null;
  responseCount?: number | null;
  requestedAt?: Date;
}

export async function logProviderRequest(input: ProviderRequestLogInput): Promise<void> {
  const ctx = getProviderRequestContext();
  try {
    await ensureTable();
    await db.query(
      `INSERT INTO provider_request_logs
         (provider, endpoint, symbol, request_type, status_code, success,
          error_message, requested_at, job_id, source_job, response_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.provider ?? 'indianapi',
        input.endpoint.slice(0, 128),
        input.symbol?.toUpperCase().slice(0, 64) ?? ctx?.symbol?.toUpperCase() ?? null,
        input.requestType ?? ctx?.requestType ?? null,
        input.statusCode ?? null,
        input.success ? 1 : 0,
        input.errorMessage?.slice(0, 512) ?? null,
        input.requestedAt ?? new Date(),
        input.jobId ?? ctx?.jobId ?? null,
        input.sourceJob ?? ctx?.sourceJob ?? null,
        input.responseCount ?? null,
      ],
    );
  } catch (err) {
    console.warn(
      '[PROVIDER_REQUEST_LOG] insert failed:',
      (err as Error)?.message ?? String(err),
    );
  }
}

function istDayStartUtc(): Date {
  const ms = Date.now() + 5.5 * 3_600_000;
  const d = new Date(ms);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const istMidnightMs = Date.UTC(yyyy, d.getUTCMonth(), d.getUTCDate()) - 5.5 * 3_600_000;
  return new Date(istMidnightMs);
}

function istMonthStartUtc(): Date {
  const ms = Date.now() + 5.5 * 3_600_000;
  const d = new Date(ms);
  const istMidnightMs = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) - 5.5 * 3_600_000;
  return new Date(istMidnightMs);
}

export interface ProviderRequestAggregation {
  requests_today: number;
  requests_this_month: number;
  monthly_budget: number;
  monthly_remaining: number;
  daily_soft_limit: number;
  daily_remaining: number;
  by_job: Array<{ source_job: string; count: number }>;
  by_endpoint: Array<{ endpoint: string; count: number }>;
  counter_daily: number;
  counter_monthly: number;
}

export async function aggregateProviderRequests(
  provider = 'indianapi',
): Promise<ProviderRequestAggregation> {
  await ensureTable();
  const usage = getApiUsage();
  const dayStart = istDayStartUtc();
  const monthStart = istMonthStartUtc();

  const { rows: dayRows } = await db.query<{ c: number }>(
    `SELECT COUNT(*) AS c FROM provider_request_logs
      WHERE provider = ? AND requested_at >= ?`,
    [provider, dayStart],
  );
  const { rows: monthRows } = await db.query<{ c: number }>(
    `SELECT COUNT(*) AS c FROM provider_request_logs
      WHERE provider = ? AND requested_at >= ?`,
    [provider, monthStart],
  );
  const { rows: jobRows } = await db.query<{ source_job: string; c: number }>(
    `SELECT COALESCE(source_job, 'unknown') AS source_job, COUNT(*) AS c
       FROM provider_request_logs
      WHERE provider = ? AND requested_at >= ?
      GROUP BY COALESCE(source_job, 'unknown')
      ORDER BY c DESC
      LIMIT 25`,
    [provider, monthStart],
  );
  const { rows: epRows } = await db.query<{ endpoint: string; c: number }>(
    `SELECT endpoint, COUNT(*) AS c
       FROM provider_request_logs
      WHERE provider = ? AND requested_at >= ?
      GROUP BY endpoint
      ORDER BY c DESC
      LIMIT 25`,
    [provider, monthStart],
  );

  const requestsToday = Number(dayRows[0]?.c ?? 0);
  const requestsMonth = Number(monthRows[0]?.c ?? 0);
  const counterDaily = Math.max(requestsToday, usage.daily);
  const counterMonthly = Math.max(requestsMonth, usage.monthly);

  return {
    requests_today: requestsToday,
    requests_this_month: requestsMonth,
    monthly_budget: usage.monthly_limit,
    monthly_remaining: Math.max(0, usage.monthly_limit - counterMonthly),
    daily_soft_limit: usage.daily_limit,
    daily_remaining: Math.max(0, usage.daily_limit - counterDaily),
    by_job: jobRows.map((r) => ({
      source_job: r.source_job,
      count: Number(r.c),
    })),
    by_endpoint: epRows.map((r) => ({
      endpoint: r.endpoint,
      count: Number(r.c),
    })),
    counter_daily: counterDaily,
    counter_monthly: counterMonthly,
  };
}

export type QuotaGuardAction = 'allow' | 'warn' | 'block';

export interface QuotaGuardResult {
  action: QuotaGuardAction;
  allowed: boolean;
  estimated_requests: number;
  daily_used: number;
  monthly_used: number;
  daily_remaining: number;
  monthly_remaining: number;
  reasons: string[];
}

export interface QuotaGuardInput {
  estimatedRequests: number;
  jobId: string;
  sourceJob: string;
  /** When true, never block — only return warn metadata. */
  warnOnly?: boolean;
}

export async function checkQuotaBeforeJob(
  input: QuotaGuardInput,
): Promise<QuotaGuardResult> {
  const agg = await aggregateProviderRequests();
  const estimate = Math.max(0, Math.floor(input.estimatedRequests));
  const hardStop = INDIAN_API_HARD_STOP_ON_LIMIT() && !input.warnOnly;

  const reasons: string[] = [];
  let action: QuotaGuardAction = 'allow';

  const dailyAfter = agg.counter_daily + estimate;
  const monthlyAfter = agg.counter_monthly + estimate;

  if (monthlyAfter > agg.monthly_budget) {
    reasons.push(
      `monthly projection ${monthlyAfter} > budget ${agg.monthly_budget} ` +
      `(used=${agg.counter_monthly}, estimate=${estimate})`,
    );
    action = 'block';
  } else if (dailyAfter > agg.daily_soft_limit) {
    reasons.push(
      `daily projection ${dailyAfter} > soft limit ${agg.daily_soft_limit} ` +
      `(used=${agg.counter_daily}, estimate=${estimate})`,
    );
    action = 'warn';
  } else if (estimate >= 500) {
    reasons.push(`large job estimate=${estimate} requests`);
    action = 'warn';
  }

  const allowed = action !== 'block' || !hardStop;

  console.log('[QUOTA_GUARD]', {
    job_id: input.jobId,
    source_job: input.sourceJob,
    estimated_requests: estimate,
    action,
    allowed,
    hard_stop: hardStop,
    daily_used: agg.counter_daily,
    monthly_used: agg.counter_monthly,
    daily_remaining: agg.daily_remaining,
    monthly_remaining: agg.monthly_remaining,
    reasons,
  });

  return {
    action,
    allowed,
    estimated_requests: estimate,
    daily_used: agg.counter_daily,
    monthly_used: agg.counter_monthly,
    daily_remaining: agg.daily_remaining,
    monthly_remaining: agg.monthly_remaining,
    reasons,
  };
}

export async function assertQuotaForJob(input: QuotaGuardInput): Promise<QuotaGuardResult> {
  const result = await checkQuotaBeforeJob(input);
  if (!result.allowed) {
    throw new Error(
      `QUOTA_GUARD_BLOCK source_job=${input.sourceJob} job_id=${input.jobId} — ` +
      result.reasons.join('; '),
    );
  }
  if (result.action === 'warn') {
    console.warn(
      `[QUOTA_GUARD WARN] source_job=${input.sourceJob} job_id=${input.jobId} — ` +
      result.reasons.join('; '),
    );
  }
  return result;
}
