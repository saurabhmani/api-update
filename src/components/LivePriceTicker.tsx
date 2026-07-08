'use client';

import { useEffect, useRef, useState } from 'react';
import { useLivePrice } from '@/lib/hooks/useLivePrice';
import MarketStreamStatus from '@/components/ui/MarketStreamStatus';

export interface LivePriceTickerProps {
  symbol: string;
  className?: string;
  size?: 'sm' | 'lg';
  throttleMs?: number;
}

type FlashDirection = 'up' | 'down' | null;

export function LivePriceTicker({
  symbol,
  className,
  size = 'lg',
  throttleMs = 150,
}: LivePriceTickerProps) {
  const { live, connected, lastAt } = useLivePrice(symbol, { throttleMs });
  const [flash, setFlash] = useState<FlashDirection>(null);
  const prevPriceRef = useRef<number | null>(null);
  const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const price = live?.price ?? null;
  const pChange = live?.pChange ?? null;

  useEffect(() => {
    if (price == null) return;
    const prev = prevPriceRef.current;
    if (prev != null && price !== prev) {
      setFlash(price > prev ? 'up' : 'down');
      if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
      flashTimerRef.current = setTimeout(() => setFlash(null), 600);
    }
    prevPriceRef.current = price;
  }, [price]);

  useEffect(() => () => {
    if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
  }, []);

  if (price == null) {
    return <span className={`ltp-loading ${className ?? ''}`}>—</span>;
  }

  const flashClass = flash === 'up' ? 'ltp-up' : flash === 'down' ? 'ltp-down' : '';
  const pctClass   = pChange == null ? '' : pChange >= 0 ? 'ltp-positive' : 'ltp-negative';
  const stale = lastAt != null && Date.now() - lastAt > 15_000;

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
      <MarketStreamStatus
        status={connected ? 'connected' : 'disconnected'}
        lastAt={lastAt}
      />
      {stale && <span className="ltp-badge ltp-badge-warn">stale</span>}

      <style jsx>{`
        .ltp-loading { color: #94a3b8; font-weight: 600; }
        .ltp-root {
          display: inline-flex; align-items: center; gap: 10px;
          padding: 4px 10px; border-radius: 6px;
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
          font-size: 10px; padding: 2px 7px; border-radius: 999px;
          font-weight: 700; letter-spacing: 0.4px; text-transform: uppercase;
        }
        .ltp-badge-warn { background: #fee2e2; color: #991b1b; }
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
