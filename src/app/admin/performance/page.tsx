'use client';
import { useEffect, useState } from 'react';
import AppShell from '@/components/layout/AppShell';
import { Card, StatCard, Badge, Loading, Empty } from '@/components/ui';
import { fmt } from '@/lib/utils';
import { TrendingUp, Target, Activity } from 'lucide-react';

function PctBadge({ val }: { val: number }) {
  const v = val ?? 0;
  return <Badge variant={v >= 60 ? 'green' : v >= 40 ? 'orange' : 'red'}>{v.toFixed(1)}% accuracy</Badge>;
}

export default function AdminPerformancePage() {
  const [sigData,   setSigData]   = useState<any>(null);
  const [setupData, setSetupData] = useState<any>(null);
  const [logs,      setLogs]      = useState<any[]>([]);
  const [loading,   setLoading]   = useState(true);

  useEffect(() => {
    Promise.all([
      fetch('/api/admin/performance?resource=signals').then(r => r.json()),
      fetch('/api/admin/performance?resource=setups').then(r => r.json()),
      fetch('/api/admin/performance?resource=logs').then(r => r.json()),
    ]).then(([s, sp, l]) => {
      setSigData(s);
      setSetupData(sp);
      setLogs(l.logs || []);
    }).finally(() => setLoading(false));
  }, []);

  if (loading) return <AppShell title="Admin — Performance"><Loading /></AppShell>;

  const ss = sigData?.summary;
  const ts = setupData?.summary;

  return (
    <AppShell title="Admin — Signal & Setup Performance">
      <div className="page">
        <div className="page__header"><div><h1>Performance Tracking</h1><p>Signal and setup accuracy over time</p></div></div>

        {/* Signal summary */}
        <h2 style={{ fontSize: 16, fontWeight: 700, color: '#1E3A5F', marginBottom: 12 }}>Signal Accuracy</h2>
        <div className="grid-stats" style={{ marginBottom: 20 }}>
          <StatCard label="Total Signals"  value={ss?.total ?? 0}      icon={Activity}   iconVariant="blue" />
          <StatCard label="Target Hit"     value={ss?.target_hit ?? 0} icon={TrendingUp} iconVariant="green" />
          <StatCard label="SL Hit"         value={ss?.sl_hit ?? 0}     icon={TrendingUp} iconVariant="red" />
          <StatCard label="Accuracy"       value={`${ss?.accuracy_pct ?? 0}%`} icon={Target} iconVariant={ss?.accuracy_pct >= 60 ? 'green' : 'orange'} />
        </div>

        {/* Setup summary */}
        <h2 style={{ fontSize: 16, fontWeight: 700, color: '#1E3A5F', marginBottom: 12 }}>Setup Accuracy</h2>
        <div className="grid-stats" style={{ marginBottom: 24 }}>
          <StatCard label="Total Setups"   value={ts?.total ?? 0}      icon={Activity}   iconVariant="blue" />
          <StatCard label="Target Hit"     value={ts?.target_hit ?? 0} icon={TrendingUp} iconVariant="green" />
          <StatCard label="SL Hit"         value={ts?.sl_hit ?? 0}     icon={TrendingUp} iconVariant="red" />
          <StatCard label="Accuracy"       value={`${ts?.accuracy_pct ?? 0}%`} icon={Target} iconVariant={ts?.accuracy_pct >= 60 ? 'green' : 'orange'} />
        </div>

        {/* Recent signal performance */}
        <Card title="Recent Signal Results" flush style={{ marginBottom: 20 } as any}>
          {!sigData?.recent?.length ? <Empty icon={Activity} title="No performance data yet" /> : (
            <div style={{ overflowX: 'auto' }}>
              <table className="table">
                <thead><tr><th>Symbol</th><th>Signal</th><th>Timeframe</th><th>Entry</th><th>T1</th><th>SL</th><th>Outcome</th><th>P&L%</th><th>Hit Time</th></tr></thead>
                <tbody>
                  {sigData.recent.map((r: any) => (
                    <tr key={r.id}>
                      <td><strong style={{ color: '#1E3A5F' }}>{r.tradingsymbol}</strong></td>
                      <td><span className={`signal-chip signal-chip--${r.signal_type}`}>{r.signal_type}</span></td>
                      <td style={{ fontSize: 12, color: '#64748B' }}>{r.timeframe}</td>
                      <td>{fmt.currency(r.entry_price)}</td>
                      <td style={{ color: '#16A34A' }}>{fmt.currency(r.target1)}</td>
                      <td style={{ color: '#DC2626' }}>{fmt.currency(r.stop_loss)}</td>
                      <td>
                        <Badge variant={r.outcome === 'target_hit' ? 'green' : r.outcome === 'sl_hit' ? 'red' : r.outcome === 'pending' ? 'orange' : 'gray'}>
                          {r.outcome}
                        </Badge>
                      </td>
                      <td style={{ color: r.pnl_pct > 0 ? '#16A34A' : r.pnl_pct < 0 ? '#DC2626' : '#94A3B8' }}>
                        {r.pnl_pct != null ? `${r.pnl_pct > 0 ? '+' : ''}${r.pnl_pct.toFixed(2)}%` : '—'}
                      </td>
                      <td style={{ fontSize: 11, color: '#94A3B8' }}>{r.hit_time ? fmt.datetime(r.hit_time) : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        {/* Execution logs */}
        <Card title="Execution Logs" flush>
          {!logs.length ? <Empty icon={Activity} title="No execution logs" /> : (
            <div style={{ overflowX: 'auto' }}>
              <table className="table table--compact">
                <thead><tr><th>Time</th><th>Job</th><th>Signals</th><th>Duration</th><th>Status</th></tr></thead>
                <tbody>
                  {logs.slice(0, 30).map((l: any) => (
                    <tr key={l.id}>
                      <td style={{ fontSize: 11, color: '#64748B' }}>{fmt.datetime(l.run_at)}</td>
                      <td style={{ fontSize: 12 }}>{l.rule_key}</td>
                      <td>{l.signals_generated}</td>
                      <td style={{ fontSize: 12, color: '#64748B' }}>{l.duration_ms}ms</td>
                      <td><Badge variant={l.status === 'success' ? 'green' : 'red'}>{l.status}</Badge></td>
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
