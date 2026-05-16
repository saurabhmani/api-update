// ════════════════════════════════════════════════════════════════
//  candleRefreshScheduler — market-aware live candle refresh
//
//  Spec INSTITUTIONAL §K (calibrated 2026-05) — real-time candle
//  ingestion with adaptive cadence + priority queue.
//
//  Cadence
//  ───────
//    Market OPEN   : LIVE_REFRESH_INTERVAL_OPEN_MS    default 5  min
//    Pre-open      : LIVE_REFRESH_INTERVAL_OPEN_MS    (same as open)
//    Market CLOSED : LIVE_REFRESH_INTERVAL_CLOSED_MS  default 30 min
//
//  Per-cycle cap (MAX_PER_CYCLE inside refreshDailyCandles still
//  applies, env-tunable via CANDLE_MAX_PER_CYCLE):
//    Market OPEN   : LIVE_REFRESH_CAP_OPEN     default 250 symbols
//    Market CLOSED : LIVE_REFRESH_CAP_CLOSED   default  50 symbols
//
//  Priority queue (highest priority refreshed first; rotates within
//  each tier so no symbol is starved):
//    TIER 1 — active confirmed-snapshot symbols (must stay <5min)
//    TIER 2 — symbols with q365_signals rows in last 30 min
//    TIER 3 — round-robin across DEFAULT_PHASE1_CONFIG.universe
//
//  API safety
//  ──────────
//  Daily budget cap: 2,500 IndianAPI calls/day (INDIANAPI_DAILY_LIMIT).
//  Monthly budget cap: 70,000 IndianAPI calls/month.
//  Worst-case math @ open defaults:
//    5min × 7h market = 84 cycles/day
//    84 × 250 symbols/cycle = 21,000 calls if every symbol needs upstream
//    But cache hit (CANDLE_FRESH_IF_WITHIN_MIN=5) cuts ~90% of these
//    when bars are <5min old → ~2,100 effective calls/day.
//  When dailyUsed approaches the limit the cap auto-shrinks via the
//  budget calculator — same band ladder as run-signal-engine.
//
//  Idempotent boot. setTimeout-chained so the next interval is
//  recomputed from market state every tick (was setInterval-fixed).
// ════════════════════════════════════════════════════════════════

import { refreshDailyCandles } from '@/lib/marketData/candleIngest';
import { DEFAULT_PHASE1_CONFIG } from '@/lib/signal-engine/constants/signalEngine.constants';
import { getMarketStatus } from '@/lib/marketData/marketHours';
import {
  isNifty500Initialized,
  initNifty500UniverseFromDb,
} from '@/lib/marketData/nifty500Universe';

// ── Cadence + cap (market-aware) ────────────────────────────────

function envInt(name: string, fallback: number, lo: number, hi: number): number {
  const raw = Number(process.env[name]);
  if (!Number.isFinite(raw)) return fallback;
  return Math.max(lo, Math.min(hi, Math.floor(raw)));
}

const INTERVAL_OPEN_MS   = envInt('LIVE_REFRESH_INTERVAL_OPEN_MS',   15 * 60_000, 60_000, 60 * 60_000);
const INTERVAL_CLOSED_MS = envInt('LIVE_REFRESH_INTERVAL_CLOSED_MS', 30 * 60_000, 60_000, 6 * 60 * 60_000);
const CAP_OPEN           = envInt('LIVE_REFRESH_CAP_OPEN',           250, 1, 1000);
const CAP_CLOSED         = envInt('LIVE_REFRESH_CAP_CLOSED',          50, 1, 1000);

// Legacy override — if the operator explicitly set CANDLE_REFRESH_INTERVAL_MS,
// use it (back-compat). Otherwise the market-aware ladder above wins.
const LEGACY_INTERVAL_MS = process.env.CANDLE_REFRESH_INTERVAL_MS != null
  ? Math.max(60_000, Number(process.env.CANDLE_REFRESH_INTERVAL_MS) || 5 * 60_000)
  : null;

let timer: NodeJS.Timeout | null = null;
let running = false;
let lastRefreshedAt: number | null = null;
let lastTickElapsedMs = 0;
let lastTickRefreshed = 0;
let lastTickCap       = 0;
let lastTickQueueDepth = 0;
let cumulativeRefreshes = 0;       // for refresh_rate_per_minute estimate
const ROLLING_RATE_WINDOW_MS = 5 * 60_000;
const recentTicks: Array<{ ts: number; refreshed: number }> = [];

export function getCandleRefreshAgeMs(): number | null {
  if (lastRefreshedAt == null) return null;
  return Date.now() - lastRefreshedAt;
}

// Cold-start threshold: 12h covers a weekend cold start + any
// unplanned downtime. Below this we still refresh once even if the
// market is closed, so the UI doesn't sit on session-old bars.
const COLD_START_STALE_MS =
  Math.max(3_600_000, Number(process.env.CANDLE_COLD_START_STALE_MS) || 12 * 3_600_000);

// ── Priority queue (tier 1 → tier 3) ────────────────────────────
//
// Cached refresh subset. Re-built every tick from three sources:
//   1. Active confirmed-snapshot symbols
//   2. Symbols emitted by saveSignals in the last 30 min
//   3. Round-robin window over DEFAULT_PHASE1_CONFIG.universe
//
// The result is a deduped, priority-ordered string[]. Capped by the
// caller (per-cycle cap), so the head of the array is always
// guaranteed to refresh first.
let refreshSubsetCache: string[] = [];
let lastSubsetTier1Count = 0;
let lastSubsetTier2Count = 0;
let lastSubsetTier3Count = 0;
let universeRotationCursor = 0;

function pickRefreshSubset(maxPerCycle: number): string[] {
  // Always include the universe-fallback head if cache is empty.
  if (refreshSubsetCache.length === 0) {
    return DEFAULT_PHASE1_CONFIG.universe.slice(0, maxPerCycle);
  }
  return refreshSubsetCache.slice(0, maxPerCycle);
}

async function refreshSubsetCacheNow(maxPerCycle: number): Promise<void> {
  try {
    const { db } = await import('@/lib/db');

    // Tier 1 — active confirmed-snapshot symbols. These MUST stay
    // <5min fresh because the live signals UI renders them.
    const tier1 = new Set<string>();
    const { rows: snapRows } = await db.query<{ symbol: string }>(
      `SELECT DISTINCT symbol FROM q365_confirmed_signal_snapshots
        WHERE status = 'ACTIVE' AND valid_until > NOW()`,
    ).catch(() => ({ rows: [] as { symbol: string }[] }));
    for (const r of snapRows as { symbol: string }[]) {
      tier1.add(String(r.symbol).toUpperCase());
    }
    lastSubsetTier1Count = tier1.size;

    // Tier 2 — symbols with q365_signals rows in the last 30 min.
    // These are the maturity-tracker's working set; keeping their
    // candles fresh lets the maturity worker compute up-to-date scores.
    const tier2 = new Set<string>();
    const { rows: recentRows } = await db.query<{ symbol: string }>(
      `SELECT DISTINCT symbol FROM q365_signals
        WHERE generated_at >= DATE_SUB(NOW(), INTERVAL 30 MINUTE)`,
    ).catch(() => ({ rows: [] as { symbol: string }[] }));
    for (const r of recentRows as { symbol: string }[]) {
      const sym = String(r.symbol).toUpperCase();
      if (!tier1.has(sym)) tier2.add(sym);
    }
    lastSubsetTier2Count = tier2.size;

    // Tier 3 — round-robin across DEFAULT_PHASE1_CONFIG.universe.
    // The cursor advances each tick so the WHOLE universe is touched
    // over `ceil(universe / capacityForTier3)` ticks.
    const universe = DEFAULT_PHASE1_CONFIG.universe;
    const capacityRemaining = Math.max(0, maxPerCycle - tier1.size - tier2.size);
    const tier3: string[] = [];
    if (capacityRemaining > 0 && universe.length > 0) {
      for (let i = 0; i < capacityRemaining; i++) {
        const idx = (universeRotationCursor + i) % universe.length;
        const sym = String(universe[idx]).toUpperCase();
        if (!tier1.has(sym) && !tier2.has(sym) && !tier3.includes(sym)) {
          tier3.push(sym);
        }
      }
      // Advance cursor so the next tick picks up where this one left off.
      universeRotationCursor = (universeRotationCursor + capacityRemaining) % universe.length;
    }
    lastSubsetTier3Count = tier3.length;

    refreshSubsetCache = [...tier1, ...tier2, ...tier3];
  } catch (err) {
    console.warn('[candleScheduler] refreshSubsetCache update failed', err);
  }
}

// ── Auto-throttle (budget guard) ────────────────────────────────
//
// Same band ladder as run-signal-engine's computeThrottledCap. Auto-
// shrinks the per-cycle cap as the daily IndianAPI budget approaches
// the limit so a runaway scheduler can never exhaust the quota.
async function getThrottledCap(baseCap: number): Promise<{
  cap: number;
  band: 'normal' | 'warn' | 'throttle' | 'critical';
  pct:  number;
  daily: number;
  dailyLimit: number;
}> {
  try {
    const { getApiUsage } = await import('@/providers/adapters/IndianAPIAdapter');
    const u = getApiUsage();
    const dailyLimit = u.daily_limit;
    if (dailyLimit <= 0) {
      return { cap: baseCap, band: 'normal', pct: 0, daily: u.daily, dailyLimit };
    }
    const pct = Math.round((u.daily / dailyLimit) * 1000) / 10;
    if (pct >= 95) return { cap: Math.max(20, Math.floor(baseCap * 0.25)), band: 'critical', pct, daily: u.daily, dailyLimit };
    if (pct >= 80) return { cap: Math.max(40, Math.floor(baseCap * 0.5)),  band: 'throttle', pct, daily: u.daily, dailyLimit };
    if (pct >= 60) return { cap: Math.max(60, Math.floor(baseCap * 0.75)), band: 'warn',     pct, daily: u.daily, dailyLimit };
    return { cap: baseCap, band: 'normal', pct, daily: u.daily, dailyLimit };
  } catch {
    return { cap: baseCap, band: 'normal', pct: 0, daily: 0, dailyLimit: 0 };
  }
}

// ── Effective coverage probe ────────────────────────────────────

async function probeCoverageAndAge(): Promise<{
  effective_coverage_pct:   number;
  live_candle_age_minutes:  number | null;
  bars_within_5min:         number;
  bars_within_10min:        number;
  total_universe:           number;
}> {
  const universe = DEFAULT_PHASE1_CONFIG.universe;
  if (universe.length === 0) {
    return {
      effective_coverage_pct: 0, live_candle_age_minutes: null,
      bars_within_5min: 0, bars_within_10min: 0, total_universe: 0,
    };
  }
  try {
    const { db } = await import('@/lib/db');
    const placeholders = universe.map(() => '?').join(',');
    const { rows } = await db.query<{
      sym: number; latest: Date | string | null;
      fresh_5: number; fresh_10: number;
    }>(
      `SELECT COUNT(DISTINCT symbol) AS sym,
              MAX(ts)               AS latest,
              SUM(CASE WHEN updated_at >= DATE_SUB(NOW(), INTERVAL 5  MINUTE) THEN 1 ELSE 0 END) AS fresh_5,
              SUM(CASE WHEN updated_at >= DATE_SUB(NOW(), INTERVAL 10 MINUTE) THEN 1 ELSE 0 END) AS fresh_10
         FROM market_data_daily
        WHERE symbol IN (${placeholders})`,
      universe.map((s) => s.toUpperCase()),
    );
    const r = rows[0] ?? { sym: 0, latest: null, fresh_5: 0, fresh_10: 0 };
    const sym = Number(r.sym ?? 0);
    const latest = r.latest;
    const ageMin = latest != null
      ? Math.round((Date.now() - new Date(latest as any).getTime()) / 60_000)
      : null;
    return {
      effective_coverage_pct:   Math.round((sym / universe.length) * 1000) / 10,
      live_candle_age_minutes:  ageMin,
      bars_within_5min:         Number(r.fresh_5 ?? 0),
      bars_within_10min:        Number(r.fresh_10 ?? 0),
      total_universe:           universe.length,
    };
  } catch {
    return {
      effective_coverage_pct: 0, live_candle_age_minutes: null,
      bars_within_5min: 0, bars_within_10min: 0, total_universe: universe.length,
    };
  }
}

// ── Per-tick worker ─────────────────────────────────────────────

async function runOnce(): Promise<void> {
  if (running) return;
  if (!isNifty500Initialized()) {
    try {
      await initNifty500UniverseFromDb();
    } catch (err) {
      console.warn(
        '[candleScheduler] universe init failed — skipping tick:',
        (err as Error)?.message ?? err,
      );
      return;
    }
  }

  const market = getMarketStatus();
  // Production spec: "IF market CLOSED: BLOCK ALL external API calls".
  // Default-on hard block — even the cold-start catch-up does not fire
  // off-hours, since IndianAPI's historical_data endpoint moves the
  // daily counter the same as live calls. CANDLE_ALLOW_OFF_HOURS_REFRESH=1
  // unlocks the cold-start branch.
  if (!market.isOpen && market.state !== 'pre-open') {
    if (process.env.CANDLE_ALLOW_OFF_HOURS_REFRESH !== '1') {
      console.log(
        `[REFRESH_WINDOW] state=${market.state} action=skip reason="market closed (CANDLE_ALLOW_OFF_HOURS_REFRESH != 1)"`,
      );
      return;
    }
    const age = lastRefreshedAt != null ? Date.now() - lastRefreshedAt : null;
    const coldStart = age == null || age > COLD_START_STALE_MS;
    if (!coldStart) {
      console.log(
        `[REFRESH_WINDOW] state=${market.state} action=skip reason="recent refresh ${age! < 3_600_000 ? Math.round(age! / 60_000) + 'm' : Math.round(age! / 3_600_000) + 'h'} ago"`,
      );
      return;
    }
    console.log(
      `[REFRESH_WINDOW] state=${market.state} action=cold_start reason="last refresh ${age == null ? 'never' : Math.round(age / 3_600_000) + 'h'} ago"`,
    );
  } else {
    console.log(`[REFRESH_WINDOW] state=${market.state} action=tick market_open=${market.isOpen}`);
  }

  running = true;
  const t0 = Date.now();
  // Compute the cap for this cycle. baseCap = market-aware ladder.
  const baseCap = market.isOpen ? CAP_OPEN : CAP_CLOSED;
  const throttle = await getThrottledCap(baseCap);
  if (throttle.band !== 'normal') {
    console.warn(
      `[LIVE_REFRESH] throttle band=${throttle.band} daily_used=${throttle.pct}% ` +
      `cap=${baseCap}→${throttle.cap}`,
    );
  }
  const cap = throttle.cap;
  lastTickCap = cap;

  // Build the priority subset. Tier 1 + Tier 2 + Tier 3 round-robin.
  await refreshSubsetCacheNow(cap);
  const subset = pickRefreshSubset(cap);
  lastTickQueueDepth = refreshSubsetCache.length;

  console.log(
    `[QUEUE_DRAIN] tier1_active_snapshots=${lastSubsetTier1Count} ` +
    `tier2_recent_signals=${lastSubsetTier2Count} ` +
    `tier3_universe_round_robin=${lastSubsetTier3Count} ` +
    `cap=${cap} picked=${subset.length} ` +
    `cursor=${universeRotationCursor}/${DEFAULT_PHASE1_CONFIG.universe.length}`,
  );

  try {
    // Spec INSTITUTIONAL §K — fresh-if-within: aggressive 5min during
    // open (so a symbol just refreshed is skipped), 30min when closed.
    // Daily bars only mutate every ~5min upstream; tighter than that
    // is wasted budget. Falls through to env CANDLE_FRESH_IF_WITHIN_MIN
    // when set so the operator's existing override still wins.
    const freshWithinMin = market.isOpen
      ? envInt('LIVE_REFRESH_FRESH_IF_WITHIN_MIN_OPEN',   5,  1, 60)
      : envInt('LIVE_REFRESH_FRESH_IF_WITHIN_MIN_CLOSED', 30, 1, 240);

    const res = await refreshDailyCandles({
      symbols: subset,
      force:   false,
      freshIfWithinMinutes: freshWithinMin,
    });
    lastRefreshedAt    = Date.now();
    lastTickElapsedMs  = Date.now() - t0;
    lastTickRefreshed  = res.refreshed;
    cumulativeRefreshes += res.refreshed;
    recentTicks.push({ ts: Date.now(), refreshed: res.refreshed });
    // Drop entries outside the rolling window.
    while (recentTicks.length > 0 && recentTicks[0].ts < Date.now() - ROLLING_RATE_WINDOW_MS) {
      recentTicks.shift();
    }
    const rollingRefreshed = recentTicks.reduce((s, r) => s + r.refreshed, 0);
    const refreshRatePerMin = Math.round(
      (rollingRefreshed / Math.max(1, ROLLING_RATE_WINDOW_MS / 60_000)) * 10,
    ) / 10;

    console.log(
      `[CANDLE_INGEST] elapsed_ms=${lastTickElapsedMs} ` +
      `refreshed=${res.refreshed}/${res.staleCount} ` +
      `bars=${res.barsIngested} failed=${res.failed.length} ` +
      `latest_after=${res.latestTsAfter ?? 'none'} ` +
      `age_after_h=${res.ageHoursAfter ?? 'n/a'}`,
    );

    // Budget projection — extrapolate today's & this month's expected
    // usage based on the rolling refresh rate. Cheap (no extra DB hop).
    const ticksPerHour = market.isOpen
      ? Math.round(3_600_000 / (LEGACY_INTERVAL_MS ?? INTERVAL_OPEN_MS))
      : Math.round(3_600_000 / (LEGACY_INTERVAL_MS ?? INTERVAL_CLOSED_MS));
    const marketHoursPerDay = 7;       // ~6.5h NSE cash + pre-open
    const tradingDaysPerMonth = 22;
    const projectedDaily   = Math.round(refreshRatePerMin * 60 * marketHoursPerDay);
    const projectedMonthly = projectedDaily * tradingDaysPerMonth;
    const coverage = await probeCoverageAndAge();
    console.log(
      `[REALTIME_HEALTH] live_candle_age_minutes=${coverage.live_candle_age_minutes ?? 'null'} ` +
      `refreshed_symbols=${res.refreshed} ` +
      `refresh_rate_per_minute=${refreshRatePerMin} ` +
      `effective_coverage=${coverage.effective_coverage_pct}% ` +
      `queue_depth=${lastTickQueueDepth} ` +
      `estimated_daily_usage=${projectedDaily} ` +
      `estimated_monthly_usage=${projectedMonthly} ` +
      `daily_budget_used=${throttle.daily}/${throttle.dailyLimit} ` +
      `band=${throttle.band}`,
    );
    console.log(
      `[CANDLE_FRESHNESS] target_open=<5min target_intraday=<10min ` +
      `bars_within_5min=${coverage.bars_within_5min}/${coverage.total_universe} ` +
      `bars_within_10min=${coverage.bars_within_10min}/${coverage.total_universe} ` +
      `effective_coverage=${coverage.effective_coverage_pct}% ` +
      `latest_age_min=${coverage.live_candle_age_minutes ?? 'null'} ` +
      `verdict=${coverage.live_candle_age_minutes != null && coverage.live_candle_age_minutes <= 5 ? 'FRESH' : coverage.live_candle_age_minutes != null && coverage.live_candle_age_minutes <= 10 ? 'INTRADAY_OK' : 'STALE'}`,
    );
    console.log(
      `[LIVE_REFRESH] tick_complete elapsed_ms=${lastTickElapsedMs} ` +
      `cap=${cap} subset_size=${subset.length} ` +
      `refreshed=${res.refreshed} ticks_per_hour=${ticksPerHour} ` +
      `cumulative_refreshes=${cumulativeRefreshes}`,
    );

    // Stream-server seeding — push the freshly ingested closes so any
    // browser currently connected sees the actual close (matching
    // Google / NSE EOD) within this refresh cycle. Never overwrites a
    // real Kite frame; if a live tick came in during the refresh it
    // keeps precedence. (Unchanged from prior behaviour.)
    try {
      const { seedKiteMapFromDaily } = await import('@/lib/ws/streamServer');
      const seeded = await seedKiteMapFromDaily();
      if (seeded > 0) {
        console.log(`[candleScheduler] seeded ${seeded} stream frames from fresh closes`);
      }
    } catch (err: any) {
      // Stream server may be inactive in some deployments — non-fatal.
      void err;
    }

    if (res.failed.length > 0) {
      const grouped = new Map<string, string[]>();
      for (const f of res.failed) {
        const list = grouped.get(f.reason) ?? [];
        list.push(f.symbol);
        grouped.set(f.reason, list);
      }
      for (const [reason, syms] of grouped) {
        console.warn(
          `[CANDLE_INGEST] failed (${syms.length}) reason="${reason}" ` +
          `symbols=[${syms.slice(0, 10).join(', ')}${syms.length > 10 ? `, +${syms.length - 10} more` : ''}]`,
        );
      }
    }
  } catch (err) {
    console.warn('[LIVE_REFRESH] tick failed:', (err as Error)?.message ?? err);
  } finally {
    running = false;
  }
}

// ── Boot — chained setTimeout so cadence adapts to market state ─

function scheduleNextTick(): void {
  const market = getMarketStatus();
  // LEGACY_INTERVAL_MS pinned override → use as-is. Otherwise pick
  // open vs closed cadence from the market state.
  const next =
    LEGACY_INTERVAL_MS != null
      ? LEGACY_INTERVAL_MS
      : (market.isOpen || market.state === 'pre-open' ? INTERVAL_OPEN_MS : INTERVAL_CLOSED_MS);
  timer = setTimeout(async () => {
    await runOnce();
    scheduleNextTick();
  }, next);
}

export function startCandleScheduler(): void {
  if (timer) return;
  console.log(
    `[LIVE_REFRESH] ✓ starting  ` +
    `interval_open=${INTERVAL_OPEN_MS}ms (${Math.round(INTERVAL_OPEN_MS / 60_000)}min)  ` +
    `interval_closed=${INTERVAL_CLOSED_MS}ms (${Math.round(INTERVAL_CLOSED_MS / 60_000)}min)  ` +
    `cap_open=${CAP_OPEN}  cap_closed=${CAP_CLOSED}  ` +
    `legacy_pin=${LEGACY_INTERVAL_MS != null ? `${LEGACY_INTERVAL_MS}ms` : 'unset'}  ` +
    `universe=${DEFAULT_PHASE1_CONFIG.universe.length}`,
  );
  // Kick one immediate tick on boot so market_data_daily lands a
  // fresh row before the first user request.
  void runOnce().then(scheduleNextTick);
}

export function stopCandleScheduler(): void {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}
