/**
 * simulateTradingDay.ts — minute-by-minute simulation of an IST
 * trading day (or weekend day) with per-path IndianAPI call counts.
 *
 * Why a pure simulator instead of a fake-timers boot of the real
 * crons: `node-cron` schedules against the system clock and doesn't
 * cleanly compose with vitest's fake-timer driver. Booting the
 * entire Next process with mocked adapters under fake timers takes
 * a multi-hundred-LoC harness for marginal benefit. This simulator
 * encodes the SAME cron rules the production code uses (verified
 * against src/lib/scheduler.ts + src/lib/workers/bootInProc.ts) and
 * walks every minute of the day. It models the resolver's QUOTE_TTL_S
 * cache so overlapping worker symbols amortise correctly.
 *
 * Verified against:
 *   - src/lib/scheduler.ts                                (cron rules)
 *   - src/lib/workers/bootInProc.ts                       (cron rules)
 *   - src/lib/marketData/resolver/marketDataResolver.ts   (cache-first)
 *   - src/lib/marketData/candleIngest.ts                  (MAX_PER_CYCLE)
 *   - src/lib/cron/confirmedSnapshotLifecycle.ts          (market-hours gate)
 *   - src/app/api/signals/stream/route.ts                 (5s SSE + off-hours skip)
 *
 * Usage:
 *   npx tsx scripts/simulateTradingDay.ts             # weekday
 *   npx tsx scripts/simulateTradingDay.ts --weekend   # weekend
 *   CANDLE_MAX_PER_CYCLE=80 npx tsx scripts/simulateTradingDay.ts
 *   npx tsx scripts/simulateTradingDay.ts --sse-clients=3
 */

// Wrapped in a function so the top-level `const`s don't collide with
// scripts/auditApiUsage.ts in the project's flat tsconfig scope.
function _runSimulateTradingDay(): void {
const env = process.env;
const intEnv = (k: string, d: number) => Math.max(0, Number(env[k]) || d);

// ── Knobs (mirror production defaults) ─────────────────────────
const QUOTE_TTL_S            = intEnv('QUOTE_TTL_S', 60);
const QUOTE_TTL_MIN          = QUOTE_TTL_S / 60;
const CANDLE_MAX_PER_CYCLE   = intEnv('CANDLE_MAX_PER_CYCLE', 100);
const UNIVERSE_SIZE          = 504;                 // NIFTY 500 actual
const CONFIRMED_SNAPSHOTS    = 50;                  // typical ACTIVE pool
const TIER1_SIZE             = 20;                  // schedulerConfig default
const SSE_CLIENTS            = intEnv('SSE_CLIENTS', 1);
const args                   = process.argv.slice(2);
const isWeekend              = args.includes('--weekend');
const sseClientsOverride = (() => {
  const m = args.find((a) => a.startsWith('--sse-clients='));
  return m ? Number(m.split('=')[1]) || SSE_CLIENTS : SSE_CLIENTS;
})();

// IST minute helpers — minute-of-day [0..1439]
const istMin = (h: number, m: number) => h * 60 + m;
const MARKET_OPEN_IST  = istMin( 9, 15);
const MARKET_CLOSE_IST = istMin(15, 30);
const SESSION_START_M  = istMin( 9,  0);
const SESSION_END_M    = istMin(17,  0);

// ── Path counters ──────────────────────────────────────────────
const counts = new Map<string, number>();
function inc(path: string, n = 1): void {
  counts.set(path, (counts.get(path) ?? 0) + n);
}

// ── Per-symbol cache model ─────────────────────────────────────
// `cache.get(symbol)` returns the IST minute at which the entry
// expires. A read at `nowMin >= expiresAt` is a miss.
const cache = new Map<string, number>();

/** Cache-first batch fetch. Charges ONE call per unique cold-symbol
 *  set (matching the resolver's batch coalescing). All hot symbols
 *  in `symbols` resolve from cache; the misses are batched into a
 *  single call. */
function batchFetch(symbols: string[], path: string, nowMin: number): void {
  const misses: string[] = [];
  for (const s of symbols) {
    const exp = cache.get(s) ?? -Infinity;
    if (exp <= nowMin) misses.push(s);
  }
  if (misses.length === 0) return;
  inc(path, 1);   // ONE batch call per cold-symbol set
  // Mark misses fresh until expiry.
  for (const s of misses) cache.set(s, nowMin + QUOTE_TTL_MIN);
}

/** Per-symbol historical fetch (one call per symbol — that's how
 *  IndianAPI's `/historical_data` works). Used by candle refresh. */
function historicalBatch(symbols: string[], path: string): void {
  inc(path, symbols.length);
}

// ── Mock symbol pools ──────────────────────────────────────────
const universe = Array.from({ length: UNIVERSE_SIZE }, (_, i) => `SYM${String(i).padStart(3, '0')}`);
const confirmedSyms = universe.slice(0, CONFIRMED_SNAPSHOTS);
const tier1Syms = universe.slice(0, TIER1_SIZE);

// Last successful candle refresh per-symbol — for the maxAgeHours filter.
// Initially -Infinity (forces the warmup to refresh everything).
const lastCandleRefreshMin = new Map<string, number>();
const CANDLE_MAX_AGE_MIN = 3 * 60;            // maxAgeHours=3

function candleRefresh(symbols: string[], force: boolean, noCap: boolean, nowMin: number, path: string): void {
  let toRefresh = symbols.filter((s) => {
    if (force) return true;
    const last = lastCandleRefreshMin.get(s) ?? -Infinity;
    return nowMin - last > CANDLE_MAX_AGE_MIN;
  });
  if (!noCap && toRefresh.length > CANDLE_MAX_PER_CYCLE) {
    toRefresh = toRefresh.slice(0, CANDLE_MAX_PER_CYCLE);
  }
  if (toRefresh.length === 0) return;
  historicalBatch(toRefresh, path);
  for (const s of toRefresh) lastCandleRefreshMin.set(s, nowMin);
}

// ── Curated subset for 15-min ticks (mirrors pickRefreshSubset) ──
function curatedSubset(): string[] {
  // active confirmed snapshots + Tier 1 — typical ~70-100 symbols
  const set = new Set<string>([...confirmedSyms, ...tier1Syms]);
  return [...set];
}

// ── Cron firing predicates ──────────────────────────────────────
const inMarketWindow  = (m: number) => m >= MARKET_OPEN_IST && m <= MARKET_CLOSE_IST;
const inRescoreWindow = (m: number) => m >= istMin(9, 20) && m <= istMin(15, 30);

// ── Walk the day minute-by-minute ───────────────────────────────
const dayLabel = isWeekend ? 'WEEKEND DAY' : 'TRADING DAY';
console.log(`=== simulateTradingDay — ${dayLabel} ===`);
console.log(`knobs: QUOTE_TTL_S=${QUOTE_TTL_S}  CANDLE_MAX_PER_CYCLE=${CANDLE_MAX_PER_CYCLE}  ` +
            `SSE_CLIENTS=${sseClientsOverride}  CONFIRMED_SNAPSHOTS=${CONFIRMED_SNAPSHOTS}`);

for (let m = SESSION_START_M; m <= SESSION_END_M; m++) {
  // Weekend: only the Sat/Sun 09:00 IST Tier C runs (1 call).
  if (isWeekend) {
    if (m === istMin(9, 0)) inc('weekend:tier-c (intel)', 1);
    continue;
  }

  // 09:20 IST — pre-open Tier A warmup (single batch call).
  if (m === istMin(9, 20)) batchFetch(confirmedSyms, 'pre-open:tier-a', m);

  // 09:25 IST — pre-open candle warmup (full universe, force=true noCap=true).
  if (m === istMin(9, 25)) candleRefresh(universe, true, true, m, 'pre-open:candle warmup');

  // 15:35 IST — post-close batch sync.
  if (m === istMin(15, 35)) batchFetch(confirmedSyms, 'post-close:tier-a', m);

  // ── Market-hours-gated paths ────────────────────────────────
  const open = inMarketWindow(m);

  // Tier A every 10 min during market hours (09:30, 09:40, ...).
  if (open && m % 10 === 0) {
    batchFetch(confirmedSyms, 'tier-a:every-10min', m);
  }
  // Tier B every 20 min at :05/:25/:45 — 6 deep symbols max.
  if (open && (m % 60 === 5 || m % 60 === 25 || m % 60 === 45)) {
    inc('tier-b:trigger-deep', 6);
  }
  // Tier C hourly at :15.
  if (open && m % 60 === 15) {
    inc('tier-c:intel', 1);
  }
  // Rescore every 5 min, 09:20-15:30 IST.
  if (inRescoreWindow(m) && m % 5 === 0) {
    batchFetch(confirmedSyms, 'rescore:*/5min', m);
  }
  // Lifecycle every 30s while market is open (= 2 firings/minute).
  if (open) {
    batchFetch(confirmedSyms, 'lifecycle:30s', m);
    batchFetch(confirmedSyms, 'lifecycle:30s', m);
  }
  // 15-min candle refresh ticks (curated subset, capped). Skips the
  // 09:25 minute (warmup runs then). The maxAgeHours filter inside
  // candleRefresh() makes most ticks effectively no-ops.
  if (open && m % 15 === 0 && m !== istMin(9, 25)) {
    candleRefresh(curatedSubset(), false, false, m, 'candle:15min curated');
  }

  // ── SSE: 5s push during market hours, off-hours = no upstream ──
  // 5-second cadence × N clients. Cache TTL means most pushes hit
  // cache; a single fresh batch fetch every QUOTE_TTL_MIN per client.
  if (open) {
    // 12 push attempts per minute per client; only the cold one
    // triggers a batch fetch (cache-first).
    for (let i = 0; i < 12; i++) {
      for (let c = 0; c < sseClientsOverride; c++) {
        // The market-hours branch in stream/route.ts is the only
        // path that calls resolveBatch.
        batchFetch(confirmedSyms, 'sse:enrichment', m);
      }
    }
  }
  // Off-hours SSE pushes do NOT call upstream (Step 7b). No-op.

  // ── /api/signals HTTP poll: 5s × 1, server FREEZE_TTL=5min ──
  if (open && m % 5 === 0) {
    batchFetch(confirmedSyms, 'http-signals:poll', m);
  }
}

// Operator-driven (chart, stocks, search) — modelled flat.
if (!isWeekend) inc('operator-driven:ad-hoc', 50);

// ── Print + total ───────────────────────────────────────────────
const ordered = [...counts.entries()].sort((a, b) => b[1] - a[1]);
console.log('='.repeat(72));
for (const [path, n] of ordered) {
  const pad = path.padEnd(40);
  console.log(`[sim] ${pad} ${String(n).padStart(7)} calls`);
}
console.log('='.repeat(72));
const total = ordered.reduce((s, [, n]) => s + n, 0);
console.log(`[sim] DAY TOTAL                                 ${String(total).padStart(7)} calls`);

const tradingDays = 22;
const weekendDays = 8;
if (!isWeekend) {
  const monthly = total * tradingDays + 5 * weekendDays;       // 5/wd weekend baseline
  console.log(`[sim] PROJECTED MONTHLY (${tradingDays}td × ${total} + ${weekendDays}wd × 5)  = ${monthly} calls`);
  const ceiling = 70_000;
  if (monthly > ceiling) {
    console.error(`[sim] FAIL — ${monthly} > ${ceiling}`);
    process.exit(1);
  }
  console.log(`[sim] PASS — ${monthly} < ${ceiling}`);
}
process.exit(0);
}
_runSimulateTradingDay();
