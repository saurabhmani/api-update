// ════════════════════════════════════════════════════════════════
//  apiQuota — IndianAPI usage tracking with IST resets.
//
//  Real production limits (from .env / spec):
//    DAILY_LIMIT          = 2,500   (resets 00:00 IST)
//    MONTHLY_SAFE_LIMIT   = 70,000  (soft cap — reduce polling at 70%)
//    MONTHLY_HARD_LIMIT   = 90,000  (freeze ceiling — 100% never exceeded)
//
//  Behavior ladder:
//    < 70%   → SAFE      — normal operation
//    70–90%  → WARNING   — reduce non-critical polling
//    > 90%   → CRITICAL  — block non-critical, only essential calls
//    100%    → BLOCKED   — only health probes; nothing else
//
//  Counters live in Redis (cacheGet/cacheSet falls back to in-process
//  memory when Redis is down) keyed by IST day / IST month, so the
//  daily counter rolls over at 00:00 IST and the monthly counter on
//  the 1st of the IST month — independently of process restarts and
//  independently of the existing UTC-keyed apiBudgetGuard.
//
//  This module is the REPORTING + BEHAVIOR-CONTROL layer for the
//  dashboard. Hard enforcement still lives in apiBudgetGuard
//  (canSpend → spend); both are updated on the same call event so
//  they stay in sync within the rounding noise of two systems.
// ════════════════════════════════════════════════════════════════

import { cacheGet, cacheSet } from '@/lib/redis';

// ── Limits ─────────────────────────────────────────────────────────

export const DAILY_LIMIT =
  Number(process.env.INDIANAPI_DAILY_SOFT_LIMIT) || 2_500;

export const MONTHLY_SAFE_LIMIT =
  Number(process.env.BUDGET_MONTHLY_SOFT_CAP) || 70_000;

export const MONTHLY_HARD_LIMIT =
  Number(process.env.INDIANAPI_MONTHLY_LIMIT)
  || Number(process.env.BUDGET_MONTHLY_FREEZE)
  || 90_000;

// State thresholds (fraction of MONTHLY_HARD_LIMIT or DAILY_LIMIT,
// whichever is higher). Tunable via env if your ops team prefers
// different bands.
const WARN_PCT     = Number(process.env.QUOTA_WARN_PCT)     || 0.70;
const CRITICAL_PCT = Number(process.env.QUOTA_CRITICAL_PCT) || 0.90;
const NEAR_PCT     = Number(process.env.QUOTA_NEAR_PCT)     || 0.90;

// ── Types ──────────────────────────────────────────────────────────

export type QuotaState = 'SAFE' | 'WARNING' | 'CRITICAL' | 'BLOCKED';

export interface DailyQuota {
  used:      number;
  limit:     number;
  remaining: number;
  percent:   number;          // 0..1
}

export interface MonthlyQuota {
  used:           number;
  safe_limit:     number;
  hard_limit:     number;
  remaining_safe: number;     // can go negative when over safe
  remaining_hard: number;
  percent:        number;     // used / hard_limit
  percent_safe:   number;     // used / safe_limit (display helper)
}

export interface QuotaReport {
  daily:           DailyQuota;
  monthly:         MonthlyQuota;
  state:           QuotaState;
  limit_near:      boolean;       // daily ≥ NEAR_PCT * DAILY_LIMIT
  reduce_polling:  boolean;       // any axis ≥ WARN_PCT
  block_non_essential: boolean;   // any axis ≥ CRITICAL_PCT
  block_all:       boolean;       // any axis hit 100%
  resets: {
    daily_at:   string;   // next IST midnight
    monthly_at: string;   // next IST month start
  };
  last_updated_at: string;
}

// ── IST keying helpers ─────────────────────────────────────────────

/** Read current wall-clock as IST. We don't depend on TZ env — use
 *  the UTC offset trick so the `getUTC*` accessors read IST. */
function nowIst(): Date {
  return new Date(Date.now() + 5.5 * 3_600_000);
}

function istDayKey(d = nowIst()): string {
  // YYYY-MM-DD in IST
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function istMonthKey(d = nowIst()): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

function nextIstMidnightIso(d = nowIst()): string {
  // Next 00:00 IST in absolute UTC ISO.
  const next = new Date(d.getTime());
  next.setUTCHours(24, 0, 0, 0);                    // bump to next IST midnight
  // The +5.5h trick turned IST into UTC-ticks; reverse it for ISO.
  return new Date(next.getTime() - 5.5 * 3_600_000).toISOString();
}

function nextIstMonthStartIso(d = nowIst()): string {
  const next = new Date(d.getTime());
  next.setUTCMonth(next.getUTCMonth() + 1, 1);
  next.setUTCHours(0, 0, 0, 0);
  return new Date(next.getTime() - 5.5 * 3_600_000).toISOString();
}

// Slightly oversize TTLs so a value never expires inside the window
// it represents — Redis takes the older value with a short race window
// during reset boundaries; the small overlap is harmless.
const DAY_TTL_S   = 36 * 60 * 60;          // 36 h
const MONTH_TTL_S = 35 * 24 * 60 * 60;     // 35 d

const dayKey   = (k: string) => `quota:ist:day:${k}`;
const monthKey = (k: string) => `quota:ist:month:${k}`;

async function readN(k: string): Promise<number> {
  return (await cacheGet<number>(k)) ?? 0;
}

async function bump(k: string, n: number, ttl: number): Promise<number> {
  const cur = await readN(k);
  const next = cur + n;
  await cacheSet(k, next, ttl);
  return next;
}

// ── Public API ─────────────────────────────────────────────────────

/**
 * Record one (or N) IndianAPI requests. Bumps both the IST-day and
 * IST-month counters. Safe to call from inside a sync hot path —
 * fire-and-forget the returned promise.
 */
export async function recordIndianApiQuota(n = 1): Promise<void> {
  if (n <= 0) return;
  await Promise.all([
    bump(dayKey(istDayKey()), n, DAY_TTL_S),
    bump(monthKey(istMonthKey()), n, MONTH_TTL_S),
  ]);
}

/** Build the spec-shaped quota report. */
export async function getQuotaReport(): Promise<QuotaReport> {
  const [dayUsed, monthUsed] = await Promise.all([
    readN(dayKey(istDayKey())),
    readN(monthKey(istMonthKey())),
  ]);

  const daily: DailyQuota = {
    used:      dayUsed,
    limit:     DAILY_LIMIT,
    remaining: Math.max(0, DAILY_LIMIT - dayUsed),
    percent:   DAILY_LIMIT > 0 ? dayUsed / DAILY_LIMIT : 0,
  };

  const monthly: MonthlyQuota = {
    used:           monthUsed,
    safe_limit:     MONTHLY_SAFE_LIMIT,
    hard_limit:     MONTHLY_HARD_LIMIT,
    remaining_safe: MONTHLY_SAFE_LIMIT - monthUsed,
    remaining_hard: Math.max(0, MONTHLY_HARD_LIMIT - monthUsed),
    percent:        MONTHLY_HARD_LIMIT > 0 ? monthUsed / MONTHLY_HARD_LIMIT : 0,
    percent_safe:   MONTHLY_SAFE_LIMIT > 0 ? monthUsed / MONTHLY_SAFE_LIMIT : 0,
  };

  const worstPct = Math.max(daily.percent, monthly.percent);
  const state    = deriveQuotaState(worstPct);

  return {
    daily,
    monthly,
    state,
    limit_near:           daily.percent >= NEAR_PCT,
    reduce_polling:       worstPct >= WARN_PCT,
    block_non_essential:  worstPct >= CRITICAL_PCT,
    block_all:            worstPct >= 1.0,
    resets: {
      daily_at:   nextIstMidnightIso(),
      monthly_at: nextIstMonthStartIso(),
    },
    last_updated_at: new Date().toISOString(),
  };
}

export function deriveQuotaState(percent: number): QuotaState {
  if (percent >= 1.0)          return 'BLOCKED';
  if (percent >= CRITICAL_PCT) return 'CRITICAL';
  if (percent >= WARN_PCT)     return 'WARNING';
  return 'SAFE';
}

// ── Behavior control hooks ─────────────────────────────────────────
//
// Callers can consult these synchronously for the current decision.
// The returned booleans are reads against the Redis-backed counter
// (so they reflect process-restart-safe state).

export async function shouldReducePolling(): Promise<boolean> {
  const r = await getQuotaReport();
  return r.reduce_polling;
}

export async function shouldStopNonCritical(): Promise<boolean> {
  const r = await getQuotaReport();
  return r.block_non_essential;
}

export async function isLimitNear(): Promise<boolean> {
  const r = await getQuotaReport();
  return r.limit_near;
}

/** Test helper — wipe the counters for the current IST day + month. */
export async function _resetQuotaForTests(): Promise<void> {
  await Promise.all([
    cacheSet(dayKey(istDayKey()),   0, DAY_TTL_S),
    cacheSet(monthKey(istMonthKey()), 0, MONTH_TTL_S),
  ]);
}
