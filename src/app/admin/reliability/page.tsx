'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import {
  Activity, AlertTriangle, Bell, Clock, Database, LineChart,
  RefreshCw, Server, Shield, Users, Zap, FileText, Radio,
} from 'lucide-react';
import AppShell from '@/components/layout/AppShell';
import { Badge, Button, Card, Empty, Loading, AlertBanner } from '@/components/ui';
import { fmt } from '@/lib/utils';
import styles from './reliability.module.scss';

type Tab =
  | 'overview' | 'users' | 'strategies' | 'signals'
  | 'cron' | 'loaders' | 'broker' | 'api' | 'alerts' | 'audit';

const TABS: { id: Tab; label: string }[] = [
  { id: 'overview', label: 'Dashboard' },
  { id: 'users', label: 'Users' },
  { id: 'strategies', label: 'Strategies' },
  { id: 'signals', label: 'Signals' },
  { id: 'cron', label: 'Cron' },
  { id: 'loaders', label: 'Data Loaders' },
  { id: 'broker', label: 'Broker' },
  { id: 'api', label: 'API Health' },
  { id: 'alerts', label: 'Alerting' },
  { id: 'audit', label: 'Audit Logs' },
];

function statusClass(s: string) {
  if (s === 'healthy' || s === 'success' || s === 'ok' || s === 'CLEAN') return styles.ok;
  if (s === 'degraded' || s === 'warning' || s === 'warn' || s === 'NEEDS_CLEANUP') return styles.warn;
  return styles.fail;
}

export default function ReliabilityPage() {
  const [tab, setTab] = useState<Tab>('overview');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [dash, setDash] = useState<any>(null);
  const [alertData, setAlertData] = useState<any>(null);
  const [audit, setAudit] = useState<any[]>([]);
  const [dispatching, setDispatching] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [statusRes, alertsRes, auditRes] = await Promise.all([
        fetch('/api/reliability/status').then((r) => r.json()),
        fetch('/api/reliability/alerts').then((r) => r.json()),
        fetch('/api/reliability/audit?limit=100').then((r) => r.json()),
      ]);
      if (!statusRes.ok) throw new Error(statusRes.error ?? 'Failed to load');
      setDash(statusRes.dashboard);
      setAlertData(alertsRes);
      setAudit(auditRes.entries ?? []);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Load failed');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const dispatchAlerts = async () => {
    setDispatching(true);
    try {
      const res = await fetch('/api/reliability/alerts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'dispatch' }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error);
      await load();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Dispatch failed');
    } finally {
      setDispatching(false);
    }
  };

  const m = dash?.metrics;
  const overall = dash?.overallStatus ?? 'unknown';

  return (
    <AppShell title="Platform Reliability">
      <div className="page">
        <div className="page__header">
          <h1><Activity size={22} style={{ verticalAlign: 'middle', marginRight: 8 }} />Platform Reliability</h1>
          <p>SRE dashboard — health metrics, cron monitoring, alerting, and audit logs.</p>
        </div>

        {error && <AlertBanner variant="error">{error}</AlertBanner>}

        <div style={{ marginBottom: 16, display: 'flex', gap: 8, alignItems: 'center' }}>
          <Button variant="secondary" size="sm" onClick={load} loading={loading}>
            <RefreshCw size={14} /> Refresh
          </Button>
          <Badge variant={overall === 'healthy' ? 'green' : overall === 'degraded' ? 'orange' : 'red'}>
            {overall.toUpperCase()}
          </Badge>
        </div>

        {!loading && dash && (
          <div className={`${styles.statusStrip} ${styles[overall as keyof typeof styles] ?? ''}`}>
            <Shield size={18} />
            <span>System {overall}</span>
            <span>·</span>
            <span>API uptime {m?.apiUptimePct ?? '—'}%</span>
            <span>·</span>
            <span>{dash.alerts?.critical ?? 0} critical alerts</span>
            <span>·</span>
            <span>Updated {new Date(dash.generatedAt).toLocaleTimeString()}</span>
          </div>
        )}

        <nav className={styles.tabs}>
          {TABS.map((t) => (
            <button key={t.id} type="button" className={tab === t.id ? styles.tabActive : styles.tab} onClick={() => setTab(t.id)}>
              {t.label}
            </button>
          ))}
        </nav>

        {loading ? <Loading /> : !dash ? <Empty icon={Server} title="No data" /> : (
          <>
            {tab === 'overview' && (
              <>
                <div className={styles.stats}>
                  <div className={styles.stat}><small>API Uptime</small><strong>{m.apiUptimePct}%</strong></div>
                  <div className={styles.stat}><small>Signal Latency</small><strong>{m.signalLatencyMs ?? '—'}ms</strong></div>
                  <div className={styles.stat}><small>Cron Failures (24h)</small><strong className={m.cronFailureCount24h > 0 ? styles.fail : styles.ok}>{m.cronFailureCount24h}</strong></div>
                  <div className={styles.stat}><small>Data Freshness</small><strong>{m.dataFreshnessQuality}</strong></div>
                  <div className={styles.stat}><small>Broker Failures (24h)</small><strong>{m.brokerFailureCount24h}</strong></div>
                  <div className={styles.stat}><small>Active Users</small><strong>{dash.users.activeUsers}</strong></div>
                </div>
                <Card title="Active Alerts" compact>
                  {(dash.alerts?.items?.length ?? 0) === 0 ? (
                    <Empty icon={Bell} title="No active alerts" />
                  ) : (
                    dash.alerts.items.slice(0, 8).map((a: any) => (
                      <div key={a.id} className={`${styles.alertCard} ${styles[a.severity] ?? ''}`}>
                        <strong>{a.title}</strong>
                        <p style={{ margin: '4px 0 0', fontSize: '0.82rem', color: '#64748B' }}>{a.detail}</p>
                      </div>
                    ))
                  )}
                </Card>
              </>
            )}

            {tab === 'users' && (
              <Card title="User Management" action={<Users size={16} />}>
                <div className={styles.stats}>
                  <div className={styles.stat}><small>Total</small><strong>{dash.users.totalUsers}</strong></div>
                  <div className={styles.stat}><small>Active</small><strong>{dash.users.activeUsers}</strong></div>
                  <div className={styles.stat}><small>Admins</small><strong>{dash.users.adminUsers}</strong></div>
                  <div className={styles.stat}><small>Disabled</small><strong>{dash.users.disabledUsers}</strong></div>
                  <div className={styles.stat}><small>Logins (24h)</small><strong>{dash.users.recentLogins24h}</strong></div>
                </div>
                <Link href="/admin/users" className="btn btn--sm btn--primary" style={{ marginTop: 12 }}>
                  Open User Management →
                </Link>
              </Card>
            )}

            {tab === 'strategies' && (
              <Card title="Strategy Monitor" action={<LineChart size={16} />}>
                <div className={styles.stats}>
                  <div className={styles.stat}><small>Active Strategies</small><strong>{dash.strategies.activeStrategies}</strong></div>
                  <div className={styles.stat}><small>With Performance Data</small><strong>{dash.strategies.strategiesWithData}</strong></div>
                  <div className={styles.stat}><small>Stale Snapshots</small><strong className={dash.strategies.staleStrategies > 0 ? styles.warn : ''}>{dash.strategies.staleStrategies}</strong></div>
                  <div className={styles.stat}><small>Last Backtest</small><strong style={{ fontSize: '0.85rem' }}>{dash.strategies.lastBacktestAt ? fmt.datetime(dash.strategies.lastBacktestAt) : '—'}</strong></div>
                </div>
                <Link href="/strategies/performance" className="btn btn--sm btn--secondary" style={{ marginTop: 12 }}>
                  Strategy Performance →
                </Link>
              </Card>
            )}

            {tab === 'signals' && (
              <Card title="Signal Validation" action={<Zap size={16} />}>
                <div className={styles.stats}>
                  <div className={styles.stat}><small>Total Signals</small><strong>{dash.signals.totalRows}</strong></div>
                  <div className={styles.stat}><small>Unique Symbols</small><strong>{dash.signals.uniqueSymbols}</strong></div>
                  <div className={styles.stat}><small>Duplicates</small><strong className={dash.signals.duplicatesRemoved > 0 ? styles.warn : styles.ok}>{dash.signals.duplicatesRemoved}</strong></div>
                  <div className={styles.stat}><small>Blank Fields</small><strong>{dash.signals.blankFieldsFixed}</strong></div>
                  <div className={styles.stat}><small>Quality</small><strong className={statusClass(dash.signals.signalQuality)}>{dash.signals.signalQuality}</strong></div>
                  <div className={styles.stat}><small>Engine</small><strong>{dash.signals.engineHealth}</strong></div>
                </div>
                <Link href="/signals/engine-health" className="btn btn--sm btn--secondary" style={{ marginTop: 12 }}>
                  Engine Health Map →
                </Link>
              </Card>
            )}

            {tab === 'cron' && (
              <Card title="Cron Monitoring" action={<Clock size={16} />}>
                <table className={styles.table}>
                  <thead><tr><th>Job</th><th>Schedule</th><th>Last Run</th><th>Status</th><th>Duration</th><th>Failures 24h</th></tr></thead>
                  <tbody>
                    {dash.cronJobs.map((j: any) => (
                      <tr key={j.id}>
                        <td><strong>{j.label}</strong></td>
                        <td style={{ fontSize: '0.78rem', color: '#64748B' }}>{j.schedule}</td>
                        <td>{j.lastRunAt ? fmt.datetime(j.lastRunAt) : '—'}</td>
                        <td className={statusClass(j.lastStatus)}>{j.lastStatus}</td>
                        <td>{j.lastDurationMs != null ? `${j.lastDurationMs}ms` : '—'}</td>
                        <td className={j.failureCount24h > 0 ? styles.fail : ''}>{j.failureCount24h}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <Link href="/admin/pipeline" className="btn btn--sm btn--secondary" style={{ marginTop: 12 }}>
                  Pipeline Control →
                </Link>
              </Card>
            )}

            {tab === 'loaders' && (
              <Card title="Data Loader Monitoring" action={<Database size={16} />}>
                <table className={styles.table}>
                  <thead><tr><th>Provider</th><th>Last Success</th><th>Last Failure</th><th>Failures 24h</th><th>Avg Latency</th><th>Circuit</th></tr></thead>
                  <tbody>
                    {dash.dataLoaders.map((d: any) => (
                      <tr key={d.provider}>
                        <td><strong>{d.provider}</strong></td>
                        <td>{d.lastSuccessAt ? fmt.datetime(d.lastSuccessAt) : '—'}</td>
                        <td>{d.lastFailureAt ? fmt.datetime(d.lastFailureAt) : '—'}</td>
                        <td className={d.failureCount24h > 0 ? styles.fail : ''}>{d.failureCount24h}</td>
                        <td>{d.avgLatencyMs != null ? `${Math.round(d.avgLatencyMs)}ms` : '—'}</td>
                        <td><Badge variant={d.circuitOpen ? 'red' : 'green'}>{d.circuitOpen ? 'OPEN' : 'OK'}</Badge></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Card>
            )}

            {tab === 'broker' && (
              <Card title="Broker Monitoring" action={<Radio size={16} />}>
                <table className={styles.table}>
                  <thead><tr><th>Broker</th><th>Status</th><th>Last Check</th><th>Latency</th><th>Failures 24h</th><th>Kill Switch</th></tr></thead>
                  <tbody>
                    {dash.brokers.map((b: any) => (
                      <tr key={b.broker}>
                        <td><strong>{b.broker}</strong></td>
                        <td className={statusClass(b.status)}>{b.status}</td>
                        <td>{b.lastCheckedAt ? fmt.datetime(b.lastCheckedAt) : '—'}</td>
                        <td>{b.avgLatencyMs != null ? `${b.avgLatencyMs}ms` : '—'}</td>
                        <td>{b.failureCount24h}</td>
                        <td><Badge variant={b.killSwitchActive ? 'red' : 'green'}>{b.killSwitchActive ? 'ACTIVE' : 'OFF'}</Badge></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Card>
            )}

            {tab === 'api' && (
              <Card title="API Health Monitoring" action={<Server size={16} />}>
                <div className={styles.stats}>
                  <div className={styles.stat}><small>System Status</small><strong className={statusClass(dash.apiHealth.systemStatus)}>{dash.apiHealth.systemStatus}</strong></div>
                  <div className={styles.stat}><small>Error Rate</small><strong>{(dash.apiHealth.errorRate * 100).toFixed(2)}%</strong></div>
                  <div className={styles.stat}><small>Avg Latency</small><strong>{Math.round(dash.apiHealth.avgLatencyMs)}ms</strong></div>
                  <div className={styles.stat}><small>Quota State</small><strong className={statusClass(dash.apiHealth.quotaState)}>{dash.apiHealth.quotaState}</strong></div>
                  <div className={styles.stat}><small>Market</small><strong>{dash.apiHealth.marketOpen ? 'OPEN' : 'CLOSED'}</strong></div>
                </div>
                <Link href="/debug/system-health" className="btn btn--sm btn--secondary" style={{ marginTop: 12 }}>
                  Detailed API Monitor →
                </Link>
              </Card>
            )}

            {tab === 'alerts' && (
              <>
                <Card title="Alert Channels" compact>
                  <div className={styles.channelGrid}>
                    {alertData?.channels && Object.entries(alertData.channels).map(([ch, cfg]: [string, any]) => (
                      <div key={ch} className={`${styles.channel} ${cfg.enabled ? styles.on : styles.off}`}>
                        <strong style={{ textTransform: 'capitalize' }}>{ch}</strong>
                        <div style={{ fontSize: '0.78rem', marginTop: 4 }}>{cfg.enabled ? 'Configured' : `Set ${cfg.config}`}</div>
                      </div>
                    ))}
                  </div>
                  <Button onClick={dispatchAlerts} loading={dispatching}>
                    <Bell size={14} /> Dispatch Alerts
                  </Button>
                </Card>
                <Card title="Triggered Alerts" compact>
                  {(alertData?.alerts?.length ?? 0) === 0 ? (
                    <Empty icon={AlertTriangle} title="No alerts" />
                  ) : (
                    alertData.alerts.map((a: any) => (
                      <div key={a.id} className={`${styles.alertCard} ${styles[a.severity] ?? ''}`}>
                        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                          <strong>{a.title}</strong>
                          <Badge variant={a.severity === 'critical' ? 'red' : a.severity === 'warning' ? 'orange' : 'gray'}>{a.severity}</Badge>
                        </div>
                        <p style={{ margin: '4px 0 0', fontSize: '0.82rem', color: '#64748B' }}>{a.detail}</p>
                      </div>
                    ))
                  )}
                </Card>
                <Card title="Delivery Log" compact>
                  <table className={styles.table}>
                    <thead><tr><th>Time</th><th>Alert</th><th>Channel</th><th>Status</th></tr></thead>
                    <tbody>
                      {(alertData?.deliveries ?? []).slice(0, 20).map((d: any) => (
                        <tr key={d.id}>
                          <td>{fmt.datetime(d.createdAt)}</td>
                          <td>{d.title}</td>
                          <td>{d.channel}</td>
                          <td className={statusClass(d.status)}>{d.status}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </Card>
              </>
            )}

            {tab === 'audit' && (
              <Card title="Reliability Audit Logs" action={<FileText size={16} />}>
                {audit.length === 0 ? (
                  <Empty icon={FileText} title="No audit entries" />
                ) : (
                  <table className={styles.table}>
                    <thead><tr><th>Time</th><th>Actor</th><th>Action</th><th>Resource</th><th>Detail</th></tr></thead>
                    <tbody>
                      {audit.map((e: any) => (
                        <tr key={e.id}>
                          <td>{fmt.datetime(e.createdAt)}</td>
                          <td>{e.actorEmail ?? 'system'}</td>
                          <td><strong>{e.action}</strong></td>
                          <td>{e.resource ?? '—'}</td>
                          <td style={{ fontSize: '0.75rem', color: '#64748B', maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                            {JSON.stringify(e.detail).slice(0, 80)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
                <Link href="/admin/audit" className="btn btn--sm btn--secondary" style={{ marginTop: 12 }}>
                  Full Compliance Audit →
                </Link>
              </Card>
            )}
          </>
        )}
      </div>
    </AppShell>
  );
}
