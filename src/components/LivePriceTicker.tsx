'use client';

// ════════════════════════════════════════════════════════════════
//  LivePriceTicker — TradingView-style price pulse (polling only)
//
//  A lightweight, drop-in live-price widget for the stock detail
//  page at /market/[key]. Polls `/api/price?symbol=X` on a cadence
//  (default 5s), stores the previous price, and flashes green/red
//  for 600ms whenever the new price differs from the last tick.
//
//  Deliberate non-features:
//    - No WebSocket. Yahoo-friendly cadence; no streaming pressure.
//    - No SWR / React Query dependency. Pure React hooks — one less
//      thing to keep patched in the app's dep graph.
//    - No global cache. Each mounted instance manages its own loop;
//      two tickers on the same page make one fetch each, which is
//      fine at 5s cadence (you get 24 req/min for the whole page).
//
//  Server-load guardrails (all built in):
//    1. inFlightRef — blocks overlapping fetches if the network is
//       slow (no stampede when the user comes back from a 30s pause).
//    2. visibilitychange — pauses polling when the tab is hidden;
//       resumes with an immediate fetch when it comes back.
//    3. AbortController — in-flight request is cancelled when the
//       component unmounts or symbol changes, so navigation doesn't
//       leak requests.
//    4. Stale fallback — if Yahoo fails mid-session, we keep showing
//       the last good price and flip on a "stale" badge. The user
//       never sees "—" mid-session just because one fetch 500'd.
//
//  Usage:
//    <LivePriceTicker symbol="TITAN" />
//    <LivePriceTicker symbol="RELIANCE" refreshMs={8000} />
// ════════════════════════════════════════════════════════════════

import { useEffect, useRef, useState } from 'react';

export interface LivePriceTickerProps {
  /** Bare tradingsymbol — e.g. "TITAN", "RELIANCE". NSE:/ .NS suffixes stripped server-side. */
  symbol: string;
  /** Poll interval in ms. Default 5000. Kept between 3000-10000 to match Yahoo's tolerance. */
  refreshMs?: number;
  /** Optional className merged onto the outer container. */
  className?: string;
  /** Size preset — 'sm' for inline contexts, 'lg' for the header display on /market. */
  size?: 'sm' | 'lg';
}

interface PriceApiResponse {
  price?:   number | null;
  pChange?: number | null;
  change?:  number | null;
  source?:  'kite' | 'yahoo' | 'none' | null;
  error?:   string;
}

type FlashDirection = 'up' | 'down' | null;

export function LivePriceTicker({
  symbol,
  refreshMs = 5000,
  className,
  size = 'lg',
}: LivePriceTickerProps) {
  const [price,   setPrice]   = useState<number | null>(null);
  const [pChange, setPChange] = useState<number | null>(null);
  const [source,  setSource]  = useState<string | null>(null);
  const [flash,   setFlash]   = useState<FlashDirection>(null);
  const [stale,   setStale]   = useState<boolean>(false);

  // Refs used for behaviour that must NOT trigger a re-render.
  const prevPriceRef   = useRef<number | null>(null);
  const inFlightRef    = useRef<boolean>(false);
  const pollTimerRef   = useRef<ReturnType<typeof setInterval> | null>(null);
  const flashTimerRef  = useRef<ReturnType<typeof setTimeout>  | null>(null);
  const abortRef       = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!symbol) return;

    async function fetchPrice(): Promise<void> {
      // Guard 1: if a previous request hasn't returned yet, skip.
      // Prevents a stampede when the network briefly stalls.
      if (inFlightRef.current) return;
      inFlightRef.current = true;

      // Guard 2: abort signal per request so we don't process a
      // response that arrived AFTER the component unmounted.
      abortRef.current?.abort();
      const ctl = new AbortController();
      abortRef.current = ctl;

      try {
        const res = await fetch(
          `/api/price?symbol=${encodeURIComponent(symbol)}`,
          { cache: 'no-store', signal: ctl.signal },
        );
        if (!res.ok) {
          // 503 / 4xx — treat as stale; keep showing last good price.
          setStale(true);
          return;
        }
        const data = (await res.json()) as PriceApiResponse;
        const nextPrice = Number(data.price);
        if (!Number.isFinite(nextPrice) || nextPrice <= 0) {
          setStale(true);
          return;
        }

        setStale(false);
        setSource(data.source ?? null);
        setPChange(typeof data.pChange === 'number' ? data.pChange : null);

        // Flash logic — only fire when the price actually moved.
        // First tick (prev === null) is a silent set; no flash.
        const prev = prevPriceRef.current;
        if (prev != null && nextPrice !== prev) {
          const direction: 'up' | 'down' = nextPrice > prev ? 'up' : 'down';
          setFlash(direction);
          if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
          flashTimerRef.current = setTimeout(() => setFlash(null), 600);
        }

        prevPriceRef.current = nextPrice;
        setPrice(nextPrice);
      } catch (err: any) {
        // AbortError is expected on unmount — don't surface it.
        if (err?.name !== 'AbortError') {
          setStale(true);
        }
      } finally {
        inFlightRef.current = false;
      }
    }

    // Fire one immediately so the user sees a value without waiting
    // the full refreshMs.
    fetchPrice();

    // Steady-state polling.
    pollTimerRef.current = setInterval(fetchPrice, refreshMs);

    // Pause when the tab is hidden — most users leave a stock page
    // open in a background tab. Polling while hidden is a pure waste.
    const onVisibility = () => {
      if (document.hidden) {
        if (pollTimerRef.current) {
          clearInterval(pollTimerRef.current);
          pollTimerRef.current = null;
        }
      } else if (!pollTimerRef.current) {
        // Resume: fetch immediately so the user sees fresh data the
        // instant they come back, then resume the interval.
        fetchPrice();
        pollTimerRef.current = setInterval(fetchPrice, refreshMs);
      }
    };
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      if (pollTimerRef.current)  clearInterval(pollTimerRef.current);
      if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
      abortRef.current?.abort();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [symbol, refreshMs]);

  if (price == null) {
    return <span className={`ltp-loading ${className ?? ''}`}>—</span>;
  }

  const flashClass = flash === 'up' ? 'ltp-up' : flash === 'down' ? 'ltp-down' : '';
  const pctClass   = pChange == null ? '' : pChange >= 0 ? 'ltp-positive' : 'ltp-negative';
  const isDelayed  = source !== 'kite';

  return (
    <span className={`ltp-root ltp-${size} ${flashClass} ${className ?? ''}`}>
      <span className="ltp-price">
        ₹{price.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
      </span>
      {pChange != null && (
        <span className={`ltp-pct ${pctClass}`}>
          {pChange >= 0 ? '+' : ''}{pChange.toFixed(2)}%
        </span>
      )}
      {isDelayed && !stale && <span className="ltp-badge ltp-badge-info">delayed</span>}
      {stale && <span className="ltp-badge ltp-badge-warn">stale</span>}

      <style jsx>{`
        .ltp-loading {
          color: #94a3b8;
          font-weight: 600;
        }
        .ltp-root {
          display: inline-flex;
          align-items: center;
          gap: 10px;
          padding: 4px 10px;
          border-radius: 6px;
          font-variant-numeric: tabular-nums;
          transition: background-color 120ms ease;
        }
        .ltp-lg .ltp-price { font-size: 22px; font-weight: 800; color: #0f172a; }
        .ltp-lg .ltp-pct   { font-size: 14px; font-weight: 700; }
        .ltp-sm .ltp-price { font-size: 14px; font-weight: 700; color: #0f172a; }
        .ltp-sm .ltp-pct   { font-size: 12px; font-weight: 600; }

        .ltp-pct.ltp-positive { color: #16a34a; }
        .ltp-pct.ltp-negative { color: #dc2626; }

        .ltp-badge {
          font-size: 10px;
          padding: 2px 7px;
          border-radius: 999px;
          font-weight: 700;
          letter-spacing: 0.4px;
          text-transform: uppercase;
          line-height: 1;
        }
        .ltp-badge-info { background: #fef3c7; color: #92400e; }
        .ltp-badge-warn { background: #fee2e2; color: #991b1b; }

        /* Flash animations — whole chip pulses, not just text, so
           the movement is visible against varied row backgrounds. */
        .ltp-up   { animation: ltpFlashGreen 0.6s ease; }
        .ltp-down { animation: ltpFlashRed   0.6s ease; }
        @keyframes ltpFlashGreen {
          0%   { background-color: rgba(34, 197, 94, 0.35); }
          100% { background-color: transparent; }
        }
        @keyframes ltpFlashRed {
          0%   { background-color: rgba(239, 68, 68, 0.35); }
          100% { background-color: transparent; }
        }
      `}</style>
    </span>
  );
}
