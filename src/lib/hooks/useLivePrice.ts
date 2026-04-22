// ════════════════════════════════════════════════════════════════
//  useLivePrice — single-symbol wrapper around useLivePrices
//
//  Why not just call `useLivePrices().prices.get(sym)` in every
//  component? Two reasons:
//    1. Hot names (RELIANCE, NIFTYBEES) can tick 10–20×/sec. Layout-
//       heavy components shouldn't reflow that often — we trailing-
//       throttle to cap render cadence at ~throttleMs.
//    2. Keeps the "connected / stale / source" concerns in one hook
//       so every live component renders the same status semantics.
//
//  NOTE on throttle vs. debounce: this is a TRAILING THROTTLE, not a
//  debounce. A true debounce waits for a quiet period, which hides
//  the latest tick indefinitely when ticks keep arriving faster than
//  the window. Throttle guarantees the UI sees the latest value at
//  least once per window — the correct behaviour for live prices.
// ════════════════════════════════════════════════════════════════

'use client';

import { useEffect, useRef, useState } from 'react';
import { useLivePrices, type LivePrice } from './useLivePrices';

interface Options {
  /** Trailing throttle window in ms. 0 = no throttle. Default 150. */
  throttleMs?: number;
  /**
   * If true (default), POST to /api/market-data/subscribe on mount
   * and heartbeat every HEARTBEAT_MS so the ticker subscribes THIS
   * symbol even when it isn't in the q365_signals hot universe.
   * Set to false for symbols you know are already subscribed
   * (e.g. rows inside the /signals page).
   */
  autoSubscribe?: boolean;
}

// Heartbeat interval — must be less than the server-side view-demand
// TTL (default 120s). 60s gives one safety cycle if a single request
// fails, without being chatty.
const HEARTBEAT_MS = 60_000;

async function requestSubscribe(symbol: string): Promise<void> {
  try {
    await fetch('/api/market-data/subscribe', {
      method:  'POST',
      headers: { 'content-type': 'application/json' },
      // credentials:'same-origin' is the default for same-origin POSTs,
      // so the q200_session cookie rides along; middleware lets the
      // request through because we have a valid session.
      body:    JSON.stringify({ symbols: [symbol] }),
      keepalive: true,
    });
  } catch { /* network errors are non-fatal — next heartbeat will retry */ }
}

export interface UseLivePriceResult {
  /** Latest tick for this symbol, or null until the first frame lands. */
  live:      LivePrice | null;
  /** True while the WS is OPEN. */
  connected: boolean;
  /** Timestamp (ms) of the last frame received across ALL symbols. */
  lastAt:    number | null;
}

export function useLivePrice(
  symbol: string | null | undefined,
  opts: Options = {},
): UseLivePriceResult {
  const throttleMs    = Math.max(0, opts.throttleMs ?? 150);
  const autoSubscribe = opts.autoSubscribe ?? true;
  const { prices, connected, lastAt } = useLivePrices();

  const key = (symbol ?? '').toUpperCase();
  const fresh = key ? prices.get(key) ?? null : null;

  // ── Ensure the ticker is subscribed to THIS symbol ───────────
  // Without this, a symbol not in q365_signals (e.g. arbitrary
  // stock detail page, watchlist row) never ticks and `fresh`
  // stays null forever.
  useEffect(() => {
    if (!autoSubscribe || !key) return;
    // Fire immediately on mount / symbol change.
    void requestSubscribe(key);
    // Then heartbeat so the view-demand TTL (120s server-side)
    // doesn't expire while the component is still visible.
    const id = setInterval(() => { void requestSubscribe(key); }, HEARTBEAT_MS);
    return () => clearInterval(id);
  }, [key, autoSubscribe]);

  const [throttled, setThrottled] = useState<LivePrice | null>(fresh);
  const pendingRef   = useRef<LivePrice | null>(fresh);
  const timerRef     = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastEmitRef  = useRef<number>(0);

  useEffect(() => {
    // Symbol cleared or no frame yet — pass through.
    if (!fresh) {
      pendingRef.current = null;
      setThrottled(null);
      return;
    }
    pendingRef.current = fresh;

    if (throttleMs === 0) {
      lastEmitRef.current = Date.now();
      setThrottled(fresh);
      return;
    }

    const since = Date.now() - lastEmitRef.current;
    if (since >= throttleMs) {
      lastEmitRef.current = Date.now();
      setThrottled(fresh);
      return;
    }
    // Already inside the window — schedule a trailing flush if one
    // isn't already queued. The flush picks whatever is latest in
    // pendingRef, so bursts inside the window collapse to one render.
    if (timerRef.current) return;
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      lastEmitRef.current = Date.now();
      setThrottled(pendingRef.current);
    }, throttleMs - since);
  }, [fresh, throttleMs]);

  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current);
  }, []);

  return { live: throttled, connected, lastAt };
}
