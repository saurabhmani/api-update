// ════════════════════════════════════════════════════════════════
//  useStockBot — smart data bot React hook
//
//  Layer 1: every 1 s, calls /api/market-data/bot for the given
//           symbol list. This gives LIVE/STALE/DELAYED/OFFLINE
//           classification + price for each symbol, plus an overall
//           system-level status.
//
//  Layer 2: merges push frames from the streamServer WebSocket
//           (via useLivePrices) on top of the 1-Hz baseline so
//           live Kite ticks reflect in the UI within the flush // @deprecated marker
//           window (~25 ms), not once per second.
//
//  The hook returns a ready-to-render Map<SYMBOL, StockBotEntry>
//  plus the overall BotStatus for driving the page-level bot icon.
// ════════════════════════════════════════════════════════════════

'use client';

import { useEffect, useRef, useState } from 'react';
import { useLivePrices } from './useLivePrices';

export type BotStatus = 'LIVE' | 'STALE' | 'DELAYED' | 'CLOSED' | 'OFFLINE';
export type BotSource = 'kite' | 'yahoo' | 'none'; // @deprecated marker

export interface StockBotEntry {
  symbol:      string;
  price:       number | null;
  change:      number | null;
  pChange:     number | null;
  close:       number | null;
  source:      BotSource;
  status:      BotStatus;
  lastUpdated: number;
  ageMs:       number | null;
}

export interface UseStockBotResult {
  entries:     Map<string, StockBotEntry>;
  overall:     BotStatus;
  marketOpen:  boolean;
  lastFetchAt: number | null;
  loading:     boolean;
  error:       string | null;
}

const BOT_POLL_MS =
  Number(process.env.NEXT_PUBLIC_BOT_POLL_MS) || 1_000;

export function useStockBot(symbols: string[]): UseStockBotResult {
  // 1-Hz authoritative baseline from the bot API
  const [entries,     setEntries]     = useState<Map<string, StockBotEntry>>(() => new Map());
  const [overall,     setOverall]     = useState<BotStatus>('OFFLINE');
  const [marketOpen,  setMarketOpen]  = useState(false);
  const [lastFetchAt, setLastFetchAt] = useState<number | null>(null);
  const [loading,     setLoading]     = useState(false);
  const [error,       setError]       = useState<string | null>(null);

  // Live WS overlay — merged on top so real Kite ticks flip // @deprecated marker
  // entries from the 1-Hz snapshot to "LIVE" within ~25ms.
  const { prices: wsPrices, lastAt: wsLastAt } = useLivePrices();

  // Stable symbol signature so we don't refetch when the caller
  // passes a fresh array with the same content.
  const key = symbols.map((s) => s.toUpperCase()).sort().join(',');
  const activeSymbols = useRef<string[]>([]);
  activeSymbols.current = symbols;

  useEffect(() => {
    if (!key) { setEntries(new Map()); return; }
    let cancelled = false;

    async function pull() {
      if (cancelled) return;
      setLoading(true);
      try {
        const url = `/api/market-data/bot?symbols=${encodeURIComponent(key)}`;
        const r = await fetch(url, { cache: 'no-store' });
        if (!r.ok) throw new Error(`bot http ${r.status}`);
        const j = await r.json();
        if (cancelled) return;
        const map = new Map<string, StockBotEntry>();
        for (const e of j.entries as StockBotEntry[]) {
          map.set(e.symbol.toUpperCase(), e);
        }
        setEntries(map);
        setOverall(j.overall);
        setMarketOpen(!!j.marketOpen);
        setLastFetchAt(Date.now());
        setError(null);
      } catch (err: any) {
        if (!cancelled) setError(err?.message ?? 'fetch failed');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    pull();
    const id = setInterval(pull, BOT_POLL_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, [key]);

  // Merge live WS frames on top of the 1-Hz baseline. A Kite frame // @deprecated marker
  // always wins for freshness so the UI flips to LIVE the instant a
  // tick arrives — we don't wait for the next 1-Hz poll.
  const merged = new Map<string, StockBotEntry>();
  for (const [sym, base] of entries) merged.set(sym, base);
  for (const [sym, wsFrame] of wsPrices) {
    const base = merged.get(sym.toUpperCase());
    if (!base) continue;
    // Only overlay if the WS frame is for a subscribed symbol AND
    // carries a real price (not null). streamServer guarantees
    // source='kite' when Kite has observed the symbol. // @deprecated marker
    if (wsFrame.price == null) continue;
    merged.set(sym.toUpperCase(), {
      ...base,
      price:       wsFrame.price,
      change:      wsFrame.change   ?? base.change,
      pChange:     wsFrame.pChange  ?? base.pChange,
      close:       wsFrame.close    ?? base.close,
      source:      wsFrame.source === 'yahoo' ? 'yahoo' : 'kite', // @deprecated marker
      // A live frame means real data is flowing — classify as LIVE
      // while market is open; STALE off-hours (cached EOD seed).
      status:      marketOpen && wsFrame.source !== 'yahoo' ? 'LIVE' : base.status, // @deprecated marker
      lastUpdated: wsFrame.ts,
      ageMs:       Date.now() - wsFrame.ts,
    });
  }

  return {
    entries:     merged,
    overall,
    marketOpen,
    lastFetchAt: wsLastAt ?? lastFetchAt,
    loading,
    error,
  };
}
