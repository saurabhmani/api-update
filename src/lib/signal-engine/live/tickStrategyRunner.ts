// ════════════════════════════════════════════════════════════════
//  tickStrategyRunner — tick → strategy dispatcher
//
//  Listens on tickBus('tick') and calls an analyze handler per
//  symbol, throttled to at most 1 call per second per symbol.
//  Without the throttle, a liquid name like RELIANCE emits several
//  ticks per second and the strategy engine would run hundreds of
//  times across the universe every second — pointless work and a
//  fast path to CPU starvation.
//
//  The runner is registered ONCE via registerTickStrategyRunner()
//  — idempotent across HMR, across multiple boot calls, and across
//  concurrent API hits. The globalThis flag is the single source
//  of truth.
//
//  Wiring the real engine:
//    The default handler is a lightweight logger. To route ticks
//    to the full Phase 4 signal engine, replace `defaultHandler`
//    with a call to analyzeInstrument (or a lighter symbol-level
//    check) — but keep the throttle in place, or you'll DOS the
//    DB with 2000× analyses per second during market hours.
// ════════════════════════════════════════════════════════════════

import { tickBus } from '@/lib/marketData/tickBus';
import { getSymbolForToken } from '@/lib/marketData/kiteInstruments';
import { getLiveTick, type Tick } from '@/lib/marketData/kiteTicker';
import { generateSignal, type Signal } from './analyzeInstrument';

const GLOBAL_KEY = '__q365_tick_strategy_registered__';

// Minimum gap between analyses of the same symbol, in ms.
// 1000ms is the sane default for intraday scanning — indicators
// built on minute bars simply don't need sub-second updates.
// Override with TICK_STRATEGY_THROTTLE_MS — bump to 5000+ if the
// engine is DB-heavy and you see the concurrency pool saturating.
const THROTTLE_MS = Number(process.env.TICK_STRATEGY_THROTTLE_MS) || 1000;

// Maximum simultaneous analyses across the whole universe. The
// real engine hits the candles table, computes features, and runs
// every strategy — it's not cheap. Without this cap, a flood of
// ticks can push hundreds of parallel DB queries and starve the
// rest of the app. 8 is a conservative default; tune to your DB.
const MAX_CONCURRENCY = Number(process.env.TICK_STRATEGY_CONCURRENCY) || 8;

// Per-symbol last-run wall clock. Map key is the instrument token
// (int) because it's stable and already on the tick; avoids the
// string-allocation per tick that using `symbol` as key would cause.
const lastRunByToken = new Map<number, number>();

// Per-symbol in-flight guard. Even with a 1s throttle, a single
// generateSignal call can exceed 1s on a cold DB cache — without
// this guard we'd stack multiple concurrent analyses for the same
// symbol and double-count CPU/DB. Value is a lightweight promise
// marker; we only care about presence.
const inFlightByToken = new Set<number>();

// Global in-flight counter for the concurrency cap.
let globalInFlight = 0;

// Rolling counters for the /api/kite/ticker health probe to read.
// Exposed via getRunnerStats() — no DB write, no leak.
const stats = {
  ticksSeen: 0,
  analyzed: 0,
  throttled: 0,
  inFlightSkipped: 0,
  concurrencyCapped: 0,
  staleAtDispatch: 0,
  signalsEmitted: 0,
  holdsReturned: 0,
  errors: 0,
  startedAt: 0,
  lastTickAt: 0,
  lastAnalyzedSymbol: null as string | null,
  lastSignalSymbol: null as string | null,
  lastSignalDirection: null as string | null,
  lastSignalAt: 0,
};

// ── Real handler — wraps the Phase 4 generateSignal engine ────
//
// Called off the event loop (fire-and-forget from the bus
// listener). Responsibilities:
//   1. Resolve symbol (tick.symbol is pre-filled at subscribe
//      time; fallback lookup only for out-of-band tokens)
//   2. Run the real engine: generateSignal(instrument_key, symbol, 'NSE')
//   3. If the engine returns a BUY/SELL signal, re-emit it on
//      tickBus as a 'signal' event so downstream consumers
//      (execution engine, UI, persistence) can act on it
//   4. Never throw — all errors are logged to stats.errors and
//      swallowed so one bad symbol can't kill the pipeline
async function realHandler(tick: Tick): Promise<void> {
  const symbol = tick.symbol ?? (await getSymbolForToken(tick.token));
  if (!symbol) return;

  // ── Strict live-tick resolution at dispatch time ────────
  // getLiveTick is the single canonical accessor. It throws if
  // the WS is down, no tick is cached, or the tick is older
  // than STRICT_TICK_MAX_AGE_MS (default 2000ms). The
  // throwing API makes "use an old tick" literally impossible
  // — there's no alternative object for this call site to
  // fall back to.
  let current: Tick;
  try {
    current = getLiveTick(symbol);
  } catch (err) {
    stats.staleAtDispatch += 1;
    if (process.env.TICK_STRATEGY_LOG === '1') {
      console.log(
        `[tickStrategy] ⏱ ${symbol}  skip — ${(err as Error).message}`
      );
    }
    return;
  }
  // Use the FRESH tick returned by getLiveTick, never the one
  // that arrived on the event bus. The event tick triggered
  // the dispatch; `current` is what the engine evaluates.
  tick = current;

  // [SYNC] check — prove that the signal pipeline and the
  // tick cache agree at this exact moment. symbol/ts/ltp
  // should match whatever /api/price returns for the same
  // symbol in the same millisecond.
  console.log(
    `[SYNC] signal  ${symbol}  ts=${current.ts}  ltp=${current.lastPrice}  ` +
    `age=${Date.now() - current.ts}ms`
  );

  stats.lastAnalyzedSymbol = symbol;

  if (process.env.TICK_STRATEGY_LOG === '1') {
    console.log(
      `[tickStrategy] → ${symbol}  ltp=${tick.lastPrice}  ` +
      `vol=${tick.volume ?? '-'}`
    );
  }

  // instrument_key mirrors the convention used elsewhere in the
  // codebase ("NSE:SYMBOL"). generateSignal uses it only as an
  // identifier on the returned Signal object; candle fetches are
  // keyed on the tradingsymbol.
  const instrumentKey = `NSE:${symbol}`;

  let signal: Signal | null = null;
  try {
    signal = await generateSignal(instrumentKey, symbol, 'NSE');
  } catch (err: any) {
    stats.errors += 1;
    console.error(
      `[tickStrategy] generateSignal threw for ${symbol}:`,
      err?.message,
    );
    return;
  }

  if (!signal) {
    // Engine returned null (insufficient candles, benchmark miss).
    // Not an error — just nothing to emit.
    return;
  }

  if (signal.direction === 'HOLD') {
    stats.holdsReturned += 1;
    return;
  }

  // CRITICAL: refetch the freshest live tick from the cache
  // HERE. generateSignal can take 200-800ms (DB reads, indicator
  // computation), so the tick `current` we validated at dispatch
  // time is stale by the time we're about to emit. Use getLiveTick
  // to enforce the <2s freshness guarantee at the moment of
  // commitment. If it throws, drop the signal — the market has
  // moved and we'd be acting on cold data.
  let latest: Tick;
  try {
    latest = getLiveTick(symbol);
  } catch (err) {
    stats.staleAtDispatch += 1;
    console.log(
      `[tickStrategy] ⏱ ${symbol}  drop at emit — ${(err as Error).message}`
    );
    return;
  }
  const emitPrice = latest.lastPrice;
  const emitTs    = latest.ts;

  // Attach live tick data to the emitted event so consumers that
  // care about execution latency (order router, slippage estimator)
  // don't need a second round-trip to the cache. The Signal itself
  // carries the engine's preferred entry/stop/targets computed from
  // daily bars; the tick price is "what we actually see right now".
  const payload = {
    symbol,
    type: signal.direction, // 'BUY' | 'SELL'
    price: emitPrice,
    engineEntry: (signal as any).entry ?? null,
    stopLoss:    (signal as any).stop_loss ?? null,
    target1:     (signal as any).target_1 ?? null,
    confidence:  signal.confidence,
    strategy:    (signal as any).strategy_name ?? null,
    volume:      latest.volume ?? null,
    timestamp:   emitTs,
    signal,
  };

  stats.signalsEmitted += 1;
  stats.lastSignalSymbol = symbol;
  stats.lastSignalDirection = signal.direction;
  stats.lastSignalAt = Date.now();

  const ageMs = Date.now() - emitTs;
  console.log(
    `[tickStrategy] ✓ SIGNAL  ${signal.direction}  ${symbol}  ` +
    `price=${emitPrice}  age=${ageMs}ms  conf=${Math.round(signal.confidence)}`
  );

  tickBus.emit('signal', payload);
}

type TickHandler = (tick: Tick) => void | Promise<void>;
let currentHandler: TickHandler = realHandler;

/**
 * Override the per-tick handler. Useful for tests (swap in a stub)
 * and for temporarily disabling the real engine without editing
 * code. Calling with undefined restores the real handler.
 */
export function setTickHandler(handler?: TickHandler): void {
  currentHandler = handler ?? realHandler;
}

/**
 * Register the throttled tick listener on tickBus. Idempotent —
 * repeat calls are no-ops. Call once from bootTicker.
 */
export function registerTickStrategyRunner(): void {
  const g = globalThis as unknown as Record<string, boolean | undefined>;
  if (g[GLOBAL_KEY]) {
    return;
  }
  g[GLOBAL_KEY] = true;
  stats.startedAt = Date.now();

  tickBus.on('tick', (tick: Tick) => {
    stats.ticksSeen += 1;
    stats.lastTickAt = Date.now();

    // ── Gate 1: per-symbol throttle ──────────────────────────
    // Fast constant-time check. Most ticks land here during
    // normal market hours and return immediately.
    const now = Date.now();
    const last = lastRunByToken.get(tick.token) ?? 0;
    if (now - last < THROTTLE_MS) {
      stats.throttled += 1;
      return;
    }

    // ── Gate 2: per-symbol in-flight guard ───────────────────
    // Protects against overlap when a single analysis runs
    // longer than THROTTLE_MS (cold DB, expensive indicators).
    if (inFlightByToken.has(tick.token)) {
      stats.inFlightSkipped += 1;
      return;
    }

    // ── Gate 3: global concurrency cap ───────────────────────
    // Protects the database from a thundering herd when many
    // symbols update at the same millisecond (common at open).
    if (globalInFlight >= MAX_CONCURRENCY) {
      stats.concurrencyCapped += 1;
      return;
    }

    // Admitted — claim all three slots and dispatch.
    lastRunByToken.set(tick.token, now);
    inFlightByToken.add(tick.token);
    globalInFlight += 1;
    stats.analyzed += 1;

    // Fire-and-forget — blocking the bus on a slow strategy
    // would stall every other symbol. The .finally() block is
    // essential: without it, a thrown handler would leak the
    // in-flight slot forever.
    Promise.resolve(currentHandler(tick))
      .catch((err) => {
        stats.errors += 1;
        console.error(
          `[tickStrategy] handler error on token=${tick.token}:`,
          err?.message,
        );
      })
      .finally(() => {
        inFlightByToken.delete(tick.token);
        globalInFlight -= 1;
      });
  });

  console.log(
    `[tickStrategy] registered  throttle=${THROTTLE_MS}ms  ` +
    `concurrency=${MAX_CONCURRENCY}  ` +
    `log=${process.env.TICK_STRATEGY_LOG === '1' ? 'on' : 'off'}`
  );
}

export function getRunnerStats() {
  return {
    ...stats,
    throttleMs: THROTTLE_MS,
    maxConcurrency: MAX_CONCURRENCY,
    tokensTracked: lastRunByToken.size,
    globalInFlight,
    uptimeMs: stats.startedAt ? Date.now() - stats.startedAt : 0,
  };
}
