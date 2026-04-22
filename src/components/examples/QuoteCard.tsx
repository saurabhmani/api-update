'use client';
// ════════════════════════════════════════════════════════════════
//  QuoteCard — reference frontend integration
//
//  Rules this component demonstrates:
//    • UI NEVER calls IndianAPI or Yahoo directly.
//    • UI NEVER imports MarketDataProvider (server-only code).
//    • UI ONLY fetches /api/market/quote?symbol=... and reads the
//      envelope { data, source, data_quality, fetched_at }.
//    • Styling is SCSS modules — no Tailwind.
// ════════════════════════════════════════════════════════════════

import { useEffect, useState } from 'react';
import styles from './QuoteCard.module.scss';
import type { MarketSnapshot, ProviderResponse } from '@/types/market';

interface Props {
  symbol: string;
  refreshMs?: number;
}

type Status = 'idle' | 'loading' | 'ready' | 'error';

export default function QuoteCard({ symbol, refreshMs = 30_000 }: Props) {
  const [status, setStatus] = useState<Status>('idle');
  const [resp, setResp] = useState<ProviderResponse<MarketSnapshot> | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setStatus('loading');
      try {
        const r = await fetch(`/api/market/quote?symbol=${encodeURIComponent(symbol)}`, {
          cache: 'no-store',
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const body: ProviderResponse<MarketSnapshot> = await r.json();
        if (cancelled) return;
        setResp(body);
        setStatus('ready');
      } catch (e) {
        if (cancelled) return;
        setErr(e instanceof Error ? e.message : 'load failed');
        setStatus('error');
      }
    }

    void load();
    const id = setInterval(load, refreshMs);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [symbol, refreshMs]);

  if (status === 'loading' && !resp) return <div className={styles.card}>Loading {symbol}…</div>;
  if (status === 'error') return <div className={styles.card}>Error: {err}</div>;
  if (!resp) return null;

  const { data, source, data_quality, fetched_at } = resp;
  const isUp = data.changePercent >= 0;

  return (
    <div className={styles.card}>
      <header className={styles.header}>
        <span className={styles.symbol}>{data.symbol}</span>
        <span className={`${styles.badge} ${styles[`quality_${data_quality}`]}`}>
          {data_quality} · {source}
        </span>
      </header>
      <div className={styles.price}>
        <span className={styles.ltp}>₹{data.price.toFixed(2)}</span>
        <span className={isUp ? styles.up : styles.down}>
          {isUp ? '▲' : '▼'} {data.change.toFixed(2)} ({data.changePercent.toFixed(2)}%)
        </span>
      </div>
      <footer className={styles.footer}>
        <span>O {data.open.toFixed(2)}</span>
        <span>H {data.high.toFixed(2)}</span>
        <span>L {data.low.toFixed(2)}</span>
        <span>Vol {data.volume.toLocaleString('en-IN')}</span>
      </footer>
      <time className={styles.time}>
        {new Date(fetched_at).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' })}
      </time>
    </div>
  );
}
