'use client';
import { useEffect, useState, useRef, useCallback } from 'react';
import { changeClass, changeArrow, fmt }             from '@/lib/utils';
import type { TickerItem }                           from '@/app/api/ticker/route';
import '@/styles/components/_ticker.scss';

interface TickerStripProps {
  /** Override auto-refresh interval in ms. Default: 30 000 (30s). */
  refreshMs?: number;
  /** Number of symbols. Default: 30 (from API). */
  limit?: number;
}

export default function TickerStrip({
  refreshMs = 30_000,
  limit     = 30,
}: TickerStripProps) {

  const [items,   setItems]   = useState<TickerItem[]>([]);
  const [paused,  setPaused]  = useState(false);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState(false);
  // Spec MARKET-AWARENESS §3 — badge driven by the API mode. Defaults
  // to 'live' until the first fetch settles, but the loading skeleton
  // renders before that so the user never sees a stale LIVE pill on a
  // closed-market refresh.
  const [mode,        setMode]        = useState<'live' | 'market_closed'>('live');
  const [marketLabel, setMarketLabel] = useState<string>('Market Open');
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Fetch ticker data ──────────────────────────────────────────
  const fetchTicker = useCallback(async () => {
    try {
      const res  = await fetch(`/api/ticker?limit=${limit}`, { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const incoming: TickerItem[] = data.items ?? [];
      // Spec §3 — read the mode + market_label from the response so
      // the badge can never be more "live" than the API claims.
      if (data.mode === 'live' || data.mode === 'market_closed') {
        setMode(data.mode);
      }
      if (typeof data.market_label === 'string') {
        setMarketLabel(data.market_label);
      }
      if (incoming.length) {
        setItems(incoming);
        setError(false);
      }
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [limit]);

  // ── Initial load + polling ─────────────────────────────────────
  useEffect(() => {
    fetchTicker();

    const schedule = () => {
      timerRef.current = setTimeout(async () => {
        await fetchTicker();
        schedule(); // reschedule after each fetch completes
      }, refreshMs);
    };
    schedule();

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [fetchTicker, refreshMs]);

  // ── Duplicate items for seamless loop ─────────────────────────
  // CSS animation scrolls one copy off-screen while the duplicate
  // immediately replaces it — no jump or gap.
  const displayItems = [...items, ...items];

  // ── Skeleton while loading ─────────────────────────────────────
  if (loading) {
    return (
      <div className="ticker" aria-label="Loading market data…">
        <div className="ticker__loading">
          {Array.from({ length: 8 }).map((_, i) => (
            <span key={i} className="ticker__skeleton" />
          ))}
        </div>
      </div>
    );
  }

  if (error && !items.length) {
    return (
      <div className="ticker ticker--error" aria-label="Ticker unavailable">
        <span className="ticker__error-msg">Market data unavailable</span>
      </div>
    );
  }

  if (!items.length) return null;

  const isLive = mode === 'live';
  const labelText = isLive ? 'LIVE' : 'LAST CLOSE';
  return (
    <div
      className={`ticker ${isLive ? 'ticker--live' : 'ticker--closed'}`}
      aria-label={isLive ? 'Live market ticker' : `Market closed ticker (${marketLabel})`}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={()    => setPaused(true)}
      onBlur={()     => setPaused(false)}
    >
      {/* Spec §3 — label tracks /api/ticker.mode. LIVE only when the
          backend confirms regular session; otherwise LAST CLOSE
          (same item set, truthful badge). The hover title carries the
          full market label so the operator can see exactly what state
          (Pre-open / Holiday / Weekend / Post-close) we're in. */}
      <div
        className="ticker__label"
        title={marketLabel}
        style={!isLive ? { background: '#FEF3C7', color: '#92400E' } : undefined}
      >
        <span
          className="ticker__dot"
          style={!isLive ? { background: '#D97706', animation: 'none' } : undefined}
        />
        {labelText}
      </div>

      {/* Scrolling track */}
      <div className="ticker__viewport" aria-live="polite" aria-atomic="false">
        <div
          className={`ticker__track ${paused ? 'ticker__track--paused' : ''}`}
          style={{ '--item-count': items.length } as React.CSSProperties}
        >
          {displayItems.map((item, idx) => {
            const positive = item.change_percent > 0;
            const negative = item.change_percent < 0;
            return (
              <div
                key={`${item.symbol}-${idx}`}
                className="ticker__item"
                aria-label={`${item.symbol} ₹${item.ltp} ${item.change_percent > 0 ? '+' : ''}${item.change_percent.toFixed(2)}%`}
              >
                {/* Symbol */}
                <span className="ticker__symbol">{item.symbol}</span>

                {/* Price */}
                <span className="ticker__price">
                  {fmt.currency(item.ltp)}
                </span>

                {/* Change % */}
                <span className={`ticker__change ${changeClass(item.change_percent)}`}>
                  <span className="ticker__arrow" aria-hidden="true">
                    {changeArrow(item.change_percent)}
                  </span>
                  {Math.abs(item.change_percent).toFixed(2)}%
                </span>

                {/* Separator dot */}
                <span className="ticker__sep" aria-hidden="true">·</span>
              </div>
            );
          })}
        </div>
      </div>

      {/* Pause indicator */}
      {paused && (
        <div className="ticker__paused-badge" aria-hidden="true">
          ⏸ paused
        </div>
      )}
    </div>
  );
}
