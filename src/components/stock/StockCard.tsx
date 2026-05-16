// ════════════════════════════════════════════════════════════════
//  StockCard — animated price card for one symbol.
//
//  Input: a StockBotEntry (from useStockBot).
//  Renders: symbol, price, change%, source badge, status ring.
//
//  Animations:
//    LIVE    (Yahoo)  — green/red flash on price tick, pulse ring
//    DELAYED (Yahoo)  — amber glow, "Delayed" badge, soft pulse
//    CLOSED           — grey, "Market Closed", no flashing
//    OFFLINE          — red muted, "No data"
//
//  Pure styled-jsx, no external CSS dep.
// ════════════════════════════════════════════════════════════════

'use client';

import React, { useEffect, useRef, useState } from 'react';
import type { StockBotEntry } from '@/lib/hooks/useStockBot';

type Flash = 'up' | 'down' | null;

interface Palette {
  bg: string;        ring: string;
  border: string;    badgeBg: string;
  badgeText: string; label: string;
}

function palette(status: StockBotEntry['status']): Palette {
  switch (status) {
    case 'LIVE':
      return { bg: '#F0FDF4', ring: 'rgba(34,197,94,0.35)', border: '#10B981', badgeBg: '#10B981', badgeText: '#fff',     label: 'LIVE (Yahoo)' };
    case 'DELAYED':
      return { bg: '#FFFBEB', ring: 'rgba(245,158,11,0.35)', border: '#F59E0B', badgeBg: '#F59E0B', badgeText: '#fff',     label: 'DELAYED (Yahoo)' };
    case 'CLOSED':
      return { bg: '#F8FAFC', ring: 'transparent',           border: '#94A3B8', badgeBg: '#CBD5E1', badgeText: '#334155', label: 'MARKET CLOSED' };
    case 'STALE':
      return { bg: '#F8FAFC', ring: 'transparent',           border: '#94A3B8', badgeBg: '#CBD5E1', badgeText: '#334155', label: 'LAST CLOSE' };
    case 'OFFLINE':
      return { bg: '#FEF2F2', ring: 'rgba(239,68,68,0.30)', border: '#EF4444', badgeBg: '#EF4444', badgeText: '#fff',     label: 'NO DATA' };
  }
}

const FLASH_MS = 600;

export default function StockCard({ entry }: { entry: StockBotEntry }): React.ReactElement {
  const prevPrice = useRef<number | null>(null);
  const [flash, setFlash] = useState<Flash>(null);

  useEffect(() => {
    if (entry.price == null) return;
    const prev = prevPrice.current;
    if (prev != null && prev !== entry.price) {
      setFlash(entry.price > prev ? 'up' : 'down');
      const t = setTimeout(() => setFlash(null), FLASH_MS);
      return () => clearTimeout(t);
    }
    prevPrice.current = entry.price;
  }, [entry.price]);

  const p = palette(entry.status);
  const cls = `card status-${entry.status.toLowerCase()}${flash ? ` flash-${flash}` : ''}`;
  const priceStr = entry.price != null
    ? entry.price.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : '—';
  const pch = entry.pChange;
  const pchStr = pch != null
    ? `${pch >= 0 ? '+' : ''}${pch.toFixed(2)}%`
    : '—';
  const pchColor = pch == null ? '#64748B' : pch >= 0 ? '#16A34A' : '#DC2626';

  return (
    <div className={cls}>
      <div className="header">
        <div className="symbol">{entry.symbol}</div>
        <div className="badge" style={{ background: p.badgeBg, color: p.badgeText }}>
          {p.label}
        </div>
      </div>

      <div className="price" style={{ color: flash === 'up' ? '#16A34A' : flash === 'down' ? '#DC2626' : '#0F172A' }}>
        ₹{priceStr}
      </div>

      <div className="meta">
        <span className="pChange" style={{ color: pchColor }}>{pchStr}</span>
        <span className="dot" />
        <span className="source">via {entry.source}</span>
      </div>

      <span className="ring" aria-hidden />

      <style jsx>{`
        .card {
          position: relative;
          padding: 14px 16px;
          border-radius: 12px;
          border: 1.5px solid ${p.border};
          background: ${p.bg};
          min-width: 160px;
          box-shadow: 0 1px 2px rgba(15,23,42,0.06);
          overflow: hidden;
          transition: transform 220ms ease, box-shadow 220ms ease;
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        }
        .card:hover { transform: translateY(-1px); box-shadow: 0 4px 12px rgba(15,23,42,0.10); }

        .ring {
          position: absolute;
          inset: -2px;
          border-radius: 14px;
          pointer-events: none;
          background: radial-gradient(closest-side, ${p.ring}, transparent 70%);
          opacity: 0;
        }
        .status-live    .ring { animation: liveRing 1.4s ease-out infinite; opacity: 1; }
        .status-delayed .ring { animation: delayedRing 2.2s ease-in-out infinite; opacity: 1; }
        .status-offline .ring { animation: offlineRing 1.1s ease-in-out infinite; opacity: 1; }

        .header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          gap: 8px;
        }
        .symbol {
          font-weight: 800;
          font-size: 13px;
          letter-spacing: 0.5px;
          color: #0F172A;
        }
        .badge {
          font-size: 9px;
          font-weight: 700;
          padding: 2px 7px;
          border-radius: 10px;
          text-transform: uppercase;
          letter-spacing: 0.4px;
          white-space: nowrap;
        }
        .price {
          margin-top: 10px;
          font-size: 24px;
          font-weight: 800;
          letter-spacing: -0.3px;
          transition: color 200ms ease, transform 200ms ease;
          font-variant-numeric: tabular-nums;
        }
        .flash-up   .price { animation: flashUp   ${FLASH_MS}ms ease-out; }
        .flash-down .price { animation: flashDown ${FLASH_MS}ms ease-out; }

        .meta {
          margin-top: 6px;
          display: flex;
          align-items: center;
          gap: 8px;
          font-size: 12px;
        }
        .pChange { font-weight: 700; font-variant-numeric: tabular-nums; }
        .dot {
          width: 3px;
          height: 3px;
          border-radius: 50%;
          background: #CBD5E1;
        }
        .source {
          color: #64748B;
          font-size: 11px;
          text-transform: uppercase;
          letter-spacing: 0.4px;
        }

        @keyframes liveRing {
          0%   { opacity: 0.7; transform: scale(1);    }
          70%  { opacity: 0;   transform: scale(1.05); }
          100% { opacity: 0;   transform: scale(1.05); }
        }
        @keyframes delayedRing {
          0%, 100% { opacity: 0.30; }
          50%      { opacity: 0.70; }
        }
        @keyframes offlineRing {
          0%, 100% { opacity: 0.20; }
          50%      { opacity: 0.55; }
        }
        @keyframes flashUp {
          0%   { background: rgba(16,185,129,0.25); transform: translateY(-1px); }
          100% { background: transparent;            transform: translateY(0);    }
        }
        @keyframes flashDown {
          0%   { background: rgba(220,38,38,0.25);  transform: translateY(1px);  }
          100% { background: transparent;            transform: translateY(0);    }
        }
      `}</style>
    </div>
  );
}
