// ════════════════════════════════════════════════════════════════
//  IndianAPI usage tracker — daily / monthly / per-run call counters
//  with budget enforcement.
//
//  Redis-backed (shared across processes / PM2 instances) with an
//  in-process fallback when Redis is unavailable. Counters are
//  bucketed by IST calendar day (Asia/Kolkata) so they rotate at
//  midnight IST regardless of host timezone.
//
//  Budget semantics:
//    • daily soft limit  → throw ApiBudgetExceededError (degrade;
//      resume tomorrow)
//    • monthly limit     → hard freeze until the month rolls
//    • per-run limit     → cap a single ingestion run so one job can
//      never drain the whole day's budget
// ════════════════════════════════════════════════════════════════

import { getRedisClient } from '@/lib/redis';
import { getIndianApiIngestConfig } from '@/lib/marketData/providerFlags';

export type ApiBudgetBucket = 'daily' | 'monthly' | 'per-run';

export class ApiBudgetExceededError extends Error {
  constructor(
    public readonly bucket: ApiBudgetBucket,
    public readonly used: number,
    public readonly limit: number,
  ) {
    super(`IndianAPI ${bucket} budget exceeded: ${used}/${limit}`);
    this.name = 'ApiBudgetExceededError';
  }
}

export interface ApiUsageSnapshot {
  date: string;
  month: string;
  daily: number;
  monthly: number;
  perRun: number | null;
  dailyLimit: number;
  monthlyLimit: number;
  perRunLimit: number;
}

const KEY_PREFIX = 'indianapi:usage';
// Keep counters a bit past their natural window so ops can inspect them.
const DAILY_TTL_S = 3 * 24 * 60 * 60;
const MONTHLY_TTL_S = 40 * 24 * 60 * 60;

function nowIstParts(): { date: string; month: string } {
  // Asia/Kolkata is UTC+5:30, no DST.
  const ms = Date.now() + 5.5 * 60 * 60_000;
  const d = new Date(ms);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return { date: `${yyyy}-${mm}-${dd}`, month: `${yyyy}-${mm}` };
}

// In-process fallback counters (single-instance correctness only)
const _localCounts = new Map<string, number>();

function localIncr(key: string, by: number): number {
  const next = (_localCounts.get(key) ?? 0) + by;
  _localCounts.set(key, next);
  return next;
}

function localGet(key: string): number {
  return _localCounts.get(key) ?? 0;
}

// Per-run window — process-local by design: one run belongs to one
// process (the ingest lock guarantees no concurrent runs).
let _perRun: { used: number; limit: number } | null = null;

export function beginPerRunBudget(limit?: number): void {
  const cfg = getIndianApiIngestConfig();
  _perRun = { used: 0, limit: limit ?? cfg.perRunLimit };
}

export function endPerRunBudget(): void {
  _perRun = null;
}

export function checkPerRunBudget(): void {
  if (!_perRun) return;
  if (_perRun.used >= _perRun.limit) {
    throw new ApiBudgetExceededError('per-run', _perRun.used, _perRun.limit);
  }
}

/** Increment usage counters AFTER a request was dispatched upstream. */
export async function incrementApiUsage(by = 1): Promise<void> {
  const { date, month } = nowIstParts();
  const dayKey = `${KEY_PREFIX}:day:${date}`;
  const monthKey = `${KEY_PREFIX}:month:${month}`;

  if (_perRun) _perRun.used += by;

  const redis = getRedisClient();
  if (redis) {
    try {
      await redis
        .multi()
        .incrby(dayKey, by)
        .expire(dayKey, DAILY_TTL_S)
        .incrby(monthKey, by)
        .expire(monthKey, MONTHLY_TTL_S)
        .exec();
      return;
    } catch {
      // fall through to local
    }
  }
  localIncr(dayKey, by);
  localIncr(monthKey, by);
}

export async function getApiUsage(): Promise<ApiUsageSnapshot> {
  const cfg = getIndianApiIngestConfig();
  const { date, month } = nowIstParts();
  const dayKey = `${KEY_PREFIX}:day:${date}`;
  const monthKey = `${KEY_PREFIX}:month:${month}`;

  let daily = localGet(dayKey);
  let monthly = localGet(monthKey);

  const redis = getRedisClient();
  if (redis) {
    try {
      const [d, m] = await redis.mget(dayKey, monthKey);
      daily = Number(d ?? 0);
      monthly = Number(m ?? 0);
    } catch {
      // keep local values
    }
  }

  return {
    date,
    month,
    daily,
    monthly,
    perRun: _perRun ? _perRun.used : null,
    dailyLimit: cfg.dailySoftLimit,
    monthlyLimit: cfg.monthlyLimit,
    perRunLimit: _perRun?.limit ?? cfg.perRunLimit,
  };
}

/**
 * Pre-flight budget gate. Throws ApiBudgetExceededError when any
 * bucket is exhausted; callers surface "budget exhausted" instead of
 * silently hammering the upstream's hard rate limit.
 */
export async function checkApiBudget(): Promise<void> {
  checkPerRunBudget();
  const usage = await getApiUsage();
  if (usage.monthly >= usage.monthlyLimit) {
    throw new ApiBudgetExceededError('monthly', usage.monthly, usage.monthlyLimit);
  }
  if (usage.daily >= usage.dailyLimit) {
    throw new ApiBudgetExceededError('daily', usage.daily, usage.dailyLimit);
  }
}

/** Test hook — clears local fallback counters and per-run window. */
export function resetIndianApiUsageForTests(): void {
  _localCounts.clear();
  _perRun = null;
}
