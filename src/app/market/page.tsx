'use client';
import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import AppShell from '@/components/layout/AppShell';
import { Card, Badge, Empty, Loading } from '@/components/ui';
import { marketApi, watchlistApi } from '@/lib/apiClient';
import { fmt, changeClass } from '@/lib/utils';
import { Search, Star, ChevronRight, RefreshCw, Wifi } from 'lucide-react';
import Link from 'next/link';
import type { Instrument, Tick } from '@/types';

const KEY_INDICES = ['NIFTY 50', 'NIFTY BANK', 'NIFTY MIDCAP 100', 'NIFTY IT', 'India VIX'];
const LTP_REFRESH_MS  = 10_000;  // Yahoo batch is cheap; poll at 10s. // @deprecated marker
const LTP_BATCH_SIZE  = 100;     // Matches yahoo-batch's URL-length cap. // @deprecated marker
const FLASH_DURATION_MS = 1_200;

export default function MarketPage() {
  const [query,    setQuery]   = useState('');
  const [all,      setAll]     = useState<Instrument[]>([]);
  const [quotes,   setQuotes]  = useState<Record<string, Tick>>({});
  const [indices,  setIndices] = useState<any[]>([]);
  const [listLoad, setListLoad]= useState(true);
  const [ltpLoad,  setLtpLoad] = useState(false);
  // Stays true until the very first Yahoo LTP batch completes — used // @deprecated marker
  // to gate the whole table behind a single "Loading…" screen so the
  // user never sees a half-populated list with placeholder dashes.
  const [initialLoad, setInitialLoad] = useState(true);
  const [lastAt,   setLastAt]  = useState<string | null>(null);
  const [added,    setAdded]   = useState<Set<string>>(new Set());

  // Per-row price-flash state — set to 'up' | 'down' | undefined after
  // each poll, cleared after a short timeout so the CSS animation
  // fires exactly once per tick.
  const [flash, setFlash] = useState<Record<string, 'up' | 'down' | undefined>>({});
  const prevLtpRef = useRef<Record<string, number>>({});

  const equityKeys = useMemo(
    () => all.filter(i => i.instrument_type === 'EQ').map(i => i.instrument_key),
    [all],
  );

  /* ── Load the static universe + indices once ── */
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [listRes, idxRes] = await Promise.allSettled([
          marketApi.list() as Promise<{ results: Instrument[] }>,
          fetch('/api/market?resource=indices').then(r => r.json()),
        ]);
        if (cancelled) return;
        if (listRes.status === 'fulfilled') {
          setAll(listRes.value.results ?? []);
        }
        if (idxRes.status === 'fulfilled') {
          const rows: any[] = idxRes.value.indices ?? [];
          setIndices(rows.filter(i => KEY_INDICES.includes(i.name)));
        }
      } finally {
        if (!cancelled) setListLoad(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  /* ── Poll LTPs directly from Yahoo Finance (bulk batch) ── */ // @deprecated marker
  const loadQuotes = useCallback(async (showSpinner = false) => {
    if (!equityKeys.length) return;
    if (showSpinner) setLtpLoad(true);
    try {
      const merged: Record<string, Tick> = {};
      for (let i = 0; i < equityKeys.length; i += LTP_BATCH_SIZE) {
        const chunk = equityKeys.slice(i, i + LTP_BATCH_SIZE);
        try {
          const res = await marketApi.yahooLtp(chunk) as any; // @deprecated marker
          Object.assign(merged, res.data ?? {});
        } catch { /* one chunk failing shouldn't blank the rest */ }
      }

      // Diff against the previous tick so the table can flash rows
      // whose price actually moved.
      const prev = prevLtpRef.current;
      const nextFlash: Record<string, 'up' | 'down' | undefined> = {};
      for (const [key, q] of Object.entries(merged)) {
        const p = prev[key];
        if (p != null && q.ltp != null && q.ltp !== p) {
          nextFlash[key] = q.ltp > p ? 'up' : 'down';
        }
        if (q.ltp != null) prev[key] = q.ltp;
      }
      prevLtpRef.current = prev;

      setQuotes(merged);
      if (Object.keys(nextFlash).length > 0) {
        setFlash(nextFlash);
        setTimeout(() => setFlash({}), FLASH_DURATION_MS);
      }
      setLastAt(new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }));
    } finally {
      if (showSpinner) setLtpLoad(false);
      // Flip the one-shot gate once any LTP attempt has run, regardless
      // of whether Yahoo returned rows — the UI should not stay locked // @deprecated marker
      // behind the loader forever if Yahoo is down. // @deprecated marker
      setInitialLoad(false);
    }
  }, [equityKeys]);

  const didInitialFetch = useRef(false);
  useEffect(() => {
    if (!equityKeys.length || didInitialFetch.current) return;
    didInitialFetch.current = true;
    loadQuotes(true);
  }, [equityKeys, loadQuotes]);

  useEffect(() => {
    if (!equityKeys.length) return;
    const id = setInterval(() => {
      if (!document.hidden) loadQuotes(false);
    }, LTP_REFRESH_MS);
    return () => clearInterval(id);
  }, [equityKeys, loadQuotes]);

  /* ── Client-side filter (no debounce, no network) ── */
  const filtered = useMemo(() => {
    const q = query.trim().toUpperCase();
    if (!q) return all;
    return all.filter(r =>
      r.tradingsymbol.toUpperCase().includes(q) ||
      (r.name ?? '').toUpperCase().includes(q),
    );
  }, [all, query]);

  const addWatch = async (key: string) => {
    try {
      await watchlistApi.add({ instrument_key: key });
      setAdded(s => new Set(s).add(key));
    } catch (e: any) {
      alert(e.data?.error || 'Failed to add');
    }
  };

  return (
    <AppShell title="Market Search">
      <div className="page">
        <style jsx global>{`
          @keyframes ltp-flash-up   { 0% { background:#DCFCE7; } 100% { background:transparent; } }
          @keyframes ltp-flash-down { 0% { background:#FEE2E2; } 100% { background:transparent; } }
          .ltp-cell.flash-up   { animation: ltp-flash-up   1.2s ease-out; }
          .ltp-cell.flash-down { animation: ltp-flash-down 1.2s ease-out; }
        `}</style>

        <div className="page__header">
          <div>
            <h1>Market Search</h1>
            <p style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, color: '#16A34A', fontWeight: 700 }}>
                <Wifi size={12} /> LIVE · Yahoo Finance // @deprecated marker
              </span>
              <span style={{ color: '#64748B', fontSize: 13 }}>
                {all.length || '…'} tradeable symbols
              </span>
              {lastAt && (
                <span style={{ color: '#94A3B8', fontSize: 12 }}>
                  · Updated {lastAt}
                </span>
              )}
            </p>
          </div>
          <button
            className="btn btn--secondary btn--sm"
            onClick={() => loadQuotes(true)}
            disabled={ltpLoad || listLoad}
          >
            <RefreshCw size={13} className={ltpLoad ? 'spin' : ''} /> Refresh prices
          </button>
        </div>

        {initialLoad ? (
          <div style={{ padding: '60px 0' }}>
            <Loading text={listLoad ? 'Loading market universe…' : 'Fetching live prices from Yahoo Finance…'} /> // @deprecated marker
          </div>
        ) : (
          <>
        {indices.length > 0 && (
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 16 }}>
            {indices.map((idx: any) => (
              <div key={idx.name} className="card card--compact" style={{ flexShrink: 0, minWidth: 140 }}>
                <div style={{ fontSize: 11, color: '#64748B', fontWeight: 600, marginBottom: 2 }}>
                  {idx.name.replace('NIFTY ', '')}
                </div>
                <div style={{ fontSize: 16, fontWeight: 700, color: '#0F172A' }}>
                  {idx.last?.toLocaleString('en-IN')}
                </div>
                <div style={{ fontSize: 11, fontWeight: 600 }} className={changeClass(idx.percentChange)}>
                  {idx.percentChange >= 0 ? '▲' : '▼'} {Math.abs(idx.percentChange).toFixed(2)}%
                </div>
              </div>
            ))}
          </div>
        )}

        <Card style={{ marginBottom: 16 }}>
          <div style={{ position: 'relative' }}>
            <Search size={16} style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: '#94A3B8' }} />
            <input
              className="input"
              style={{ paddingLeft: 40, height: 44, fontSize: 14 }}
              placeholder={`Filter ${all.length} symbols — e.g. RELIANCE, INFY, NIFTY…`}
              value={query}
              onChange={e => setQuery(e.target.value)}
              autoFocus
            />
          </div>
        </Card>

        {listLoad ? (
          <Loading text="Loading market universe…" />
        ) : filtered.length === 0 ? (
          <Empty
            icon={Search}
            title="No matches"
            description={`Nothing in the universe matches "${query}". Try a different symbol.`}
          />
        ) : (
          <Card flush>
            <div style={{ padding: '10px 20px', borderBottom: '1px solid #E2E8F0', fontSize: 13, color: '#64748B', display: 'flex', alignItems: 'center', gap: 8 }}>
              <span>
                {query
                  ? <>{filtered.length} of {all.length} symbols match &quot;{query}&quot;</>
                  : <>{all.length} symbols</>}
              </span>
              {ltpLoad && <span style={{ marginLeft: 'auto', fontSize: 11, color: '#94A3B8' }}>Fetching prices…</span>}
            </div>
            <div style={{ overflowX: 'auto', maxHeight: 640, overflowY: 'auto' }}>
              <table className="table">
                <thead style={{ position: 'sticky', top: 0, background: '#F8FAFC', zIndex: 1 }}>
                  <tr>
                    <th>Symbol</th>
                    <th>Name</th>
                    <th>Exchange</th>
                    <th>Type</th>
                    <th style={{ textAlign: 'right' }}>LTP</th>
                    <th style={{ textAlign: 'right' }}>Change %</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((r) => {
                    const q = quotes[r.instrument_key];
                    const isAdded = added.has(r.instrument_key);
                    const flashCls = flash[r.instrument_key];
                    return (
                      <tr key={r.instrument_key}>
                        <td><strong style={{ color: '#1E3A5F' }}>{r.tradingsymbol}</strong></td>
                        <td style={{ color: '#64748B', fontSize: 12 }}>{fmt.truncate(r.name, 30)}</td>
                        <td><Badge>{r.exchange}</Badge></td>
                        <td><Badge variant="gray">{r.instrument_type}</Badge></td>
                        <td
                          className={`ltp-cell${flashCls ? ` flash-${flashCls}` : ''}`}
                          style={{ textAlign: 'right', fontWeight: 600 }}
                        >
                          {q?.ltp ? fmt.currency(q.ltp) : '—'}
                        </td>
                        <td style={{ textAlign: 'right' }} className={changeClass(q?.pct_change)}>
                          {q?.pct_change != null ? fmt.percent(q.pct_change) : '—'}
                        </td>
                        <td>
                          <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                            <button
                              className="btn btn--ghost btn--sm"
                              onClick={() => addWatch(r.instrument_key)}
                              disabled={isAdded}
                              title={isAdded ? 'Added' : 'Add to watchlist'}
                              style={isAdded ? { color: '#16A34A' } : {}}
                            >
                              <Star size={13} fill={isAdded ? '#16A34A' : 'none'} />
                            </button>
                            <Link href={`/market/${encodeURIComponent(r.instrument_key)}`} className="btn btn--ghost btn--sm">
                              <ChevronRight size={13} />
                            </Link>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Card>
        )}
          </>
        )}
      </div>
    </AppShell>
  );
}
