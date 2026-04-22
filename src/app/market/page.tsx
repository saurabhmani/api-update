'use client';
import { useState, useEffect, useRef } from 'react';
import AppShell from '@/components/layout/AppShell';
import { Card, Badge, Empty, Loading } from '@/components/ui';
import { marketApi, watchlistApi } from '@/lib/apiClient';
import { fmt, changeClass } from '@/lib/utils';
import { Search, Star, ChevronRight, TrendingUp, TrendingDown } from 'lucide-react';
import Link from 'next/link';
import type { Instrument, Tick } from '@/types';

const KEY_INDICES = ['NIFTY 50', 'NIFTY BANK', 'NIFTY MIDCAP 100', 'NIFTY IT', 'INDIA VIX'];

export default function MarketPage() {
  const [query,    setQuery]    = useState('');
  const [results,  setResults]  = useState<Instrument[]>([]);
  const [quotes,   setQuotes]   = useState<Record<string, Tick>>({});
  const [loading,  setLoading]  = useState(false);
  const [added,    setAdded]    = useState<Set<string>>(new Set());

  const [gainers,  setGainers]  = useState<any[]>([]);
  const [losers,   setLosers]   = useState<any[]>([]);
  const [indices,  setIndices]  = useState<any[]>([]);
  const [mktLoad,  setMktLoad]  = useState(true);

  const timerRef = useRef<ReturnType<typeof setTimeout>>();

  /* ── Load market overview on mount ── */
  useEffect(() => {
    async function loadMarket() {
      try {
        const [intelRes, idxRes] = await Promise.allSettled([
          fetch('/api/market-intelligence').then(r => r.json()),
          fetch('/api/market?resource=indices').then(r => r.json()),
        ]);
        if (intelRes.status === 'fulfilled') {
          setGainers(intelRes.value.topGainers ?? []);
          setLosers(intelRes.value.topLosers  ?? []);
        }
        if (idxRes.status === 'fulfilled') {
          const all: any[] = idxRes.value.indices ?? [];
          setIndices(all.filter(i => KEY_INDICES.includes(i.name)));
        }
      } finally { setMktLoad(false); }
    }
    loadMarket();
  }, []);

  /* ── Debounced search ── */
  const handleSearch = (q: string) => {
    setQuery(q);
    clearTimeout(timerRef.current);

    if (q.length < 2) {
      setResults([]);
      setQuotes({});
      return;
    }

    timerRef.current = setTimeout(async () => {
      setLoading(true);
      try {
        const data = await marketApi.search(q) as any;
        const rows: Instrument[] = data.results || [];
        setResults(rows);

        // If results already carry price data (from universe cache), seed quotes from them
        const seedQuotes: Record<string, Tick> = {};
        const missingKeys: string[] = [];

        for (const r of rows) {
          const rAny = r as any;
          if (rAny.ltp) {
            seedQuotes[r.instrument_key] = {
              instrument_key: r.instrument_key,
              ltp:        rAny.ltp,
              net_change: rAny.net_change ?? 0,
              pct_change: rAny.pct_change ?? 0,
              volume:     rAny.volume ?? 0,
              oi:         0,
              ts:         new Date().toISOString(),
            };
          } else if (r.instrument_key) {
            missingKeys.push(r.instrument_key);
          }
        }

        if (missingKeys.length) {
          const qData = await marketApi.ltp(missingKeys) as any;
          Object.assign(seedQuotes, qData.data || {});
        }

        setQuotes(seedQuotes);
      } finally { setLoading(false); }
    }, 350);
  };

  const addWatch = async (key: string) => {
    try {
      await watchlistApi.add({ instrument_key: key });
      setAdded(s => new Set(s).add(key));
    } catch (e: any) {
      alert(e.data?.error || 'Failed to add');
    }
  };

  const showOverview = query.length < 2;

  return (
    <AppShell title="Market Search">
      <div className="page">
        <div className="page__header">
          <div>
            <h1>Market Search</h1>
            <p>Search across NSE, BSE and F&amp;O instruments</p>
          </div>
        </div>

        {/* ── Search bar ── */}
        <Card style={{ marginBottom: 20 }}>
          <div style={{ position: 'relative' }}>
            <Search size={16} style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: '#94A3B8' }} />
            <input
              className="input"
              style={{ paddingLeft: 40, height: 48, fontSize: 15 }}
              placeholder="Search by symbol or company name… e.g. RELIANCE, Infosys, NIFTY"
              value={query}
              onChange={e => handleSearch(e.target.value)}
              autoFocus
            />
          </div>
        </Card>

        {/* ── Market Overview (shown when no search query) ── */}
        {showOverview && (
          <>
            {/* Key Indices */}
            {indices.length > 0 && (
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 20 }}>
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

            {/* Gainers / Losers */}
            {mktLoad ? (
              <Loading text="Loading market data…" />
            ) : (gainers.length > 0 || losers.length > 0) ? (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
                {/* Gainers */}
                <Card flush>
                  <div style={{ padding: '12px 16px', borderBottom: '1px solid #E2E8F0', display: 'flex', alignItems: 'center', gap: 6 }}>
                    <TrendingUp size={14} color="#16A34A" />
                    <span style={{ fontSize: 13, fontWeight: 600, color: '#16A34A' }}>Top Gainers</span>
                    <span style={{ fontSize: 11, color: '#94A3B8', marginLeft: 'auto' }}>NIFTY 500 · {gainers.length} stocks</span>
                  </div>
                  <div style={{ overflowX: 'auto', maxHeight: 520, overflowY: 'auto' }}>
                    <table className="table">
                      <thead>
                        <tr>
                          <th>Symbol</th>
                          <th style={{ textAlign: 'right' }}>LTP</th>
                          <th style={{ textAlign: 'right' }}>Change %</th>
                        </tr>
                      </thead>
                      <tbody>
                        {gainers.map((g: any) => (
                          <tr key={g.symbol}>
                            <td>
                              <div style={{ fontWeight: 600, color: '#1E3A5F', fontSize: 13 }}>{g.symbol}</div>
                              <div style={{ fontSize: 11, color: '#94A3B8' }}>{fmt.truncate(g.name, 22)}</div>
                            </td>
                            <td style={{ textAlign: 'right', fontWeight: 600 }}>{fmt.currency(g.ltp)}</td>
                            <td style={{ textAlign: 'right' }} className={changeClass(g.change_percent)}>
                              {fmt.percent(g.change_percent)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </Card>

                {/* Losers */}
                <Card flush>
                  <div style={{ padding: '12px 16px', borderBottom: '1px solid #E2E8F0', display: 'flex', alignItems: 'center', gap: 6 }}>
                    <TrendingDown size={14} color="#DC2626" />
                    <span style={{ fontSize: 13, fontWeight: 600, color: '#DC2626' }}>Top Losers</span>
                    <span style={{ fontSize: 11, color: '#94A3B8', marginLeft: 'auto' }}>NIFTY 500 · {losers.length} stocks</span>
                  </div>
                  <div style={{ overflowX: 'auto', maxHeight: 520, overflowY: 'auto' }}>
                    <table className="table">
                      <thead>
                        <tr>
                          <th>Symbol</th>
                          <th style={{ textAlign: 'right' }}>LTP</th>
                          <th style={{ textAlign: 'right' }}>Change %</th>
                        </tr>
                      </thead>
                      <tbody>
                        {losers.map((g: any) => (
                          <tr key={g.symbol}>
                            <td>
                              <div style={{ fontWeight: 600, color: '#1E3A5F', fontSize: 13 }}>{g.symbol}</div>
                              <div style={{ fontSize: 11, color: '#94A3B8' }}>{fmt.truncate(g.name, 22)}</div>
                            </td>
                            <td style={{ textAlign: 'right', fontWeight: 600 }}>{fmt.currency(g.ltp)}</td>
                            <td style={{ textAlign: 'right' }} className={changeClass(g.change_percent)}>
                              {fmt.percent(g.change_percent)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </Card>
              </div>
            ) : null}
          </>
        )}

        {/* ── Search results ── */}
        {!showOverview && (
          <>
            {loading && <Loading text="Searching…" />}

            {!loading && results.length > 0 && (
              <Card flush>
                <div style={{ padding: '10px 20px', borderBottom: '1px solid #E2E8F0', fontSize: 13, color: '#64748B', fontWeight: 500 }}>
                  {results.length} result{results.length !== 1 ? 's' : ''} for &quot;{query}&quot;
                </div>
                <div style={{ overflowX: 'auto' }}>
                  <table className="table">
                    <thead>
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
                      {results.map((r, i) => {
                        const q = quotes[r.instrument_key];
                        const isAdded = added.has(r.instrument_key);
                        return (
                          <tr key={i}>
                            <td><strong style={{ color: '#1E3A5F' }}>{r.tradingsymbol}</strong></td>
                            <td style={{ color: '#64748B', fontSize: 12 }}>{fmt.truncate(r.name, 30)}</td>
                            <td><Badge>{r.exchange}</Badge></td>
                            <td><Badge variant="gray">{r.instrument_type}</Badge></td>
                            <td style={{ textAlign: 'right', fontWeight: 600 }}>{q?.ltp ? fmt.currency(q.ltp) : '—'}</td>
                            <td style={{ textAlign: 'right' }} className={changeClass(q?.pct_change)}>{fmt.percent(q?.pct_change)}</td>
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

            {!loading && results.length === 0 && (
              <Empty
                icon={Search}
                title="No results found"
                description="Try a different symbol or company name"
              />
            )}
          </>
        )}
      </div>
    </AppShell>
  );
}
