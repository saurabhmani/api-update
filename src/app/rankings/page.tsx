'use client';
import { useEffect, useState, useCallback } from 'react';
import AppShell from '@/components/layout/AppShell';
import { Card, Badge, Loading, Empty } from '@/components/ui';
import { rankingsApi } from '@/lib/apiClient';
import { fmt, changeClass } from '@/lib/utils';
import { TrendingUp } from 'lucide-react';

export default function RankingsPage() {
  const [rows,    setRows]    = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    rankingsApi.get(50).then((d: any) => setRows(d.data || [])).finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  // Refresh rankings every 10 seconds
  useEffect(() => {
    const id = setInterval(() => { if (!document.hidden) load(); }, 10_000);
    return () => clearInterval(id);
  }, [load]);

  return (
    <AppShell title="Rankings">
      <div className="page">
        <div className="page__header"><div><h1>Rankings</h1><p>Top stocks by Quantorus365 score</p></div></div>
        <Card flush>
          {loading ? <Loading /> : rows.length === 0 ? (
            <Empty icon={TrendingUp} title="No rankings data" description="Go to Admin → Data Management and trigger a rankings sync." />
          ) : (
            <div style={{ overflowX:'auto' }}>
              <table className="table">
                <thead>
                  <tr><th>#</th><th>Symbol</th><th>Name</th><th>Exchange</th><th style={{ textAlign:'right' }}>Score</th><th style={{ textAlign:'right' }}>LTP</th><th style={{ textAlign:'right' }}>Change %</th></tr>
                </thead>
                <tbody>
                  {rows.map((r, i) => (
                    <tr key={r.id || i}>
                      <td style={{ fontWeight:700, color:'#94A3B8' }}>{i + 1}</td>
                      <td><strong style={{ color:'#1E3A5F' }}>{r.tradingsymbol}</strong></td>
                      <td style={{ color:'#64748B', fontSize:12 }}>{fmt.truncate(r.name, 28)}</td>
                      <td><Badge>{r.exchange}</Badge></td>
                      <td style={{ textAlign:'right', fontWeight:700 }}>{fmt.number(Number(r.score), 1)}</td>
                      <td style={{ textAlign:'right' }}>{fmt.currency(Number(r.ltp))}</td>
                      <td style={{ textAlign:'right' }} className={changeClass(Number(r.pct_change))}>{fmt.percent(Number(r.pct_change))}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>
    </AppShell>
  );
}
