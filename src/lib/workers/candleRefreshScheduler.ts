// ════════════════════════════════════════════════════════════════
//  candleRefreshScheduler — 60s force-refresh of daily candles
//
//  Purpose
//  ───────
//  Keeps `market_data_daily` warm with today's intraday-updating
//  Yahoo daily bar. During NSE hours Yahoo's /v8/finance/chart
//  endpoint streams a continuously updating "today" bar at the
//  end of the series (open stamped at 09:15 IST, but OHLC values
//  update every few seconds). Refreshing once a minute means
//  the engine always reads a row whose OHLC is at most ~60s stale.
//
//  Why not WebSocket here?
//  ───────────────────────
//  Yahoo and NSE do not expose OHLC push streams. The only
//  real-time WS mechanism we have is streamServer.ts which pushes
//  LAST-PRICE only — that's fine for the Live column in the UI,
//  but the signal engine needs full OHLC bars. Pulling every 60s
//  from Yahoo is the honest upper bound on OHLC freshness.
//
//  Behaviour
//  ─────────
//  - Boots from instrumentation.ts alongside the stream server.
//  - Idempotent — startCandleScheduler() is safe to call twice.
//  - Refresh runs ONLY while the NSE session is open (plus a
//    short pre-open window). Outside market hours we stop touching
//    Yahoo so we don't burn rate limit on frozen bars.
//  - Tracks `lastRefreshedAt` wall-clock so the route handler
//    can check "was data refreshed in the last N minutes?" via
//    getCandleRefreshAgeMs().
// ════════════════════════════════════════════════════════════════

import { refreshDailyCandles } from '@/lib/marketData/candleIngest';
import { DEFAULT_PHASE1_CONFIG } from '@/lib/signal-engine/constants/signalEngine.constants';
import { getMarketStatus } from '@/lib/marketData/marketHours';

// Refresh interval — default 10s (tunable via CANDLE_REFRESH_INTERVAL_MS).
// At 10s the OHLC bars the signal engine reads are never more than
// ~10s stale during market hours. Floor of 5s prevents accidental
// misconfiguration from hammering Yahoo's public endpoint.
const INTERVAL_MS =
  Math.max(5_000, Number(process.env.CANDLE_REFRESH_INTERVAL_MS) || 10_000);

let timer: NodeJS.Timeout | null = null;
let running = false;
let lastRefreshedAt: number | null = null;

export function getCandleRefreshAgeMs(): number | null {
  if (lastRefreshedAt == null) return null;
  return Date.now() - lastRefreshedAt;
}

// Cold-start threshold. If lastRefreshedAt is null (server just
// started) or older than this, we run a refresh even when the
// market is closed so the engine has today's close to work with.
// 12h covers a weekend cold start + any unplanned downtime.
const COLD_START_STALE_MS =
  Math.max(3_600_000, Number(process.env.CANDLE_COLD_START_STALE_MS) || 12 * 3_600_000);

async function runOnce(): Promise<void> {
  if (running) {
    // Previous tick still in flight — skip this beat, not overlap.
    return;
  }
  const market = getMarketStatus();
  // Decision ladder:
  //   1. Market open / pre-open → refresh every INTERVAL_MS (normal path).
  //   2. Market closed + never refreshed in this process → refresh once
  //      so the UI doesn't sit on last-session bars after a cold boot.
  //   3. Market closed + last refresh > COLD_START_STALE_MS ago →
  //      catch-up refresh (handles week-long downtime / YoY gaps).
  //   4. Market closed + recently refreshed → skip (don't hammer Yahoo
  //      with frozen bars during weekends).
  if (!market.isOpen && market.state !== 'pre-open') {
    const age = lastRefreshedAt != null ? Date.now() - lastRefreshedAt : null;
    const coldStart = age == null || age > COLD_START_STALE_MS;
    if (!coldStart) return;
    console.log(
      `[candleScheduler] market closed — running catch-up refresh  ` +
      `last=${age == null ? 'never' : Math.round(age / 3_600_000) + 'h ago'}`,
    );
  }
  running = true;
  const t0 = Date.now();
  try {
    const res = await refreshDailyCandles({
      symbols: DEFAULT_PHASE1_CONFIG.universe,
      force:   true,
    });
    lastRefreshedAt = Date.now();
    console.log(
      `[candleScheduler] tick  ${Date.now() - t0}ms  ` +
      `refreshed=${res.refreshed}/${res.staleCount}  bars=${res.barsIngested}  ` +
      `failed=${res.failed.length}  latest=${res.latestTsAfter ?? '—'}`,
    );

    // Push the freshly ingested closes into the stream server's Kite
    // map so any browser currently connected sees Friday's actual
    // close (matching Google / NSE EOD) within this refresh cycle,
    // not whatever stale mid-day tick was sitting in memory. This
    // call never overwrites a real Kite frame; if a live tick came
    // in during the refresh it keeps precedence.
    try {
      const { seedKiteMapFromDaily } = await import('@/lib/ws/streamServer');
      const seeded = await seedKiteMapFromDaily();
      if (seeded > 0) {
        console.log(`[candleScheduler] seeded ${seeded} stream frames from fresh closes`);
      }
    } catch (err: any) {
      console.warn(`[candleScheduler] stream seed failed: ${err?.message ?? err}`);
    }
    // Surface the failing symbols inline — without this, the operator
    // has to grep `candleIngest` warnings across the whole log just
    // to know what got skipped this cycle. The most common failure
    // modes are post-corporate-action renames (demerger → Yahoo 404)
    // and delistings, both fixable via symbolNormalize.ts.
    if (res.failed.length > 0) {
      const grouped = new Map<string, string[]>();
      for (const f of res.failed) {
        const key = f.reason || 'unknown';
        const list = grouped.get(key) ?? [];
        list.push(f.symbol);
        grouped.set(key, list);
      }
      for (const [reason, syms] of grouped) {
        console.warn(
          `[candleScheduler] failed (${syms.length})  reason="${reason}"  ` +
          `symbols=[${syms.join(', ')}]`,
        );
      }
    }
  } catch (err) {
    console.warn(
      '[candleScheduler] tick failed:',
      (err as Error)?.message ?? err,
    );
  } finally {
    running = false;
  }
}

export function startCandleScheduler(): void {
  if (timer) return;
  console.log(
    `[candleScheduler] ✓ starting  interval=${INTERVAL_MS}ms  ` +
    `universe=${DEFAULT_PHASE1_CONFIG.universe.length}`,
  );
  // Kick one immediate tick on boot so `market_data_daily` lands a
  // fresh row before the first user request — without waiting for
  // the first interval to elapse.
  runOnce();
  timer = setInterval(runOnce, INTERVAL_MS);
}

export function stopCandleScheduler(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
