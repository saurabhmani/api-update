// ════════════════════════════════════════════════════════════════
//  tickFreshnessGuard — system-wide "are we actually live?" check
//
//  Purpose
//  ───────
//  The signal engine must refuse to emit orders when the market
//  data feed has gone quiet. "Quiet" can mean:
//
//    - Kite WebSocket is closed / reconnecting
//    - Access token is dead (loginRequired flag on the ticker)
//    - Socket is nominally open but no packets have arrived for
//      longer than STALE_MAX_MS (network blip, upstream issue,
//      exchange halt, lunch-hour illiquidity on an unlisted name)
//
//  Design
//  ──────
//  Event-driven, not polling. A single `tickBus.on('tick')`
//  subscriber stamps `lastTickTs = Date.now()` on every frame.
//  Callers ask `getMarketFreshness()` / `isMarketDataStale()` /
//  `assertFreshMarketData()` at decision points.
//
//  Zero DB writes. Zero loops over the symbol universe. The hot
//  path is one Map-less timestamp write per incoming tick.
//
//  Singleton via globalThis so HMR in Next.js dev mode doesn't
//  create shadow guards with stale counters.
// ════════════════════════════════════════════════════════════════

import { tickBus } from './tickBus';
import { getTicker } from './kiteTicker';
import type { Tick } from './kiteTicker';
import type { MarketFreshness, MarketState } from './tickTypes';
import { getMarketStatus } from './marketHours';
import { logger } from '@/lib/logger';

const log = logger.child({ component: 'tickFreshnessGuard' });

const STALE_MAX_MS = Number(process.env.TICK_STALE_MAX_MS) || 5_000;

interface GuardState {
  lastTickTs:    number | null;
  ticksReceived: number;
  installed:     boolean;
}

const GLOBAL_KEY = '__q365_tick_freshness_guard__';

function getState(): GuardState {
  const g = globalThis as unknown as Record<string, GuardState | undefined>;
  if (!g[GLOBAL_KEY]) {
    g[GLOBAL_KEY] = { lastTickTs: null, ticksReceived: 0, installed: false };
  }
  return g[GLOBAL_KEY]!;
}

/**
 * Install the bus listener exactly once per process. Safe to call
 * from multiple entry points (instrumentation hook, API route,
 * worker boot) — re-entry is a no-op.
 */
export function installTickFreshnessGuard(): void {
  const state = getState();
  if (state.installed) return;
  state.installed = true;

  const onTick = (_tick: Tick): void => {
    state.lastTickTs = Date.now();
    state.ticksReceived += 1;
  };
  tickBus.on('tick', onTick);
  console.log(`[tickFreshnessGuard] installed  staleMs=${STALE_MAX_MS}`);
}

/**
 * Compute the current market freshness verdict. Pure read — does
 * not touch the network, the DB, or the ticker socket state
 * beyond one synchronous getStatus() call.
 */
export function getMarketFreshness(maxAgeMs: number = STALE_MAX_MS): MarketFreshness {
  const state = getState();
  const ticker = getTicker();
  const st = ticker.getStatus();

  const base = {
    lastTickTs:      state.lastTickTs,
    ageMs:           state.lastTickTs != null ? Date.now() - state.lastTickTs : null,
    maxAgeMs,
    subscribedCount: st.subscribed,
    ticksReceived:   state.ticksReceived,
  };

  // If the market itself is closed (weekend / holiday / outside
  // 09:15–15:30 IST), "no ticks" is the expected state — don't
  // flag it as 'stale' or wake anyone up. Return 'closed' with a
  // friendly label instead so the UI banner and the signal engine
  // can short-circuit cleanly.
  const mkt = getMarketStatus();
  if (!mkt.isOpen) {
    return {
      ...base,
      state: 'closed' as MarketState,
      reason: mkt.label,
    };
  }

  if (st.loginRequired) {
    return {
      ...base,
      state: 'unauthenticated' as MarketState,
      reason: 'Kite access_token invalid — visit /api/kite/login',
    };
  }
  if (st.state !== 'open') {
    return {
      ...base,
      state: 'disconnected' as MarketState,
      reason: `ticker socket state=${st.state}`,
    };
  }
  if (state.lastTickTs == null) {
    return {
      ...base,
      state: 'stale' as MarketState,
      reason: 'socket open but no ticks have arrived yet',
    };
  }
  const age = Date.now() - state.lastTickTs;
  if (age > maxAgeMs) {
    return {
      ...base,
      state: 'stale' as MarketState,
      reason: `last tick is ${age}ms old (> ${maxAgeMs}ms cutoff)`,
    };
  }
  return { ...base, state: 'live' as MarketState };
}

/** Convenience boolean for gate expressions: `if (isMarketDataStale()) return;`
 *  A 'closed' market is NOT stale — it's expected. Callers that need to
 *  block on "market must be live right now" should check the state
 *  directly via getMarketFreshness(). */
export function isMarketDataStale(maxAgeMs: number = STALE_MAX_MS): boolean {
  const s = getMarketFreshness(maxAgeMs).state;
  return s !== 'live' && s !== 'closed';
}

export class MarketStaleError extends Error {
  constructor(public freshness: MarketFreshness) {
    super(`MARKET_STALE state=${freshness.state} reason=${freshness.reason ?? '-'}`);
    this.name = 'MarketStaleError';
  }
}

/**
 * Throwing variant — use at the top of signal-generation code
 * paths so downstream logic can't accidentally run on a dead feed.
 * Pairs with the `getLiveTick` throwing accessor in kiteTicker.
 */
export function assertFreshMarketData(maxAgeMs: number = STALE_MAX_MS): MarketFreshness {
  const f = getMarketFreshness(maxAgeMs);
  if (f.state !== 'live') throw new MarketStaleError(f);
  return f;
}
