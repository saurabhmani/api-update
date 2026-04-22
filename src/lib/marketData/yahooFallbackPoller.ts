// ════════════════════════════════════════════════════════════════
//  yahooFallbackPoller — keep prices flowing when Kite goes silent
//
//  Activation rule (spec):
//    • Market must be OPEN — no point polling after hours.
//    • Kite WS must be either NOT open OR no tick for >30s.
//
//  Deactivation rule (spec):
//    • Fresh Kite tick within 3s AND ws state === 'open' — Kite is
//      back, Yahoo is a waste of quota.
//
//  How it feeds the pipeline
//    Every poll cycle (default 7s), the poller takes the currently
//    subscribed hot universe from the ticker, fetches Yahoo prices
//    with bounded concurrency, and emits each result as a TickData
//    on the `tickBus` with `source: 'yahoo'`. Downstream consumers
//    (redisTickBridge → Redis streams; streamServer → UI WS;
//    freshnessGuard → lastTickTs) all keep working identically;
//    the UI's LiveCell renders the 'yahoo' badge automatically.
//
//  What this module deliberately does NOT do
//    • Doesn't set ticker.ticksBySymbol — that Map is the Kite-only
//      truth and getLiveTick() throws on stale entries. Polluting it
//      with Yahoo data would break execution guardrails.
//    • Doesn't write the tickFreshnessGuard's lastTickTs directly —
//      the bus listener handles that for us, so a live Yahoo tick
//      genuinely counts as "market data is flowing" in the sense
//      the UI banner cares about.
//    • Doesn't cache beyond what priceCache already does (2s TTL).
// ════════════════════════════════════════════════════════════════

import { tickBus } from './tickBus';
import { getTicker } from './kiteTicker';
import type { Tick } from './kiteTicker';
import { fetchFromYahooCached } from './priceCache';
import { getMarketStatus } from './marketHours';
import { logger } from '@/lib/logger';

const log = logger.child({ component: 'yahooFallbackPoller' });

const GLOBAL_KEY = '__q365_yahoo_fallback_poller__';

// Health-check cadence — cheap, just reads ticker state.
const HEALTH_CHECK_MS =
  Number(process.env.YAHOO_FALLBACK_HEALTH_MS) || 2_000;

// Poll cadence — 10s default (tunable via YAHOO_FALLBACK_POLL_MS).
// At 10s with priceCache TTL of 2s, every poll forces a fresh Yahoo
// fetch while the in-flight dedup prevents symbol stampedes.
const POLL_INTERVAL_MS =
  Number(process.env.YAHOO_FALLBACK_POLL_MS) || 10_000;

// Maximum symbols to poll per cycle. Yahoo's public chart endpoint
// is tolerant but not infinite; keeping this under 100 avoids
// tripping rate limits when the hot universe is large.
const MAX_SYMBOLS =
  Number(process.env.YAHOO_FALLBACK_MAX_SYMBOLS) || 100;

// Parallel fetches per cycle. Yahoo typically answers in ~300ms;
// concurrency 10 keeps wall time under ~3s for a 100-symbol batch.
const CONCURRENCY =
  Number(process.env.YAHOO_FALLBACK_CONCURRENCY) || 10;

// Start fallback when Kite has been silent for this long.
const STALE_THRESHOLD_MS =
  Number(process.env.YAHOO_FALLBACK_STALE_MS) || 30_000;

// Stop fallback when Kite ticks are fresher than this.
const RECOVERY_THRESHOLD_MS =
  Number(process.env.YAHOO_FALLBACK_RECOVERY_MS) || 3_000;

// Hard grace-period: if the ticker has been stuck in idle/connecting
// state for this long without ever producing a Kite tick — almost
// always means the daily OAuth wasn't done and the socket will never
// open — activate Yahoo anyway so users still see live prices.
// Track this from poller install, since ticker.getStatus() doesn't
// expose "time since last state transition".
const IDLE_GRACE_MS =
  Number(process.env.YAHOO_FALLBACK_IDLE_GRACE_MS) || 90_000;

interface PollerState {
  healthTimer: NodeJS.Timeout | null;
  pollTimer:   NodeJS.Timeout | null;
  active: boolean;          // currently polling Yahoo
  startedAt: number | null; // when current activation began
  cycles: number;           // poll cycles executed this session
  emitted: number;          // ticks emitted onto tickBus
  errors:  number;
  activations: number;      // times we transitioned inactive→active
  recoveries:  number;      // times we transitioned active→inactive via Kite recovery
  lastKiteTickTs: number | null; // tracked via bus listener
  lastPollAt: number | null;
  installedAt: number | null;    // when installYahooFallbackPoller() first ran
}

function getState(): PollerState {
  const g = globalThis as unknown as Record<string, PollerState | undefined>;
  if (!g[GLOBAL_KEY]) {
    g[GLOBAL_KEY] = {
      healthTimer: null, pollTimer: null,
      active: false, startedAt: null,
      cycles: 0, emitted: 0, errors: 0,
      activations: 0, recoveries: 0,
      lastKiteTickTs: null, lastPollAt: null,
      installedAt: null,
    };
  }
  const s = g[GLOBAL_KEY]!;
  // Back-fill for state created by an older build.
  if (s.installedAt === undefined) s.installedAt = null;
  return s;
}

/**
 * Bus listener — stamps lastKiteTickTs whenever a REAL Kite tick
 * arrives (i.e. source is absent or 'kite'). We ignore our own
 * Yahoo emissions here, otherwise the recovery check would always
 * see fresh ticks and never activate the poller in the first place.
 */
function ensureBusListener(): void {
  const state = getState();
  // Use a stable symbol so repeated installs don't stack listeners.
  const marker = '__q365_yahoo_poller_bus_listener__';
  if ((tickBus as any)[marker]) return;
  (tickBus as any)[marker] = true;
  tickBus.on('tick', (tick: Tick) => {
    if (tick.source && tick.source !== 'kite') return;
    state.lastKiteTickTs = Date.now();
  });
}

// Tiny bounded-concurrency map — one less dependency than pulling
// in p-limit. Executes `task(item)` for each item with at most `n`
// in flight. Resolves when every task has settled.
async function parallelEach<T>(
  items: T[],
  n: number,
  task: (item: T) => Promise<void>,
): Promise<void> {
  let idx = 0;
  const workers: Promise<void>[] = [];
  for (let k = 0; k < Math.min(n, items.length); k++) {
    workers.push((async () => {
      while (idx < items.length) {
        const i = idx++;
        try { await task(items[i]); }
        catch { /* swallowed — individual errors don't kill the batch */ }
      }
    })());
  }
  await Promise.all(workers);
}

async function listHotSymbols(): Promise<string[]> {
  const ticker = getTicker();
  // listSubscribedSymbols does a token→symbol lookup per subscribed
  // token. Works whether the WS is open or reconnecting.
  const all = await ticker.listSubscribedSymbols().catch(() => [] as string[]);
  // Dedup + filter blanks + cap to MAX_SYMBOLS.
  const uniq: string[] = [];
  const seen = new Set<string>();
  for (const s of all) {
    const up = String(s ?? '').trim().toUpperCase();
    if (!up || seen.has(up)) continue;
    seen.add(up);
    uniq.push(up);
    if (uniq.length >= MAX_SYMBOLS) break;
  }
  return uniq;
}

async function pollOnce(): Promise<void> {
  const state = getState();
  state.cycles += 1;
  state.lastPollAt = Date.now();
  const symbols = await listHotSymbols();
  if (symbols.length === 0) {
    // Nothing subscribed yet — dynSubSync hasn't run, or the hot
    // universe is empty (no active signals in DB). Nothing useful
    // Yahoo can do for us; don't fire spurious network calls.
    return;
  }

  const t0 = Date.now();
  let got = 0;
  let miss = 0;
  await parallelEach(symbols, CONCURRENCY, async (sym) => {
    const res = await fetchFromYahooCached(sym).catch(() => null);
    if (!res || res.price == null) {
      miss += 1;
      state.errors += 1;
      return;
    }
    const price = Number(res.price);
    if (!Number.isFinite(price) || price <= 0) {
      miss += 1;
      return;
    }
    // Build a TickData and push it on the bus with source='yahoo'.
    // token=0 is the sentinel for "no Kite token" (same convention
    // the simulator uses). We deliberately do NOT populate ticker's
    // ticksBySymbol — see the header comment.
    const pChangeRaw = typeof res.pChange === 'number' ? res.pChange : null;
    const changeRaw  = typeof res.change  === 'number' ? res.change  : null;
    const tick: Tick = {
      token: 0,
      symbol: sym,
      lastPrice: price,
      ts: Date.now(),
      source: 'yahoo',
      ...(changeRaw != null  ? { change:  changeRaw  } : {}),
      ...(pChangeRaw != null ? { pChange: pChangeRaw } : {}),
    };
    tickBus.emit('tick', tick);
    state.emitted += 1;
    got += 1;
  });
  const ms = Date.now() - t0;
  // One terse line per cycle — grep target is [YAHOO].
  console.log(
    `[YAHOO] cycle=${state.cycles}  ${ms}ms  symbols=${symbols.length}  ` +
    `got=${got}  miss=${miss}  emitted=${state.emitted}`,
  );
}

function schedulePoll(): void {
  const state = getState();
  if (state.pollTimer) return;
  state.pollTimer = setInterval(() => {
    // Re-check health before each poll — if Kite came back during
    // the poll interval, stop immediately rather than waste one
    // more cycle on Yahoo.
    if (!shouldBeActive()) {
      transitionToInactive('kite recovered mid-poll');
      return;
    }
    pollOnce().catch((err) => {
      state.errors += 1;
      console.warn(`[YAHOO] poll error — ${err?.message ?? err}`);
    });
  }, POLL_INTERVAL_MS);
  state.pollTimer.unref?.();
  // Fire once immediately so the UI doesn't stare at a blank feed
  // for POLL_INTERVAL_MS after activation.
  pollOnce().catch((err) => {
    state.errors += 1;
    console.warn(`[YAHOO] initial poll error — ${err?.message ?? err}`);
  });
}

function stopPoll(): void {
  const state = getState();
  if (state.pollTimer) {
    clearInterval(state.pollTimer);
    state.pollTimer = null;
  }
}

function shouldBeActive(): boolean {
  const state  = getState();
  const market = getMarketStatus();
  const ticker = getTicker();
  const st     = ticker.getStatus();

  // ── Market-OPEN path: Yahoo is DISABLED (non-negotiable rule) ─
  // Rule: "MARKET OPEN — Disable Yahoo completely". During trading
  // hours we only accept live Kite ticks. A missing/stale tick
  // becomes a UI 'WAITING' state rather than a mixed-source feed.
  // The background poller has no job during market hours.
  //
  // EXCEPTION — loginRequired override.
  // When Kite is blocked on an expired/missing access_token, the
  // ticker will NEVER recover on its own — it requires a human to
  // re-run OAuth at /api/kite/login. Until then, the strict "Kite
  // only" policy would serve an empty board to every user for the
  // entire session. That's worse than honest 15-min Yahoo data.
  //
  // This override fires ONLY when loginRequired is true. Any other
  // Kite failure mode (stale socket, reconnecting, idle grace) is
  // transient and will self-heal — we still wait those out.
  //
  // Disable the override with YAHOO_FALLBACK_ON_LOGIN_REQUIRED=0
  // if you prefer the stricter "Kite only" policy.
  if (market.isOpen) {
    const allowLoginOverride =
      process.env.YAHOO_FALLBACK_ON_LOGIN_REQUIRED !== '0';
    if (st.loginRequired && allowLoginOverride) {
      return true;
    }
    return false;
  }

  // ── Market-CLOSED path: Yahoo is passive-only ─────────────────
  // Yahoo is consulted ON DEMAND by API enrichers (signals,
  // /api/price, MarketDataProvider) when Kite cache + EOD both
  // miss for a specific symbol. A background poller that sweeps
  // Yahoo every 10s after-hours just repeats the same EOD close
  // and serves no purpose the on-demand path doesn't already cover.
  // Opt-in via YAHOO_POLLER_AFTER_HOURS=1 if you want the legacy
  // 10s sweep (e.g. to pre-warm the Kite-empty symbol set).
  return process.env.YAHOO_POLLER_AFTER_HOURS === '1';

  // ── Market-open path ─────────────────────────────────────────
  // No Kite tick ever during this session → activate.
  if (state.lastKiteTickTs == null) {
    if (st.state === 'idle' || st.state === 'connecting') {
      const installAge = state.installedAt ? Date.now() - state.installedAt : 0;
      if (installAge > IDLE_GRACE_MS) return true;
      return false;
    }
    return true;
  }

  const age = Date.now() - state.lastKiteTickTs;
  if (st.state !== 'open') return true;
  return age > STALE_THRESHOLD_MS;
}

function shouldRecover(): boolean {
  const state  = getState();
  const ticker = getTicker();
  const st     = ticker.getStatus();
  const market = getMarketStatus();

  // Market closed — never recover. Two reasons:
  //   1. shouldBeActive() returns true unconditionally when market is
  //      closed (for EOD accuracy), so recovering here just triggers
  //      an instant re-activation 2s later → oscillation.
  //   2. When MARKET_SIMULATE=1, the synthetic ticker emits ticks with
  //      no `source` field, which the bus listener stamps as Kite
  //      ticks. That would spuriously satisfy the "Kite is fresh"
  //      recovery check even though no real Kite data is flowing.
  // During off-hours, Yahoo stays active until the next market open.
  if (!market.isOpen) return false;

  // Market open — recover only if Kite ticks are flowing fresh.
  if (st.state === 'open'
      && state.lastKiteTickTs != null
      && Date.now() - state.lastKiteTickTs <= RECOVERY_THRESHOLD_MS) {
    return true;
  }

  return false;
}

function transitionToActive(reason: string): void {
  const state = getState();
  if (state.active) return;
  state.active = true;
  state.startedAt = Date.now();
  state.activations += 1;
  console.warn(
    `[YAHOO] ✗ Kite silent — ACTIVATING Yahoo fallback  reason="${reason}"  ` +
    `activations=${state.activations}`,
  );
  log.warn('Yahoo fallback activated', { reason });
  schedulePoll();
}

function transitionToInactive(reason: string): void {
  const state = getState();
  if (!state.active) return;
  state.active = false;
  const dur = state.startedAt ? Date.now() - state.startedAt : null;
  state.startedAt = null;
  state.recoveries += 1;
  console.log(
    `[YAHOO] ✓ Kite recovered — DEACTIVATING Yahoo fallback  reason="${reason}"  ` +
    `durationMs=${dur ?? '—'}  recoveries=${state.recoveries}`,
  );
  log.info('Yahoo fallback deactivated', { reason, durationMs: dur });
  stopPoll();
}

function healthCheck(): void {
  const state = getState();
  if (!state.active) {
    if (shouldBeActive()) {
      const age = state.lastKiteTickTs == null
        ? null
        : Date.now() - state.lastKiteTickTs;
      const reason = age == null
        ? 'no Kite tick since boot'
        : `Kite tick age ${Math.round(age / 1000)}s > ${STALE_THRESHOLD_MS / 1000}s threshold`;
      transitionToActive(reason);
    }
  } else {
    if (shouldRecover()) {
      transitionToInactive('Kite ticks fresh within recovery threshold');
    }
  }
}

/**
 * Install the poller. Idempotent — safe across Next.js HMR because
 * the singleton state lives on globalThis.
 *
 * Boot order:
 *   1. bootTicker wires the Kite socket and kicks subscribe.
 *   2. bootTicker calls installYahooFallbackPoller().
 *   3. This function attaches the bus listener (so it can observe
 *      Kite ticks) and starts the health-check timer.
 *   4. The health check runs every 2s; the first time it sees no
 *      Kite ticks for >30s it activates the Yahoo poll loop.
 */
export function installYahooFallbackPoller(): void {
  const state = getState();
  if (state.healthTimer) return;
  ensureBusListener();
  state.installedAt = Date.now();
  console.log(
    `[YAHOO] installing fallback poller  poll=${POLL_INTERVAL_MS}ms  ` +
    `stale=${STALE_THRESHOLD_MS}ms  recover=${RECOVERY_THRESHOLD_MS}ms  ` +
    `idle_grace=${IDLE_GRACE_MS}ms  max=${MAX_SYMBOLS}  concurrency=${CONCURRENCY}`,
  );
  state.healthTimer = setInterval(() => {
    try { healthCheck(); }
    catch (err: any) { console.warn(`[YAHOO] health check threw — ${err?.message ?? err}`); }
  }, HEALTH_CHECK_MS);
  state.healthTimer.unref?.();
}

export function uninstallYahooFallbackPoller(): void {
  const state = getState();
  if (state.healthTimer) {
    clearInterval(state.healthTimer);
    state.healthTimer = null;
  }
  stopPoll();
  state.active = false;
}

export function getYahooFallbackStats(): {
  installed: boolean;
  active: boolean;
  startedAt: number | null;
  cycles: number;
  emitted: number;
  errors: number;
  activations: number;
  recoveries: number;
  lastKiteTickTs: number | null;
  lastKiteTickAgeMs: number | null;
  lastPollAt: number | null;
} {
  const s = getState();
  return {
    installed: s.healthTimer != null,
    active: s.active,
    startedAt: s.startedAt,
    cycles: s.cycles,
    emitted: s.emitted,
    errors: s.errors,
    activations: s.activations,
    recoveries: s.recoveries,
    lastKiteTickTs: s.lastKiteTickTs,
    lastKiteTickAgeMs: s.lastKiteTickTs ? Date.now() - s.lastKiteTickTs : null,
    lastPollAt: s.lastPollAt,
  };
}
