'use client';
import { useEffect, useState, useCallback } from 'react';
import AppShell from '@/components/layout/AppShell';
import { Card, Badge, Button, Loading, Empty } from '@/components/ui';
import { watchlistApi, marketApi } from '@/lib/apiClient';
import { useLiveTick } from '@/hooks/useLiveTick';
import { fmt, changeClass, debounce } from '@/lib/utils';
import { Star, Trash2, Search, Wifi, WifiOff } from 'lucide-react';
import type { WatchlistItem } from '@/types';

export default function WatchlistPage() {
  const [items,       setItems]       = useState<WatchlistItem[]>([]);
  const [loading,     setLoading]     = useState(true);
  const [query,       setQuery]       = useState('');
  const [suggestions, setSuggestions] = useState<any[]>([]);
  const [showSug,     setShowSug]     = useState(false);

  const keys = items.map(i => i.instrument_key).filter(Boolean) as string[];
  const { ticks, connected } = useLiveTick(keys);

  async function load() {
    setLoading(true);
    try { const d = await watchlistApi.get() as any; setItems(d.items || []); }
    finally { setLoading(false); }
  }

  useEffect(() => { load(); }, []);

  const suggest = useCallback(debounce(async (q: string) => {
    if (q.length < 2) { setSuggestions([]); return; }
    const d = await marketApi.suggest(q) as any;
    setSuggestions(d.results?.slice(0,8) || []);
    setShowSug(true);
  }, 300), []);

  const addItem = async (inst: any) => {
    setQuery(''); setSuggestions([]); setShowSug(false);
    try { await watchlistApi.add({ instrument_key: inst.instrument_key }); await load(); }
    catch (e: any) { alert(e.data?.error || 'Failed to add'); }
  };

  const removeItem = async (id: number) => {
    if (!confirm('Remove from watchlist?')) return;
    await watchlistApi.remove(id);
    setItems(prev => prev.filter(i => i.id !== id));
  };

  return (
    <AppShell title="Watchlist">
      <div className="page">
        <div className="page__header">
          <div>
            <h1>Watchlist</h1>
            <p>{items.length} stocks tracked</p>
          </div>
          <span style={{ display:'flex', alignItems:'center', gap:6, fontSize:12, color: connected ? '#16A34A' : '#94A3B8' }}>
            {connected ? <Wifi size={13} /> : <WifiOff size={13} />}
            {connected ? 'Live' : 'Offline'}
          </span>
        </div>

        {/* Search to add */}
        <Card style={{ marginBottom:20, position:'relative' }}>
          <div style={{ position:'relative' }}>
            <Search size={15} style={{ position:'absolute', left:12, top:'50%', transform:'translateY(-50%)', color:'#94A3B8' }} />
            <input
              className="input" style={{ paddingLeft:38 }}
              placeholder="Search and add stock to watchlist…"
              value={query}
              onChange={e => { setQuery(e.target.value); suggest(e.target.value); }}
              onFocus={() => suggestions.length && setShowSug(true)}
              onBlur={() => setTimeout(() => setShowSug(false), 150)}
            />
          </div>
          {showSug && suggestions.length > 0 && (
            <div className="suggestions">
              {suggestions.map((s, i) => (
                <div key={i} className="suggestions__item" onMouseDown={() => addItem(s)}>
                  <div>
                    <strong style={{ color:'#1E3A5F' }}>{s.tradingsymbol}</strong>
                    <span style={{ color:'#94A3B8', marginLeft:8, fontSize:12 }}>{fmt.truncate(s.name, 30)}</span>
                  </div>
                  <Badge>{s.exchange}</Badge>
                </div>
              ))}
            </div>
          )}
        </Card>

        {/* Table */}
        <Card flush>
          {loading ? <Loading /> : items.length === 0 ? (
            <Empty icon={Star} title="No stocks in watchlist" description="Search above to add your first stock." />
          ) : (
            <div style={{ overflowX:'auto' }}>
              <table className="table">
                <thead>
                  <tr>
                    <th>Symbol</th><th>Name</th><th>Exchange</th>
                    <th style={{ textAlign:'right' }}>LTP</th>
                    <th style={{ textAlign:'right' }}>Change</th>
                    <th style={{ textAlign:'right' }}>Change %</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {items.map(item => {
                    const tick = ticks[item.instrument_key] ?? null;
                    return (
                      <tr key={item.id}>
                        <td><strong style={{ color:'#1E3A5F' }}>{item.tradingsymbol}</strong></td>
                        <td style={{ color:'#64748B', fontSize:12 }}>{fmt.truncate(item.name, 26)}</td>
                        <td><Badge>{item.exchange}</Badge></td>
                        <td style={{ textAlign:'right', fontWeight:600, fontVariantNumeric:'tabular-nums' }}>{fmt.currency(tick?.ltp)}</td>
                        <td style={{ textAlign:'right' }} className={changeClass(tick?.net_change)}>
                          {tick?.net_change != null ? (tick.net_change >= 0 ? '+' : '') + tick.net_change.toFixed(2) : '—'}
                        </td>
                        <td style={{ textAlign:'right' }} className={changeClass(tick?.pct_change)}>{fmt.percent(tick?.pct_change)}</td>
                        <td>
                          <button className="btn btn--ghost btn--sm" style={{ color:'#EF4444' }} onClick={() => removeItem(item.id)}>
                            <Trash2 size={13} />
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>
    </AppShell>
  );
}
