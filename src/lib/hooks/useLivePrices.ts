// ════════════════════════════════════════════════════════════════
//  useLivePrices — React hook subscribing to the streamServer WS
//
//  Replaces the old `setInterval(fetch('/api/stocks'), 1000)` and
//  `setInterval(fetch('/api/signals'), 2000)` polls. Connects once
//  per component, receives push frames, exposes a Map keyed by
//  tradingsymbol. Auto-reconnects on drop with exponential backoff.
//
//  Usage:
//    const { prices, connected } = useLivePrices();
//    const live = prices.get('RELIANCE'); // { price, pChange, ... }
// ════════════════════════════════════════════════════════════════

'use client';

import { useEffect, useRef, useState, useCallback } from 'react';

export type LivePrice = {
  symbol:  string;
  price:   number | null;
  change:  number | null;
  pChange: number | null;
  /** Previous-day close from Kite's ohlc.close. Used by the UI to
   *  recompute day-change as (price - close) / close so the displayed
   *  percent is always derived from the canonical reference price,
   *  not from a stale mid-session snapshot that may read 0.00%. */
  close?:  number | null;
  source:  string;
  ts:      number;
};

/**
 * Composite mode used by the UI status banner. Derived from three
 * inputs so a single enum covers every realistic state:
 *   - marketOpen      (NSE session flag from the health endpoint)
 *   - source          ('kite' | 'yahoo' | 'none' from the server)
 *   - last frame age  (lastAt from the WS — proves data IS flowing)
 *
 * States:
 *   'KITE_LIVE'       Market open, real-time Kite ticks in last 10s
 *   'YAHOO_FALLBACK'  Market open, Yahoo poll is carrying the feed
 *   'MARKET_CLOSED'   Outside NSE session (weekend, holiday, after
 *                     hours) — expected silence, NOT a failure
 *   'WAITING'         Market open, WS connected, no ticks yet
 *   'DISCONNECTED'    Browser can't reach the stream server
 */
export type LiveMode =
  | 'KITE_LIVE'
  | 'YAHOO_FALLBACK'
  | 'MARKET_CLOSED'
  | 'WAITING'
  | 'DISCONNECTED';

export interface UseLivePricesResult {
  /** Map keyed by UPPERCASE symbol → most recent frame */
  prices:    Map<string, LivePrice>;
  /** True while the WebSocket is in OPEN state */
  connected: boolean;
  /** Timestamp of the last frame received (ms), or null */
  lastAt:    number | null;

  // ── Market awareness (polled from /api/market-data/health) ──
  /** True during NSE regular session (09:15–15:30 IST, weekdays). */
  marketOpen:  boolean;
  /** Human-readable label from the server ("Market Open", "Market Closed (Weekend)", etc.) */
  marketLabel: string;
  /** What's currently feeding the bus server-side, or null pre-probe. */
  source:      'kite' | 'yahoo' | 'none' | null;
  /** Composite UI state — drives the status banner. */
  mode:        LiveMode;
}

function resolveWsUrl(): string {
  // Resolution order:
  //   1. NEXT_PUBLIC_STREAM_WS_URL (full override, e.g. wss://quantorus.in/ws)
  //   2. HTTPS page → wss://<host>/ws  (proxied by nginx to localhost:3001)
  //   3. HTTP  page → ws://<host>:<port>  (direct, dev mode)
  //
  // Browser default port is 3001 — matches STREAM_WS_PORT=3001 in the
  // project's .env.local. If you change the server-side STREAM_WS_PORT
  // also set NEXT_PUBLIC_STREAM_WS_PORT to the same value so the
  // browser connects to the right port.
  const override = process.env.NEXT_PUBLIC_STREAM_WS_URL;
  if (override) return override;

  if (typeof window === 'undefined') {
    const devPort = process.env.NEXT_PUBLIC_STREAM_WS_PORT ?? '3001';
    return `ws://localhost:${devPort}`;
  }

  const isHttps = window.location.protocol === 'https:';
  const host    = window.location.hostname;
  if (isHttps) {
    // wss on the same port as the page (443) routed via /ws path.
    return `wss://${host}/ws`;
  }
  // Plain HTTP (local dev) — direct connect to the WS port.
  // Default 3001 matches STREAM_WS_PORT=3001 in .env.local.
  const devPort = process.env.NEXT_PUBLIC_STREAM_WS_PORT ?? '3001';
  return `ws://${host}:${devPort}`;
}

// Cadence for the health poll. We keep this cheap (server endpoint
// is in-memory, no DB) and rely on the composite mode shifting
// within one cycle of market transitions. 5s is well under the 30s
// stale threshold, so "Kite went silent" is reflected in the UI
// within ~one poll. Overrideable for tests.
const HEALTH_POLL_MS =
  Number(process.env.NEXT_PUBLIC_HEALTH_POLL_MS) || 5_000;

// A tick is considered "fresh enough to mean real-time" when its
// age is under this threshold. Matches the server-side FRESH_MS (3s)
// with a generous UI margin for network jitter.
const LIVE_FRESH_MS = 10_000;

export function useLivePrices(): UseLivePricesResult {
  const [prices,    setPrices]    = useState<Map<string, LivePrice>>(() => new Map());
  const [connected, setConnected] = useState(false);
  const [lastAt,    setLastAt]    = useState<number | null>(null);

  // Server-side market + feed state, polled on a cheap interval.
  // null source === "haven't probed yet"; treated as WAITING.
  const [marketOpen,  setMarketOpen]  = useState(false);
  const [marketLabel, setMarketLabel] = useState('Loading…');
  const [source, setSource] = useState<'kite' | 'yahoo' | 'none' | null>(null);

  // `now` ticks every second so the derived `mode` re-evaluates
  // without a separate interval in the consumer. 1s is plenty —
  // the LIVE_FRESH_MS window is 10s.
  const [now, setNow] = useState(() => Date.now());

  const socketRef    = useRef<WebSocket | null>(null);
  const reconnectRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const attemptRef   = useRef(0);
  const closedByEffect = useRef(false);

  const connect = useCallback(() => {
    if (closedByEffect.current) return;
    const url = resolveWsUrl();
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch (err) {
      void err;
      scheduleReconnect();
      return;
    }
    socketRef.current = ws;

    ws.onopen = () => {
      attemptRef.current = 0;
      setConnected(true);
    };

    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        // Two frame types from streamServer:
        //   'prices'      — per-batch delta, fires every ~1s (MERGE)
        //   'FULL_UPDATE' — end-of-sweep snapshot with every symbol
        //                   (REPLACE, authoritative)
        const isFull  = msg?.type === 'FULL_UPDATE';
        const isDelta = msg?.type === 'prices';
        if (!isFull && !isDelta) return;
        if (!Array.isArray(msg.data)) return;

        const frames = msg.data as LivePrice[];
        const now = Date.now();

        setPrices((prev) => {
          // FULL_UPDATE is authoritative → rebuild from scratch so we
          // never carry stale symbols across sweeps. Delta frames
          // merge into the existing Map so incremental batches
          // accumulate until the next FULL_UPDATE arrives.
          const next = isFull ? new Map<string, LivePrice>() : new Map(prev);
          for (const f of frames) {
            if (!f?.symbol) continue;
            next.set(f.symbol.toUpperCase(), f);
          }
          return next;
        });
        setLastAt(now);
      } catch { /* swallow malformed frame */ }
    };

    ws.onerror = () => {
      // onerror fires right before onclose; no need to log both.
    };

    ws.onclose = () => {
      setConnected(false);
      socketRef.current = null;
      scheduleReconnect();
    };
  }, []);

  const scheduleReconnect = useCallback(() => {
    if (closedByEffect.current) return;
    if (reconnectRef.current) clearTimeout(reconnectRef.current);
    const n = ++attemptRef.current;
    // 1s, 2s, 4s, 8s … capped at 15s
    const delay = Math.min(15_000, 1_000 * 2 ** Math.min(4, n - 1));
    reconnectRef.current = setTimeout(() => connect(), delay);
  }, [connect]);

  useEffect(() => {
    closedByEffect.current = false;
    connect();
    return () => {
      closedByEffect.current = true;
      if (reconnectRef.current) clearTimeout(reconnectRef.current);
      const ws = socketRef.current;
      if (ws) {
        try { ws.close(); } catch { /* ignore */ }
      }
      socketRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Health poll: market open/closed + active feed source ─────
  // Server side already owns the truth (getMarketDataHealth). We
  // pull it on a 5s interval so the UI can tell "Kite silent because
  // market closed" from "Kite silent because something broke" — and
  // so the mode auto-switches to KITE_LIVE the moment the first tick
  // arrives at the open. The fetch is in-memory on the server; no DB.
  useEffect(() => {
    let cancelled = false;

    const poll = async () => {
      try {
        const res = await fetch('/api/market-data/health', { cache: 'no-store' });
        // 503 is returned on FAIL but the body is still parseable and
        // carries the same shape; don't early-return on non-2xx.
        const j = await res.json().catch(() => null);
        if (cancelled || !j) return;
        if (j.market && typeof j.market.isOpen === 'boolean') {
          setMarketOpen(j.market.isOpen);
        }
        if (j.market && typeof j.market.label === 'string') {
          setMarketLabel(j.market.label);
        }
        if (j.source === 'kite' || j.source === 'yahoo' || j.source === 'none') {
          setSource(j.source);
        }
      } catch { /* network blip — try again next tick */ }
    };

    poll();
    const id = setInterval(poll, HEALTH_POLL_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  // 1Hz clock that keeps the derived `mode` from freezing on a
  // frame-less second. Cheap — a single setState per tab per second.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(id);
  }, []);

  // ── Derived composite mode ───────────────────────────────────
  // Priority ladder (highest wins) — Kite-first policy:
  //   1. WS not connected                → DISCONNECTED
  //   2. Server reports source='yahoo'   → YAHOO_FALLBACK  (UI label: "Delayed")
  //      NOTE: Yahoo can only appear after market close (when Kite
  //      cache + EOD both missed). It must beat MARKET_CLOSED so
  //      the UI shows "Delayed" instead of "Last Close", because
  //      the data is NOT Kite-sourced in this narrow case.
  //   3. Market closed                   → MARKET_CLOSED   (UI label: "Last Close")
  //      Data is source='kite' from cached tick OR EOD VIEW.
  //   4. Fresh frame within LIVE_FRESH_MS → KITE_LIVE      (UI label: "LIVE")
  //   5. Otherwise                       → WAITING
  let mode: LiveMode;
  if (!connected) {
    mode = 'DISCONNECTED';
  } else if (source === 'yahoo') {
    mode = 'YAHOO_FALLBACK';
  } else if (!marketOpen) {
    mode = 'MARKET_CLOSED';
  } else if (lastAt != null && now - lastAt <= LIVE_FRESH_MS) {
    mode = 'KITE_LIVE';
  } else {
    mode = 'WAITING';
  }

  return {
    prices,
    connected,
    lastAt,
    marketOpen,
    marketLabel,
    source,
    mode,
  };
}
