'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  Activity, AlertTriangle, Bell, Clock, LayoutDashboard,
  RefreshCw, Server, Shield, Zap,
} from 'lucide-react';
import AppShell from '@/components/layout/AppShell';
import { Badge, Button, Card, Empty, Loading, AlertBanner } from '@/components/ui';
import { fmt } from '@/lib/utils';
import styles from './dashboard.module.scss';

type Tab = 'dashboard' | 'signals' | 'cron' | 'health' | 'alerts';

const TABS: { id: Tab; label: string }[] = [
  { id: 'dashboard', label: 'Admin Dashboard' },
  { id: 'signals', label: 'Signal Validation' },
  { id: 'cron', label: 'Cron Monitor' },
  { id: 'health', label: 'System Health' },
  { id: 'alerts', label: 'Alert Center' },
];

function sc(s: string) {
  if (['healthy', 'success', 'ok', 'CLEAN'].includes(s)) return styles.ok;
  if (['degraded', 'warning', 'warn', 'NEEDS_CLEANUP'].includes(s)) return styles.warn;
  return styles.fail;
}

export default function AdminDashboardPage() {
  const [tab, setTab] = useState<Tab>('dashboard');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [dash, setDash] = useState<any>(null);
  const [signals, setSignals] = useState<any>(null);
  const [cron, setCron] = useState<any>(null);
  const [health, setHealth] = useState<any>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [dRes, sRes, cRes, hRes] = await Promise.all([
        fetch('/api/admin/dashboard').then((r) => r.json()),
        fetch('/api/admin/signals').then((r) => r.json()),
        fetch('/api/admin/cron').then((r) => r.json()),
        fetch('/api/admin/system-health').then((r) => r.json()),
      ]);
      if (!dRes.ok) throw new Error(dRes.error ?? 'Failed to load dashboard');
      setDash(dRes.dashboard);
      setSignals(sRes.signals);
      setCron(cRes);
      setHealth(hRes.health);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Load failed');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const status = dash?.systemStatus ?? 'unknown';
  const summary = dash?.summary;

  return (
    <AppShell title="Admin Dashboard">
      <div className="page">
        <div className="page__header">
          <h1><LayoutDashboard size={22} style={{ verticalAlign: 'middle', marginRight: 8 }} />Admin Dashboard</h1>
          <p>System status, cron jobs, signal validation, data delays, and alerts.</p>
        </div>

        {error && <AlertBanner variant="error">{error}</AlertBanner>}

        <div style={{ marginBottom: 16, display: 'flex', gap: 8, alignItems: 'center' }}>
          <Button variant="secondary" size="sm" onClick={load} loading={loading}>
            <RefreshCw size={14} /> Refresh
          </Button>
          {!loading && dash && (
            <Badge variant={status === 'healthy' ? 'green' : status === 'degraded' ? 'orange' : 'red'}>
              {status.toUpperCase()}
            </Badge>
          )}
        </div>

        {!loading && dash && (
          <div className={`${styles.statusBanner} ${styles[status as keyof typeof styles] ?? ''}`}>
            <Shield size={18} />
            <span>System {status}</span>
            <span>·</span>
            <span>{summary?.alertCritical ?? 0} critical / {summary?.alertWarning ?? 0} warning</span>
            <span>·</span>
            <span>Data: {summary?.dataFreshnessQuality}</span>
            <span>·</span>
            <span>{summary?.cronFailures24h ?? 0} cron failures (24h)</span>
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
            {tab === 'dashboard' && (
              <>
                <div className={styles.stats}>
                  <div className={styles.stat}><small>API Uptime</small><strong>{summary?.apiUptimePct}%</strong></div>
                  <div className={styles.stat}><small>Signal Latency</small><strong>{summary?.signalLatencyMs ?? '—'}ms</strong></div>
                  <div className={styles.stat}><small>Failed Jobs</small><strong className={(dash.failedJobs?.length ?? 0) > 0 ? styles.fail : styles.ok}>{dash.failedJobs?.length ?? 0}</strong></div>
                  <div className={styles.stat}><small>Data Delay</small><strong>{summary?.dataDelaySeconds ?? '—'}s</strong></div>
                  <div className={styles.stat}><small>Strategy Failures</small><strong className={(summary?.strategyFailures ?? 0) > 0 ? styles.warn : ''}>{summary?.strategyFailures ?? 0}</strong></div>
                  <div className={styles.stat}><small>Active Users</small><strong>{dash.users?.activeUsers}</strong></div>
                </div>

                {(dash.failedJobs?.length ?? 0) > 0 && (
                  <Card title="Failed Jobs" compact>
                    <table className={styles.table}>
                      <thead><tr><th>Job</th><th>Last Run</th><th>Status</th><th>Failures 24h</th></tr></thead>
                      <tbody>
                        {dash.failedJobs.map((j: any) => (
                          <tr key={j.id}>
                            <td><strong>{j.label}</strong></td>
                            <td>{j.lastRunAt ? fmt.datetime(j.lastRunAt) : '—'}</td>
                            <td className={sc(j.lastStatus)}>{j.lastStatus}</td>
                            <td className={styles.fail}>{j.failureCount24h}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </Card>
                )}

                {(dash.dataDelays?.length ?? 0) > 0 && (
                  <Card title="Data Delays" compact>
                    <table className={styles.table}>
                      <thead><tr><th>Provider</th><th>Last Success</th><th>Failures 24h</th><th>Circuit</th></tr></thead>
                      <tbody>
                        {dash.dataDelays.map((d: any) => (
                          <tr key={d.provider}>
                            <td><strong>{d.provider}</strong></td>
                            <td>{d.lastSuccessAt ? fmt.datetime(d.lastSuccessAt) : '—'}</td>
                            <td className={d.failureCount24h > 0 ? styles.fail : ''}>{d.failureCount24h}</td>
                            <td><Badge variant={d.circuitOpen ? 'red' : 'green'}>{d.circuitOpen ? 'OPEN' : 'OK'}</Badge></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </Card>
                )}
              </>
            )}

            {tab === 'signals' && signals && (
              <Card title="Signal Validation" action={<Zap size={16} />}>
                <div className={styles.stats}>
                  <div className={styles.stat}><small>Total Signals</small><strong>{signals.totalRows}</strong></div>
                  <div className={styles.stat}><small>Unique Symbols</small><strong>{signals.uniqueSymbols}</strong></div>
                  <div className={styles.stat}><small>Duplicates</small><strong className={sc(signals.quality)}>{signals.duplicatesRemoved}</strong></div>
                  <div className={styles.stat}><small>Blank Fields</small><strong>{signals.blankFieldsFixed}</strong></div>
                  <div className={styles.stat}><small>Quality</small><strong className={sc(signals.quality)}>{signals.quality}</strong></div>
                  <div className={styles.stat}><small>Rejections 24h</small><strong>{signals.rejectionCount24h}</strong></div>
                </div>
                {(signals.alerts?.length ?? 0) > 0 && (
                  <>
                    <h4 style={{ marginTop: 16 }}>Signal Alerts</h4>
                    {signals.alerts.map((a: any) => (
                      <div key={a.id} className={`${styles.alertItem} ${styles[a.severity] ?? ''}`}>
                        <strong>{a.title}</strong>
                        <p style={{ margin: '4px 0 0', fontSize: '0.82rem', color: '#64748B' }}>{a.detail}</p>
                      </div>
                    ))}
                  </>
                )}
              </Card>
            )}

            {tab === 'cron' && cron && (
              <Card title="Cron Monitor" action={<Clock size={16} />}>
                <div className={styles.stats}>
                  <div className={styles.stat}><small>Jobs Tracked</small><strong>{cron.jobs?.length}</strong></div>
                  <div className={styles.stat}><small>Failed Jobs</small><strong className={(cron.failedJobs?.length ?? 0) > 0 ? styles.fail : styles.ok}>{cron.failedJobs?.length ?? 0}</strong></div>
                  <div className={styles.stat}><small>Failures 24h</small><strong>{cron.failureCount24h}</strong></div>
                </div>
                <table className={styles.table}>
                  <thead><tr><th>Job</th><th>Schedule</th><th>Last Run</th><th>Status</th><th>Duration</th><th>Failures 24h</th></tr></thead>
                  <tbody>
                    {cron.jobs?.map((j: any) => (
                      <tr key={j.id}>
                        <td><strong>{j.label}</strong></td>
                        <td style={{ fontSize: '0.78rem', color: '#64748B' }}>{j.schedule}</td>
                        <td>{j.lastRunAt ? fmt.datetime(j.lastRunAt) : '—'}</td>
                        <td className={sc(j.lastStatus)}>{j.lastStatus}</td>
                        <td>{j.lastDurationMs != null ? `${j.lastDurationMs}ms` : '—'}</td>
                        <td className={j.failureCount24h > 0 ? styles.fail : ''}>{j.failureCount24h}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {(cron.failedLogs?.length ?? 0) > 0 && (
                  <>
                    <h4 style={{ marginTop: 20 }}>Failed Job Logs</h4>
                    <table className={styles.table}>
                      <thead><tr><th>Job</th><th>Started</th><th>Error</th></tr></thead>
                      <tbody>
                        {cron.failedLogs.slice(0, 15).map((l: any) => (
                          <tr key={l.id}>
                            <td>{l.jobLabel ?? l.jobName}</td>
                            <td>{fmt.datetime(l.startedAt)}</td>
                            <td className={styles.fail}>{l.errorMessage ?? 'failed'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </>
                )}
              </Card>
            )}

            {tab === 'health' && health && (
              <Card title="System Health" action={<Activity size={16} />}>
                <div className={styles.stats}>
                  <div className={styles.stat}><small>Status</small><strong className={sc(health.overallStatus)}>{health.overallStatus}</strong></div>
                  <div className={styles.stat}><small>Error Rate</small><strong>{(health.metrics?.apiErrorRate * 100).toFixed(2)}%</strong></div>
                  <div className={styles.stat}><small>Avg Latency</small><strong>{Math.round(health.metrics?.apiAvgLatencyMs ?? 0)}ms</strong></div>
                  <div className={styles.stat}><small>Data Delay</small><strong>{health.metrics?.dataFreshnessSeconds ?? '—'}s</strong></div>
                  <div className={styles.stat}><small>Quota</small><strong className={sc(health.apiHealth?.quotaState)}>{health.apiHealth?.quotaState}</strong></div>
                </div>
                {(health.dataDelays?.length ?? 0) > 0 && (
                  <>
                    <h4>Data Loader Delays</h4>
                    <table className={styles.table}>
                      <thead><tr><th>Provider</th><th>Last Success</th><th>Failures</th><th>Circuit</th></tr></thead>
                      <tbody>
                        {health.dataDelays.map((d: any) => (
                          <tr key={d.provider}>
                            <td>{d.provider}</td>
                            <td>{d.lastSuccessAt ? fmt.datetime(d.lastSuccessAt) : '—'}</td>
                            <td className={styles.fail}>{d.failureCount24h}</td>
                            <td><Badge variant={d.circuitOpen ? 'red' : 'green'}>{d.circuitOpen ? 'OPEN' : 'OK'}</Badge></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </>
                )}
              </Card>
            )}

            {tab === 'alerts' && (
              <Card title="Alert Center" action={<Bell size={16} />}>
                {(dash.alerts?.length ?? 0) === 0 ? (
                  <Empty icon={AlertTriangle} title="No active alerts" />
                ) : (
                  dash.alerts.map((a: any) => (
                    <div key={a.alertKey ?? a.id} className={`${styles.alertItem} ${styles[a.severity] ?? ''}`}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <strong>{a.title}</strong>
                        <Badge variant={a.severity === 'critical' ? 'red' : a.severity === 'warning' ? 'orange' : 'gray'}>{a.severity}</Badge>
                      </div>
                      <p style={{ margin: '4px 0 0', fontSize: '0.82rem', color: '#64748B' }}>{a.message}</p>
                      <small style={{ color: '#94A3B8' }}>{fmt.datetime(a.createdAt)} · {a.source}</small>
                    </div>
                  ))
                )}
              </Card>
            )}
          </>
        )}
      </div>
    </AppShell>
  );
}
