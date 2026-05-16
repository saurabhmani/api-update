// ════════════════════════════════════════════════════════════════
//  apiBudgetGuard — request accounting + graceful degradation.
//
//  Every adapter call initiated by the new scheduler tiers MUST go
//  through canSpend() → spend(). Ad-hoc calls from MarketDataProvider
//  should also be accounted so counters reflect reality.
//
//  Counters live in Redis (cacheSet/cacheGet already fall back to
//  in-process memory when Redis is unavailable).
//
//  Degradation ladder (monthly):
//    < softCap       → normal ops
//    softCap..hard   → MAX_DEEP_PER_CYCLE = 4; trigger thresholds +20%
//    hard..freeze    → MAX_DEEP_PER_CYCLE = 2; Tier C reduced
//    >= freeze       → Tier B off; Tier A only; ad-hoc non-critical denied
// ════════════════════════════════════════════════════════════════

import { cacheGet, cacheSet } from '@/lib/redis';
import { logger } from '@/lib/logger';
import { CONFIG, setConfig } from './schedulerConfig';

const log = logger.child({ component: 'apiBudgetGuard' });

export type RequestType =
  | 'batch'      // NSE batch quotes
  | 'movers'     // trending / shockers / most active
  | 'deep'       // single-symbol live (trigger-driven)
  | 'hist'       // historical candles
  | 'news'       // market or company news
  | 'corp'       // corporate intel / fundamentals
  | 'search'     // symbol search
  | 'adhoc';     // user-initiated route traffic not classified above

export type DegradationLevel = 'normal' | 'soft' | 'hard' | 'freeze';

export interface BudgetSnapshot {
  monthKey: string;
  dayKey: string;
  monthTotal: number;
  dayTotal: number;
  byType: Record<RequestType, number>;
  skippedToday: number;
  level: DegradationLevel;
  maxDeepPerCycle: number;
  triggerMultiplier: number;
}

const REQUEST_TYPES: RequestType[] = [
  'batch', 'movers', 'deep', 'hist', 'news', 'corp', 'search', 'adhoc',
];

function utcDayKey(d = new Date()): string {
  return d.toISOString().slice(0, 10);           // YYYY-MM-DD
}
function utcMonthKey(d = new Date()): string {
  return d.toISOString().slice(0, 7);            // YYYY-MM
}

const MONTH_TTL_S = 40 * 24 * 60 * 60;           // 40 days, covers rollover
const DAY_TTL_S   = 48 * 60 * 60;

// ── Internal: atomic-ish increment backed by cacheGet/cacheSet ──────
// NOTE: the redis.ts helpers don't currently expose INCR. We simulate
// it with get+set; this is safe for single-writer (the scheduler
// process) and acceptable for budget accounting where a rare off-by-one
// in a multi-writer race has zero operational impact. If/when the
// codebase needs true atomicity, swap this for an r.incr call.
async function incr(key: string, n: number, ttlS: number): Promise<number> {
  const cur = (await cacheGet<number>(key)) ?? 0;
  const next = cur + n;
  await cacheSet(key, next, ttlS);
  return next;
}

async function readN(key: string): Promise<number> {
  return (await cacheGet<number>(key)) ?? 0;
}

// ── Public API ──────────────────────────────────────────────────────

/**
 * Decide whether a request (or batch of n requests) may be made.
 * Returns the degradation level so callers can shape their behavior
 * even when allowed (e.g. triggerEngine tightens thresholds in 'hard').
 */
export async function canSpend(
  type: RequestType,
  n = 1,
): Promise<{ allowed: boolean; level: DegradationLevel; reason?: string }> {
  const snap = await snapshot();
  const level = snap.level;

  // Hard freeze: only critical batch + movers may pass.
  if (level === 'freeze') {
    if (type === 'batch' || type === 'movers') {
      return { allowed: true, level };
    }
    await bumpSkipped(n);
    return { allowed: false, level, reason: 'monthly freeze reached' };
  }

  // Hard cap: deny hist + search + non-deep adhoc, allow the rest.
  if (level === 'hard') {
    if (type === 'hist' || type === 'search' || type === 'adhoc') {
      await bumpSkipped(n);
      return { allowed: false, level, reason: 'monthly hard cap' };
    }
    return { allowed: true, level };
  }

  // Daily safety net — smoothing, not a primary lever.
  if (snap.dayTotal + n > CONFIG.budget.dailySoftCap) {
    if (type === 'hist' || type === 'search' || type === 'adhoc') {
      await bumpSkipped(n);
      return { allowed: false, level, reason: 'daily soft cap' };
    }
  }

  return { allowed: true, level };
}

/** Record a successful (or attempted) spend. Callers should spend() on
 *  the *attempt*, not the success — a failed IndianAPI call still
 *  counts against the quota. */
export async function spend(type: RequestType, n = 1): Promise<void> {
  const day = utcDayKey();
  const mon = utcMonthKey();

  await Promise.all([
    incr(`budget:day:${day}`, n, DAY_TTL_S),
    incr(`budget:day:${day}:${type}`, n, DAY_TTL_S),
    incr(`budget:month:${mon}`, n, MONTH_TTL_S),
    incr(`budget:month:${mon}:${type}`, n, MONTH_TTL_S),
  ]);

  // Re-evaluate degradation and apply runtime knobs.
  await applyDegradation();
}

async function bumpSkipped(n: number): Promise<void> {
  await incr(`budget:skipped:${utcDayKey()}`, n, DAY_TTL_S);
}

/** Current ledger — safe to expose on an ops/admin endpoint. */
export async function snapshot(): Promise<BudgetSnapshot> {
  const day = utcDayKey();
  const mon = utcMonthKey();

  const [monthTotal, dayTotal, skippedToday] = await Promise.all([
    readN(`budget:month:${mon}`),
    readN(`budget:day:${day}`),
    readN(`budget:skipped:${day}`),
  ]);

  const byType = {} as Record<RequestType, number>;
  await Promise.all(REQUEST_TYPES.map(async t => {
    byType[t] = await readN(`budget:month:${mon}:${t}`);
  }));

  const level = classify(monthTotal);

  return {
    monthKey: mon,
    dayKey: day,
    monthTotal,
    dayTotal,
    byType,
    skippedToday,
    level,
    maxDeepPerCycle: maxDeepForLevel(level),
    triggerMultiplier: triggerMultForLevel(level),
  };
}

export function classify(monthTotal: number): DegradationLevel {
  const b = CONFIG.budget;
  if (monthTotal >= b.monthlyFreeze)    return 'freeze';
  if (monthTotal >= b.monthlyHardLimit) return 'hard';
  if (monthTotal >= b.monthlySoftCap)   return 'soft';
  return 'normal';
}

export function maxDeepForLevel(level: DegradationLevel): number {
  switch (level) {
    case 'freeze': return 0;
    case 'hard':   return 2;
    case 'soft':   return 4;
    default:       return CONFIG.maxDeepFetchesPerCycle;
  }
}

export function triggerMultForLevel(level: DegradationLevel): number {
  // Multiplier applied to pctChangeMin / volumeRatioMin. Higher number
  // = stricter trigger, fewer symbols qualify, fewer deep fetches.
  switch (level) {
    case 'freeze': return 999;   // nothing qualifies
    case 'hard':   return 1.3;
    case 'soft':   return 1.2;
    default:       return 1.0;
  }
}

// Applies the current degradation level to CONFIG so downstream
// consumers that read CONFIG.maxDeepFetchesPerCycle (e.g. the legacy
// trigger code path) see the throttled value. Trigger engine also
// reads degradation level directly for threshold scaling.
let lastAppliedLevel: DegradationLevel | null = null;
async function applyDegradation(): Promise<void> {
  const snap = await snapshot();
  if (snap.level === lastAppliedLevel) return;
  lastAppliedLevel = snap.level;

  setConfig('maxDeepFetchesPerCycle', snap.maxDeepPerCycle);

  log.warn('budget degradation level changed', {
    level: snap.level,
    monthTotal: snap.monthTotal,
    newMaxDeep: snap.maxDeepPerCycle,
  });
}

/** Test helper — resets in-process state but not Redis. */
export function _resetInternalStateForTests(): void {
  lastAppliedLevel = null;
}
