// ════════════════════════════════════════════════════════════════
//  exampleConsumer — reference implementation for tick consumers
//
//  This file is documentation-as-code. It shows the ONE correct
//  way a downstream module should hook into the live feed:
//
//    1. Call installTickFreshnessGuard() once at boot so the
//       staleness verdict is available to everyone.
//    2. Subscribe via `tickBus.on('tick', handler)` — NEVER poll
//       the ticker in a setInterval. Ticks are pushed.
//    3. Inside the handler, do O(1) work keyed by symbol. Never
//       iterate the subscribed universe per tick.
//    4. Before acting on a tick (placing an order, mutating
//       persistent state), call assertFreshMarketData() so a
//       momentarily dead feed can't leak into decisions.
//    5. Return the unsubscribe function from your start() so
//       tests and HMR can tear the consumer down cleanly.
//
//  Copy this file as a starting point for new consumers; do not
//  import `exampleConsumer` from production code.
// ════════════════════════════════════════════════════════════════

import { tickBus } from './tickBus';
import { getTicker } from './kiteTicker';
import {
  installTickFreshnessGuard,
  assertFreshMarketData,
  MarketStaleError,
} from './tickFreshnessGuard';
import type { TickData, Signal } from './tickTypes';
import { logger } from '@/lib/logger';

const log = logger.child({ component: 'exampleConsumer' });

type SignalHandler = (signal: Signal) => void;

export interface ExampleConsumerOptions {
  /** Symbols the consumer cares about. Tick events for other symbols are skipped in O(1). */
  watch: string[];
  /** % move from the session open that should fire a demo BUY signal. */
  breakoutPct?: number;
  /** Where to send emitted signals. Defaults to console.log. */
  onSignal?: SignalHandler;
}

/**
 * Start the example consumer. Returns an async `stop()` that
 * removes the listener. Idempotent only in the sense that each
 * call adds ONE listener — call stop() before restarting.
 */
export async function startExampleConsumer(
  opts: ExampleConsumerOptions,
): Promise<() => void> {
  const watchSet = new Set(opts.watch.map((s) => s.trim().toUpperCase()));
  const breakoutPct = opts.breakoutPct ?? 1.0;
  const emit: SignalHandler =
    opts.onSignal ??
    ((s) => console.log(`[exampleConsumer] signal ${s.side} ${s.symbol} @${s.price} (${s.strategy})`));

  // 1. Make sure staleness tracking is running. Idempotent.
  installTickFreshnessGuard();

  // 2. Ensure the ticker is subscribed to the symbols we care about.
  //    Ticker.subscribeSymbols() is itself idempotent — only new
  //    tokens hit the wire, known ones are no-ops.
  const ticker = getTicker();
  const { resolved, unknown } = await ticker.subscribeSymbols(opts.watch, 'quote');
  console.log(
    `[exampleConsumer] started  watching=${resolved.length}  unknown=${unknown.length}`,
  );

  // 3. Per-symbol memory. One entry, O(1) write per tick.
  //    We track the session open (first observed `open` field) so
  //    the breakout check is a single subtraction, not a rolling
  //    window iteration.
  const sessionOpen = new Map<string, number>();
  const alreadyFired = new Set<string>();

  // 4. Event-driven handler. No loops over the universe.
  const handler = (tick: TickData): void => {
    const sym = tick.symbol;
    if (!sym || !watchSet.has(sym)) return;

    // Record session open the first time we see it.
    if (tick.open != null && !sessionOpen.has(sym)) {
      sessionOpen.set(sym, tick.open);
    }

    if (alreadyFired.has(sym)) return;

    const open = sessionOpen.get(sym);
    if (open == null || open <= 0) return;

    const pct = ((tick.lastPrice - open) / open) * 100;
    if (pct < breakoutPct) return;

    // 5. Gate the emission on live market data. If the feed
    //    happens to be stale RIGHT NOW (socket flapped, token
    //    died), don't route the signal — we'd be acting on
    //    last-known state, not live state.
    try {
      assertFreshMarketData();
    } catch (err) {
      if (err instanceof MarketStaleError) {
        console.warn(
          `[exampleConsumer] suppressed ${sym} — ${err.freshness.state} (${err.freshness.reason})`,
        );
        return;
      }
      throw err;
    }

    alreadyFired.add(sym);
    const signal: Signal = {
      symbol:     sym,
      side:       'BUY',
      price:      tick.lastPrice,
      ts:         tick.ts,
      strategy:   'example-breakout',
      confidence: Math.min(1, pct / (breakoutPct * 2)),
    };
    emit(signal);
  };

  tickBus.on('tick', handler);

  // 6. Teardown — critical for tests and dev HMR.
  return () => {
    tickBus.off('tick', handler);
    console.log('[exampleConsumer] stopped');
  };
}
