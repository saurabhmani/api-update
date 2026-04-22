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
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Fetch ticker data ──────────────────────────────────────────
  const fetchTicker = useCallback(async () => {
    try {
      const res  = await fetch(`/api/ticker?limit=${limit}`, { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const incoming: TickerItem[] = data.items ?? [];
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

  return (
    <div
      className="ticker"
      aria-label="Live market ticker"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={()    => setPaused(true)}
      onBlur={()     => setPaused(false)}
    >
      {/* Label badge */}
      <div className="ticker__label" aria-hidden="true">
        <span className="ticker__dot" />
        LIVE
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
