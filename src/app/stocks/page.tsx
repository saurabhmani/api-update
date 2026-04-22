// ════════════════════════════════════════════════════════════════
//  /stocks — hybrid market-data showcase
//
//  Wires the full loop-based system end-to-end:
//    useStockBot (1-Hz poll of /api/market-data/bot)
//      + useLivePrices merge (~25 ms WS push) [inside the hook]
//      → StockCard × N         (animated per-symbol cards)
//      + BotIndicator          (single header bot, system-wide status)
//
//  Symbols are taken from ?symbols=A,B,C in the URL, or fall back to
//  a sensible NIFTY-50 sample if not provided.
// ════════════════════════════════════════════════════════════════

'use client';

import { useMemo } from 'react';
import { useSearchParams } from 'next/navigation';
import { useStockBot } from '@/lib/hooks/useStockBot';
import BotIndicator from '@/components/stock/BotIndicator';
import FloatingBotIndicator from '@/components/stock/FloatingBotIndicator';
import StockCard from '@/components/stock/StockCard';

const DEFAULT_SYMBOLS = [
  'RELIANCE', 'TCS', 'INFY', 'HDFCBANK', 'ICICIBANK',
  'SBIN', 'LUPIN', 'ITC', 'AXISBANK', 'LT',
  'BHARTIARTL', 'HINDUNILVR', 'MARUTI', 'KOTAKBANK', 'BAJFINANCE',
];

export default function StocksPage() {
  const sp = useSearchParams();
  const symbols = useMemo(() => {
    const q = sp?.get('symbols');
    if (q) return q.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
    return DEFAULT_SYMBOLS;
  }, [sp]);

  const { entries, overall, marketOpen, lastFetchAt, error, loading } = useStockBot(symbols);

  const counts = {
    LIVE:    0,
    DELAYED: 0,
    CLOSED:  0,
    STALE:   0,
    OFFLINE: 0,
  };
  for (const e of entries.values()) counts[e.status] += 1;

  // Figure out current source for the floating badge — take the
  // modal source across entries (kite wins ties, then yahoo, none).
  const srcTally = { kite: 0, yahoo: 0, none: 0 };
  for (const e of entries.values()) srcTally[e.source] += 1;
  const floatingSource: 'kite' | 'yahoo' | 'none' =
    srcTally.kite >= srcTally.yahoo && srcTally.kite > 0 ? 'kite' :
    srcTally.yahoo > 0                                   ? 'yahoo' :
    'none';

  return (
    <div className="page">
      {/* Floating status badge — glassmorphic, fixed top-right, mobile-friendly */}
      <FloatingBotIndicator
        status={overall}
        counts={counts}
        lastUpdated={lastFetchAt}
        source={floatingSource}
      />
      <header className="topbar">
        <div className="title">
          <h1>Live Market</h1>
          <span className="subtitle">
            {marketOpen ? 'Market Open' : 'Market Closed'}
            {lastFetchAt ? ` · updated ${new Date(lastFetchAt).toLocaleTimeString()}` : ''}
          </span>
        </div>
        <BotIndicator status={overall} counts={counts} />
      </header>

      {error && (
        <div className="banner err">Error: {error}</div>
      )}

      <section className="grid">
        {symbols.map((sym) => {
          const entry = entries.get(sym) ?? {
            symbol: sym,
            price: null,
            change: null,
            pChange: null,
            close: null,
            source: 'none' as const,
            status: loading ? ('STALE' as const) : ('OFFLINE' as const),
            lastUpdated: Date.now(),
            ageMs: null,
          };
          return <StockCard key={sym} entry={entry} />;
        })}
      </section>

      <footer className="footer">
        <span>
          Symbols: {symbols.length} · LIVE {counts.LIVE} ·
          DELAYED {counts.DELAYED} · CLOSED {counts.CLOSED} ·
          OFFLINE {counts.OFFLINE}
        </span>
      </footer>

      <style jsx>{`
        .page {
          padding: 24px;
          max-width: 1280px;
          margin: 0 auto;
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
          color: #0F172A;
        }
        .topbar {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 8px 0 20px;
          border-bottom: 1px solid #E2E8F0;
          margin-bottom: 20px;
        }
        .title h1 {
          margin: 0;
          font-size: 22px;
          font-weight: 800;
          letter-spacing: -0.3px;
        }
        .subtitle {
          font-size: 12px;
          color: #64748B;
          margin-top: 2px;
          display: block;
        }
        .banner.err {
          padding: 10px 14px;
          border-radius: 8px;
          background: #FEE2E2;
          color: #7F1D1D;
          border: 1px solid #FCA5A5;
          margin-bottom: 16px;
          font-size: 13px;
        }
        .grid {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
          gap: 14px;
        }
        .footer {
          margin-top: 24px;
          padding-top: 16px;
          border-top: 1px solid #E2E8F0;
          font-size: 12px;
          color: #64748B;
          letter-spacing: 0.3px;
        }
      `}</style>
    </div>
  );
}
