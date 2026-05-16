// ════════════════════════════════════════════════════════════════
//  IndianAPI usage tracker — daily / monthly call counters with
//  budget enforcement and disk persistence.
//
//  Spec "OPTIMIZE API USAGE" §4 + §5:
//    - Daily limit:    INDIANAPI_DAILY_LIMIT     (default 2500)
//    - Monthly limit:  INDIANAPI_MONTHLY_LIMIT   (default 70000)
//    - Calls beyond the daily floor throw a budget-exceeded error
//      so callers (resolveBatch / candleIngest / route handlers) can
//      surface "API budget exhausted — try again tomorrow" instead
//      of silently 5xx-ing on the upstream's hard rate limit.
//
//  Counters are bucketed by IST calendar day (Asia/Kolkata) so they
//  rotate at midnight IST regardless of host timezone. Persisted to
//  `.next/indianapi-usage.json` so a dev-server restart inside the
//  same day keeps the counter — without persistence, every restart
//  resets to 0 and the budget guard is meaningless.
//
//  Atomic write (tmp + rename) so concurrent IndianAPI calls never
//  see a half-written file. Synchronous on the hot path is fine —
//  the file is small (<200 bytes) and writes are infrequent
//  (debounced to once per second below).
// ════════════════════════════════════════════════════════════════

import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'fs';
import path from 'path';

const STORE_PATH = path.join(process.cwd(), '.next', 'indianapi-usage.json');

interface UsageBucket {
  /** IST calendar day, e.g. "2026-05-04". Rotates at midnight IST. */
  date:    string;
  /** IST calendar month, e.g. "2026-05". Rotates at month boundary. */
  month:   string;
  /** Calls dispatched today (every successful invocation of the
   *  underlying axios round-trip — retries count separately). */
  daily:   number;
  /** Calls dispatched in the current month. */
  monthly: number;
  /** Last-call wall clock for debug. */
  lastAt:  number;
}

function nowIstParts(): { date: string; month: string } {
  // Asia/Kolkata is UTC+5:30, no DST. We add the offset to UTC and
  // read the resulting parts. Avoids depending on Intl.DateTimeFormat
  // which is locale/runtime sensitive in Node 18+.
  const ms = Date.now() + 5.5 * 60 * 60_000;
  const d = new Date(ms);
  const yyyy = d.getUTCFullYear();
  const mm   = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd   = String(d.getUTCDate()).padStart(2, '0');
  return { date: `${yyyy}-${mm}-${dd}`, month: `${yyyy}-${mm}` };
}

function emptyBucket(): UsageBucket {
  const { date, month } = nowIstParts();
  return { date, month, daily: 0, monthly: 0, lastAt: 0 };
}

function readBucket(): UsageBucket {
  try {
    if (!existsSync(STORE_PATH)) return emptyBucket();
    const raw = readFileSync(STORE_PATH, 'utf8');
    const parsed = JSON.parse(raw) as Partial<UsageBucket>;
    if (!parsed || typeof parsed !== 'object') return emptyBucket();
    const { date, month } = nowIstParts();
    // Roll over the daily counter at IST midnight; roll over the
    // monthly counter at the IST month boundary. Both are read at
    // every load so a process running across midnight resets cleanly.
    return {
      date,
      month,
      daily:   parsed.date  === date  ? Number(parsed.daily ?? 0)   : 0,
      monthly: parsed.month === month ? Number(parsed.monthly ?? 0) : 0,
      lastAt:  Number(parsed.lastAt ?? 0),
    };
  } catch {
    return emptyBucket();
  }
}

let _bucket: UsageBucket | null = null;
function loadOnce(): UsageBucket {
  if (_bucket == null) _bucket = readBucket();
  return _bucket;
}

let _lastWriteAt = 0;
const WRITE_DEBOUNCE_MS = 1_000;
function persist(force = false): void {
  if (_bucket == null) return;
  const now = Date.now();
  if (!force && (now - _lastWriteAt) < WRITE_DEBOUNCE_MS) return;
  _lastWriteAt = now;
  try {
    const dir = path.dirname(STORE_PATH);
    try { mkdirSync(dir, { recursive: true }); } catch { /* exists */ }
    const tmp = STORE_PATH + '.tmp';
    writeFileSync(tmp, JSON.stringify(_bucket), 'utf8');
    renameSync(tmp, STORE_PATH);
  } catch {
    /* swallow — disk failure must not break the call path */
  }
}

// ── Limits ──────────────────────────────────────────────────────
//
// Defaults match the user-stated plan limits. Env-overridable for
// operators on different tiers (paid plans get a higher daily ceiling).
function resolveLimit(envName: string, fallback: number): number {
  const raw = Number(process.env[envName]);
  if (!Number.isFinite(raw) || raw <= 0) return fallback;
  return Math.max(1, Math.floor(raw));
}
export const INDIANAPI_DAILY_LIMIT   = resolveLimit('INDIANAPI_DAILY_LIMIT',   2500);
export const INDIANAPI_MONTHLY_LIMIT = resolveLimit('INDIANAPI_MONTHLY_LIMIT', 70000);
// Spec "Per-run API call limit" — a pipeline run (refreshDailyCandles +
// Phase 4) historically consumed ~1500 IndianAPI calls. Two unbounded
// runs exhaust the daily 2500 ceiling; the per-run cap fails fast
// after N successful round-trips inside one run, so the pipeline's
// existing fallback chain (cache → stored bars → Yahoo) serves the
// rest. Pipeline still completes — refreshDailyCandles' per-symbol
// try/catch tolerates the synthetic 429, and Phase 4 reads from
// market_data_daily, not the live provider.
//
// Recalibrated 2026-05 (smart-rotation cutover): 200 → 100. Pipeline
// run now scans a fixed CHUNK_SIZE=100 slice of the universe per run
// (rotation offset = runCount * CHUNK_SIZE), so the per-run cap is
// pinned to the chunk size. Math: 100 calls/run × 20 runs/day = 2000
// calls vs the 2500 daily ceiling — leaves ~20% headroom for quote
// enrichment + ad-hoc pulls. Bumping this above 100 without also
// raising SIGNAL_RUN_UNIVERSE_CAP is wasted budget (the route can't
// fetch more symbols than the chunk contains). Override via
// INDIANAPI_PER_RUN_LIMIT env when running historical bootstrap /
// one-shot bulk ingestion.
export const INDIANAPI_PER_RUN_LIMIT = resolveLimit('INDIANAPI_PER_RUN_LIMIT', 100);

// Soft warn threshold (percent of daily limit). When today's count
// crosses this, every increment emits the [API USAGE WARN] line so
// operators see the budget approach in the log instead of finding
// out only when calls start failing budget-exceeded.
const WARN_THRESHOLD_PCT = 80;

// Log cadence — emit `[API USAGE]` every N calls, plus once when the
// warn threshold is crossed. 50 keeps the log volume sane (a 503-symbol
// scan emits ~10 lines instead of 503).
const LOG_EVERY_N_CALLS = (() => {
  const raw = Number(process.env.INDIANAPI_USAGE_LOG_EVERY);
  if (!Number.isFinite(raw) || raw <= 0) return 50;
  return Math.max(1, Math.floor(raw));
})();
let _warnLogged = false;

// ── Public API ──────────────────────────────────────────────────

export interface ApiUsageSnapshot {
  date:               string;
  month:              string;
  daily:              number;
  monthly:            number;
  daily_limit:        number;
  monthly_limit:      number;
  daily_remaining:    number;
  monthly_remaining:  number;
  daily_percent:      number;
  monthly_percent:    number;
  daily_exceeded:     boolean;
  monthly_exceeded:   boolean;
  last_call_at:       string | null;
  // Per-run window. `per_run_active=false` outside a pipeline run;
  // the count/remaining fields reflect the most-recently-active
  // window (or zero if none has run since boot).
  per_run_active:     boolean;
  per_run_count:      number;
  per_run_limit:      number;
  per_run_remaining:  number;
  per_run_exceeded:   boolean;
}

// ── Per-run state ──────────────────────────────────────────────
//
// One window per pipeline run. The pipeline driver (run-signal-engine
// route + auto-recovery) wraps its lifecycle with begin/end so the
// counter is fresh on every dispatch. State is module-scope because
// pipeline runs are serialised by the in-flight guard (scannerState's
// global flag) — there is at most one active window at a time.
let _perRunActive       = false;
let _perRunCount        = 0;
let _perRunStartedAt    = 0;
let _perRunHitLogged    = false;

export function getApiUsage(): ApiUsageSnapshot {
  const b = loadOnce();
  // Honor IST rollover even if the file wasn't reread this tick —
  // a long-lived process crosses midnight and the counter must rotate.
  const { date, month } = nowIstParts();
  if (b.date !== date)   { b.date  = date;  b.daily   = 0; }
  if (b.month !== month) { b.month = month; b.monthly = 0; }
  const dailyPct  = INDIANAPI_DAILY_LIMIT   > 0 ? (b.daily   / INDIANAPI_DAILY_LIMIT)   * 100 : 0;
  const monthPct  = INDIANAPI_MONTHLY_LIMIT > 0 ? (b.monthly / INDIANAPI_MONTHLY_LIMIT) * 100 : 0;
  return {
    date:              b.date,
    month:             b.month,
    daily:             b.daily,
    monthly:           b.monthly,
    daily_limit:       INDIANAPI_DAILY_LIMIT,
    monthly_limit:     INDIANAPI_MONTHLY_LIMIT,
    daily_remaining:   Math.max(0, INDIANAPI_DAILY_LIMIT   - b.daily),
    monthly_remaining: Math.max(0, INDIANAPI_MONTHLY_LIMIT - b.monthly),
    daily_percent:     Math.round(dailyPct  * 10) / 10,
    monthly_percent:   Math.round(monthPct * 10) / 10,
    daily_exceeded:    b.daily   >= INDIANAPI_DAILY_LIMIT,
    monthly_exceeded:  b.monthly >= INDIANAPI_MONTHLY_LIMIT,
    last_call_at:      b.lastAt ? new Date(b.lastAt).toISOString() : null,
    per_run_active:    _perRunActive,
    per_run_count:     _perRunCount,
    per_run_limit:     INDIANAPI_PER_RUN_LIMIT,
    per_run_remaining: Math.max(0, INDIANAPI_PER_RUN_LIMIT - _perRunCount),
    per_run_exceeded:  _perRunActive && _perRunCount >= INDIANAPI_PER_RUN_LIMIT,
  };
}

/** Open a fresh per-run budget window. Idempotent: any leaked window
 *  from a prior run (e.g. a thrown finally that didn't end()) is
 *  closed and replaced. The pipeline driver MUST call this at the
 *  start of every run so the counter doesn't bleed across runs. */
export function beginPerRunBudget(): void {
  _perRunActive    = true;
  _perRunCount     = 0;
  _perRunStartedAt = Date.now();
  _perRunHitLogged = false;
}

/** Close the per-run window and return a summary. Safe to call when
 *  no window is open (returns zero counts). */
export function endPerRunBudget(): {
  count:      number;
  limit:      number;
  hit:        boolean;
  durationMs: number;
} {
  const summary = {
    count:      _perRunCount,
    limit:      INDIANAPI_PER_RUN_LIMIT,
    hit:        _perRunActive && _perRunCount >= INDIANAPI_PER_RUN_LIMIT,
    durationMs: _perRunStartedAt > 0 ? Date.now() - _perRunStartedAt : 0,
  };
  _perRunActive    = false;
  _perRunCount     = 0;
  _perRunStartedAt = 0;
  _perRunHitLogged = false;
  return summary;
}

/** Check whether the next call would exceed the per-run budget.
 *  Throws ApiBudgetExceededError when over. Logged once per window
 *  on the first hit so the operator sees the switch to fallback. */
export function checkPerRunBudget(): void {
  if (!_perRunActive) return;
  if (_perRunCount >= INDIANAPI_PER_RUN_LIMIT) {
    if (!_perRunHitLogged) {
      _perRunHitLogged = true;
      console.warn(
        `[API RUN LIMIT] reached ${_perRunCount} calls — switching to fallback ` +
        `(limit=${INDIANAPI_PER_RUN_LIMIT}). Subsequent IndianAPI calls in this run will fast-fail; ` +
        `pipeline continues on cache/stored bars.`,
      );
    }
    throw new ApiBudgetExceededError('per_run', getApiUsage());
  }
}

/** Throws BudgetExceededError when the next call would exceed the
 *  daily / monthly ceiling. Call this BEFORE dispatching the network
 *  round-trip so we never burn an upstream call we can't afford. */
export type ApiBudgetBucket = 'daily' | 'monthly' | 'per_run';

export class ApiBudgetExceededError extends Error {
  readonly code = 'API_BUDGET_EXCEEDED';
  readonly bucket: ApiBudgetBucket;
  readonly snapshot: ApiUsageSnapshot;
  constructor(bucket: ApiBudgetBucket, snapshot: ApiUsageSnapshot) {
    let msg: string;
    if (bucket === 'daily') {
      msg = `IndianAPI daily budget exhausted (${snapshot.daily}/${snapshot.daily_limit})`;
    } else if (bucket === 'monthly') {
      msg = `IndianAPI monthly budget exhausted (${snapshot.monthly}/${snapshot.monthly_limit})`;
    } else {
      msg = `IndianAPI per-run budget exhausted (${snapshot.per_run_count}/${snapshot.per_run_limit})`;
    }
    super(msg);
    this.name   = 'ApiBudgetExceededError';
    this.bucket = bucket;
    this.snapshot = snapshot;
  }
}

export function checkApiBudget(): void {
  const snap = getApiUsage();
  if (snap.daily_exceeded)   throw new ApiBudgetExceededError('daily',   snap);
  if (snap.monthly_exceeded) throw new ApiBudgetExceededError('monthly', snap);
}

/** Increment counters after a SUCCESSFUL upstream call. We don't
 *  count breaker fast-fails or auth-fail latches because no network
 *  round-trip happened — those would wrongly debit the budget for
 *  zero quota use. */
export function incrementApiUsage(label = 'indianapi'): void {
  const b = loadOnce();
  const { date, month } = nowIstParts();
  if (b.date !== date)   { b.date  = date;  b.daily   = 0; _warnLogged = false; }
  if (b.month !== month) { b.month = month; b.monthly = 0; }
  b.daily   += 1;
  b.monthly += 1;
  b.lastAt   = Date.now();
  if (_perRunActive) _perRunCount += 1;
  persist();

  // [API USAGE] log — emitted every LOG_EVERY_N_CALLS, plus a one-shot
  // [API USAGE WARN] when the daily counter crosses 80% of the limit.
  // Designed to stay terse: one line per ~50 calls keeps PM2 logs
  // readable while still telling an operator "what % of today's
  // budget is gone".
  if (b.daily % LOG_EVERY_N_CALLS === 0) {
    console.log(
      `[API USAGE] daily=${b.daily}/${INDIANAPI_DAILY_LIMIT} ` +
      `monthly=${b.monthly}/${INDIANAPI_MONTHLY_LIMIT} ` +
      `label=${label}`,
    );
  }
  const dailyPct = INDIANAPI_DAILY_LIMIT > 0
    ? (b.daily / INDIANAPI_DAILY_LIMIT) * 100 : 0;
  if (!_warnLogged && dailyPct >= WARN_THRESHOLD_PCT) {
    _warnLogged = true;
    console.warn(
      `[API USAGE WARN] daily usage at ${Math.round(dailyPct)}% ` +
      `(${b.daily}/${INDIANAPI_DAILY_LIMIT}) — pipeline will refuse new ` +
      `IndianAPI calls when the limit is reached. Set INDIANAPI_DAILY_LIMIT ` +
      `to override on a paid plan.`,
    );
  }
}

// ── Compliance classifier ─────────────────────────────────────
//
// Three-tier readiness label backing /api/usage. Distinct from the
// schedulerConfig degradation level (`normal/soft/hard/freeze`),
// which gates which CALL TYPES are allowed; this label answers the
// operator's "are we safe vs. the user-stated limits today?" question:
//
//   SAFE        — comfortably under the daily soft target AND on track
//                 to land under the monthly target.
//   BORDERLINE  — past the daily warn band (≥80%) OR projected to land
//                 in the monthly soft band (>monthly_target).
//   UNSAFE      — daily exceeded, OR projected monthly burn rate would
//                 cross the monthly ceiling before month-end.
//
// `monthlyTarget` defaults to 70,000 (the user-stated soft target); the
// absolute ceiling defaults to 90,000 (worst-case). Both env-tunable.
export type ComplianceLabel = 'SAFE' | 'BORDERLINE' | 'UNSAFE';

export const INDIANAPI_MONTHLY_TARGET = resolveLimit('INDIANAPI_MONTHLY_TARGET', 70_000);
export const INDIANAPI_MONTHLY_CEILING = resolveLimit('INDIANAPI_MONTHLY_CEILING', 90_000);

export interface ComplianceProjection {
  label:                ComplianceLabel;
  reasons:              string[];
  daily:                number;
  daily_limit:          number;
  daily_remaining:      number;
  daily_percent:        number;
  monthly:              number;
  monthly_target:       number;
  monthly_ceiling:      number;
  monthly_remaining:    number;
  /** Projected end-of-month total at the current daily burn rate. */
  monthly_projection:   number;
  /** Linear projection % vs the monthly TARGET (70k by default). */
  monthly_projection_pct_target:  number;
  /** Linear projection % vs the absolute ceiling (90k by default). */
  monthly_projection_pct_ceiling: number;
  /** Days elapsed in the current IST month (denominator of the burn-rate). */
  days_elapsed:         number;
  /** Days remaining in the current IST month. */
  days_remaining:       number;
  /** True iff projection exceeds ceiling — the loud-fail condition. */
  projection_over_ceiling: boolean;
}

/** Day count for the current IST calendar month + days elapsed since
 *  the 1st. Pure math — no I/O. */
function istMonthDays(): { elapsed: number; total: number; remaining: number } {
  const ms = Date.now() + 5.5 * 60 * 60_000;
  const d  = new Date(ms);
  const yyyy = d.getUTCFullYear();
  const mm   = d.getUTCMonth(); // 0-indexed
  const today = d.getUTCDate();
  // Day-after-last-day-of-month trick: setUTCDate(0) on month+1 gives
  // last day of `mm`. Works across all month lengths and leap years.
  const total = new Date(Date.UTC(yyyy, mm + 1, 0)).getUTCDate();
  const elapsed = Math.max(1, today);   // today counts; avoids /0
  return { elapsed, total, remaining: Math.max(0, total - today) };
}

/** Build the SAFE/BORDERLINE/UNSAFE projection from the live counters.
 *  Cheap pure read; safe to call from any handler. */
export function getComplianceProjection(): ComplianceProjection {
  const u = getApiUsage();
  const { elapsed, total, remaining } = istMonthDays();
  const dailyAvg     = u.monthly / elapsed;
  const projection   = Math.round(u.monthly + dailyAvg * remaining);
  const target       = INDIANAPI_MONTHLY_TARGET;
  const ceiling      = INDIANAPI_MONTHLY_CEILING;
  const projectionPctTarget  = target > 0 ? Math.round((projection / target) * 1000) / 10 : 0;
  const projectionPctCeiling = ceiling > 0 ? Math.round((projection / ceiling) * 1000) / 10 : 0;

  const reasons: string[] = [];
  let label: ComplianceLabel = 'SAFE';

  // Hard fail conditions → UNSAFE.
  if (u.daily_exceeded) {
    label = 'UNSAFE';
    reasons.push(`daily ${u.daily}/${u.daily_limit} exceeded`);
  }
  if (u.monthly >= ceiling) {
    label = 'UNSAFE';
    reasons.push(`monthly ${u.monthly} ≥ ceiling ${ceiling}`);
  }
  if (projection > ceiling) {
    label = 'UNSAFE';
    reasons.push(`projected monthly ${projection} > ceiling ${ceiling}`);
  }

  // Borderline conditions (only promote if not already UNSAFE).
  if (label !== 'UNSAFE') {
    if (u.daily_percent >= 80) {
      label = 'BORDERLINE';
      reasons.push(`daily at ${u.daily_percent}% of limit`);
    }
    if (projection > target) {
      if (label === 'SAFE') label = 'BORDERLINE';
      reasons.push(`projected monthly ${projection} > target ${target}`);
    }
    if (u.monthly >= target) {
      if (label === 'SAFE') label = 'BORDERLINE';
      reasons.push(`monthly ${u.monthly} already past target ${target}`);
    }
  }

  if (label === 'SAFE' && reasons.length === 0) {
    reasons.push(
      `daily ${u.daily}/${u.daily_limit} (${u.daily_percent}%); ` +
      `projected monthly ${projection} vs target ${target} / ceiling ${ceiling}`,
    );
  }

  return {
    label,
    reasons,
    daily:                u.daily,
    daily_limit:          u.daily_limit,
    daily_remaining:      u.daily_remaining,
    daily_percent:        u.daily_percent,
    monthly:              u.monthly,
    monthly_target:       target,
    monthly_ceiling:      ceiling,
    monthly_remaining:    Math.max(0, ceiling - u.monthly),
    monthly_projection:   projection,
    monthly_projection_pct_target:  projectionPctTarget,
    monthly_projection_pct_ceiling: projectionPctCeiling,
    days_elapsed:         elapsed,
    days_remaining:       remaining,
    projection_over_ceiling: projection > ceiling,
  };
}

/** Test-only helper. Resets the in-memory bucket; the disk file is
 *  rewritten by the next `incrementApiUsage`. */
export function __resetApiUsageForTests(): void {
  _bucket = emptyBucket();
  _warnLogged = false;
  _perRunActive    = false;
  _perRunCount     = 0;
  _perRunStartedAt = 0;
  _perRunHitLogged = false;
  persist(true);
}
