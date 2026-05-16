/**
 * auditApiUsage.ts — projected monthly IndianAPI quota under the
 * post-budget-fix scheduler config. Prints a single line per major
 * call path plus a daily/monthly total. CI gates a merge below 70k.
 *
 * Strategy: this is a STATIC simulation, not a live mock-driver. We
 * enumerate the call sites whose cadences are knobs (env or cron
 * strings), apply the cache-first amortisation, and print expected
 * daily / monthly load. The numbers are reproducible and easy to
 * reason about without booting the full Next process.
 *
 * Usage:
 *   npx tsx scripts/auditApiUsage.ts
 *
 * To override a knob:
 *   CANDLE_MAX_PER_CYCLE=80 npx tsx scripts/auditApiUsage.ts
 */

// Match the runtime config that production reads — without this,
// `npx tsx scripts/auditApiUsage.ts` would project against the audit's
// own bare defaults instead of the operator's actual env, hiding tunes
// (CACHE_TTL_LIVE_PRICE_MS, INDIANAPI_EMULATED_BATCH_MAX) until boot.
import { config as dotenvConfig } from 'dotenv';
import { resolve as resolvePath } from 'node:path';
dotenvConfig({ path: resolvePath(process.cwd(), '.env.local') });

interface PathCalls {
  name:    string;
  perDay:  number;
  notes:   string;
}

// Wrapped in a function so the top-level `const`s don't collide with
// scripts/simulateTradingDay.ts in the project's flat tsconfig scope.
function _runAuditApiUsage(): void {
const env = process.env;
const intEnv = (k: string, d: number) => Math.max(0, Number(env[k]) || d);

// ── Knobs (read from env if set, otherwise the post-fix defaults) ──
const CANDLE_MAX_PER_CYCLE      = intEnv('CANDLE_MAX_PER_CYCLE', 100);
const CANDLE_REFRESH_INTERVAL_M = intEnv('CANDLE_REFRESH_INTERVAL_MS', 15 * 60_000) / 60_000;
const STREAM_INTERVAL_S         = 5;     // see SSE Step 7(a)
// Quote cache TTL — accepts either CACHE_TTL_LIVE_PRICE_MS (the env
// the resolver actually reads, 60 s default) or QUOTE_TTL_S as an
// override knob for "what does the math look like if we bumped it".
const QUOTE_TTL_S               = intEnv('QUOTE_TTL_S',
  Math.max(1, Math.round((Number(env['CACHE_TTL_LIVE_PRICE_MS']) || 60_000) / 1000)));
const CONFIRMED_SNAPSHOTS       = 50;    // typical ACTIVE row count
// Active tracked set fetched by Tier A / rescore / lifecycle / SSE.
// IndianAPI's /nse/batch_quote does NOT exist on this plan — Tier A
// emulates batch via concurrent /stock calls (1 upstream call per
// symbol). The cap below is the per-tick fan-out; bigger = more
// coverage, smaller = lower monthly burn. Aligned with the adapter's
// MAX_EMULATED_BATCH_SYMBOLS so the audit and runtime stay in sync.
const ACTIVE_TRACKED_SYMBOLS    = intEnv('INDIANAPI_EMULATED_BATCH_MAX', 50);
const SSE_CLIENTS               = 1;     // baseline; auditApiUsage knob
const TRADING_HOURS             = 6.25;
const TRADING_DAYS_PER_MONTH    = 22;

function pathRow(name: string, perDay: number, notes: string): PathCalls {
  return { name, perDay: Math.round(perDay), notes };
}

const paths: PathCalls[] = [];

// 09:25 IST pre-open warmup — ONE call per active universe symbol
// per day. NIFTY 500 default = 500 calls.
paths.push(pathRow(
  'pre-open candle warmup (09:25 IST)',
  500,
  'force=true noCap=true; ONE allowed full sweep/day',
));

// 15-min in-process candle refresh ticks during the session.
// Each tick is capped at CANDLE_MAX_PER_CYCLE. With maxAgeHours=3,
// after the 09:25 IST warmup symbols stay fresh for 3 hours, so
// only ticks AFTER ~12:25 actually engage the cap. Within the
// remaining ~3-hour window the cycle goes:
//   12:30 stale-refresh  → cap-engaged   (~100 fetches)
//   12:45–15:25           → all fresh    (~0 fetches each)
//   15:30 stale-refresh  → cap-engaged   (~100 fetches)
// Plus a small bleed for new symbols added to the subset
// intraday (new confirmed snapshots / trigger picks). Modelled
// here as 2 cap-engaged ticks plus 4 small partial ticks.
const stalledTicks   = 2;                               // cap-engaged
const partialTicks   = 4;                               // ~30% of cap each
const partialFraction = 0.3;
const candleCallsPerDay =
  stalledTicks * CANDLE_MAX_PER_CYCLE +
  partialTicks * Math.round(CANDLE_MAX_PER_CYCLE * partialFraction);
paths.push(pathRow(
  '15-min candle refresh (curated subset, maxAgeHours filter)',
  candleCallsPerDay,
  `~${stalledTicks} cap-engaged + ${partialTicks} partial ticks/day`,
));

// ─────────────────────────────────────────────────────────────────
// Live-feed shared-cache rate
// ─────────────────────────────────────────────────────────────────
// Tier A, rescore, lifecycle, SSE, and /api/signals all consult the
// SAME per-symbol quote cache (key=quote:<SYM>). Any one of them
// triggering a /stock fetch warms the cache for every other reader
// within QUOTE_TTL_S seconds. So the combined upstream cost is
// bounded by the cache write rate, NOT the sum of each path's tick
// count × symbol count. The right model is:
//
//   total_per_day = ACTIVE × (trading_seconds / QUOTE_TTL_S)
//
// Below this the per-path lines above the line are kept for
// visibility but their cost has already been absorbed here. Anything
// beyond this rate is a cache-miss spike (cold start, stale TTL),
// not the steady-state.
const liveFeedSeconds   = TRADING_HOURS * 3600;
const liveFeedRefreshes = Math.ceil(liveFeedSeconds / Math.max(1, QUOTE_TTL_S));
const liveFeedCalls     = liveFeedRefreshes * ACTIVE_TRACKED_SYMBOLS;
paths.push(pathRow(
  'live feed (Tier A + rescore + lifecycle + SSE + /signals)',
  liveFeedCalls,
  `shared cache: ${liveFeedRefreshes} refreshes × ${ACTIVE_TRACKED_SYMBOLS} symbols (TTL=${QUOTE_TTL_S}s)`,
));

// Tier B trigger-deep (every 20 min, max 6/cycle, hard-capped by guard).
paths.push(pathRow(
  'Tier B trigger-deep (every 20 min)',
  Math.floor((TRADING_HOURS * 60) / 20) * 6,
  '6 deep symbols max per cycle',
));

// Tier C intel (every 60 min during session + weekend backfill).
paths.push(pathRow(
  'Tier C intel (hourly + 2/weekend)',
  Math.ceil(TRADING_HOURS),
  'news / corporate, cache-heavy',
));

// Maturity worker — Step 8 makes it DB-only (feed-health table read).
paths.push(pathRow(
  'maturity worker',
  0,
  'DB-only after Step 8',
));

// Misc operator-driven (single-symbol quote routes / search / charts).
paths.push(pathRow(
  'operator-driven (charts, single-quote, search)',
  50,
  'ad-hoc; cache-first hits 80%',
));

// Weekend tier C — once at 09:00 IST Sat/Sun.
const weekendDailyCost = 5;

// ── Print + total ───────────────────────────────────────────────
const tradingDayTotal = paths.reduce((s, p) => s + p.perDay, 0);
const monthlyProjection =
  tradingDayTotal * TRADING_DAYS_PER_MONTH +
  weekendDailyCost * 8;

console.log('=== auditApiUsage projection ===');
for (const p of paths) {
  const padded = p.name.padEnd(50);
  console.log(`[audit] ${padded} ${String(p.perDay).padStart(7)} calls/day  · ${p.notes}`);
}
console.log('='.repeat(72));
console.log(`[audit] TRADING-DAY TOTAL                            ${String(tradingDayTotal).padStart(7)} calls`);
console.log(`[audit] WEEKEND-DAY TOTAL                            ${String(weekendDailyCost).padStart(7)} calls`);
console.log(`[audit] PROJECTED MONTHLY (${TRADING_DAYS_PER_MONTH}td × ${tradingDayTotal} + 8wd × ${weekendDailyCost}) = ${monthlyProjection} calls`);
console.log('='.repeat(72));

// CI gate — match the spec's "merge below 70k" rule.
const PROJECTED_BUDGET_CEILING = 70_000;
if (monthlyProjection > PROJECTED_BUDGET_CEILING) {
  console.error(
    `[audit] FAIL — projected monthly ${monthlyProjection} > ceiling ${PROJECTED_BUDGET_CEILING}. ` +
    `Re-tune CANDLE_MAX_PER_CYCLE or rescore cadence before merging.`,
  );
  process.exit(1);
}
console.log(`[audit] PASS — projected monthly ${monthlyProjection} < ceiling ${PROJECTED_BUDGET_CEILING}`);
process.exit(0);
}
_runAuditApiUsage();
