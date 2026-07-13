'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Card, Loading, Badge, StatCard } from '@/components/ui';
import {
  useStrategyOperations,
  useStrategyAlerts,
  useOpsTimeline,
  useAutomationSettings,
  useOpsInvalidation,
  useStrategyHealth,
} from '@/hooks/useStrategyOperations';
import type { StrategyHealthStatus } from '@/lib/strategy-hub/operations/types';
import {
  Activity, AlertTriangle, CheckCircle2, RefreshCw, Server, Shield, Zap,
} from 'lucide-react';
import styles from '@/app/strategies/strategies.module.scss';

const HEALTH_VARIANT: Record<StrategyHealthStatus, 'green' | 'orange' | 'red' | 'gray'> = {
  healthy: 'green',
  warning: 'orange',
  critical: 'red',
  offline: 'gray',
};

function fmtWhen(iso: string | null | undefined): string {
  if (!iso) return '—';
  try { return new Date(iso).toLocaleString(); } catch { return iso; }
}

interface Props {
  canManage: boolean;
}

export function StrategyOperationsPanel({ canManage }: Props) {
  const [section, setSection] = useState<'overview' | 'alerts' | 'scheduler' | 'engine' | 'timeline' | 'automation'>('overview');
  const [timelineSearch, setTimelineSearch] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const { data, isLoading, error, refetch, isFetching } = useStrategyOperations();
  const { data: alerts } = useStrategyAlerts('open');
  const { data: timeline } = useOpsTimeline(timelineSearch || undefined);
  const { data: automation, refetch: refetchAutomation } = useAutomationSettings();
  const invalidate = useOpsInvalidation();

  const runJob = async (job: string) => {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch('/api/strategies/operations/automation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ job }),
      });
      const body = await res.json();
      setMessage(body.message ?? (body.ok ? 'Job completed' : 'Job failed'));
      invalidate();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'Action failed');
    } finally {
      setBusy(false);
    }
  };

  const alertAction = async (alertId: number, action: 'acknowledge' | 'resolve') => {
    if (!canManage) return;
    setBusy(true);
    try {
      await fetch('/api/strategies/operations/alerts', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ alertId, action }),
      });
      invalidate();
    } finally {
      setBusy(false);
    }
  };

  const saveAutomation = async (patch: Record<string, boolean>) => {
    if (!canManage) return;
    setBusy(true);
    try {
      await fetch('/api/strategies/operations/automation', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ settings: { ...automation?.settings, ...patch } }),
      });
      await refetchAutomation();
      setMessage('Automation settings saved');
    } finally {
      setBusy(false);
    }
  };

  if (isLoading) return <Loading text="Loading operations dashboard…" />;
  if (error || !data) {
    return (
      <Card>
        <p style={{ color: '#DC2626' }}>Failed to load operations dashboard.</p>
        <button type="button" className="btn btn--outline btn--sm" onClick={() => refetch()}>Retry</button>
      </Card>
    );
  }

  const s = data.summary;

  return (
    <div className={styles.opsPanel}>
      <div className={styles.analyticsToolbar}>
        <div className={styles.filters}>
          {(['overview', 'alerts', 'scheduler', 'engine', 'timeline', 'automation'] as const).map((tab) => (
            <button
              key={tab}
              type="button"
              className={section === tab ? styles.filterChipActive : styles.filterChip}
              onClick={() => setSection(tab)}
            >
              {tab.charAt(0).toUpperCase() + tab.slice(1)}
              {tab === 'alerts' && s.openAlerts > 0 ? ` (${s.openAlerts})` : ''}
            </button>
          ))}
        </div>
        <button
          type="button"
          className="btn btn--outline btn--sm"
          onClick={() => refetch()}
          disabled={isFetching}
          style={{ display: 'flex', alignItems: 'center', gap: 6 }}
        >
          <RefreshCw size={14} className={isFetching ? styles.spin : undefined} />
          Refresh
        </button>
      </div>

      {data.marketHoursActive && (
        <p className={styles.analyticsCacheNote}>Market hours — auto-refresh active</p>
      )}
      {message && <p style={{ fontSize: '0.85rem', color: '#059669' }}>{message}</p>}

      {section === 'overview' && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 14, marginBottom: 20 }}>
            <StatCard label="Healthy" value={s.healthyStrategies} icon={CheckCircle2} iconVariant="green" />
            <StatCard label="Warning" value={s.warningStrategies} icon={AlertTriangle} iconVariant="orange" />
            <StatCard label="Critical" value={s.criticalStrategies} icon={Shield} iconVariant="orange" />
            <StatCard label="Open Alerts" value={s.openAlerts} icon={Zap} iconVariant="blue" />
            <StatCard label="Paper Deployed" value={s.paperDeployed} icon={Server} iconVariant="blue" />
            <StatCard label="Live Deployed" value={s.liveDeployed} icon={Activity} iconVariant="green" />
          </div>

          <Card title="Signal Engine" style={{ marginBottom: 16 }}>
            <div className={styles.analyticsKpiGrid}>
              <div><span className={styles.configMetaLabel}>Status</span><strong>{data.signalEngine.scanStatus}</strong></div>
              <div><span className={styles.configMetaLabel}>Last Scan</span><strong>{fmtWhen(data.lastScanTime)}</strong></div>
              <div><span className={styles.configMetaLabel}>Next Scan</span><strong>{fmtWhen(data.nextScheduledScan)}</strong></div>
              <div><span className={styles.configMetaLabel}>Signals (24h)</span><strong>{data.signalEngine.signalsGenerated}</strong></div>
              <div><span className={styles.configMetaLabel}>Approved</span><strong>{data.signalEngine.signalsApproved}</strong></div>
              <div><span className={styles.configMetaLabel}>Errors</span><strong>{data.signalEngine.errorCount}</strong></div>
            </div>
          </Card>

          <Card title="Strategy Health">
            <HealthTable />
          </Card>
        </>
      )}

      {section === 'alerts' && (
        <Card title="Alert Center">
          {!alerts?.length ? (
            <p style={{ color: '#64748B' }}>No open alerts.</p>
          ) : (
            <div className={styles.analyticsRecList}>
              {alerts.map((a) => (
                <div key={a.id} className={styles.analyticsRecCard}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
                    <strong>{a.title}</strong>
                    <Badge variant={a.severity === 'critical' ? 'red' : a.severity === 'warning' ? 'orange' : 'gray'}>
                      {a.severity}
                    </Badge>
                  </div>
                  <p style={{ fontSize: '0.85rem', margin: '6px 0' }}>{a.description}</p>
                  <p style={{ fontSize: '0.8rem', color: '#1E40AF' }}>Action: {a.suggestedAction}</p>
                  <p style={{ fontSize: '0.75rem', color: '#94A3B8' }}>{fmtWhen(a.createdAt)}</p>
                  {canManage && (
                    <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                      <button type="button" className="btn btn--outline btn--sm" disabled={busy} onClick={() => alertAction(a.id, 'acknowledge')}>
                        Acknowledge
                      </button>
                      <button type="button" className="btn btn--primary btn--sm" disabled={busy} onClick={() => alertAction(a.id, 'resolve')}>
                        Resolve
                      </button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </Card>
      )}

      {section === 'scheduler' && (
        <Card title="Scheduler Monitor">
          <div className={styles.analyticsTableWrap}>
            <table className={styles.analyticsTable}>
              <thead>
                <tr>
                  <th>Job</th><th>Schedule</th><th>Last Run</th><th>Duration</th><th>Status</th>
                </tr>
              </thead>
              <tbody>
                {data.scheduler.jobs.map((j) => (
                  <tr key={j.id}>
                    <td>{j.name}</td>
                    <td>{j.schedule}</td>
                    <td>{fmtWhen(j.lastRun)}</td>
                    <td>{j.durationMs != null ? `${j.durationMs}ms` : '—'}</td>
                    <td>
                      <Badge variant={j.status === 'success' ? 'green' : j.status === 'failed' ? 'red' : 'orange'}>
                        {j.status}
                      </Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {canManage && (
            <div style={{ marginTop: 12, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button type="button" className="btn btn--outline btn--sm" disabled={busy} onClick={() => runJob('health_check')}>
                Run Health Check
              </button>
              <button type="button" className="btn btn--outline btn--sm" disabled={busy} onClick={() => runJob('cache_refresh')}>
                Refresh Caches
              </button>
            </div>
          )}
        </Card>
      )}

      {section === 'engine' && (
        <Card title="Signal Engine Monitor">
          <div className={styles.analyticsKpiGrid} style={{ marginBottom: 16 }}>
            <div><span className={styles.configMetaLabel}>Scan Status</span><strong>{data.signalEngine.scanStatus}</strong></div>
            <div><span className={styles.configMetaLabel}>Queue</span><strong>{data.signalEngine.queueSize}</strong></div>
            <div><span className={styles.configMetaLabel}>Processed</span><strong>{data.signalEngine.strategiesProcessed}</strong></div>
            <div><span className={styles.configMetaLabel}>Throughput/min</span><strong>{data.signalEngine.throughputPerMin}</strong></div>
            <div><span className={styles.configMetaLabel}>Memory</span><strong>{data.signalEngine.memoryUsageMb} MB</strong></div>
            <div><span className={styles.configMetaLabel}>Processing</span><strong>{data.signalEngine.processingTimeMs ?? '—'} ms</strong></div>
          </div>
          {data.signalEngine.strategyStats.length > 0 && (
            <div className={styles.analyticsTableWrap}>
              <table className={styles.analyticsTable}>
                <thead>
                  <tr><th>Strategy</th><th>Evaluated</th><th>Matched</th><th>Confirmed</th><th>Rejected</th></tr>
                </thead>
                <tbody>
                  {data.signalEngine.strategyStats.slice(0, 20).map((r) => (
                    <tr key={r.strategyId}>
                      <td>{r.strategyId}</td>
                      <td>{r.evaluated}</td>
                      <td>{r.matched}</td>
                      <td>{r.confirmed}</td>
                      <td>{r.rejected}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}

      {section === 'timeline' && (
        <Card title="Activity Timeline">
          <input
            type="search"
            placeholder="Search timeline…"
            value={timelineSearch}
            onChange={(e) => setTimelineSearch(e.target.value)}
            className={styles.analyticsCompareInput}
            style={{ marginBottom: 12 }}
          />
          {!timeline?.length ? (
            <p style={{ color: '#64748B' }}>No activity recorded yet.</p>
          ) : (
            <div className={styles.opsTimeline}>
              {timeline.map((e) => (
                <div key={e.id} className={styles.opsTimelineItem}>
                  <div className={styles.opsTimelineMeta}>
                    <Badge variant="gray">{e.category}</Badge>
                    <span style={{ fontSize: '0.75rem', color: '#94A3B8' }}>{fmtWhen(e.timestamp)}</span>
                  </div>
                  <strong>{e.title}</strong>
                  <p style={{ fontSize: '0.85rem', margin: '4px 0', color: '#475569' }}>{e.description}</p>
                  {e.strategyId && (
                    <Link href={`/strategies/${e.strategyId}`} style={{ fontSize: '0.8rem' }}>
                      {e.strategyName ?? e.strategyId}
                    </Link>
                  )}
                </div>
              ))}
            </div>
          )}
        </Card>
      )}

      {section === 'automation' && automation && (
        <Card title="Automation Settings">
          {!canManage && (
            <p style={{ color: '#64748B', marginBottom: 12 }}>Read-only — administrators can change automation.</p>
          )}
          <div className={styles.opsAutomationList}>
            {([
              ['revalidateOnConfigChange', 'Revalidate after configuration changes'],
              ['scheduledDailyValidation', 'Scheduled daily validation'],
              ['automaticHealthChecks', 'Automatic health checks'],
              ['automaticCacheRefresh', 'Automatic cache refresh'],
              ['scheduledPerformanceRecalc', 'Scheduled performance recalculation'],
              ['automaticRankingRefresh', 'Automatic ranking refresh'],
              ['automaticLearningRefresh', 'Automatic learning refresh'],
              ['scheduledDailyAiReview', 'Daily AI strategy review'],
              ['scheduledWeeklyOptimizationReport', 'Weekly optimization report'],
              ['scheduledMonthlyExecutiveSummary', 'Monthly executive summary'],
              ['automaticAnomalyDetection', 'Automatic anomaly detection'],
              ['automaticRecommendationRefresh', 'Automatic recommendation refresh'],
            ] as const).map(([key, label]) => (
              <label key={key} className={styles.opsAutomationRow}>
                <input
                  type="checkbox"
                  checked={automation.settings[key]}
                  disabled={!canManage || busy}
                  onChange={(e) => saveAutomation({ [key]: e.target.checked })}
                />
                <span>{label}</span>
              </label>
            ))}
          </div>
          {canManage && (
            <div style={{ marginTop: 16, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button type="button" className="btn btn--primary btn--sm" disabled={busy} onClick={() => runJob('performance_recalc')}>
                Recalculate Performance
              </button>
              <button type="button" className="btn btn--outline btn--sm" disabled={busy} onClick={() => runJob('learning_refresh')}>
                Refresh Learning
              </button>
              <button type="button" className="btn btn--outline btn--sm" disabled={busy} onClick={() => runJob('daily_validation')}>
                Run Validation Sweep
              </button>
              <button type="button" className="btn btn--outline btn--sm" disabled={busy} onClick={() => runJob('ai_daily_review')}>
                AI Daily Review
              </button>
              <button type="button" className="btn btn--outline btn--sm" disabled={busy} onClick={() => runJob('ai_anomaly_detection')}>
                Detect Anomalies
              </button>
            </div>
          )}
        </Card>
      )}
    </div>
  );
}

function HealthTable() {
  const { data: rows = [], isLoading } = useStrategyHealth();

  if (isLoading) return <Loading text="Loading health…" />;

  return (
    <div className={styles.analyticsTableWrap}>
      <table className={styles.analyticsTable}>
        <thead>
          <tr>
            <th>Strategy</th><th>Status</th><th>Score</th><th>Mode</th>
            <th>Validation</th><th>Signals</th><th>Deployment</th>
          </tr>
        </thead>
        <tbody>
          {rows.slice(0, 30).map((h) => (
            <tr key={h.strategyId}>
              <td>
                <Link href={`/strategies/${h.strategyId}`}>{h.strategyName}</Link>
              </td>
              <td><Badge variant={HEALTH_VARIANT[h.healthStatus]}>{h.healthStatus}</Badge></td>
              <td>{h.healthScore}</td>
              <td>{h.currentMode}</td>
              <td>{h.validationStatus ?? '—'}</td>
              <td>{h.signalGenerationStatus}</td>
              <td>{h.deploymentStatus}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
