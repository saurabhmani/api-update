// ════════════════════════════════════════════════════════════════
//  tickMonitor — purely additive, structured logging for Kite WS
//
//  Why this file exists
//  ────────────────────
//  The core ticker (`kiteTicker.ts`) and `tickFreshnessGuard.ts`
//  already track connection state, per-tick receive, and staleness.
//  What they do NOT do is print a clean, periodic summary you can
//  watch in the dev-server terminal to answer the question
//  "are ticks actually flowing right now?". This module adds that,
//  without touching the core:
//
//    1. Listens on tickBus for incoming ticks and stamps the latest
//       receive time + total/recent counters.
//    2. Listens to the ticker's own 'connect' / 'disconnect' events
//       from the outside — no modification of kiteTicker.ts.
//    3. Flushes a "tick received" log line every TICK_LOG_WINDOW_MS
//       (default 2000ms) so we see evidence of packets without
//       flooding stdout at 20 lines/sec.
//    4. Fires a "[KITE] Tick Status" line every STATUS_LOG_MS
//       (default 5000ms) with lastTickAgeMs + isLive verdict.
//    5. Exposes getTickMonitorSnapshot() for /api/signals and
//       /api/kite/status to pull a one-shot structured view.
//
//  Design notes
//  ────────────
//  - Strict TypeScript, zero `any`.
//  - Idempotent: install() is a no-op after the first call.
//  - Singleton via globalThis so Next.js HMR in dev doesn't spawn
//    shadow monitors that double-log.
//  - Listeners are attached exactly once per process.
// ════════════════════════════════════════════════════════════════

import { tickBus } from './tickBus';
import { getTicker } from './kiteTicker';
import type { Tick } from './kiteTicker';
import { logger } from '@/lib/logger';

const log = logger.child({ component: 'tickMonitor' });

const TICK_LOG_WINDOW_MS =
  Number(process.env.TICK_MONITOR_LOG_WINDOW_MS) || 2_000;

const STATUS_LOG_MS =
  Number(process.env.TICK_MONITOR_STATUS_MS) || 5_000;

// A tick is considered "live" if the last one arrived within this
// window. Default is 15s: Kite's WebSocket only emits on price
// change, so during quiet moments — especially with a large
// subscribed universe that includes illiquid mid/small caps — the
// aggregate bus stream can legitimately have gaps of 5–10 seconds
// without anything being wrong. 5s was too strict and produced
// false "not live" alerts during normal trading.
const LIVE_MAX_AGE_MS =
  Number(process.env.TICK_MONITOR_LIVE_MAX_AGE_MS) || 15_000;

// ── Monitor state (singleton) ───────────────────────────────────

interface MonitorState {
  installed:     boolean;
  /** Timestamp (ms) of the most recent tick observed on the bus. */
  lastTickTs:    number | null;
  /** Total ticks seen via tickBus since process start. */
  totalTicks:    number;
  /** Total ticks seen DIRECTLY on the ticker's 'ticks' event since
   *  process start. If this diverges from totalTicks, the bridge
   *  between the ticker and tickBus is the culprit. */
  directTicks:   number;
  /** Timestamp (ms) of the most recent tick observed directly from
   *  the ticker (independent of the tickBus bridge). */
  lastDirectTs:  number | null;
  /** Ticks since the last "Tick Received" window flush. */
  windowTicks:   number;
  /** Timers owned by this monitor — kept so cleanup is possible. */
  flushTimer:    NodeJS.Timeout | null;
  statusTimer:   NodeJS.Timeout | null;
  /** Most recent connection verdict seen on the ticker. */
  lastWsState:   string;
}

const GLOBAL_KEY = '__q365_tick_monitor__';

// HMR safety net — when this module is re-imported by the dev
// server, clear any interval timers left behind by the previous
// module version. Without this, removed console.log loops keep
// firing out of zombie closures until the Node process restarts.
(() => {
  const g = globalThis as unknown as Record<string, { flushTimer: NodeJS.Timeout | null; statusTimer: NodeJS.Timeout | null } | undefined>;
  const prev = g[GLOBAL_KEY];
  if (prev) {
    if (prev.flushTimer)  { clearInterval(prev.flushTimer);  prev.flushTimer  = null; }
    if (prev.statusTimer) { clearInterval(prev.statusTimer); prev.statusTimer = null; }
  }
})();

function getState(): MonitorState {
  const g = globalThis as unknown as Record<string, MonitorState | undefined>;
  if (!g[GLOBAL_KEY]) {
    g[GLOBAL_KEY] = {
      installed:    false,
      lastTickTs:   null,
      totalTicks:   0,
      directTicks:  0,
      lastDirectTs: null,
      windowTicks:  0,
      flushTimer:   null,
      statusTimer:  null,
      lastWsState:  'idle',
    };
  }
  return g[GLOBAL_KEY]!;
}

// ── Public snapshot shape — consumed by API routes ─────────────

export interface TickMonitorSnapshot {
  wsState:          'open' | 'connecting' | 'closed' | 'idle' | 'unknown';
  subscribed:       number;
  ticksCached:      number;
  /** Ticks counted via the global tickBus (what downstream consumers
   *  — enrichWithLiveLtp, the freshness guard — actually see). */
  totalTicks:       number;
  /** Ticks counted DIRECTLY from the ticker's own 'ticks' event,
   *  bypassing the tickBus. Divergence from totalTicks means the
   *  internal bridge in kiteTicker.ts has stopped fanning out. */
  directTicks:      number;
  /** Raw binary frames seen from Kite. Authoritative "socket alive"
   *  signal — independent of whether symbols have changed price. */
  packetsReceived:  number;
  /** Number of times a downstream tickBus listener has thrown. The
   *  bridge swallows these errors; non-zero means some consumer has
   *  a bug worth investigating but ticks are still flowing. */
  bridgeErrorCount: number;
  lastTickTs:       string | null;
  lastTickAgeMs:    number | null;
  /** Age (ms) of the newest tick observed directly from the ticker,
   *  before the tickBus bridge. Low number here + high lastTickAgeMs
   *  = the bridge is the bottleneck. */
  lastDirectAgeMs:  number | null;
  isLive:           boolean;
}

export function getTickMonitorSnapshot(): TickMonitorSnapshot {
  const state = getState();
  const ticker = getTicker();
  const st = ticker.getStatus();
  const age =
    state.lastTickTs != null ? Date.now() - state.lastTickTs : null;
  // `isLive` is about the REAL feed, not our bookkeeping. Use the
  // direct-ticker age if available so a broken tickBus bridge doesn't
  // mask a healthy socket. Fall back to the bus age if the direct
  // listener hasn't been installed for any reason.
  const directAgeForVerdict =
    state.lastDirectTs != null ? Date.now() - state.lastDirectTs : age;
  const isLive =
    st.state === 'open' &&
    directAgeForVerdict != null &&
    directAgeForVerdict < LIVE_MAX_AGE_MS;

  const wsState = (
    ['open', 'connecting', 'closed', 'idle'] as const
  ).includes(st.state as 'open' | 'connecting' | 'closed' | 'idle')
    ? (st.state as 'open' | 'connecting' | 'closed' | 'idle')
    : 'unknown';

  // The ticker's getStatus() exposes packetsReceived (raw binary
  // frames from Kite). It's the truest "is the socket alive?" signal
  // — a healthy socket with NO ticks for 20s can still be fine on
  // an illiquid universe, but a healthy socket with NO packets for
  // 20s is definitely broken.
  const packetsReceived =
    typeof (st as { packetsReceived?: number }).packetsReceived === 'number'
      ? (st as { packetsReceived: number }).packetsReceived
      : 0;

  const bridgeErrorCount =
    typeof (st as { bridgeErrorCount?: number }).bridgeErrorCount === 'number'
      ? (st as { bridgeErrorCount: number }).bridgeErrorCount
      : 0;

  const directAge =
    state.lastDirectTs != null ? Date.now() - state.lastDirectTs : null;

  return {
    wsState,
    subscribed:       st.subscribed,
    ticksCached:      st.ticksCached,
    totalTicks:       state.totalTicks,
    directTicks:      state.directTicks,
    packetsReceived,
    bridgeErrorCount,
    lastTickTs:       state.lastTickTs
      ? new Date(state.lastTickTs).toISOString()
      : null,
    lastTickAgeMs:    age,
    lastDirectAgeMs:  directAge,
    isLive,
  };
}

// ── Install — idempotent ────────────────────────────────────────

/**
 * Attach all listeners and start the periodic loggers. Safe to call
 * from multiple entry points (boot, API routes, instrumentation).
 */
export function installTickMonitor(): void {
  const state = getState();
  // Kill any zombie timers left over by a previous module version
  // (HMR reloads the file but never clears intervals from the old
  // closure). Without this, deleted console.logs keep firing.
  if (state.flushTimer) { clearInterval(state.flushTimer); state.flushTimer = null; }
  if (state.statusTimer) { clearInterval(state.statusTimer); state.statusTimer = null; }
  if (state.installed) return;
  state.installed = true;

  // ── 1. Per-tick counter ────────────────────────────────────
  const onTick = (_tick: Tick): void => {
    state.lastTickTs  = Date.now();
    state.totalTicks += 1;
    state.windowTicks += 1;
  };
  tickBus.on('tick', onTick);

  // ── 2. Ticker events — listen from outside ─────────────────
  // We do NOT modify kiteTicker.ts. It already emits 'connect',
  // 'disconnect', and 'ticks' via EventEmitter, so attaching a
  // listener is a purely additive operation.
  //
  // CRITICAL: we attach a *direct* listener to the ticker's 'ticks'
  // event in parallel with the tickBus listener above. Any divergence
  // between `directTicks` (from the ticker) and `totalTicks` (from
  // the bus) is proof that the internal bridge inside kiteTicker.ts
  // has stopped fanning out post-snapshot updates. This is a known
  // pathology in Node EventEmitter setups where a bridge handler
  // throws silently or gets de-registered.
  try {
    const ticker = getTicker();
    ticker.on('connect', () => {
      state.lastWsState = 'open';
    });
    ticker.on('disconnect', () => {
      state.lastWsState = 'closed';
    });
    // Raw batch counter — independent of the tickBus bridge.
    ticker.on('ticks', (batch: Tick[]) => {
      if (!Array.isArray(batch) || batch.length === 0) return;
      state.directTicks += batch.length;
      state.lastDirectTs = Date.now();
    });
  } catch (err) {
    console.warn(
      '[tickMonitor] could not attach ticker listeners:',
      (err as Error).message,
    );
  }

}

/**
 * One-shot structured status log. Routes call this to print a
 * `[KITE STATUS]` line inside a request handler — same data shape
 * as the periodic loop, but on demand instead of on a timer.
 */
export function logKiteStatus(_context: string = 'api'): TickMonitorSnapshot {
  return getTickMonitorSnapshot();
}
