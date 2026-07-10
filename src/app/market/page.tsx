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
const LTP_REFRESH_MS  = 10_000;
const LTP_BATCH_SIZE  = 100;
const LTP_PARALLEL    = 4;
const FLASH_DURATION_MS = 1_200;
const PAGE_CACHE_KEY    = 'q365-market-page-v1';

type PageCache = {
  all: Instrument[];
  quotes: Record<string, Tick>;
  indices: any[];
};

function readPageCache(): PageCache | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = sessionStorage.getItem(PAGE_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PageCache;
    if (!Array.isArray(parsed.all) || parsed.all.length === 0) return null;
    return {
      all: parsed.all,
      quotes: parsed.quotes ?? {},
      indices: Array.isArray(parsed.indices) ? parsed.indices : [],
    };
  } catch {
    return null;
  }
}

export default function MarketPage() {
  const [query,    setQuery]   = useState('');
  const [all,      setAll]     = useState<Instrument[]>([]);
  const [quotes,   setQuotes]  = useState<Record<string, Tick>>({});
  const [indices,  setIndices] = useState<any[]>([]);
  const [listLoad, setListLoad]= useState(true);
  const [listRefreshing, setListRefreshing] = useState(false);
  const [listError,setListError]= useState<string | null>(null);
  const [ltpLoad,  setLtpLoad] = useState(false);
  const [lastAt,   setLastAt]  = useState<string | null>(null);
  const [added,    setAdded]   = useState<Set<string>>(new Set());

  const [flash, setFlash] = useState<Record<string, 'up' | 'down' | undefined>>({});
  const prevLtpRef = useRef<Record<string, number>>({});
  const quotesGenRef = useRef(0);
  const equityKeysSigRef = useRef('');
  const mountedRef = useRef(false);
  const allLenRef = useRef(0);

  const equityKeys = useMemo(
    () => all.filter(i => i.instrument_type === 'EQ').map(i => i.instrument_key),
    [all],
  );

  useEffect(() => {
    allLenRef.current = all.length;
  }, [all.length]);

  const fetchUniverse = useCallback(async () => {
    const hasExisting = allLenRef.current > 0;
    if (hasExisting) setListRefreshing(true);
    else setListLoad(true);
    setListError(null);
    try {
      const [listRes, idxRes] = await Promise.allSettled([
        marketApi.list() as Promise<{ results: Instrument[] }>,
        fetch('/api/market?resource=indices').then(r => r.json()),
      ]);
      if (listRes.status === 'fulfilled') {
        const rows = listRes.value.results ?? [];
        if (rows.length > 0) {
          equityKeysSigRef.current = '';
          setAll(rows);
        } else if (!hasExisting) {
          setListError('Symbol list returned empty — retrying may help after the server warms up.');
        } else {
          setListError('Reload returned empty — showing the previous symbol list.');
        }
      } else if (!hasExisting) {
        setListError('Could not load market universe. Please sign in again or retry.');
      } else {
        setListError('Could not refresh symbol list — showing the previous list.');
      }
      if (idxRes.status === 'fulfilled') {
        const rows: any[] = idxRes.value.indices ?? [];
        const next = rows.filter(i => KEY_INDICES.includes(i.name));
        if (next.length > 0) setIndices(next);
      }
    } finally {
      setListLoad(false);
      setListRefreshing(false);
    }
  }, []);

  useEffect(() => {
    if (mountedRef.current) return;
    mountedRef.current = true;
    const cache = readPageCache();
    if (cache) {
      allLenRef.current = cache.all.length;
      setAll(cache.all);
      setQuotes(cache.quotes);
      setIndices(cache.indices);
      setListLoad(false);
      prevLtpRef.current = Object.fromEntries(
        Object.entries(cache.quotes)
          .filter(([, q]) => q?.ltp != null)
          .map(([k, q]) => [k, q.ltp as number]),
      );
    }
    void fetchUniverse();
  }, [fetchUniverse]);

  const loadQuotes = useCallback(async (showSpinner = false) => {
    if (!equityKeys.length) return;
    if (showSpinner) setLtpLoad(true);
    const gen = ++quotesGenRef.current;
    try {
      const chunks: string[][] = [];
      for (let i = 0; i < equityKeys.length; i += LTP_BATCH_SIZE) {
        chunks.push(equityKeys.slice(i, i + LTP_BATCH_SIZE));
      }

      let cursor = 0;
      const workers = Array.from({ length: Math.min(LTP_PARALLEL, chunks.length) }, async () => {
        while (cursor < chunks.length) {
          const idx = cursor++;
          const chunk = chunks[idx];
          try {
            const res = await marketApi.yahooLtp(chunk) as { data?: Record<string, Tick> };
            if (gen !== quotesGenRef.current) return;
            const batch = res.data ?? {};
            setQuotes(prev => ({ ...prev, ...batch }));

            const prev = prevLtpRef.current;
            const nextFlash: Record<string, 'up' | 'down'> = {};
            for (const [key, q] of Object.entries(batch)) {
              const p = prev[key];
              if (p != null && q.ltp != null && q.ltp !== p) {
                nextFlash[key] = q.ltp > p ? 'up' : 'down';
              }
              if (q.ltp != null) prev[key] = q.ltp;
            }
            prevLtpRef.current = prev;
            if (Object.keys(nextFlash).length > 0) {
              setFlash(f => ({ ...f, ...nextFlash }));
            }
          } catch {
            /* one chunk failing shouldn't blank the rest */
          }
        }
      });
      await Promise.all(workers);

      if (gen === quotesGenRef.current) {
        setLastAt(new Date().toLocaleTimeString('en-IN', {
          hour: '2-digit', minute: '2-digit', second: '2-digit',
        }));
        if (Object.keys(prevLtpRef.current).length > 0) {
          setTimeout(() => setFlash({}), FLASH_DURATION_MS);
        }
      }
    } finally {
      if (showSpinner) setLtpLoad(false);
    }
  }, [equityKeys]);

  // Refresh prices whenever the universe is ready or changes — never
  // wipe the table; only show a spinner on the very first load.
  useEffect(() => {
    if (listLoad || !equityKeys.length) return;
    const sig = equityKeys.join('|');
    const isFirst = equityKeysSigRef.current === '';
    const universeChanged = equityKeysSigRef.current !== '' && equityKeysSigRef.current !== sig;
    equityKeysSigRef.current = sig;
    if (isFirst || universeChanged) {
      void loadQuotes(isFirst);
    }
  }, [equityKeys, listLoad, loadQuotes]);

  useEffect(() => {
    if (all.length === 0) return;
    try {
      sessionStorage.setItem(PAGE_CACHE_KEY, JSON.stringify({ all, quotes, indices }));
    } catch {
      /* quota / private mode */
    }
  }, [all, quotes, indices]);

  useEffect(() => {
    if (!equityKeys.length) return;
    const id = setInterval(() => {
      if (!document.hidden) void loadQuotes(false);
    }, LTP_REFRESH_MS);
    return () => clearInterval(id);
  }, [equityKeys, loadQuotes]);

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
                <Wifi size={12} /> LIVE · Market quotes
              </span>
              <span style={{ color: '#64748B', fontSize: 13 }}>
                {listLoad && all.length === 0 ? '…' : all.length} tradeable symbols
                {listRefreshing && all.length > 0 && (
                  <span style={{ marginLeft: 6, color: '#94A3B8' }}>· refreshing list…</span>
                )}
              </span>
              {lastAt && (
                <span style={{ color: '#94A3B8', fontSize: 12 }}>
                  · Prices updated {lastAt}
                </span>
              )}
            </p>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              className="btn btn--secondary btn--sm"
              onClick={() => void fetchUniverse()}
              disabled={listLoad || listRefreshing}
            >
              <RefreshCw size={13} className={listRefreshing ? 'spin' : ''} /> Reload list
            </button>
            <button
              className="btn btn--secondary btn--sm"
              onClick={() => void loadQuotes(true)}
              disabled={ltpLoad || equityKeys.length === 0}
            >
              <RefreshCw size={13} className={ltpLoad ? 'spin' : ''} /> Refresh prices
            </button>
          </div>
        </div>

        {listLoad && all.length === 0 ? (
          <div style={{ padding: '60px 0' }}>
            <Loading text="Loading market universe…" />
          </div>
        ) : (
          <>
        {listError && (
          <Card style={{ marginBottom: 16, borderColor: '#FCD34D', background: '#FFFBEB' }}>
            <p style={{ margin: 0, fontSize: 13, color: '#92400E' }}>{listError}</p>
          </Card>
        )}

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

        {filtered.length === 0 && all.length === 0 ? (
          <Empty
            icon={Search}
            title="Market universe unavailable"
            description="Could not load the tradeable symbol list. Click Reload list or check that q365_universe is populated."
          />
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
