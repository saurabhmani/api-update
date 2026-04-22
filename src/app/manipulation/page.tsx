'use client';
import { useEffect, useState, useCallback } from 'react';
import AppShell from '@/components/layout/AppShell';
import { Card } from '@/components/ui';
import { ShieldAlert, Scan, RefreshCw, AlertTriangle, CheckCircle, TrendingUp, TrendingDown } from 'lucide-react';

interface AlertRow {
  alertId?: string;
  alert_id?: string;
  symbol: string;
  type: string;
  severity: string;
  score: number;
  status: string;
  headline: string;
  description: string;
  evidence?: any;
  detectedAt?: string;
  detected_at?: string;
}

interface SummaryData {
  totalAlerts: number;
  byType: Record<string, number>;
  bySeverity: Record<string, number>;
  topAlerts: AlertRow[];
  recentTrend: 'increasing' | 'stable' | 'decreasing';
}

export default function ManipulationPage() {
  const [summary, setSummary] = useState<SummaryData | null>(null);
  const [alerts, setAlerts] = useState<AlertRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filterType, setFilterType] = useState<string>('all');
  const [filterSeverity, setFilterSeverity] = useState<string>('all');

  const loadSummary = useCallback(async () => {
    try {
      const res = await fetch('/api/manipulation?action=summary', { cache: 'no-store' });
      const data = await res.json();
      setSummary(data);
    } catch { /* ignore */ }
  }, []);

  const loadAlerts = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ action: 'alerts', limit: '100' });
      if (filterType !== 'all') params.set('type', filterType);
      if (filterSeverity !== 'all') params.set('severity', filterSeverity);
      const res = await fetch(`/api/manipulation?${params}`, { cache: 'no-store' });
      const data = await res.json();
      setAlerts(data.alerts ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Load failed');
    } finally {
      setLoading(false);
    }
  }, [filterType, filterSeverity]);

  const runScan = async () => {
    setScanning(true);
    setError(null);
    try {
      const res = await fetch('/api/manipulation', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
      const data = await res.json();
      if (!res.ok) { setError(data.error ?? 'Scan failed'); return; }
      await loadSummary();
      await loadAlerts();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Scan failed');
    } finally {
      setScanning(false);
    }
  };

  const updateStatus = async (alertId: string, status: string) => {
    try {
      await fetch('/api/manipulation', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ alertId, status }),
      });
      await loadAlerts();
    } catch { /* ignore */ }
  };

  useEffect(() => {
    loadSummary();
    loadAlerts();
  }, [loadSummary, loadAlerts]);

  // Auto-refresh every 30 seconds
  useEffect(() => {
    const id = setInterval(() => {
      if (!document.hidden) {
        loadSummary();
        loadAlerts();
      }
    }, 10_000);
    return () => clearInterval(id);
  }, [loadSummary, loadAlerts]);

  const TrendIcon = summary?.recentTrend === 'increasing' ? TrendingUp : summary?.recentTrend === 'decreasing' ? TrendingDown : CheckCircle;
  const trendColor = summary?.recentTrend === 'increasing' ? '#DC2626' : summary?.recentTrend === 'decreasing' ? '#15803D' : '#64748B';

  return (
    <AppShell title="Manipulation Detection">
      <div className="page">
        <div className="page__header">
          <div>
            <h1><ShieldAlert size={20} style={{ verticalAlign: -3, marginRight: 8 }} />Manipulation Watch</h1>
            <p>Real-time anomaly detection: volume spikes, price manipulation, pump-and-dump patterns.</p>
          </div>
          <button className="btn btn--primary btn--sm" onClick={runScan} disabled={scanning}>
            {scanning ? <RefreshCw size={13} className="spin" /> : <Scan size={13} />}
            {scanning ? ' Scanning...' : ' Run Full Scan'}
          </button>
        </div>

        {error && (
          <div style={{ background: '#FEE2E2', color: '#DC2626', padding: '8px 14px', borderRadius: 8, marginBottom: 16, fontSize: 12, fontWeight: 600 }}>
            <AlertTriangle size={12} style={{ verticalAlign: -2, marginRight: 6 }} />{error}
          </div>
        )}

        {/* Summary cards */}
        {summary && (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 20 }}>
            <div style={{ background: '#fff', border: '1px solid #E2E8F0', borderRadius: 8, padding: 14 }}>
              <div style={{ fontSize: 10, fontWeight: 700, color: '#94A3B8', textTransform: 'uppercase' }}>Total Alerts (30d)</div>
              <div style={{ fontSize: 26, fontWeight: 800, color: '#1E293B', marginTop: 4 }}>{summary.totalAlerts}</div>
              <div style={{ fontSize: 11, color: trendColor, marginTop: 4, display: 'flex', alignItems: 'center', gap: 4 }}>
                <TrendIcon size={11} /> Trend: {summary.recentTrend}
              </div>
            </div>
            <div style={{ background: '#FEE2E2', border: '1px solid #DC262633', borderRadius: 8, padding: 14 }}>
              <div style={{ fontSize: 10, fontWeight: 700, color: '#DC2626', textTransform: 'uppercase' }}>Critical</div>
              <div style={{ fontSize: 26, fontWeight: 800, color: '#DC2626', marginTop: 4 }}>{summary.bySeverity?.critical ?? 0}</div>
              <div style={{ fontSize: 11, color: '#7F1D1D', marginTop: 4 }}>Immediate review needed</div>
            </div>
            <div style={{ background: '#FEF3C7', border: '1px solid #D9770633', borderRadius: 8, padding: 14 }}>
              <div style={{ fontSize: 10, fontWeight: 700, color: '#D97706', textTransform: 'uppercase' }}>Warning</div>
              <div style={{ fontSize: 26, fontWeight: 800, color: '#D97706', marginTop: 4 }}>{summary.bySeverity?.warning ?? 0}</div>
              <div style={{ fontSize: 11, color: '#92400E', marginTop: 4 }}>Suspicious activity</div>
            </div>
            <div style={{ background: '#F0FDF4', border: '1px solid #16A34A33', borderRadius: 8, padding: 14 }}>
              <div style={{ fontSize: 10, fontWeight: 700, color: '#15803D', textTransform: 'uppercase' }}>Info</div>
              <div style={{ fontSize: 26, fontWeight: 800, color: '#15803D', marginTop: 4 }}>{summary.bySeverity?.info ?? 0}</div>
              <div style={{ fontSize: 11, color: '#065F46', marginTop: 4 }}>Notable patterns</div>
            </div>
          </div>
        )}

        {/* By type breakdown */}
        {summary && Object.keys(summary.byType ?? {}).length > 0 && (
          <Card title="Alerts by Type">
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, padding: 12 }}>
              {Object.entries(summary.byType).map(([type, count]) => (
                <span key={type} style={{ background: '#F1F5F9', padding: '6px 12px', borderRadius: 99, fontSize: 12 }}>
                  <strong>{type.replace(/_/g, ' ')}:</strong> {count}
                </span>
              ))}
            </div>
          </Card>
        )}

        {/* Filters */}
        <div style={{ display: 'flex', gap: 12, marginTop: 20, marginBottom: 12 }}>
          <select value={filterType} onChange={e => setFilterType(e.target.value)}
            style={{ padding: '6px 10px', borderRadius: 6, border: '1px solid #E2E8F0', fontSize: 12 }}>
            <option value="all">All types</option>
            <option value="volume_anomaly">Volume Anomaly</option>
            <option value="price_spike">Price Spike</option>
            <option value="pump_and_dump">Pump & Dump</option>
          </select>
          <select value={filterSeverity} onChange={e => setFilterSeverity(e.target.value)}
            style={{ padding: '6px 10px', borderRadius: 6, border: '1px solid #E2E8F0', fontSize: 12 }}>
            <option value="all">All severities</option>
            <option value="critical">Critical only</option>
            <option value="warning">Warning</option>
            <option value="info">Info</option>
          </select>
        </div>

        {/* Alerts table */}
        <Card title={`Alerts (${alerts.length})`}>
          {loading ? (
            <div style={{ padding: 40, textAlign: 'center', color: '#94A3B8' }}>
              <RefreshCw size={20} className="spin" />
              <div style={{ fontSize: 12, marginTop: 6 }}>Loading...</div>
            </div>
          ) : alerts.length === 0 ? (
            <div style={{ padding: 40, textAlign: 'center', color: '#94A3B8' }}>
              <ShieldAlert size={32} style={{ opacity: 0.4, marginBottom: 8 }} />
              <div style={{ fontSize: 13 }}>No alerts. Click "Run Full Scan" to analyze the universe.</div>
            </div>
          ) : (
            <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ background: '#F8FAFC' }}>
                  {['SYMBOL', 'TYPE', 'SEVERITY', 'SCORE', 'STATUS', 'HEADLINE', 'DETECTED', 'ACTIONS'].map(h => (
                    <th key={h} style={{ padding: '8px 12px', textAlign: 'left', fontSize: 10, color: '#94A3B8', fontWeight: 700 }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {alerts.map((a) => {
                  const alertId = a.alertId ?? a.alert_id ?? '';
                  const detected = a.detectedAt ?? a.detected_at;
                  return (
                    <tr key={alertId} style={{ borderTop: '1px solid #F1F5F9' }}>
                      <td style={{ padding: '8px 12px', fontWeight: 700 }}>{a.symbol}</td>
                      <td style={{ padding: '8px 12px', fontSize: 11 }}>{(a.type ?? '').replace(/_/g, ' ')}</td>
                      <td style={{ padding: '8px 12px' }}>
                        <span style={{
                          background: a.severity === 'critical' ? '#FEE2E2' : a.severity === 'warning' ? '#FEF3C7' : '#F1F5F9',
                          color: a.severity === 'critical' ? '#DC2626' : a.severity === 'warning' ? '#D97706' : '#64748B',
                          fontWeight: 700, fontSize: 10, padding: '2px 8px', borderRadius: 99,
                        }}>
                          {(a.severity ?? '').toUpperCase()}
                        </span>
                      </td>
                      <td style={{ padding: '8px 12px', fontWeight: 700, color: a.score >= 70 ? '#DC2626' : a.score >= 45 ? '#D97706' : '#64748B' }}>
                        {a.score}
                      </td>
                      <td style={{ padding: '8px 12px', fontSize: 11, color: '#64748B' }}>{a.status}</td>
                      <td style={{ padding: '8px 12px', fontSize: 11, maxWidth: 320 }}>{a.headline}</td>
                      <td style={{ padding: '8px 12px', fontSize: 11, color: '#94A3B8' }}>
                        {detected ? new Date(detected).toLocaleDateString('en-IN') : '—'}
                      </td>
                      <td style={{ padding: '8px 12px' }}>
                        {a.status === 'new' && (
                          <div style={{ display: 'flex', gap: 4 }}>
                            <button onClick={() => updateStatus(alertId, 'acknowledged')}
                              style={{ background: '#DBEAFE', color: '#1D4ED8', border: 'none', padding: '2px 8px', borderRadius: 4, fontSize: 10, fontWeight: 700, cursor: 'pointer' }}>
                              ACK
                            </button>
                            <button onClick={() => updateStatus(alertId, 'dismissed')}
                              style={{ background: '#F1F5F9', color: '#64748B', border: 'none', padding: '2px 8px', borderRadius: 4, fontSize: 10, fontWeight: 700, cursor: 'pointer' }}>
                              DISMISS
                            </button>
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </Card>
      </div>
    </AppShell>
  );
}
